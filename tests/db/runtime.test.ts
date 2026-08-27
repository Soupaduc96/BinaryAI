import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultTestAsset, syntheticUptrend } from '@binaryai/fixtures';
import {
  analysisSignalKey,
  countMissingIntervals,
  finalizedCandles,
  runAnalysisCycle,
  runSettlementCycle,
  settlementCandleStart,
} from '@binaryai/runtime';
import { trendMomentumStrategy } from '@binaryai/strategies';
import type { CandleSeries, Repositories, Signal } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';

/**
 * The continuous runtime against a real PostgreSQL engine.
 *
 * Candles come from the labelled synthetic generator: deterministic input is
 * what makes "the same candle must not produce two signals" a testable claim.
 * The database is real, because deduplication, atomicity and settlement races
 * are ultimately guaranteed by constraints, not by application code.
 */

const MINUTE = 60_000;
const SYMBOL = 'SYNTH';

let context: TestDatabase;
let repositories: Repositories;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

beforeEach(async () => {
  await truncateAll(context.database);
  await repositories.assets.upsert(defaultTestAsset);
});

afterAll(async () => {
  await context?.close();
});

/** Stores a clean, boundary-aligned 1m series ending at `lastCandleAt`. */
async function seedCandles(count: number, lastCandleAt: number): Promise<CandleSeries> {
  const generated = syntheticUptrend(count);
  const start = lastCandleAt - (count - 1) * MINUTE;
  const series: CandleSeries = {
    ...generated,
    asset: SYMBOL,
    timeframe: '1m',
    candles: generated.candles.map((candle, index) => ({
      ...candle,
      timestamp: start + index * MINUTE,
      complete: true,
    })),
  };
  await repositories.candles.upsertSeries(series);
  return series;
}

/** A closed 1m boundary comfortably in the past. */
function alignedPast(minutesAgo: number, from = Date.now()): number {
  return Math.floor((from - minutesAgo * MINUTE) / MINUTE) * MINUTE;
}

const deps = () => ({ repositories, strategy: trendMomentumStrategy, asset: defaultTestAsset });
const options = { symbol: SYMBOL, timeframe: '1m' as const };

describe('candle finalization', () => {
  it('excludes a bar whose close time has not arrived', () => {
    const now = alignedPast(0);
    const series: CandleSeries = {
      asset: SYMBOL,
      timeframe: '1m',
      source: 'live_provider',
      candles: [
        {
          timestamp: now - 2 * MINUTE,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: null,
          complete: true,
        },
        // Opened at `now`, closes at now+60s: still forming.
        { timestamp: now, open: 1, high: 1, low: 1, close: 1, volume: null, complete: true },
      ],
    };
    const finalized = finalizedCandles(series, now + 30_000);
    expect(finalized.candles).toHaveLength(1);
    expect(finalized.candles[0]?.timestamp).toBe(now - 2 * MINUTE);
  });

  it('counts missing intervals without filling them', () => {
    const base = alignedPast(10);
    const series: CandleSeries = {
      asset: SYMBOL,
      timeframe: '1m',
      source: 'live_provider',
      candles: [0, 1, 5].map((offset) => ({
        timestamp: base + offset * MINUTE,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: null,
        complete: true,
      })),
    };
    expect(countMissingIntervals(series)).toBe(3);
  });
});

