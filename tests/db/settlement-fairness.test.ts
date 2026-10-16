import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assetFromInstrument, findInstrument } from '@binaryai/market-data';
import { runSettlementCycle, settlementCandleStart } from '@binaryai/runtime';
import type { Repositories, Signal } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';

/**
 * R17 — settlement must be FAIR ACROSS INSTRUMENTS.
 *
 * The scan used to be `ORDER BY expires_at ASC LIMIT n`, which is oldest-first
 * across every instrument at once. That is fair only while one instrument
 * exists. A 1m instrument produces sixty signals an hour and a 1d instrument
 * produces one, so the busy instrument's backlog fills every batch and the
 * quiet one waits behind it for as long as the backlog lasts — a starvation
 * that gets worse, not better, the further behind settlement falls.
 *
 * These tests use deliberately skewed data: instrument A with a large backlog,
 * B and C with two signals each, and a batch smaller than A's backlog alone.
 * Under the old query B and C could not appear at all.
 */

const MINUTE = 60_000;
let context: TestDatabase;
let repositories: Repositories;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
}, 60_000);

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
});

/** One expired, unsettled, directional signal on `asset`. */
async function seedExpired(asset: string, index: number, expiresAt: number): Promise<Signal> {
  const decidedAt = expiresAt - 3 * MINUTE;
  const signal: Signal = {
    id: `sig_${asset}_${index}`,
    createdAt: decidedAt,
    asset,
    timeframe: '1m',
    direction: index % 2 === 0 ? 'call' : 'put',
    timestamp: decidedAt,
    price: 100,
    expiration: { seconds: 180, expiresAt },
    confidence: {
      score: 0.8,
      components: [],
      calibration: 'uncalibrated_heuristic',
      sampleSize: null,
      disclaimer: 'test',
    },
    riskLevel: 'low',
    marketRegime: 'trend_up',
    strategy: { id: 'trend-momentum', version: '1.0.0', name: 'Trend Momentum' },
    indicators: [],
    confirmations: [],
    conflicts: [],
    reasoning: {
      summary: 'test',
      supporting: [],
      opposing: [],
      caveats: [],
      generatedBy: 'rule_engine',
    },
    status: 'accepted',
    recommendation: 'consider',
    executionMode: 'demo',
    dataSource: 'historical_provider',
    dataQuality: {
      usable: true,
      score: 1,
      candleCount: 100,
      firstTimestamp: decidedAt,
      lastTimestamp: decidedAt,
      issues: [],
    },
  };
  await repositories.signals.save(signal);
  return signal;
}

