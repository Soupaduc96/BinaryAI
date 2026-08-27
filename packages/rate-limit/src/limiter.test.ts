import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './limiter.js';
import { createMemoryRateLimitStore, type RateLimitStore } from './store.js';
import { createRedisRateLimitStore } from './redis-store.js';
import { createFakeRedis } from './fake-redis.js';

/**
 * Limiter behaviour, run against BOTH stores.
 *
 * Running the same suite twice is the point: the whole reason the store is an
 * interface is so a deployment can swap it, and a swap is only safe if the two
 * agree on the observable contract. Divergence here would mean turning Redis on
 * silently changes what callers experience.
 */

const tuning = { generalLimit: 3, generalWindowMs: 1_000 };
const anon = { kind: 'network', address: '203.0.113.4' } as const;

function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const stores: Array<[string, (now: () => number) => RateLimitStore]> = [
  ['memory', () => createMemoryRateLimitStore()],
  ['redis', (now) => createRedisRateLimitStore({ client: createFakeRedis(now) })],
];

describe.each(stores)('createRateLimiter (%s store)', (_name, makeStore) => {
  it('allows requests up to the limit and refuses the one after', async () => {
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });

    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.check('api_request', anon)).outcome).toBe('allowed');
    }
    expect((await limiter.check('api_request', anon)).outcome).toBe('limited');
  });

  it('counts down the remaining budget', async () => {
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });

    expect((await limiter.check('api_request', anon)).remaining).toBe(2);
    expect((await limiter.check('api_request', anon)).remaining).toBe(1);
    expect((await limiter.check('api_request', anon)).remaining).toBe(0);
  });

  it('opens a fresh window once the old one ends', async () => {
    // Without this the first burst would throttle an identity permanently.
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });

    for (let i = 0; i < 4; i += 1) await limiter.check('api_request', anon);
    time.advance(1_001);

    expect((await limiter.check('api_request', anon)).outcome).toBe('allowed');
  });

  it('keeps separate identities on separate budgets', async () => {
    // One noisy caller must not be able to lock everybody else out.
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });

    for (let i = 0; i < 4; i += 1) await limiter.check('api_request', anon);
    const other = await limiter.check('api_request', {
      kind: 'network',
      address: '198.51.100.9',
    });

    expect(other.outcome).toBe('allowed');
  });

  it('keeps separate classes on separate budgets', async () => {
    // Exhausting the general budget must not also exhaust the login budget,
    // and vice versa: they protect different things.
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });

    for (let i = 0; i < 4; i += 1) await limiter.check('api_request', anon);

    expect((await limiter.check('auth_attempt', anon)).outcome).toBe('allowed');
  });

  it('reports a retry hint of at least one second when limited', async () => {
    // Retry-After: 0 invites an immediate retry that is certain to be refused.
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });

    for (let i = 0; i < 3; i += 1) await limiter.check('api_request', anon);
    time.advance(999);
    const decision = await limiter.check('api_request', anon);

    expect(decision.outcome).toBe('limited');
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('reports no retry hint while allowed', async () => {
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });
    expect((await limiter.check('api_request', anon)).retryAfterSeconds).toBe(0);
  });

  it('is not degraded on the normal path', async () => {
    const time = clock();
    const limiter = createRateLimiter({ store: makeStore(time.now), tuning, now: time.now });
    expect((await limiter.check('api_request', anon)).degraded).toBe(false);
  });
});

describe('createRateLimiter — store failure', () => {
  function brokenStore(): RateLimitStore {
    return {
      kind: 'redis',
      shared: true,
      hit: () => Promise.reject(new Error('ECONNREFUSED')),
      healthy: async () => false,
      close: async () => undefined,
    };
  }

  it('refuses credential traffic when the counter is unreachable', async () => {
    // An unreachable counter means unlimited password guessing. Refusing is
    // strictly safer than serving.
    const decision = await createRateLimiter({ store: brokenStore(), tuning }).check(
      'auth_attempt',
      anon,
    );

    expect(decision.outcome).toBe('unavailable');
    expect(decision.degraded).toBe(true);
  });

  it('serves general traffic when the counter is unreachable, but marks it degraded', async () => {
    // The counter protects capacity here, not a secret. Refusing every read
    // during a cache outage would turn a degraded dependency into an outage.
    const decision = await createRateLimiter({ store: brokenStore(), tuning }).check(
      'api_request',
      anon,
    );

    expect(decision.outcome).toBe('allowed');
    expect(decision.degraded).toBe(true);
  });

  it('reports no reset time rather than inventing one', async () => {
    // A fabricated window would be trusted by the caller and by the dashboard.
    const decision = await createRateLimiter({ store: brokenStore(), tuning }).check(
      'auth_attempt',
      anon,
    );
    expect(decision.resetAt).toBeNull();
  });

  it('counts failures and remembers the last message', async () => {
    const limiter = createRateLimiter({ store: brokenStore(), tuning });
    await limiter.check('api_request', anon);
    await limiter.check('api_request', anon);

    const status = await limiter.status();
    expect(status.failures).toBe(2);
    expect(status.lastError).toContain('ECONNREFUSED');
    expect(status.available).toBe(false);
  });

  it('notifies the failure hook without exposing a key or identity', async () => {
    // This message reaches the log. A key carrying an account id would put
    // identity into logs on every outage.
    const onStoreFailure = vi.fn();
    await createRateLimiter({ store: brokenStore(), tuning, onStoreFailure }).check(
      'auth_attempt',
      { kind: 'account', accountId: 'acc-secret' },
    );

    expect(onStoreFailure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onStoreFailure.mock.calls[0])).not.toContain('acc-secret');
  });
});

describe('createRateLimiter — status', () => {
  it('reports the in-process store as NOT shared', async () => {
    // The whole point of the flag: with two instances the effective limit is
    // double what the operator configured, and the status must say so.
    const status = await createRateLimiter({
      store: createMemoryRateLimitStore(),
      tuning,
    }).status();

    expect(status).toMatchObject({ store: 'memory', shared: false, available: true });
  });

  it('reports a Redis store as shared', async () => {
    const status = await createRateLimiter({
      store: createRedisRateLimitStore({ client: createFakeRedis() }),
      tuning,
    }).status();

    expect(status).toMatchObject({ store: 'redis', shared: true, available: true });
  });

  it('reports unavailable when the store stops answering', async () => {
    const redis = createFakeRedis();
    const limiter = createRateLimiter({
      store: createRedisRateLimitStore({ client: redis }),
      tuning,
    });

    redis.breakWith('connection reset');
    expect((await limiter.status()).available).toBe(false);
  });
});
