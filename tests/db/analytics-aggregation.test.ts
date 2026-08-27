import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONFIDENCE_BUCKETS, bucketBounds } from '@binaryai/analytics';
import type { Repositories } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';
import {
  ALL,
  BASE,
  MINUTE,
  SYSTEM,
  seedSignal,
  setupFixtures,
  type Fixtures,
  type SeedOptions,
} from './analytics-fixtures.js';

let context: TestDatabase;
let repositories: Repositories;
let fixtures: Fixtures;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
  fixtures = await setupFixtures(context.database);
});

const seed = (options: SeedOptions = {}) => seedSignal(context.database, fixtures, options);

/**
 * Analytics aggregation, against a real PostgreSQL engine.
 *
 * Grouping, bucketing, time series and the invariants that must hold across
 * all of them. Companion to analytics-eligibility.test.ts, which covers which
 * rows are counted in the first place.
 */

describe('dimensions', () => {
  it('groups by strategy with its version', async () => {
    await seed({ result: 'win' });
    await seed({ result: 'loss' });

    const rows = await repositories.analytics.byDimension(SYSTEM, 'strategy');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('trend-momentum');
    expect(rows[0]?.version).toBe('1.0.0');
    expect(rows[0]?.wins).toBe(1);
    expect(rows[0]?.losses).toBe(1);
  });

  it('groups by regime', async () => {
    await seed({ regime: 'trend_up', result: 'win' });
    await seed({ regime: 'range', result: 'loss' });

    const rows = await repositories.analytics.byDimension(SYSTEM, 'regime');
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey['trend_up']?.wins).toBe(1);
    expect(byKey['range']?.losses).toBe(1);
  });

  it('groups by timeframe and reports only timeframes with data', async () => {
    await seed({ timeframe: '1m', result: 'win' });
    await seed({ timeframe: '1h', result: 'win' });

    const rows = await repositories.analytics.byDimension(SYSTEM, 'timeframe');
    // No placeholder rows for 5m/15m/1d: those were never observed.
    expect(rows.map((row) => row.key).sort()).toEqual(['1h', '1m']);
  });

  it('groups by asset without inventing instruments', async () => {
    await seed({ asset: 'ETH-USD', result: 'win' });

    const rows = await repositories.analytics.byDimension(SYSTEM, 'asset');
    expect(rows.map((row) => row.key)).toEqual(['ETH-USD']);
  });

  it('groups by direction', async () => {
    await seed({ direction: 'call', result: 'win' });
    await seed({ direction: 'put', result: 'loss' });

    const rows = await repositories.analytics.byDimension(SYSTEM, 'direction');
    expect(rows.map((row) => row.key).sort()).toEqual(['call', 'put']);
  });

  it('rejects an unknown dimension instead of building a query', async () => {
    await expect(
      repositories.analytics.byDimension(SYSTEM, 'asset_symbol; DROP TABLE signals' as never),
    ).rejects.toThrow(/Unsupported analytics dimension/);
  });
});

describe('confidence buckets', () => {
  const boundaries = CONFIDENCE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    ...bucketBounds(bucket),
  }));

  it('assigns samples to the right bands', async () => {
    await seed({ confidence: 0.1, result: 'win' });
    await seed({ confidence: 0.35, result: 'loss' });
    await seed({ confidence: 0.95, result: 'win' });

    const rows = await repositories.analytics.byConfidenceBucket(SYSTEM, boundaries);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey['0.00-0.19']?.wins).toBe(1);
    expect(byKey['0.20-0.39']?.losses).toBe(1);
    expect(byKey['0.80-1.00']?.wins).toBe(1);
  });

  it('places a boundary value in the higher band', async () => {
    await seed({ confidence: 0.2, result: 'win' });

    const rows = await repositories.analytics.byConfidenceBucket(SYSTEM, boundaries);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    // Must agree with assignBucket() in the analytics package, or a sample
    // would be counted in a different band than the one it is displayed under.
    expect(byKey['0.20-0.39']?.wins).toBe(1);
    expect(byKey['0.00-0.19']).toBeUndefined();
  });

  it('includes 1.0 in the top band', async () => {
    await seed({ confidence: 1, result: 'win' });
    const rows = await repositories.analytics.byConfidenceBucket(SYSTEM, boundaries);
    expect(rows.find((row) => row.key === '0.80-1.00')?.wins).toBe(1);
  });

  it('sums confidence only over decided outcomes', async () => {
    await seed({ confidence: 0.7, result: 'win' });
    await seed({ confidence: 0.7, result: 'unresolved' });

    const rows = await repositories.analytics.byConfidenceBucket(SYSTEM, boundaries);
    const bucket = rows.find((row) => row.key === '0.60-0.79');

    // The unresolved sample must not drag the mean, because it contributed no
    // verdict.
    expect(bucket?.confidenceCount).toBe(1);
    expect(Number(bucket?.confidenceSum)).toBeCloseTo(0.7, 5);
  });
});

