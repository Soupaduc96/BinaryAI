import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Analytics access control through the real API.
 *
 * Answers one question repeatedly: can a caller reach numbers that are not
 * theirs? Companion to analytics-contract.test.ts, which covers what the
 * responses say.
 */

const PASSWORD = 'correct-horse-battery-staple-7';
const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const MINUTE = 60_000;

let context: TestDatabase;
let app: FastifyInstance;
let strategyId = '';

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    AUTH_ALLOW_REGISTRATION: 'true',
    AUTH_COOKIE_SECURE: 'false',
    ...overrides,
  });
}

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
  app = await buildApp(
    createAppContext({
      config: config(),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );
  const strategy = await context.database.query<{ id: string }>(
    `INSERT INTO strategies (strategy_key, version, name, description)
     VALUES ('trend-momentum', '1.0.0', 'Trend Momentum', 'test') RETURNING id`,
  );
  strategyId = strategy.rows[0]?.id ?? '';
});

/** Registers a user and returns their cookie plus default account id. */
async function signUp(email: string): Promise<{ cookie: string; accountId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies[0];
  return {
    cookie: cookie ? `${cookie.name}=${cookie.value}` : '',
    accountId: response.json().account.id,
  };
}

async function seed(options: {
  accountId?: string | null;
  result?: 'win' | 'loss' | 'tie' | 'unresolved';
  confidence?: number;
  status?: 'accepted' | 'rejected';
  asset?: string;
  regime?: string;
  timeframe?: string;
  decidedAt?: number;
}): Promise<void> {
  const decidedAt = options.decidedAt ?? BASE;
  const signal = await context.database.query<{ id: string }>(
    `INSERT INTO signals (
       account_id, asset_symbol, timeframe, strategy_id, direction, status,
       market_regime, confidence, price, decided_at, expires_at,
       expiration_seconds, data_source
     ) VALUES ($1, $2, $3, $4, 'call', $5::signal_status, $6::market_regime, $7, 100,
               to_timestamp($8::double precision / 1000),
               to_timestamp($9::double precision / 1000), 300, 'live_provider')
     RETURNING id`,
    [
      options.accountId ?? null,
      options.asset ?? 'BTC-USD',
      options.timeframe ?? '5m',
      strategyId,
      options.status ?? 'accepted',
      options.regime ?? 'trend_up',
      options.confidence ?? 0.7,
      decidedAt,
      decidedAt + 5 * MINUTE,
    ],
  );
  if (options.result) {
    await context.database.query(
      `INSERT INTO signal_outcomes (signal_id, settled_at, settlement_price, result, price_delta, metadata)
       VALUES ($1, to_timestamp($2::double precision / 1000), 101, $3::trade_outcome, 1,
               '{"dataOrigin":"exchange"}'::jsonb)`,
      [signal.rows[0]?.id, decidedAt + 6 * MINUTE, options.result],
    );
  }
}

/** Seeds `count` settled outcomes with a given win split. */
async function seedMany(
  count: number,
  wins: number,
  options: Parameters<typeof seed>[0] = {},
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seed({
      ...options,
      result: index < wins ? 'win' : 'loss',
      decidedAt: BASE + index * MINUTE,
    });
  }
}

const ANALYTICS_ROUTES = [
  '/v1/analytics/overview',
  '/v1/analytics/strategies',
  '/v1/analytics/regimes',
  '/v1/analytics/timeframes',
  '/v1/analytics/assets',
  '/v1/analytics/confidence',
  '/v1/analytics/calibration',
  '/v1/analytics/timeseries',
];

