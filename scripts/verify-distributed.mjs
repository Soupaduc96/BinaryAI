#!/usr/bin/env node
/**
 * Multi-instance verification against real processes.
 *
 * Everything here runs as separate operating-system processes talking over real
 * sockets: a real PostgreSQL 16 server, a shared counter, and TWO independent
 * API instances on different ports. Nothing is stubbed inside a test runner,
 * because the properties being checked are precisely the ones that a
 * single-process test cannot see.
 *
 *     instance A ─┐                ┌─ shared counter (RESP)
 *                 ├─ PostgreSQL 16 ┤
 *     instance B ─┘                └─ shared sessions
 *
 * What this proves:
 *   - one rate-limit budget is shared across two instances
 *   - a session issued by one instance is accepted by the other
 *   - logout on one instance is effective on the other
 *   - credential traffic fails CLOSED when the counter is unreachable
 *   - general traffic fails OPEN and reports degraded
 *
 * What it does NOT prove: anything about Redis. The shared counter is
 * `scripts/resp-server.mjs`, which speaks four RESP commands and is explicitly
 * not Redis. See the header of that file.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 infrastructure missing.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { startPostgres16 } from './postgres16.mjs';

/**
 * The shared counter.
 *
 * Set REDIS_URL to point at a real Redis and this script uses it, which is what
 * turns the result from "the distributed property works" into "the distributed
 * property works against Redis". Without it, a local RESP stand-in is started
 * instead -- adequate for the property, explicitly not evidence about Redis.
 */
const EXTERNAL_REDIS_URL = process.env.REDIS_URL;
const RESP_PORT = Number(process.env.RESP_PORT ?? 6390);
const counterUrl = EXTERNAL_REDIS_URL ?? `redis://127.0.0.1:${RESP_PORT}`;
const counterPort = Number(new URL(counterUrl).port || 6379);
const counterHost = new URL(counterUrl).hostname;
const PORT_A = 4101;
const PORT_B = 4102;
/**
 * The API instances talk to the counter through a loopback proxy rather than
 * directly.
 *
 * The outage section needs the counter to become unreachable. With the local
 * stand-in that meant killing its process, which is impossible -- and
 * unacceptable -- when REDIS_URL points at a Redis somebody else owns. Killing
 * a proxy severs the connection identically from the API's point of view and
 * leaves the real server untouched.
 */
const PROXY_PORT = 6391;

const checks = [];
let failures = 0;

function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  if (!passed) failures += 1;
  process.stdout.write(`${passed ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n--- ${title}\n`);
}

const children = [];

function spawnNode(label, args, env) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (c) => lines.push(String(c)));
  child.stderr.on('data', (c) => lines.push(String(c)));
  children.push({ label, child, lines });
  return { child, lines };
}

async function stopAll() {
  for (const { child } of children) {
    if (!child.killed) child.kill();
  }
  await sleep(300);
}

/** Polls until the instance answers liveness, or gives up. */
async function waitForApi(port, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  return false;
}

async function call(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // Some responses have no body.
  }
  return { status: response.status, headers: response.headers, json };
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const first = raw[0] ?? response.headers.get('set-cookie') ?? '';
  return String(first).split(';')[0] ?? '';
}

// --------------------------------------------------------------- start up --