describe('time series', () => {
  it('buckets by day', async () => {
    await seed({ decidedAt: BASE, settledAt: BASE + MINUTE, result: 'win' });
    await seed({ decidedAt: BASE, settledAt: BASE + MINUTE, result: 'loss' });
    await seed({
      decidedAt: BASE + 86_400_000,
      settledAt: BASE + 86_400_000 + MINUTE,
      result: 'win',
    });

    const rows = await repositories.analytics.byPeriod(SYSTEM, 'day');
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(3);
  });

  it('produces no bucket for a period with no observations', async () => {
    await seed({ decidedAt: BASE, settledAt: BASE + MINUTE, result: 'win' });
    await seed({
      decidedAt: BASE + 3 * 86_400_000,
      settledAt: BASE + 3 * 86_400_000 + MINUTE,
      result: 'win',
    });

    // Two days of data three days apart: two buckets, not four.
    const rows = await repositories.analytics.byPeriod(SYSTEM, 'day');
    expect(rows).toHaveLength(2);
  });

  it('returns keys parseable as epoch milliseconds', async () => {
    await seed({ result: 'win' });
    const rows = await repositories.analytics.byPeriod(SYSTEM, 'day');
    expect(Number.isFinite(Number(rows[0]?.key))).toBe(true);
  });

  it('rejects an unknown interval', async () => {
    await expect(
      repositories.analytics.byPeriod(SYSTEM, "day'); DROP TABLE signals--" as never),
    ).rejects.toThrow(/Unsupported analytics interval/);
  });
});

describe('range and provenance', () => {
  it('reports the settled window over eligible samples only', async () => {
    await seed({ decidedAt: BASE, settledAt: BASE + MINUTE, result: 'win' });
    await seed({
      decidedAt: BASE + 10 * MINUTE,
      settledAt: BASE + 11 * MINUTE,
      result: 'win',
    });
    // Excluded, so it must not widen the reported window.
    await seed({
      decidedAt: BASE + 100 * MINUTE,
      settledAt: BASE + 101 * MINUTE,
      status: 'rejected',
      result: 'win',
    });

    const range = await repositories.analytics.settledRange(SYSTEM);
    expect(range.first).toBe(BASE + MINUTE);
    expect(range.last).toBe(BASE + 11 * MINUTE);
  });

  it('reports nulls when nothing has settled', async () => {
    expect(await repositories.analytics.settledRange(SYSTEM)).toEqual({ first: null, last: null });
  });

  it('reports the data origins actually behind the samples', async () => {
    await seed({ dataSource: 'live_provider', result: 'win' });
    expect(await repositories.analytics.dataOrigins(SYSTEM)).toEqual(['live_provider']);
  });

  it('filters by date range', async () => {
    await seed({ decidedAt: BASE, settledAt: BASE + MINUTE, result: 'win' });
    await seed({
      decidedAt: BASE + 10 * 86_400_000,
      settledAt: BASE + 10 * 86_400_000 + MINUTE,
      result: 'win',
    });

    const recent = await repositories.analytics.totals(SYSTEM, { from: BASE + 86_400_000 });
    expect(recent.wins).toBe(1);
  });

  it('filters by asset, timeframe, strategy, regime and direction', async () => {
    await seed({ result: 'win', asset: 'BTC-USD', timeframe: '5m', regime: 'trend_up' });
    await seed({ result: 'win', asset: 'ETH-USD', timeframe: '1h', regime: 'range' });

    expect((await repositories.analytics.totals(SYSTEM, { assetSymbol: 'BTC-USD' })).wins).toBe(1);
    expect((await repositories.analytics.totals(SYSTEM, { timeframe: '1h' })).wins).toBe(1);
    expect((await repositories.analytics.totals(SYSTEM, { regime: 'range' })).wins).toBe(1);
    expect((await repositories.analytics.totals(SYSTEM, { direction: 'call' })).wins).toBe(2);
    expect(
      (await repositories.analytics.totals(SYSTEM, { strategyKey: 'trend-momentum' })).wins,
    ).toBe(2);
  });

  it('treats a filter value as data, never as SQL', async () => {
    await seed({ result: 'win' });

    // Parameterized throughout: this is a symbol that matches nothing, not a
    // statement that runs.
    const totals = await repositories.analytics.totals(SYSTEM, {
      assetSymbol: "BTC-USD' OR '1'='1",
    });
    expect(totals.total).toBe(0);

    const stillThere = await context.database.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM signals',
    );
    expect(Number(stillThere.rows[0]?.count)).toBe(1);
  });
});

describe('invariants', () => {
  it('wins + losses never exceeds the eligible settled total', async () => {
    for (const result of ['win', 'loss', 'tie', 'unresolved'] as const) {
      await seed({ result });
    }
    await seed({ status: 'rejected', result: 'win' });

    const totals = await repositories.analytics.totals(SYSTEM);
    const classified =
      totals.wins +
      totals.losses +
      totals.ties +
      totals.unresolved +
      totals.invalid +
      totals.skipped;

    expect(classified).toBeLessThanOrEqual(totals.total);
    expect(totals.wins + totals.losses).toBe(2);
  });

  it('never reports a negative count', async () => {
    const totals = await repositories.analytics.totals(SYSTEM);
    for (const value of Object.values(totals)) {
      if (typeof value === 'number') expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps backtest runs out of live measurement entirely', async () => {
    await context.database.query(
      `INSERT INTO backtest_runs (run_key, strategy_key, strategy_version, dataset_label,
                                  dataset_source, asset_symbol, timeframe, candle_count,
                                  config, started_at, finished_at)
       VALUES ('bt_1', 'trend-momentum', '1.0.0', 'fixture', 'synthetic', 'BTC-USD', '5m',
               500, '{}'::jsonb, now(), now())`,
    );

    // Backtests live in their own tables and never write to `signals`, so
    // structurally they cannot enter calibration. This asserts that holds.
    const totals = await repositories.analytics.totals(ALL);
    expect(totals.total).toBe(0);
  });
});
