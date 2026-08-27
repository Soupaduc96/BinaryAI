import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Analytics response contract through the real API.
 *
 * Empty states, the minimum-sample policy, calibration status and terminology:
 * what the API says, and what it refuses to say.
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

describe('empty state', () => {
  it('reports null accuracy, never zero, with no outcomes', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();

    // The single most important assertion in this file.
    expect(body.overview.observedAccuracy.value).toBeNull();
    expect(body.overview.observedAccuracy.sampleSize).toBe(0);
    expect(body.overview.observedAccuracy.evidence).toBe('insufficient');
    expect(body.overview.meanConfidence).toBeNull();
  });

  it('returns no groups rather than placeholder rows', async () => {
    for (const url of ['/v1/analytics/strategies', '/v1/analytics/assets']) {
      const body = (await app.inject({ method: 'GET', url })).json();
      // No invented BTC-USD, no invented strategy.
      expect(body.groups).toEqual([]);
    }
  });

  it('returns no periods rather than a flat line at zero', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/timeseries' })).json();
    expect(body.periods).toEqual([]);
    expect(body.note).toMatch(/absent, not zero/i);
  });

  it('returns every confidence bucket, all empty', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/confidence' })).json();

    expect(body.buckets).toHaveLength(5);
    for (const bucket of body.buckets) {
      expect(bucket.observedAccuracy.value).toBeNull();
    }
    expect(body.relationship).toBe('not_established');
  });

  it('explains itself when no database is configured', async () => {
    const stateless = await buildApp(
      createAppContext({ config: config(), persistence: null, marketDataProvider: null }),
    );
    const response = await stateless.inject({ method: 'GET', url: '/v1/analytics/overview' });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toMatch(/no database/i);
  });
});

describe('minimum sample policy', () => {
  it('withholds a rate below the threshold but still reports the count', async () => {
    await seedMany(4, 3);
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();

    // 3 of 4 is 75%. Publishing that would be worse than saying nothing.
    expect(body.overview.observedAccuracy.value).toBeNull();
    expect(body.overview.observedAccuracy.sampleSize).toBe(4);
    expect(body.overview.counts.wins).toBe(3);
  });

  it('reports a rate at exactly the threshold', async () => {
    await seedMany(30, 18);
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();

    expect(body.overview.observedAccuracy.sufficient).toBe(true);
    expect(body.overview.observedAccuracy.value).toBeCloseTo(0.6, 6);
    expect(body.overview.observedAccuracy.evidence).toBe('preliminary');
  });

  it('one sample below the threshold still withholds', async () => {
    await seedMany(29, 20);
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();
    expect(body.overview.observedAccuracy.value).toBeNull();
  });

  it('publishes the threshold so a client can explain the empty state', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();
    expect(body.evidence.minimumSampleSize).toBe(30);
  });
});

describe('calibration status', () => {
  it('keeps implemented false with a large sample', async () => {
    await seedMany(120, 90);
    const body = (await app.inject({ method: 'GET', url: '/v1/calibration/status' })).json();

    // Accumulating samples is a prerequisite for a model, not evidence of one.
    expect(body.implemented).toBe(false);
    expect(body.eligibleSamples).toBe(120);
    expect(body.evidenceLevel).toBe('developing');
  });

  it('preserves every field the previous contract returned', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/calibration/status' })).json();

    expect(body.calibration).toBe('uncalibrated_heuristic');
    expect(body.implemented).toBe(false);
    expect(typeof body.settledOutcomes).toBe('number');
    expect(typeof body.persistenceConfigured).toBe('boolean');
    expect(typeof body.reason).toBe('string');
  });

  it('names the methodology and its versions', async () => {
    await seedMany(35, 20);
    const body = (await app.inject({ method: 'GET', url: '/v1/calibration/status' })).json();

    expect(body.method).toBe('bucketed_frequency');
    expect(body.methodology.confidenceSource).toBe('uncalibrated_heuristic');
    expect(body.methodology.bucketVersion).toBeTruthy();
  });

  it('scopes the sample count to the caller', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await seedMany(40, 30, { accountId: alice.accountId });

    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/calibration/status',
        headers: { cookie: bob.cookie },
      })
    ).json();

    // A status endpoint must not disclose how much data another account has.
    expect(body.eligibleSamples).toBe(0);
  });

  it('reports exclusions rather than hiding them', async () => {
    await seedMany(30, 20);
    await seed({ status: 'rejected', result: 'win' });

    const body = (await app.inject({ method: 'GET', url: '/v1/calibration/status' })).json();
    expect(body.excludedSamples).toBe(1);
    expect(body.exclusions.not_accepted).toBe(1);
  });
});

