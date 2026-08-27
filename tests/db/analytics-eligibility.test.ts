import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';
import {
  ALL,
  SYSTEM,
  accountScope,
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
 * Calibration eligibility, against a real PostgreSQL engine.
 *
 * Every test here describes one way a signal can fail to qualify as evidence,
 * and asserts that failing does not turn it into a loss.
 */

describe('eligibility', () => {
  it('counts an accepted, settled, directional signal', async () => {
    await seed({ result: 'win' });
    const totals = await repositories.analytics.totals(SYSTEM);

    expect(totals.wins).toBe(1);
    expect(totals.losses).toBe(0);
    expect(totals.total).toBe(1);
  });

  it('never turns a rejected signal into a loss', async () => {
    // The engine declined to act. Counting it as a loss would invent a
    // directional prediction that was never made, and understate accuracy.
    await seed({ status: 'rejected', result: 'loss' });
    const totals = await repositories.analytics.totals(SYSTEM);

    expect(totals.losses).toBe(0);
    expect(totals.wins).toBe(0);
    expect(totals.skipped).toBe(1);

    const exclusions = await repositories.analytics.exclusions(SYSTEM);
    expect(exclusions['not_accepted']).toBe(1);
  });

  it('never turns an unresolved outcome into a loss', async () => {
    // Expired with no settlement candle: pending, not failed.
    await seed({ result: 'unresolved' });
    const totals = await repositories.analytics.totals(SYSTEM);

    expect(totals.losses).toBe(0);
    expect(totals.unresolved).toBe(1);
  });

  it('excludes a signal that made no directional claim', async () => {
    await seed({ direction: 'none', result: 'win' });
    const exclusions = await repositories.analytics.exclusions(SYSTEM);

    expect(exclusions['no_direction']).toBe(1);
    expect((await repositories.analytics.totals(SYSTEM)).wins).toBe(0);
  });

  it('excludes synthetic data from live measurement', async () => {
    // Synthetic candles must never pool with live-market observations.
    await seed({ dataSource: 'synthetic', result: 'win' });
    const exclusions = await repositories.analytics.exclusions(SYSTEM);

    expect(exclusions['synthetic_data']).toBe(1);
    expect((await repositories.analytics.totals(SYSTEM)).wins).toBe(0);
  });

  it('excludes a sample whose strategy attribution is missing', async () => {
    await seed({ withStrategy: false, result: 'win' });
    const exclusions = await repositories.analytics.exclusions(SYSTEM);
    expect(exclusions['missing_strategy']).toBe(1);
  });

  it('excludes a settlement of unknown origin and marks it invalid', async () => {
    await seed({ settlementOrigin: null, result: 'win' });
    const totals = await repositories.analytics.totals(SYSTEM);

    expect(totals.invalid).toBe(1);
    expect(totals.wins).toBe(0);
  });

  it('reports exclusions rather than silently dropping them', async () => {
    await seed({ result: 'win' });
    await seed({ status: 'rejected', result: 'win' });
    await seed({ dataSource: 'synthetic', result: 'win' });

    const totals = await repositories.analytics.totals(SYSTEM);
    const exclusions = await repositories.analytics.exclusions(SYSTEM);

    // Every settled row is accounted for: 1 eligible + 2 excluded = 3 seen.
    expect(totals.total).toBe(3);
    expect(Object.values(exclusions).reduce((sum, n) => sum + (n ?? 0), 0)).toBe(2);
  });

  it('keeps a signal awaiting settlement out of the settled counts', async () => {
    await seed({ result: null });
    const totals = await repositories.analytics.totals(SYSTEM);

    // No outcome row at all: absent from the eligibility view entirely.
    expect(totals.total).toBe(0);
    expect(await repositories.analytics.pendingSettlement(SYSTEM)).toBe(1);
  });
});

describe('account scoping', () => {
  it('keeps one account out of another account’s aggregate', async () => {
    await seed({ accountId: fixtures.accountA, result: 'win' });
    await seed({ accountId: fixtures.accountA, result: 'win' });
    await seed({ accountId: fixtures.accountB, result: 'loss' });

    const forA = await repositories.analytics.totals(accountScope(fixtures.accountA));
    const forB = await repositories.analytics.totals(accountScope(fixtures.accountB));

    // The central privacy assertion: a count is a disclosure just as a row is.
    expect(forA.wins).toBe(2);
    expect(forA.losses).toBe(0);
    expect(forB.wins).toBe(0);
    expect(forB.losses).toBe(1);
  });

  it('includes the shared system stream for an account', async () => {
    await seed({ accountId: null, result: 'win' });
    await seed({ accountId: fixtures.accountA, result: 'win' });

    expect((await repositories.analytics.totals(accountScope(fixtures.accountA))).wins).toBe(2);
  });

  it('can exclude the system stream when asked', async () => {
    await seed({ accountId: null, result: 'win' });
    await seed({ accountId: fixtures.accountA, result: 'win' });

    expect((await repositories.analytics.totals(accountScope(fixtures.accountA, false))).wins).toBe(
      1,
    );
  });

  it('shows only unowned rows in the system scope', async () => {
    await seed({ accountId: null, result: 'win' });
    await seed({ accountId: fixtures.accountA, result: 'win' });
    await seed({ accountId: fixtures.accountB, result: 'win' });

    // An anonymous or service caller must not see private counts.
    expect((await repositories.analytics.totals(SYSTEM)).wins).toBe(1);
  });

  it('scopes every dimension, not just the totals', async () => {
    await seed({ accountId: fixtures.accountA, result: 'win', asset: 'ETH-USD' });
    await seed({ accountId: fixtures.accountB, result: 'win', asset: 'SOL-USD' });

    const assets = await repositories.analytics.byDimension(
      accountScope(fixtures.accountA),
      'asset',
    );
    expect(assets.map((row) => row.key)).toEqual(['ETH-USD']);
  });

  it('scopes exclusions, which would otherwise leak private sample counts', async () => {
    await seed({ accountId: fixtures.accountB, status: 'rejected', result: 'win' });

    expect(await repositories.analytics.exclusions(accountScope(fixtures.accountA))).toEqual({});
    expect(
      (await repositories.analytics.exclusions(accountScope(fixtures.accountB)))['not_accepted'],
    ).toBe(1);
  });

  it('scopes the pending-settlement count', async () => {
    await seed({ accountId: fixtures.accountB, result: null });
    expect(await repositories.analytics.pendingSettlement(accountScope(fixtures.accountA))).toBe(0);
    expect(await repositories.analytics.pendingSettlement(accountScope(fixtures.accountB))).toBe(1);
  });

  it('sees everything only under the explicit all-scope', async () => {
    await seed({ accountId: null, result: 'win' });
    await seed({ accountId: fixtures.accountA, result: 'win' });
    await seed({ accountId: fixtures.accountB, result: 'win' });

    expect((await repositories.analytics.totals(ALL)).wins).toBe(3);
  });
});
