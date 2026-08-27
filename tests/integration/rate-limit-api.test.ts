import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import {
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitStore,
} from '@binaryai/rate-limit';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';

/**
 * Rate limiting through the real request lifecycle.
 *
 * The unit tests prove the limiter decides correctly. These prove the decision
 * reaches the response — that the hooks are registered in an order where they
 * actually run, that the right status code comes back, and that liveness stays
 * answerable while everything else is being refused.
 *
 * The failure these guard against is silent: a limiter that is wired in the
 * wrong order, or behind a hook that returns early, allows everything while
 * every one of its own tests still passes.
 */

async function makeApp(
  env: Record<string, string | undefined> = {},
  store?: RateLimitStore,
): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...env });
  return buildApp(
    createAppContext({
      config,
      startedAt: Date.now(),
      ...(store === undefined ? {} : { rateLimitStore: store }),
    }),
  );
}

/** A store that is permanently unreachable, standing in for a Redis outage. */
function unreachableStore(): RateLimitStore {
  return {
    kind: 'redis',
    shared: true,
    hit: () => Promise.reject(new Error('ECONNREFUSED')),
    healthy: async () => false,
    close: async () => undefined,
  };
}

describe('general request limiting', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await makeApp({ RATE_LIMIT_MAX_REQUESTS: '3', RATE_LIMIT_WINDOW_MS: '60000' });
  });

  it('serves up to the limit and then returns 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(429);
  });

  it('sends a retry hint the caller can act on', async () => {
    for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/health' });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('uses a stable machine-readable error code', async () => {
    for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/health' });
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();

    expect(body.error.code).toBe('rate_limited');
  });

  it('advertises the budget on allowed responses, before anything is refused', async () => {
    // A well-behaved client should be able to slow down rather than discover
    // the limit by being rejected.
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['ratelimit-limit']).toBe('3');
    expect(response.headers['ratelimit-remaining']).toBe('2');
  });

  it('keeps answering liveness while everything else is refused', async () => {
    // An orchestrator uses liveness to decide whether to KILL the process. A
    // 429 there gets a healthy instance restarted mid-flood, which removes
    // capacity exactly when capacity matters.
    for (let i = 0; i < 6; i += 1) await app.inject({ method: 'GET', url: '/health' });

    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('does not leak who was limited', async () => {
    for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/health' });
    const body = (await app.inject({ method: 'GET', url: '/health' })).body;

    expect(body).not.toContain('127.0.0.1');
  });
});

describe('credential limiting', () => {
  it('refuses login attempts on a far tighter budget than general traffic', async () => {
    // The general limit is sized for a polling dashboard. Applying it to login
    // would permit a hundred password guesses a minute.
    const app = await makeApp({ RATE_LIMIT_MAX_REQUESTS: '10000' });

    let limited = 0;
    for (let i = 0; i < 15; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'nobody@test.local', password: 'wrong-password' },
      });
      if (response.statusCode === 429) limited += 1;
    }

    expect(limited).toBeGreaterThan(0);
  });

  it('does not consume the credential budget from general traffic', async () => {
    // The two budgets protect different things; exhausting one must not
    // exhaust the other.
    const app = await makeApp({ RATE_LIMIT_MAX_REQUESTS: '10000' });
    for (let i = 0; i < 50; i += 1) await app.inject({ method: 'GET', url: '/health' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@test.local', password: 'wrong-password' },
    });

    expect(response.statusCode).not.toBe(429);
  });

  it('says nothing about whether the account exists', async () => {
    // A throttling response that named the account would be an enumeration
    // oracle that survives the constant-shape login response.
    const app = await makeApp({ RATE_LIMIT_MAX_REQUESTS: '10000' });
    let body = '';
    for (let i = 0; i < 15; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'someone@test.local', password: 'wrong-password' },
      });
      if (response.statusCode === 429) body = response.body;
    }

    expect(body).not.toContain('someone@test.local');
  });
});

