import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecordNotFoundError } from '@binaryai/database';
import { runBacktest, DEFAULT_PAYOUT_MODEL } from '@binaryai/backtest';
import { defaultTestAsset, syntheticUptrend } from '@binaryai/fixtures';
import { trendMomentumStrategy } from '@binaryai/strategies';
import type { Repositories, Signal } from '@binaryai/types';
import {
  buildRealSignal,
  createTestDatabase,
  migrate,
  seedAsset,
  truncateAll,
  type TestDatabase,
} from './harness.js';

/**
 * Signal, outcome and backtest persistence.
 *
 * These run against a Signal produced by the real decision pipeline, not a
 * hand-written stub -- a stub would hide mapping bugs in precisely the nested
 * fields (confidence components, conflicts, data quality) that matter.
 */

let context: TestDatabase;
let repositories: Repositories;
let signal: Signal;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
  signal = buildRealSignal();
});

beforeEach(async () => {
  await truncateAll(context.database);
  await seedAsset(context.persistence, signal.asset);
});

afterAll(async () => {
  await context?.close();
});

describe('signal persistence', () => {
  it('stores a signal with every piece of its evidence', async () => {
    const ref = await repositories.signals.save(signal);

    expect(ref.id).toMatch(/^[0-9a-f-]{36}$/);
    const expectedFeatures =
      signal.indicators.length +
      signal.confirmations.length +
      signal.conflicts.length +
      signal.confidence.components.length;
    expect(ref.featureCount).toBe(expectedFeatures);
    expect(expectedFeatures).toBeGreaterThan(0);
  });

  it('replays the signal exactly as it was decided', async () => {
    await repositories.signals.save(signal);
    const persisted = await repositories.signals.findById(signal.id);

    expect(persisted).not.toBeNull();
    // The snapshot must reproduce the domain object field for field, including
    // nested confidence components and the data-quality report.
    expect(persisted?.signal).toStrictEqual(signal);
  });

  it('can be found by the engine id or the stored row id', async () => {
    const ref = await repositories.signals.save(signal);

    const byKey = await repositories.signals.findById(signal.id);
    const byRowId = await repositories.signals.findById(ref.id);
    expect(byKey?.signal.id).toBe(signal.id);
    expect(byRowId?.signal.id).toBe(signal.id);
  });

  it('projects evidence into queryable feature rows', async () => {
    await repositories.signals.save(signal);
    const persisted = await repositories.signals.findById(signal.id);
    const features = persisted?.features ?? [];

    const kinds = new Set(features.map((feature) => feature.kind));
    expect(kinds).toContain('indicator');
    expect(kinds).toContain('confidence_component');

    const indicators = features.filter((feature) => feature.kind === 'indicator');
    expect(indicators.length).toBe(signal.indicators.length);

    const component = features.find((feature) => feature.kind === 'confidence_component');
    expect(component?.weight).not.toBeNull();
    expect(component?.detail).toBeTruthy();
  });

  it('keeps the confidence calibration label with the score', async () => {
    await repositories.signals.save(signal);
    const stored = await context.database.query<{
      confidence: string;
      confidence_calibration: string;
    }>('SELECT confidence, confidence_calibration FROM signals LIMIT 1');
    expect(Number(stored.rows[0]?.confidence)).toBeCloseTo(signal.confidence.score, 5);
    expect(stored.rows[0]?.confidence_calibration).toBe('uncalibrated_heuristic');
  });

  it('records synthetic provenance rather than laundering it as live data', async () => {
    await repositories.signals.save(signal);
    const summaries = await repositories.signals.list();
    expect(summaries[0]?.dataSource).toBe('synthetic');
  });

  it('links a signal to its strategy row', async () => {
    const strategy = await repositories.strategies.register(
      trendMomentumStrategy.meta,
      trendMomentumStrategy.parameters,
    );
    await repositories.signals.save(signal, { strategyRowId: strategy.id });

    const byStrategy = await repositories.signals.list({ strategyKey: 'trend-momentum' });
    expect(byStrategy).toHaveLength(1);
  });

  it('filters and counts', async () => {
    await repositories.signals.save(signal);
    await repositories.signals.save({ ...signal, id: 'sig_second', direction: 'put' });

    expect(await repositories.signals.count()).toBe(2);
    expect(await repositories.signals.list({ direction: 'put' })).toHaveLength(1);
    expect(await repositories.signals.list({ assetSymbol: 'NOPE' })).toHaveLength(0);
    expect(await repositories.signals.count({ decidedAfter: signal.timestamp + 1 })).toBe(0);
  });

  it('rejects a duplicate engine id', async () => {
    await repositories.signals.save(signal);
    await expect(repositories.signals.save(signal)).rejects.toThrow();
  });

  it('returns null for an unknown id', async () => {
    expect(await repositories.signals.findById('sig_does_not_exist')).toBeNull();
  });

  it('rolls back the signal and its features together when the unit fails', async () => {
    await expect(
      repositories.transaction(async (tx) => {
        await tx.signals.save(signal);
        throw new Error('deliberate failure after the signal was written');
      }),
    ).rejects.toThrow(/deliberate failure/);

    expect(await repositories.signals.count()).toBe(0);
    const features = await context.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM signal_features',
    );
    expect(features.rows[0]?.count).toBe('0');
  });

  it('commits a multi-repository unit of work atomically', async () => {
    await repositories.transaction(async (tx) => {
      const strategy = await tx.strategies.register(
        trendMomentumStrategy.meta,
        trendMomentumStrategy.parameters,
      );
      await tx.signals.save(signal, { strategyRowId: strategy.id });
      await tx.systemEvents.record({
        level: 'info',
        category: 'signal',
        code: 'signal_persisted',
        message: 'stored',
        executionMode: 'demo',
        context: {},
      });
    });

    expect(await repositories.signals.count()).toBe(1);
    expect(await repositories.strategies.list()).toHaveLength(1);
    expect(await repositories.systemEvents.list()).toHaveLength(1);
  });
});

