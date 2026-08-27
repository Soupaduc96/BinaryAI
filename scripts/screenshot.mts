/**
 * Screenshots a page through the Chrome DevTools Protocol.
 *
 * Exists because a signed-in view cannot be captured with `chrome --screenshot`:
 * there is no way to hand that mode a cookie. CDP can set one before the
 * navigation, which is the only way to photograph what a logged-in user sees.
 *
 * It also measures real layout width, so "does this overflow on mobile?" is
 * answered by the rendered document rather than by eye -- a screenshot cropped
 * to the window makes overflow invisible.
 *
 *   npx tsx scripts/screenshot.mts <url> <out.png> [--width 1440] [--height 900]
 *                                  [--cookie name=value] [--host localhost]
 *
 * Development tooling. Nothing in the application depends on it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env['LOCALAPPDATA'] ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const [url, output] = process.argv.slice(2);
if (!url || !output) {
  console.error('usage: screenshot.mts <url> <out.png> [--width N] [--height N] [--cookie k=v]');
  process.exit(1);
}

const width = Number(flag('width', '1440'));
const height = Number(flag('height', '900'));
const cookie = flag('cookie');
const cookieHost = flag('host', 'localhost') as string;

const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!chrome) {
  console.error('Chrome not found. Checked:\n  ' + CHROME_CANDIDATES.join('\n  '));
  process.exit(1);
}

const port = 9222 + Math.floor(Math.random() * 500);
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** CDP is available a moment after launch; poll rather than guess a delay. */
async function targetWebSocketUrl(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error('Chrome did not expose a debugging target.');
}

const socket = new WebSocket(await targetWebSocketUrl());
await new Promise<void>((resolve, reject) => {
  socket.addEventListener('open', () => {
    resolve();
  });
  socket.addEventListener('error', () => {
    reject(new Error('CDP socket failed'));
  });
});

let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    result?: unknown;
    error?: { message: string };
  };
  if (message.id !== undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) throw new Error(`CDP: ${message.error.message}`);
    resolve?.(message.result);
  }
});

function send<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve) => {
    pending.set(id, resolve as (result: unknown) => void);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');

/**
 * Sets the viewport precisely, independent of the OS window.
 *
 * `--window-size` is not enough on its own: Chrome on Windows enforces a
 * minimum window width of roughly 500px, so asking for 390 silently produced a
 * ~504px viewport. Every "no overflow at 390px" measurement taken that way was
 * really a measurement at 504px — a check that passes without testing the case
 * it names, which is the worst kind.
 *
 * `Emulation.setDeviceMetricsOverride` sets the layout viewport directly and is
 * not subject to that floor. `mobile` is set for narrow widths so the page also
 * gets the meta-viewport handling a real phone would apply.
 */
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: width < 768,
});

if (cookie) {
  const separator = cookie.indexOf('=');
  await send('Network.setCookie', {
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    domain: cookieHost,
    path: '/',
    httpOnly: true,
  });
}

await send('Page.navigate', { url });
// Turbopack compiles on first hit in dev, so allow generously for the load.
await sleep(5000);

const metrics = await send<{
  result: { value: { scrollWidth: number; clientWidth: number; scrollHeight: number } };
}>('Runtime.evaluate', {
  expression: `({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
  })`,
  returnByValue: true,
});

const { scrollWidth, clientWidth, scrollHeight } = metrics.result.value;
const overflow = scrollWidth - clientWidth;
console.log(`layout: scrollWidth=${scrollWidth} clientWidth=${clientWidth} height=${scrollHeight}`);
console.log(overflow > 0 ? `HORIZONTAL OVERFLOW: ${overflow}px` : 'no horizontal overflow');

const shot = await send<{ data: string }>('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
});
await writeFile(output, Buffer.from(shot.data, 'base64'));
console.log(`wrote ${output}`);

socket.close();
browser.kill();
process.exit(0);