describe('live analysis', () => {
  it('analyses the newest closed candle and persists the evaluation', async () => {
    const lastAt = alignedPast(2);
    await seedCandles(200, lastAt);

    const result = await runAnalysisCycle(deps(), options);

    expect(result.analyzed).toBe(true);
    expect(result.candleTimestamp).toBe(lastAt);
    expect(result.persistedId).toBeDefined();
    expect(await repositories.signals.count()).toBe(1);
  });

  it('routes through the risk engine, never straight from the strategy', async () => {
    await seedCandles(200, alignedPast(2));
    const result = await runAnalysisCycle(deps(), options);

    const stored = await repositories.signals.findById(result.signalKey!);
    const signal = stored!.signal;

    // Whatever the strategy proposed, the persisted status is the engine's
    // decision after risk -- an accepted signal must have passed every check.
    if (signal.status === 'accepted') {
      expect(signal.recommendation).not.toBe('skip');
    } else {
      expect(signal.recommendation).toBe('skip');
    }
    expect(signal.confidence.calibration).toBe('uncalibrated_heuristic');
  });

  it('does not analyse the same candle twice', async () => {
    await seedCandles(200, alignedPast(2));

    const first = await runAnalysisCycle(deps(), options);
    const second = await runAnalysisCycle(deps(), options);

    expect(first.analyzed).toBe(true);
    expect(second.analyzed).toBe(false);
    expect(second.skipped).toBe('already_analyzed');
    expect(await repositories.signals.count()).toBe(1);
  });

  it('produces a deterministic key for the same candle and strategy', () => {
    const input = {
      symbol: SYMBOL,
      timeframe: '1m' as const,
      candleTimestamp: 1_767_225_600_000,
      strategyId: 'trend-momentum',
      strategyVersion: '1.0.0',
    };
    expect(analysisSignalKey(input)).toBe(analysisSignalKey(input));
    expect(analysisSignalKey(input)).not.toBe(
      analysisSignalKey({ ...input, candleTimestamp: input.candleTimestamp + MINUTE }),
    );
    // A strategy version bump is a different analysis of the same bar.
    expect(analysisSignalKey(input)).not.toBe(
      analysisSignalKey({ ...input, strategyVersion: '2.0.0' }),
    );
  });

  it('blocks on insufficient history', async () => {
    await seedCandles(10, alignedPast(2));
    const result = await runAnalysisCycle(deps(), options);

    expect(result.analyzed).toBe(false);
    expect(result.skipped).toBe('insufficient_history');
    expect(await repositories.signals.count()).toBe(0);
  });

  it('blocks on a data gap rather than analysing across a hole', async () => {
    const lastAt = alignedPast(2);
    const series = await seedCandles(200, lastAt);
    // Remove a bar from the middle of the window.
    const victim = series.candles[150]!.timestamp;
    await context.database.query(`DELETE FROM candles WHERE opened_at = $1 AND timeframe = '1m'`, [
      new Date(victim),
    ]);

    const result = await runAnalysisCycle(deps(), options);
    expect(result.analyzed).toBe(false);
    expect(result.skipped).toBe('data_gap');
    expect(await repositories.signals.count()).toBe(0);
  });

  it('waits when the newest candle is still forming', async () => {
    // Only a bar opened this minute: it has not closed.
    const now = alignedPast(0);
    await seedCandles(1, now);
    const result = await runAnalysisCycle(deps(), options);

    expect(result.analyzed).toBe(false);
    expect(['no_finalized_candle', 'insufficient_history']).toContain(result.skipped);
  });

  it('produces nothing when there are no candles at all', async () => {
    const result = await runAnalysisCycle(deps(), options);
    expect(result.analyzed).toBe(false);
    expect(result.skipped).toBe('no_candles');
  });

  it('refuses to analyse without persistence, rather than producing an unstorable signal', async () => {
    const result = await runAnalysisCycle(
      { repositories: null, strategy: trendMomentumStrategy, asset: defaultTestAsset },
      options,
    );
    expect(result.analyzed).toBe(false);
    expect(result.skipped).toBe('no_persistence');
  });

  it('persists the signal and its features atomically', async () => {
    await seedCandles(200, alignedPast(2));
    const result = await runAnalysisCycle(deps(), options);

    const features = await context.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM signal_features',
    );
    expect(Number(features.rows[0]?.count)).toBeGreaterThan(0);

    const stored = await repositories.signals.findById(result.signalKey!);
    expect(stored?.features.length).toBe(Number(features.rows[0]?.count));
  });

  it('records an audit event for the analysis', async () => {
    await seedCandles(200, alignedPast(2));
    await runAnalysisCycle(deps(), options);

    const events = await repositories.systemEvents.list({ category: 'analysis' });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('concurrency and recovery', () => {
  it('relies on the database as the final guard against a duplicate signal', async () => {
    await seedCandles(200, alignedPast(2));
    const first = await runAnalysisCycle(deps(), options);
    const stored = await repositories.signals.findById(first.signalKey!);

    // The application checks first, but the unique index on signals.signal_key
    // is what actually holds when two workers interleave.
    await expect(repositories.signals.save(stored!.signal)).rejects.toThrow();
    expect(await repositories.signals.count()).toBe(1);
  });

  it('survives a restart without re-analysing stored candles', async () => {
    await seedCandles(200, alignedPast(2));
    await runAnalysisCycle(deps(), options);

    // A "restart" is just a new cycle with no in-memory state: dedup must come
    // from the database, not from a cache.
    const afterRestart = await runAnalysisCycle(deps(), options);

    expect(afterRestart.skipped).toBe('already_analyzed');
    expect(await repositories.signals.count()).toBe(1);
  });
});

describe('settlement candle selection', () => {
  it('picks the last bar that closed at or before expiry', () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    // Expiry exactly on a boundary -> the bar ending exactly then.
    expect(settlementCandleStart(base, '1m')).toBe(base - MINUTE);
    // Expiry mid-bar -> the previous bar, which is the last one fully closed.
    expect(settlementCandleStart(base + 30_000, '1m')).toBe(base - MINUTE);
  });
});

describe('automatic settlement', () => {
  /** Stores a directional signal expiring at `expiresAt`. */
  async function seedSignal(
    direction: 'call' | 'put',
    entryPrice: number,
    decidedAt: number,
    expiresAt: number,
  ): Promise<Signal> {
    const signal: Signal = {
      id: `sig_${direction}_${decidedAt}`,
      createdAt: decidedAt,
      asset: SYMBOL,
      timeframe: '1m',
      direction,
      timestamp: decidedAt,
      price: entryPrice,
      expiration: { seconds: Math.round((expiresAt - decidedAt) / 1000), expiresAt },
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

  /** Writes one candle with an explicit close. */
  async function seedCandleAt(at: number, close: number): Promise<void> {
    await repositories.candles.upsertSeries({
      asset: SYMBOL,
      timeframe: '1m',
      source: 'historical_provider',
      candles: [
        {
          timestamp: at,
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1,
          complete: true,
        },
      ],
    });
  }

  it('settles a correct CALL as a win using the right candle', async () => {
    const expiresAt = alignedPast(5);
    const decidedAt = expiresAt - 3 * MINUTE;
    await seedSignal('call', 100, decidedAt, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 105);

    const cycle = await runSettlementCycle({ repositories });

    expect(cycle.scanned).toBe(1);
    expect(cycle.settled).toBe(1);
    expect(cycle.outcomes[0]?.result).toBe('win');
    expect(cycle.outcomes[0]?.settlementPrice).toBe(105);
  });

  it('settles an incorrect CALL as a loss', async () => {
    const expiresAt = alignedPast(5);
    await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 95);

    const cycle = await runSettlementCycle({ repositories });
    expect(cycle.outcomes[0]?.result).toBe('loss');
  });

  it('settles an unchanged price as a tie', async () => {
    const expiresAt = alignedPast(5);
    await seedSignal('put', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 100);

    const cycle = await runSettlementCycle({ repositories });
    expect(cycle.outcomes[0]?.result).toBe('tie');
  });

  it('leaves the outcome unresolved when the settlement candle is missing', async () => {
    const expiresAt = alignedPast(5);
    await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    // No candle stored for the settlement bar.

    const cycle = await runSettlementCycle({ repositories });

    expect(cycle.settled).toBe(0);
    expect(cycle.unresolved).toBe(1);
    expect(cycle.skipped[0]?.reason).toBe('candle_missing');
    // The signal stays pending so a later cycle can settle it once backfilled.
    expect((await repositories.signals.findExpiredUnsettled(Date.now())).length).toBe(1);
  });

  it('does not settle a signal whose expiry has not passed', async () => {
    const expiresAt = Date.now() + 10 * MINUTE;
    await seedSignal('call', 100, Date.now(), expiresAt);

    const cycle = await runSettlementCycle({ repositories });
    expect(cycle.scanned).toBe(0);
  });

  it('never settles a non-directional signal', async () => {
    const expiresAt = alignedPast(5);
    const signal = await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await context.database.query(`UPDATE signals SET direction = 'none' WHERE signal_key = $1`, [
      signal.id,
    ]);

    const cycle = await runSettlementCycle({ repositories });
    expect(cycle.scanned).toBe(0);
  });

  it('records no payout, because BinaryAI has no broker terms', async () => {
    const expiresAt = alignedPast(5);
    const signal = await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 110);
    await runSettlementCycle({ repositories });

    const outcome = await repositories.outcomes.findBySignalId(signal.id);
    expect(outcome?.payout).toBeNull();
    expect(outcome?.metadata['dataOrigin']).toBe('exchange');
    expect(String(outcome?.metadata['note'])).toMatch(/not a broker settlement/i);
  });

  it('is idempotent: a second cycle settles nothing again', async () => {
    const expiresAt = alignedPast(5);
    await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 105);

    const first = await runSettlementCycle({ repositories });
    const second = await runSettlementCycle({ repositories });

    expect(first.settled).toBe(1);
    expect(second.scanned).toBe(0);
  });

  it('relies on the outcome primary key against a duplicate settlement', async () => {
    const expiresAt = alignedPast(5);
    const signal = await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 105);
    await runSettlementCycle({ repositories });

    // signal_outcomes.signal_id is the primary key: a racing worker loses here.
    await expect(
      repositories.outcomes.record({
        signalId: signal.id,
        settledAt: Date.now(),
        settlementPrice: 105,
        result: 'win',
      }),
    ).rejects.toThrow();

    const outcomes = await context.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM signal_outcomes',
    );
    expect(outcomes.rows[0]?.count).toBe('1');
  });

  it('discovers expired signals after a restart', async () => {
    const expiresAt = alignedPast(5);
    await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 105);

    // No in-memory state carried over; the scan is a database query.
    const cycle = await runSettlementCycle({ repositories });
    expect(cycle.settled).toBe(1);
  });

  it('feeds the calibration read model while calibration stays disabled', async () => {
    const expiresAt = alignedPast(5);
    await seedSignal('call', 100, expiresAt - 3 * MINUTE, expiresAt);
    await seedCandleAt(settlementCandleStart(expiresAt, '1m'), 105);
    await runSettlementCycle({ repositories });

    const samples = await repositories.outcomes.listCalibrationSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.result).toBe('win');
    // Samples accumulating is not calibration.
    expect(samples[0]?.confidenceCalibration).toBe('uncalibrated_heuristic');
    expect(await repositories.outcomes.countSettled()).toBe(1);
  });

  it('does nothing without persistence', async () => {
    const cycle = await runSettlementCycle({ repositories: null });
    expect(cycle.scanned).toBe(0);
    expect(cycle.settled).toBe(0);
  });
});