describe('account scoping', () => {
  it('never shows one account’s outcomes to another', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await seedMany(40, 40, { accountId: alice.accountId });

    const forAlice = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/overview',
        headers: { cookie: alice.cookie },
      })
    ).json();
    const forBob = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/overview',
        headers: { cookie: bob.cookie },
      })
    ).json();

    expect(forAlice.overview.counts.wins).toBe(40);
    // Bob must not learn that Alice has 40 outcomes, let alone that they won.
    expect(forBob.overview.counts.wins).toBe(0);
    expect(forBob.overview.observedAccuracy.value).toBeNull();
  });

  it('shows the shared system stream to every user', async () => {
    const alice = await signUp('alice@example.com');
    await seedMany(35, 20, { accountId: null });

    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/overview',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(body.overview.counts.wins).toBe(20);
  });

  it('does not leak private counts through a grouped breakdown', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await seedMany(40, 30, { accountId: alice.accountId, asset: 'ETH-USD' });

    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/assets',
        headers: { cookie: bob.cookie },
      })
    ).json();

    // Not even the existence of the instrument may surface.
    expect(body.groups).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('ETH-USD');
  });

  it('does not leak private counts through calibration', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await seedMany(40, 30, { accountId: alice.accountId });

    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/calibration',
        headers: { cookie: bob.cookie },
      })
    ).json();

    expect(body.calibration.eligibleSamples).toBe(0);
    expect(body.calibration.settledSamples).toBe(0);
  });

  it('does not leak private exclusion counts', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await seed({ accountId: alice.accountId, status: 'rejected', result: 'win' });

    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/calibration',
        headers: { cookie: bob.cookie },
      })
    ).json();
    expect(body.calibration.excludedSamples).toBe(0);
  });

  it('offers no parameter for requesting another account', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await seedMany(40, 40, { accountId: alice.accountId });

    // Scope comes from the session, never from the query string. Any attempt
    // to name an account is simply ignored by the schema.
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/analytics/overview?accountId=${alice.accountId}&account=${alice.accountId}`,
        headers: { cookie: bob.cookie },
      })
    ).json();
    expect(body.overview.counts.wins).toBe(0);
  });

  it('gives an anonymous caller the system stream only', async () => {
    const alice = await signUp('alice@example.com');
    await seedMany(35, 30, { accountId: alice.accountId });
    await seedMany(35, 10, { accountId: null });

    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();
    expect(body.overview.counts.wins).toBe(10);
  });

  it('reports the scope it used without revealing an account id', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/analytics/assets',
        headers: { cookie: alice.cookie },
      })
    ).json();

    expect(body.provenance.scope).toBe('account+system');
    expect(JSON.stringify(body)).not.toContain(alice.accountId);
  });
});

describe('authorization', () => {
  it('requires a credential on every analytics route when auth is enabled', async () => {
    const guarded = await buildApp(
      createAppContext({
        config: config({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
        persistence: context.persistence,
        marketDataProvider: null,
      }),
    );

    for (const url of ANALYTICS_ROUTES) {
      const response = await guarded.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} must require auth`).toBe(401);
    }
  });

  it('gives a machine token the system scope only', async () => {
    const guarded = await buildApp(
      createAppContext({
        config: config({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
        persistence: context.persistence,
        marketDataProvider: null,
      }),
    );
    const register = await guarded.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'alice@example.com', password: PASSWORD },
    });
    const accountId = register.json().account.id;
    await seedMany(40, 40, { accountId });

    const body = (
      await guarded.inject({
        method: 'GET',
        url: '/v1/analytics/overview',
        headers: { authorization: 'Bearer a-machine-token-value' },
      })
    ).json();

    // A shared token has no user behind it and must never resolve to one.
    expect(body.overview.counts.wins).toBe(0);
    expect(body.overview.provenance.scope).toBe('system');
  });
});

describe('input validation', () => {
  it('rejects a malformed timeframe rather than returning an empty result', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?timeframe=7y',
    });

    // An empty result would read as "no data for 7y", implying 7y is a thing.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_query');
  });

  it('rejects an unknown regime and an unknown direction', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/analytics/overview?regime=moon' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/analytics/overview?direction=sideways' }))
        .statusCode,
    ).toBe(400);
  });

  it('rejects an inverted date range', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/analytics/overview?from=${BASE}&to=${BASE - 1000}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_range');
  });

  it('refuses an unbounded historical scan', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/analytics/overview?from=0&to=${BASE}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/maximum of \d+ days/);
  });

  it('bounds the window by default', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();

    // The dashboard hits this on every load with no parameters; the default
    // must not be "scan everything".
    expect(body.overview.provenance.range.from).toBeGreaterThan(0);
    expect(body.overview.provenance.range.to).toBeGreaterThan(body.overview.provenance.range.from);
  });

  it('caps the group limit', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/analytics/assets?limit=100000' })).statusCode,
    ).toBe(400);
  });

  it('rejects a non-numeric timestamp', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/analytics/overview?from=yesterday' }))
        .statusCode,
    ).toBe(400);
  });

  it('treats an injection attempt as data, not as SQL', async () => {
    await seedMany(35, 20);
    const hostile = encodeURIComponent("BTC-USD'; DROP TABLE signals; --");

    const response = await app.inject({
      method: 'GET',
      url: `/v1/analytics/overview?asset=${hostile}`,
    });

    // Matches no asset, so zero counts -- and the table is still there.
    expect(response.statusCode).toBe(200);
    expect(response.json().overview.counts.total).toBe(0);

    const survived = await context.database.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM signals',
    );
    expect(Number(survived.rows[0]?.count)).toBe(35);
  });

  it('rejects an unknown interval on the time series', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/analytics/timeseries?interval=century' }))
        .statusCode,
    ).toBe(400);
  });
});
