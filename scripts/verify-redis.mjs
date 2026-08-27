#!/usr/bin/env node
/**
 * The rate-limit client, store and limiter against a REAL Redis server.
 *
 * Why this exists separately from the unit tests: those run against
 * `createFakeRedis`, and `scripts/verify-distributed.mjs` can run against a RESP
 * stand-in. Both were written by the same hand as the client they exercise, so
 * a shared misreading of the protocol would pass both. An independent server
 * implementation is the only thing that rules that out.
 *
 * Point it at any Redis:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm run verify:redis
 *
 * Exit codes: 0 verified, 1 a check failed, 2 no server was reachable.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import {
  createRedisClient,
  createRedisRateLimitStore,
  createRateLimiter,
} from '@binaryai/rate-limit';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const client = createRedisClient({ url });

// Reachability first, and reported as infrastructure rather than as a failing
// assertion: "no Redis here" is a different fact from "Redis behaved wrongly".
try {
  await client.ping();
} catch (error) {
  console.error(
    `Could not reach a Redis server at ${url.replace(/:[^:@]*@/, ':***@')}.
` +
      `${error instanceof Error ? error.message : String(error)}

` +
      'Reported as an infrastructure problem (exit 2), not a test failure.',
  );
  await client.close();
  process.exit(2);
}

console.log(`--- server: ${url.replace(/:[^:@]*@/, ':***@')}`);
console.log('--- protocol');
check('PING returns PONG', (await client.ping()) === 'PONG');

const key = `verify:${Date.now()}`;
check('INCR on a fresh key returns 1', (await client.incr(key)) === 1);
check('INCR increments', (await client.incr(key)) === 2);
check('PTTL on a key with no expiry returns -1', (await client.pttl(key)) === -1);
check('PEXPIRE returns 1 for an existing key', (await client.pexpire(key, 2000)) === 1);
const ttl = await client.pttl(key);
check('PTTL reports the remaining window', ttl > 0 && ttl <= 2000, `${ttl}ms`);
check('PTTL on a missing key returns -2', (await client.pttl(`${key}:absent`)) === -2);

console.log('--- pipelining (replies must match commands in order)');
const pipelined = await Promise.all([
  client.incr(`${key}:p1`),
  client.incr(`${key}:p2`),
  client.incr(`${key}:p3`),
]);
check(
  'three concurrent INCRs each return 1',
  JSON.stringify(pipelined) === '[1,1,1]',
  String(pipelined),
);

console.log('--- the store');
const store = createRedisRateLimitStore({ client, prefix: `binaryai:verify:${Date.now()}` });
const now = Date.now();
const first = await store.hit('k', 1500, now);
check('first hit opens a window', first.count === 1, `resetAt in ${first.resetAt - now}ms`);
const second = await store.hit('k', 1500, Date.now());
check('second hit increments', second.count === 2);
check(
  'the window does not slide forward on each hit',
  Math.abs(second.resetAt - first.resetAt) < 250,
);
check('store reports healthy', await store.healthy());

// Longer than the 1500ms window opened above, so the next hit must start a new
// one. This is the assertion that the expiry is Redis's, not the client's.
await sleep(1700);
const afterExpiry = await store.hit('k', 1500, Date.now());
check('the window genuinely expires in Redis', afterExpiry.count === 1);

console.log('--- the limiter, end to end');
const limiter = createRateLimiter({
  store: createRedisRateLimitStore({ client, prefix: `binaryai:lim:${Date.now()}` }),
  tuning: { generalLimit: 3, generalWindowMs: 60_000 },
});
const identity = { kind: 'network', address: '203.0.113.7' };
const outcomes = [];
for (let i = 0; i < 4; i += 1)
  outcomes.push((await limiter.check('api_request', identity)).outcome);
check(
  'allows up to the limit then refuses',
  JSON.stringify(outcomes) === '["allowed","allowed","allowed","limited"]',
  String(outcomes),
);
const status = await limiter.status();
check('reports the store as shared', status.shared === true && status.store === 'redis');
check('reports available', status.available === true);
check('recorded no store failures', status.failures === 0);

await client.close();
const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed against real Redis`);
process.exit(failed === 0 ? 0 : 1);