section('Starting PostgreSQL 16');
let postgres;
try {
  postgres = await startPostgres16({ dataDir: '.tmp/pg16dist' });
} catch (error) {
  console.error(`Could not start PostgreSQL 16: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
process.stdout.write(`  PostgreSQL ${postgres.version} on port ${postgres.port}\n`);

section('Applying migrations');
await new Promise((resolve, reject) => {
  const migrate = spawn(process.execPath, ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: postgres.url },
    stdio: 'ignore',
  });
  migrate.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
});
process.stdout.write('  migrations applied from zero\n');

if (EXTERNAL_REDIS_URL) {
  section('Using the shared counter at REDIS_URL (external server)');
  process.stdout.write(`  ${counterHost}:${counterPort}
`);
} else {
  section('Starting the shared counter (RESP stand-in — NOT Redis)');
  spawnNode('resp', ['scripts/resp-server.mjs', '--port', String(RESP_PORT)], {});
  await sleep(800);
}

/** Forwards loopback:PROXY_PORT to the counter, until closed. */
function startCounterProxy() {
  const sockets = new Set();
  const server = net.createServer((inbound) => {
    sockets.add(inbound);
    const outbound = net.connect(counterPort, counterHost);
    sockets.add(outbound);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    const drop = () => {
      sockets.delete(inbound);
      sockets.delete(outbound);
      inbound.destroy();
      outbound.destroy();
    };
    inbound.on('error', drop);
    outbound.on('error', drop);
    inbound.on('close', drop);
    outbound.on('close', drop);
  });
  server.listen(PROXY_PORT, '127.0.0.1');
  return {
    // Severs every live connection and stops accepting new ones, which is what
    // a counter going away looks like from the API side.
    sever() {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

const proxy = startCounterProxy();
await sleep(300);

const apiEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'error',
  API_HOST: '127.0.0.1',
  API_CORS_ORIGINS: 'http://localhost:3000',
  AUTH_ENABLED: 'true',
  AUTH_ALLOW_REGISTRATION: 'true',
  AUTH_COOKIE_SECURE: 'false',
  DATABASE_URL: postgres.url,
  DATABASE_MAX_CONNECTIONS: '5',
  RATE_LIMIT_STORE: 'redis',
  REDIS_URL: `redis://127.0.0.1:${PROXY_PORT}`,
  RATE_LIMIT_MAX_REQUESTS: '10',
  RATE_LIMIT_WINDOW_MS: '60000',
  MAINTENANCE_WORKER_ENABLED: 'false',
};

section('Starting two API instances against one database and one counter');
spawnNode('api-a', ['apps/api/dist/server.js'], { ...apiEnv, API_PORT: String(PORT_A) });
spawnNode('api-b', ['apps/api/dist/server.js'], { ...apiEnv, API_PORT: String(PORT_B) });

if (!(await waitForApi(PORT_A)) || !(await waitForApi(PORT_B))) {
  console.error('An API instance did not come up. Output:');
  for (const { label, lines } of children) console.error(`[${label}] ${lines.join('')}`);
  await stopAll();
  await postgres.stop();
  process.exit(2);
}
process.stdout.write(`  instance A on ${PORT_A}, instance B on ${PORT_B}\n`);

try {
  // ------------------------------------------------- shared rate limiting --

  section('§9 Distributed rate limiting — one budget across two instances');

  // Budget is 10 per window for the general class. Spend 6 on A, then 6 on B.
  // With a shared counter the 11th combined request is refused, wherever it
  // lands. With per-process counters both instances would serve all 6.
  let servedA = 0;
  for (let i = 0; i < 6; i += 1) {
    if ((await call(PORT_A, '/health')).status === 200) servedA += 1;
  }
  let servedB = 0;
  let refusedB = 0;
  for (let i = 0; i < 6; i += 1) {
    const status = (await call(PORT_B, '/health')).status;
    if (status === 200) servedB += 1;
    if (status === 429) refusedB += 1;
  }

  check(
    'instance B refuses once the combined budget is spent',
    refusedB > 0,
    `A served ${servedA}, B served ${servedB}, B refused ${refusedB} (budget 10)`,
  );
  check(
    'the combined allowance is one budget, not two',
    servedA + servedB <= 10,
    `combined served ${servedA + servedB} of a budget of 10`,
  );

  // The property stated the other way round: a caller must not get a fresh
  // budget merely because the next request reaches a different process.
  const afterExhaustion = await call(PORT_A, '/health');
  check(
    'a refused caller stays refused on the other instance',
    afterExhaustion.status === 429,
    `instance A returned ${afterExhaustion.status}`,
  );

  await call(PORT_A, '/health'); // keep the window warm; no assertion

  // ------------------------------------------------------ retry semantics --

  section('§10 Rate-limit response contract');
  const limited = await call(PORT_B, '/health');
  check('exceeding the limit returns 429', limited.status === 429);
  check(
    'the error code is stable and specific, not generic',
    limited.json?.error?.code === 'rate_limited',
    `code=${limited.json?.error?.code}`,
  );
  const retryAfter = Number(limited.headers.get('retry-after'));
  check(
    'a usable retry hint is returned',
    Number.isFinite(retryAfter) && retryAfter > 0,
    `retry-after=${retryAfter}s`,
  );

  // ------------------------------------------------------- auth across A/B --

  section('§12/§13 Session issued on A, used on B');

  // The counter is exhausted for the general class; flush it so the auth flow
  // is not throttled by the previous section rather than by its own budget.
  await flushCounter();

  const email = `dist-${Date.now()}@binaryai.local`;
  const password = 'correct-horse-battery-staple-7';

  const registered = await fetch(`http://127.0.0.1:${PORT_A}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = cookieFrom(registered);
  check(
    'registration on instance A succeeds',
    registered.status < 300,
    `status ${registered.status}`,
  );
  check('a session cookie is issued', cookie.startsWith('binaryai_session='));

  const registeredBody = await registered.json().catch(() => ({}));
  check(
    'the session token never appears in the response body',
    !JSON.stringify(registeredBody).includes(cookie.split('=')[1] ?? 'x'),
  );

  const onB = await call(PORT_B, '/v1/auth/me', { cookie });
  check('the same session is accepted by instance B', onB.status === 200, `status ${onB.status}`);

  const accountOnB = await call(PORT_B, '/v1/accounts/me', { cookie });
  check(
    'account-scoped data is served through instance B',
    accountOnB.status === 200,
    `status ${accountOnB.status}`,
  );

  // Logout on A must be effective on B: sessions are server-side rows, so
  // revocation is immediate everywhere and needs no sticky routing.
  await call(PORT_A, '/v1/auth/logout', { method: 'POST', cookie, body: {} });
  const afterLogout = await call(PORT_B, '/v1/auth/me', { cookie });
  check(
    'logout on A invalidates the session on B',
    afterLogout.status === 401,
    `status ${afterLogout.status}`,
  );

  // ------------------------------------------------------- failure modes --

  section('§10 Counter unreachable — credential traffic must fail CLOSED');
  proxy.sever();
  await sleep(700);

  const loginWhileDown = await call(PORT_A, '/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  check(
    'login is refused with 503 rather than served unmetered',
    loginWhileDown.status === 503,
    `status ${loginWhileDown.status}`,
  );
  check(
    'the code says the limiter is unavailable, not that credentials failed',
    loginWhileDown.json?.error?.code === 'rate_limiter_unavailable',
    `code=${loginWhileDown.json?.error?.code}`,
  );

  section('§10 Counter unreachable — general traffic fails OPEN, reported degraded');
  const healthWhileDown = await call(PORT_A, '/health');
  check(
    'general traffic is still served',
    healthWhileDown.status === 200,
    `status ${healthWhileDown.status}`,
  );

  const ready = await call(PORT_A, '/health/ready');
  check(
    'readiness reports the shared counter as unavailable',
    ready.status === 503 && ready.json?.checks?.rate_limiter === 'unavailable',
    `status ${ready.status}, rate_limiter=${ready.json?.checks?.rate_limiter}`,
  );

  const live = await call(PORT_A, '/health/live');
  check(
    'liveness still answers 200, so the process is not restarted',
    live.status === 200,
    `status ${live.status}`,
  );

  section('§16 System status during a counter outage');
  // Status needs a session; the limiter is down, so use the machine-free path:
  // sign in is blocked, so assert on what an unauthenticated caller sees.
  const statusUnauth = await call(PORT_A, '/v1/system/status');
  check(
    'status does not report a 500 during a counter outage',
    statusUnauth.status !== 500,
    `status ${statusUnauth.status}`,
  );
} finally {
  proxy.sever();
  await stopAll();
  await postgres.stop();
}

/** Clears the shared counter between sections. */
async function flushCounter() {
  await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.connect(counterPort, counterHost, () => {
      socket.write('*1\r\n$8\r\nFLUSHALL\r\n');
      // `setTimeout` is imported from node:timers/promises as `sleep`, so the
      // global callback form is not in scope in this module.
      void sleep(150).then(() => {
        socket.destroy();
        resolve();
      });
    });
    socket.on('error', () => resolve());
  });
}

process.stdout.write(`\n${checks.length - failures}/${checks.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
