import { describe, expect, it } from 'vitest';
import { createRedisRateLimitStore } from './redis-store.js';
import { createFakeRedis } from './fake-redis.js';
import type { RedisCommands } from './redis-store.js';

/**
 * The Redis store's own mechanics.
 *
 * These are the parts that are NOT covered by running the shared limiter suite
 * against it: how the window is opened, what happens to a key that lost its
 * expiry, and that two applications sharing one server do not share counters.
 *
 * None of this is evidence about a real Redis server — see the header of
 * redis-store.ts. It is evidence that the command sequence is the one intended.
 */

function fixture(start = 1_000) {
  let value = start;
  const now = () => value;
  const redis = createFakeRedis(now);
  return {
    redis,
    store: createRedisRateLimitStore({ client: redis }),
    now,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe('createRedisRateLimitStore', () => {
  it('opens a window on the first hit and expires it after windowMs', async () => {
    const { store, now, advance } = fixture();

    expect(await store.hit('k', 1_000, now())).toEqual({ count: 1, resetAt: 2_000 });
    expect((await store.hit('k', 1_000, now())).count).toBe(2);

    advance(1_001);
    expect((await store.hit('k', 1_000, now())).count).toBe(1);
  });

  it('reports the reset time from the live TTL, not from a fresh window', async () => {
    // Recomputing `now + windowMs` on every hit would slide the window forward
    // forever, so a steady stream of requests would never reset.
    const { store, now, advance } = fixture();

    await store.hit('k', 1_000, now());
    advance(400);
    expect((await store.hit('k', 1_000, now())).resetAt).toBe(2_000);
  });

  it('repairs a key that lost its expiry instead of throttling it forever', async () => {
    // If the process that opened the window dies between INCR and PEXPIRE, the
    // key persists with no TTL. Left alone, that identity is refused for good —
    // a self-inflicted denial of service.
    const { redis, store, now } = fixture();
    await redis.incr('binaryai:rl:orphan'); // INCR with no PEXPIRE

    const hit = await store.hit('orphan', 1_000, now());

    expect(hit.count).toBe(2);
    expect(hit.resetAt).toBe(2_000);
    expect(await redis.pttl('binaryai:rl:orphan')).toBeGreaterThan(0);
  });

  it('namespaces keys so two applications on one server do not share counters', async () => {
    const redis = createFakeRedis();
    const mine = createRedisRateLimitStore({ client: redis, prefix: 'app-a' });
    const theirs = createRedisRateLimitStore({ client: redis, prefix: 'app-b' });

    await mine.hit('same', 1_000, 0);
    expect((await theirs.hit('same', 1_000, 0)).count).toBe(1);
  });

  it('sets the expiry exactly once per window', async () => {
    // PEXPIRE on every hit would extend the window indefinitely under load.
    let expireCalls = 0;
    const inner = createFakeRedis();
    const counting: RedisCommands = {
      incr: (key) => inner.incr(key),
      pexpire: (key, ms) => {
        expireCalls += 1;
        return inner.pexpire(key, ms);
      },
      pttl: (key) => inner.pttl(key),
      ping: () => inner.ping(),
      close: () => inner.close(),
    };
    const store = createRedisRateLimitStore({ client: counting });

    for (let i = 0; i < 5; i += 1) await store.hit('k', 10_000, 0);

    expect(expireCalls).toBe(1);
  });

  it('propagates an outage rather than reporting a clean count', async () => {
    // A swallowed error would silently disable the limit.
    const { redis, store, now } = fixture();
    redis.breakWith('ECONNREFUSED');

    await expect(store.hit('k', 1_000, now())).rejects.toThrow('ECONNREFUSED');
  });

  it('reports itself unhealthy during an outage without throwing', async () => {
    // The status endpoint must be able to ask without risking a 500.
    const { redis, store } = fixture();
    redis.breakWith('ECONNREFUSED');

    await expect(store.healthy()).resolves.toBe(false);
  });

  it('declares itself shared', async () => {
    expect(fixture().store.shared).toBe(true);
  });

  it('closes the client', async () => {
    const { redis, store } = fixture();
    await store.close();
    expect(redis.closed).toBe(true);
  });
});

describe('createMemoryRateLimitStore vs Redis — the honest difference', () => {
  it('the in-process store declares that it is not shared', async () => {
    const { createMemoryRateLimitStore } = await import('./store.js');
    expect(createMemoryRateLimitStore().shared).toBe(false);
  });

  it('two in-process stores do not see each other, which is the whole problem', async () => {
    // This is not a bug to fix — it is the reason `shared` exists and the
    // reason production refuses this store unless asked for by name.
    const { createMemoryRateLimitStore } = await import('./store.js');
    const instanceA = createMemoryRateLimitStore();
    const instanceB = createMemoryRateLimitStore();

    await instanceA.hit('k', 1_000, 0);
    expect((await instanceB.hit('k', 1_000, 0)).count).toBe(1);
  });

  it('two Redis stores on one server DO see each other', async () => {
    const redis = createFakeRedis();
    const instanceA = createRedisRateLimitStore({ client: redis });
    const instanceB = createRedisRateLimitStore({ client: redis });

    await instanceA.hit('k', 1_000, 0);
    expect((await instanceB.hit('k', 1_000, 0)).count).toBe(2);
  });
});