describe('terminology', () => {
  /**
   * Finds occurrences of a sensitive phrase that are NOT inside a denial.
   *
   * A plain substring search is not good enough here: "not a probability of
   * winning" is precisely the sentence these payloads should carry, while
   * "probability of winning: 0.72" is the one that must never ship. Only the
   * second is a claim, and only the second should fail.
   */
  function affirmativeUses(raw: string, phrase: string): string[] {
    const found: string[] = [];
    for (let index = raw.indexOf(phrase); index !== -1; index = raw.indexOf(phrase, index + 1)) {
      const preceding = raw.slice(Math.max(0, index - 30), index);
      // A negation anywhere in the same clause makes this a denial.
      if (!/(?:^|[^a-z])(not|never|no|nor|neither)(?![a-z])[^.;]*$/.test(preceding)) {
        found.push(raw.slice(Math.max(0, index - 50), index + phrase.length + 20));
      }
    }
    return found;
  }

  it('never presents confidence as a probability', async () => {
    await seedMany(40, 30);

    for (const url of ANALYTICS_ROUTES) {
      const raw = (await app.inject({ method: 'GET', url })).body.toLowerCase();
      for (const phrase of ['probability of winning', 'win probability', 'predicted probability']) {
        expect(affirmativeUses(raw, phrase).join(' ||| '), `${url} asserts "${phrase}"`).toBe('');
      }
    }
  });

  it('states the disclaimer rather than merely avoiding the word', async () => {
    // The inverse of the test above, and the reason it has to allow denials:
    // silence about semantics would pass a ban on the phrase while leaving a
    // reader free to assume the score is a probability.
    await seedMany(40, 30);
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/confidence' })).json();
    expect(body.semantics).toMatch(/not a probability/i);
  });

  it('uses no marketing or profit language', async () => {
    await seedMany(40, 30);

    // Phrases with no innocent reading: these cannot appear even in a denial,
    // because BinaryAI has no reason to raise them at all.
    const banned = /guaranteed|profitable strategy|risk-free|winning system|safe trade/;
    // Phrases that legitimately appear inside a disclaimer.
    const claimOnly = ['expected profit', 'expected return'];

    for (const url of [...ANALYTICS_ROUTES, '/v1/calibration/status']) {
      const raw = (await app.inject({ method: 'GET', url })).body.toLowerCase();
      expect(raw, `${url} must avoid performance claims`).not.toMatch(banned);
      for (const phrase of claimOnly) {
        expect(affirmativeUses(raw, phrase).join(' ||| '), `${url} asserts "${phrase}"`).toBe('');
      }
    }
  });

  it('states the settlement semantics on every analytics response', async () => {
    for (const url of ['/v1/analytics/overview', '/v1/analytics/assets']) {
      const body = (await app.inject({ method: 'GET', url })).json();
      const provenance = body.provenance ?? body.overview.provenance;
      expect(provenance.settlementSemantics).toMatch(/not profit figures/i);
    }
  });

  it('warns that grouped rows are ordered by evidence, not by accuracy', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/strategies' })).json();
    expect(body.ranking).toMatch(/not by accuracy/i);
  });
});

describe('aggregation through HTTP', () => {
  it('groups by strategy with a version and evidence level', async () => {
    await seedMany(40, 24);
    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/strategies' })).json();

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].key).toBe('trend-momentum');
    expect(body.groups[0].version).toBe('1.0.0');
    expect(body.groups[0].observedAccuracy.value).toBeCloseTo(0.6, 6);
    expect(body.groups[0].observedAccuracy.evidence).toBe('preliminary');
  });

  it('buckets confidence and reports the relationship honestly', async () => {
    await seedMany(40, 10, { confidence: 0.3 });
    await seedMany(40, 30, { confidence: 0.9, decidedAt: BASE + 1000 * MINUTE });

    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/confidence' })).json();
    const low = body.buckets.find((b: { id: string }) => b.id === '0.20-0.39');
    const high = body.buckets.find((b: { id: string }) => b.id === '0.80-1.00');

    expect(low.observedAccuracy.value).toBeCloseTo(0.25, 6);
    expect(high.observedAccuracy.value).toBeCloseTo(0.75, 6);
    expect(body.relationship).toBe('monotonic_increasing');
  });

  it('produces a time series with real gaps', async () => {
    await seedMany(20, 12, { decidedAt: BASE });
    await seedMany(20, 10, { decidedAt: BASE + 5 * 86_400_000 });

    const body = (
      await app.inject({ method: 'GET', url: '/v1/analytics/timeseries?interval=day' })
    ).json();

    // Two days with data, five days apart. Not seven periods.
    expect(body.periods.length).toBeLessThanOrEqual(3);
    expect(body.interval).toBe('day');
  });

  it('counts signals awaiting settlement separately from settled ones', async () => {
    await seedMany(30, 20);
    await seed({ result: undefined });

    const body = (await app.inject({ method: 'GET', url: '/v1/analytics/overview' })).json();
    expect(body.overview.pendingSettlement).toBe(1);
    expect(body.overview.observedAccuracy.sampleSize).toBe(30);
  });
});