describe('R17 — a busy instrument cannot starve a quiet one', () => {
  /**
   * The skew is the point. A is 40 signals deep and every one of them is OLDER
   * than anything on B or C, so under a global oldest-first ordering the first
   * 20-signal batch is 100% A.
   */
  async function seedSkewed(): Promise<void> {
    const base = Date.now() - 4 * 60 * MINUTE;
    for (let index = 0; index < 40; index += 1) {
      await seedExpired('BTCUSD', index, base + index * MINUTE);
    }
    // B and C arrive later, so age alone would always rank them last.
    const later = Date.now() - 30 * MINUTE;
    for (let index = 0; index < 2; index += 1) {
      await seedExpired('ETHUSD', index, later + index * MINUTE);
      await seedExpired('EURUSD', index, later + index * MINUTE);
    }
  }

  it('reaches every instrument in a batch smaller than the busy backlog', async () => {
    await seedSkewed();

    const batch = await repositories.signals.findExpiredUnsettled(Date.now(), 20);

    expect(batch).toHaveLength(20);
    const symbols = new Set(batch.map((signal) => signal.assetSymbol));
    // The assertion that fails on the old query: B and C are simply absent.
    expect(symbols).toEqual(new Set(['BTCUSD', 'ETHUSD', 'EURUSD']));
  });

  it('takes every quiet instrument BEFORE the busy one takes a second turn', async () => {
    await seedSkewed();

    const batch = await repositories.signals.findExpiredUnsettled(Date.now(), 20);
    const firstThree = batch.slice(0, 3).map((signal) => signal.assetSymbol);

    // Round-robin: rank 1 from each instrument, then rank 2 from each. The
    // busy instrument is not penalised — it simply does not go twice while
    // another instrument is still waiting for its first turn.
    expect(new Set(firstThree)).toEqual(new Set(['BTCUSD', 'ETHUSD', 'EURUSD']));
  });

  it('preserves oldest-first ordering WITHIN each instrument', async () => {
    await seedSkewed();

    const batch = await repositories.signals.findExpiredUnsettled(Date.now(), 20);
    const btc = batch.filter((signal) => signal.assetSymbol === 'BTCUSD');

    // Fairness ACROSS instruments must not reorder anything within one:
    // settling a newer signal before an older one on the same market would
    // change which candle each is settled against.
    const expiries = btc.map((signal) => signal.expiresAt);
    expect([...expiries].sort((a, b) => a - b)).toEqual(expiries);
  });

  it('fills the batch from the busy instrument when it is the only one pending', async () => {
    const base = Date.now() - 4 * 60 * MINUTE;
    for (let index = 0; index < 30; index += 1) {
      await seedExpired('BTCUSD', index, base + index * MINUTE);
    }

    const batch = await repositories.signals.findExpiredUnsettled(Date.now(), 20);

    // Interleaving costs nothing when there is nothing to interleave with. An
    // instrument with no pending signals contributes no rows and reserves no
    // capacity — a quota scheme would have wasted slots here.
    expect(batch).toHaveLength(20);
    expect(new Set(batch.map((signal) => signal.assetSymbol))).toEqual(new Set(['BTCUSD']));
  });

  it('drains the whole backlog when the batch is large enough', async () => {
    await seedSkewed();

    const batch = await repositories.signals.findExpiredUnsettled(Date.now(), 100);

    // 40 + 2 + 2. Fairness changes the ORDER work is done in, never how much
    // of it eventually gets done.
    expect(batch).toHaveLength(44);
  });
});

describe('R17 — the defect this replaced', () => {
  it('shows the old global oldest-first scan returning ONE instrument', async () => {
    const base = Date.now() - 4 * 60 * MINUTE;
    for (let index = 0; index < 40; index += 1) {
      await seedExpired('BTCUSD', index, base + index * MINUTE);
    }
    const later = Date.now() - 30 * MINUTE;
    for (let index = 0; index < 2; index += 1) {
      await seedExpired('ETHUSD', index, later + index * MINUTE);
      await seedExpired('EURUSD', index, later + index * MINUTE);
    }

    // The superseded query, run verbatim. Kept as executable evidence rather
    // than a comment: it proves the fairness tests above are testing something
    // real, and it will keep proving it after everyone here has forgotten why.
    const legacy = await context.database.query<{ asset_symbol: string }>(
      `SELECT s.asset_symbol
         FROM signals s
        WHERE s.expires_at <= $1
          AND s.direction <> 'none'
          AND NOT EXISTS (SELECT 1 FROM signal_outcomes o WHERE o.signal_id = s.id)
        ORDER BY s.expires_at ASC
        LIMIT 20`,
      [new Date()],
    );

    expect(new Set(legacy.rows.map((row) => row.asset_symbol))).toEqual(new Set(['BTCUSD']));
  });
});

