/**
 * A Chrome DevTools Protocol driver for interacting with the dashboard.
 *
 * `screenshot.mts` photographs a page. This one drives it: it can click things,
 * read what changed, and follow navigation — which is the only way to answer
 * "does this control actually do anything?" Reading the source cannot, because
 * a handler that exists may still be attached to nothing, and a control with no
 * handler may still be a link.
 *
 * Development tooling. Nothing in the application depends on it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Node exposes WebSocket as a global from 22 onwards.
 *
 * Taken off `globalThis` rather than imported from `undici`: undici is a
 * transitive dependency here, not a declared one, and reaching into it would be
 * a hidden dependency that breaks the day something upstream stops installing
 * it. The lint config declares Node globals only, so the reference is named
 * once here instead of widening the config for every file.
 */
const WebSocket = globalThis.WebSocket;
if (typeof WebSocket !== 'function') {
  throw new Error('This driver needs Node 22+ for a global WebSocket.');
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env['LOCALAPPDATA'] ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export async function launchBrowser({ port = 9331, width = 1440, height = 1000 } = {}) {
  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!chrome) throw new Error(`Chrome not found. Checked:\n  ${CHROME_CANDIDATES.join('\n  ')}`);

  const proc = spawn(
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

  const wsUrl = await targetWebSocketUrl(port);
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')));
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768,
  });

  return {
    send,

    async setViewport(w, h) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: w < 768,
      });
    },

    async setCookie(cookie, host = 'localhost') {
      const separator = cookie.indexOf('=');
      await send('Network.setCookie', {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        domain: host,
        path: '/',
        httpOnly: true,
      });
    },

    /** Navigates and waits for the network to go quiet. */
    async goto(url, settleMs = 2500) {
      await send('Page.navigate', { url });
      await sleep(settleMs);
    },

    /**
     * Evaluates an expression in the page and returns its value.
     *
     * `awaitPromise` plus `returnByValue` means a test can await something in
     * the page and get a plain JS value back, which keeps assertions readable.
     *
     * `userGesture` matters for anything gated on transient activation --
     * Fullscreen, clipboard, autoplay. A scripted `.click()` does not count as
     * a user action, so `requestFullscreen()` rejects and the control looks
     * broken when it is not. Passing the flag makes the call indistinguishable
     * from a real click as far as those APIs are concerned.
     */
    async evaluate(expression, { userGesture = false } = {}) {
      const result = await send('Runtime.evaluate', {
        // async, so a probe can `await fetch(...)` in the page. `awaitPromise`
        // below then resolves the returned promise before handing back a value.
        expression: `(async () => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
        userGesture,
      });
      if (result.result?.exceptionDetails) {
        throw new Error(
          result.result.exceptionDetails.exception?.description ??
            result.result.exceptionDetails.text,
        );
      }
      return result.result?.result?.value;
    },

    async url() {
      return this.evaluate('return location.href;');
    },

    async close() {
      socket.close();
      proc.kill();
    },
  };
}

async function targetWebSocketUrl(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is not listening yet.
    }
    await sleep(200);
  }
  throw new Error('Chrome did not expose a debugging target.');
}