describe('signal outcomes', () => {
  it('records an outcome and links it to its signal', async () => {
    await repositories.signals.save(signal);
    const outcome = await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 0.5,
      result: 'win',
      payout: DEFAULT_PAYOUT_MODEL,
      metadata: { settledBy: 'test' },
    });

    expect(outcome.result).toBe('win');
    expect(outcome.payout?.winPayoutRate).toBe(0.8);
    expect(outcome.metadata['settledBy']).toBe('test');

    const persisted = await repositories.signals.findById(signal.id);
    expect(persisted?.outcome?.result).toBe('win');
  });

  it('derives the price delta from the stored signal, not from the caller', async () => {
    await repositories.signals.save(signal);
    const outcome = await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 1.25,
      result: 'win',
    });
    expect(outcome.priceDelta).toBeCloseTo(1.25, 6);
  });

  it('marks the signal as settled', async () => {
    await repositories.signals.save(signal);
    await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price - 0.5,
      result: 'loss',
    });

    const summaries = await repositories.signals.list();
    expect(summaries[0]?.status).toBe('settled');
    expect(summaries[0]?.hasOutcome).toBe(true);
  });

  it('refuses an outcome for a signal that does not exist', async () => {
    await expect(
      repositories.outcomes.record({
        signalId: 'sig_missing',
        settledAt: Date.now(),
        settlementPrice: 1,
        result: 'win',
      }),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it('refuses two outcomes for the same signal', async () => {
    await repositories.signals.save(signal);
    const outcome = {
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 1,
      result: 'win' as const,
    };
    await repositories.outcomes.record(outcome);
    await expect(repositories.outcomes.record(outcome)).rejects.toThrow();
  });

  it('counts settled outcomes -- the gate on any future calibration', async () => {
    expect(await repositories.outcomes.countSettled()).toBe(0);
    await repositories.signals.save(signal);
    await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 1,
      result: 'win',
    });
    expect(await repositories.outcomes.countSettled()).toBe(1);
  });
});