describe('R17 — settlement CORRECTNESS across instruments', () => {
  /**
   * A candle on `asset` at `at`, so that instrument's signals can settle.
   *
   * The asset row comes first because `candles.asset_id` is a real foreign
   * key — a candle for an unknown instrument is refused by the database, not
   * merely discouraged. (Signals are looser: see the 11C-1 finding.)
   */
  async function seedCandle(asset: string, at: number, close: number): Promise<void> {
    const instrument = findInstrument(asset);
    if (!instrument) throw new Error(`test fixture uses an uncatalogued symbol: ${asset}`);
    await repositories.assets.upsert(assetFromInstrument(instrument));
    await repositories.candles.upsertSeries({
      asset,
      timeframe: '1m',
      source: 'historical_provider',
      candles: [
        { timestamp: at, open: close, high: close, low: close, close, volume: 1, complete: true },
      ],
    });
  }

  it('settles each instrument against ITS OWN candles, never a neighbour’s', async () => {
    const expiresAt = Math.floor((Date.now() - 5 * MINUTE) / MINUTE) * MINUTE;
    const settlementAt = settlementCandleStart(expiresAt, '1m');

    // Entry price is 100 for every signal. BTC settles UP, ETH settles DOWN.
    // If either instrument were settled against the other's candle, the
    // results would invert — which is the whole risk of a shared scan.
    // index 0 makes both signals a 'call' at entry price 100.
    await seedExpired('BTCUSD', 0, expiresAt);
    await seedExpired('ETHUSD', 0, expiresAt);
    await seedCandle('BTCUSD', settlementAt, 120);
    await seedCandle('ETHUSD', settlementAt, 80);

    const cycle = await runSettlementCycle({ repositories });
    expect(cycle.settled).toBe(2);

    const rows = await context.database.query<{ asset_symbol: string; result: string }>(
      `SELECT s.asset_symbol, o.result
         FROM signal_outcomes o JOIN signals s ON s.id = o.signal_id
        ORDER BY s.asset_symbol`,
    );
    // Two identical CALL signals, opposite outcomes — decided entirely by
    // which instrument's candle each was settled against.
    expect(rows.rows).toEqual([
      { asset_symbol: 'BTCUSD', result: 'win' },
      { asset_symbol: 'ETHUSD', result: 'loss' },
    ]);
  });

  it('settles nothing twice, even across repeated cycles', async () => {
    const expiresAt = Math.floor((Date.now() - 5 * MINUTE) / MINUTE) * MINUTE;
    const settlementAt = settlementCandleStart(expiresAt, '1m');
    for (const asset of ['BTCUSD', 'ETHUSD', 'EURUSD']) {
      await seedExpired(asset, 1, expiresAt);
      await seedCandle(asset, settlementAt, 110);
    }

    const first = await runSettlementCycle({ repositories });
    const second = await runSettlementCycle({ repositories });
    const third = await runSettlementCycle({ repositories });

    expect(first.settled).toBe(3);
    // Idempotent: the work is gone from the scan, not repeated.
    expect(second.settled).toBe(0);
    expect(third.settled).toBe(0);

    const duplicates = await context.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT signal_id FROM signal_outcomes GROUP BY signal_id HAVING count(*) > 1
       ) AS dupes`,
    );
    expect(Number(duplicates.rows[0]?.n)).toBe(0);
  });

  it('leaves a signal UNRESOLVED when its own instrument has no candle', async () => {
    const expiresAt = Math.floor((Date.now() - 5 * MINUTE) / MINUTE) * MINUTE;
    const settlementAt = settlementCandleStart(expiresAt, '1m');
    await seedExpired('BTCUSD', 1, expiresAt);
    await seedExpired('ETHUSD', 1, expiresAt);
    // Only BTCUSD gets a settlement candle.
    await seedCandle('BTCUSD', settlementAt, 120);

    const cycle = await runSettlementCycle({ repositories });

    // ETHUSD must NOT borrow BTCUSD's price to manufacture an outcome. An
    // unresolved signal is the honest state; a settled one would be invented.
    expect(cycle.settled).toBe(1);
    expect(cycle.unresolved).toBe(1);
    const settled = await context.database.query<{ asset_symbol: string }>(
      `SELECT s.asset_symbol FROM signal_outcomes o JOIN signals s ON s.id = o.signal_id`,
    );
    expect(settled.rows.map((r) => r.asset_symbol)).toEqual(['BTCUSD']);
  });
});