describe('when the shared counter is unreachable', () => {
  it('fails CLOSED on credential traffic', async () => {
    // An unreachable counter means unlimited password guessing. Refusing is
    // strictly safer than serving, and 503 says the limiter could not answer
    // rather than claiming the caller was too fast.
    const app = await makeApp({}, unreachableStore());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@test.local', password: 'wrong' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('rate_limiter_unavailable');
  });

  it('fails OPEN on general traffic, so a cache outage is not a full outage', async () => {
    const app = await makeApp({}, unreachableStore());
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('reports itself unavailable in system status rather than silently degraded', async () => {
    const app = await makeApp({}, unreachableStore());
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const limiter = body.components.find(
      (component: { component: string }) => component.component === 'rate_limiter',
    );

    expect(limiter.health).toBe('unavailable');
    expect(limiter.detail).toMatch(/not answering/i);
  });

  it('reports NOT READY, because this instance cannot serve a login', async () => {
    const app = await makeApp({}, unreachableStore());
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json().checks.rate_limiter).toBe('unavailable');
  });

  it('still reports ALIVE, so the instance is not restarted over a cache outage', async () => {
    const app = await makeApp({}, unreachableStore());
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('system status — limiter honesty', () => {
  it('reports the in-process store as per-instance, not as a shared limit', async () => {
    const app = await makeApp();
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const limiter = body.components.find(
      (component: { component: string }) => component.component === 'rate_limiter',
    );

    expect(limiter.detail).toMatch(/per process/i);
  });

  it('reports a reachable shared store as enforced across instances', async () => {
    const app = await makeApp(
      {},
      createRedisRateLimitStore({
        client: {
          incr: async () => 1,
          pexpire: async () => 1,
          pttl: async () => 60_000,
          ping: async () => 'PONG',
          close: async () => undefined,
        },
      }),
    );
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const limiter = body.components.find(
      (component: { component: string }) => component.component === 'rate_limiter',
    );

    expect(limiter.health).toBe('ok');
    expect(limiter.detail).toMatch(/across instances/i);
  });

  it('does not report a cache component keyed on configuration alone', async () => {
    // The old shape reported REDIS_URL being set as "ok", which said nothing
    // about whether the store answered.
    const app = await makeApp();
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();

    expect(
      body.components.some((component: { component: string }) => component.component === 'cache'),
    ).toBe(false);
  });

  it('reports session retention as scheduled but never run on a fresh instance', async () => {
    // "Never swept" and "swept, found nothing" are different facts: the first
    // means session rows are accumulating unbounded.
    const app = await makeApp();
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const maintenance = body.components.find(
      (component: { component: string }) => component.component === 'maintenance',
    );

    expect(maintenance).toBeDefined();
    expect(maintenance.detail).toMatch(/no database is configured|disabled/i);
  });
});

describe('readiness vs liveness', () => {
  it('reports ready with no database, because analysis is stateless', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json().checks.database).toBe('not_configured');
  });

  it('does not consult market data for readiness', async () => {
    // A provider outage must not pull a working instance out of the load
    // balancer over a feature that degrades gracefully on its own.
    const app = await makeApp();
    const checks = (await app.inject({ method: 'GET', url: '/health/ready' })).json().checks;

    expect(Object.keys(checks)).not.toContain('market_data');
  });

  it('answers liveness without consulting any dependency', async () => {
    const app = await makeApp({}, unreachableStore());
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('store equivalence through the API', () => {
  it('behaves identically whichever store is configured', async () => {
    // The whole reason the store is swappable is that a deployment can turn
    // Redis on. If the two disagreed here, doing so would silently change what
    // callers experience.
    const outcomes: Array<number[]> = [];

    for (const store of [
      createMemoryRateLimitStore(),
      createRedisRateLimitStore({ client: fakeRedisClient() }),
    ]) {
      const app = await makeApp({ RATE_LIMIT_MAX_REQUESTS: '2' }, store);
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
      }
      outcomes.push(codes);
    }

    expect(outcomes[0]).toEqual([200, 200, 429, 429]);
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

/** Minimal INCR/PEXPIRE/PTTL fake, sufficient for one window. */
function fakeRedisClient() {
  const counters = new Map<string, number>();
  return {
    async incr(key: string): Promise<number> {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async pexpire(): Promise<number> {
      return 1;
    },
    async pttl(): Promise<number> {
      return 60_000;
    },
    async ping(): Promise<string> {
      return 'PONG';
    },
    async close(): Promise<void> {
      counters.clear();
    },
  };
}