describe('calibration read model', () => {
  it('exposes everything a future calibration model would need', async () => {
    const strategy = await repositories.strategies.register(
      trendMomentumStrategy.meta,
      trendMomentumStrategy.parameters,
    );
    await repositories.signals.save(signal, { strategyRowId: strategy.id });
    await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 0.75,
      result: 'win',
      payout: DEFAULT_PAYOUT_MODEL,
      metadata: { settledBy: 'test-harness' },
    });

    const samples = await repositories.outcomes.listCalibrationSamples();
    expect(samples).toHaveLength(1);

    const sample = samples[0];
    expect(sample?.assetSymbol).toBe(signal.asset);
    expect(sample?.direction).toBe(signal.direction);
    expect(sample?.entryPrice).toBeCloseTo(signal.price, 6);
    expect(sample?.expiryPrice).toBeCloseTo(signal.price + 0.75, 6);
    expect(sample?.result).toBe('win');
    expect(sample?.entryAt).toBe(signal.timestamp);
    expect(sample?.expiresAt).toBe(signal.expiration.expiresAt);
    expect(sample?.strategyKey).toBe('trend-momentum');
    expect(sample?.strategyVersion).toBe('1.0.0');
    expect(sample?.confidenceAtSignal).toBeCloseTo(signal.confidence.score, 5);
    expect(sample?.payoutAssumption?.winPayoutRate).toBe(0.8);
    expect(sample?.marketRegime).toBe(signal.marketRegime);
    expect(sample?.riskLevel).toBe(signal.riskLevel);
    expect(sample?.resultMetadata['settledBy']).toBe('test-harness');
  });

  it('carries the market conditions recorded at decision time', async () => {
    await repositories.signals.save(signal);
    await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 0.1,
      result: 'win',
    });

    const [sample] = await repositories.outcomes.listCalibrationSamples();
    const conditions = sample?.marketConditions ?? {};
    expect(Object.keys(conditions).length).toBeGreaterThan(0);
    // Indicator readings, not confirmations: only numeric evidence belongs here.
    expect(typeof Object.values(conditions)[0]).toBe('number');
  });

  it('keeps synthetic samples distinguishable from live ones', async () => {
    await repositories.signals.save(signal);
    await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 0.1,
      result: 'win',
    });

    const [sample] = await repositories.outcomes.listCalibrationSamples();
    // Pooling synthetic samples with market samples would silently corrupt any
    // calibration fitted on them, so provenance is part of the read model.
    expect(sample?.dataSource).toBe('synthetic');
  });

  it('still reports the stored calibration status as uncalibrated', async () => {
    await repositories.signals.save(signal);
    await repositories.outcomes.record({
      signalId: signal.id,
      settledAt: signal.expiration.expiresAt,
      settlementPrice: signal.price + 0.1,
      result: 'win',
    });

    const [sample] = await repositories.outcomes.listCalibrationSamples();
    expect(sample?.confidenceCalibration).toBe('uncalibrated_heuristic');
  });
});

describe('backtest persistence', () => {
  const result = runBacktest({
    asset: defaultTestAsset,
    series: syntheticUptrend(300),
    strategy: trendMomentumStrategy,
    config: {
      strategyId: 'trend-momentum',
      parameters: {},
      expirationSeconds: 180,
      payout: DEFAULT_PAYOUT_MODEL,
      stake: { kind: 'fixed', value: 10 },
      startingBalance: 1000,
      warmupBars: 60,
      minConfidence: 0.55,
    },
    now: () => 1_767_225_600_000,
  });

  it('stores a run with its metrics and trades', async () => {
    const ref = await repositories.backtests.save(result);
    expect(ref.runKey).toBe(result.runId);

    const stored = await repositories.backtests.findById(result.runId);
    expect(stored?.resultType).toBe('historical_simulation');
    expect(stored?.metrics.trades).toBe(result.metrics.trades);
    expect(stored?.trades.length).toBe(result.trades.length);
    expect(stored?.disclaimer).toMatch(/not real trading performance/i);
  });

  it('keeps the dataset labelled synthetic', async () => {
    await repositories.backtests.save(result);
    const [summary] = await repositories.backtests.list();
    expect(summary?.datasetSource).toBe('synthetic');
    expect(summary?.datasetLabel).toMatch(/NOT MARKET DATA/);
    expect(summary?.resultType).toBe('historical_simulation');
  });

  it('recognises a re-run of the same deterministic run as the same run', async () => {
    await repositories.backtests.save(result);
    await repositories.backtests.save(result);
    expect(await repositories.backtests.list()).toHaveLength(1);
  });

  it('preserves a null win rate rather than turning it into zero', async () => {
    const empty = {
      ...result,
      runId: 'bt_empty',
      trades: [],
      metrics: {
        ...result.metrics,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        profitFactor: null,
      },
    };
    await repositories.backtests.save(empty);

    const [summary] = await repositories.backtests.list();
    expect(summary?.winRate).toBeNull();
  });
});
