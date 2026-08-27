import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecordNotFoundError } from '@binaryai/database';
import { syntheticUptrend } from '@binaryai/fixtures';
import type { CandleSeries, Repositories } from '@binaryai/types';
import { trendMomentumStrategy } from '@binaryai/strategies';
import {
  createTestDatabase,
  migrate,
  seedAsset,
  truncateAll,
  type TestDatabase,
} from './harness.js';

let context: TestDatabase;
let repositories: Repositories;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

beforeEach(async () => {
  await truncateAll(context.database);
});

afterAll(async () => {
  await context?.close();
});

describe('asset repository', () => {
  it('creates and reads back an asset', async () => {
    const stored = await repositories.assets.upsert({
      symbol: 'EURUSD',
      displayName: 'Euro / US Dollar',
      assetClass: 'forex',
      pricePrecision: 5,
      isOtc: false,
    });

    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.symbol).toBe('EURUSD');
    expect(stored.assetClass).toBe('forex');
    expect(stored.isActive).toBe(true);

    const found = await repositories.assets.findBySymbol('EURUSD');
    expect(found).toEqual(stored);
  });

  it('updates on conflict rather than duplicating', async () => {
    const first = await repositories.assets.upsert({
      symbol: 'EURUSD',
      displayName: 'old name',
      assetClass: 'forex',
      pricePrecision: 5,
      isOtc: false,
    });
    const second = await repositories.assets.upsert({
      symbol: 'EURUSD',
      displayName: 'new name',
      assetClass: 'forex',
      pricePrecision: 4,
      isOtc: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('new name');
    expect(second.pricePrecision).toBe(4);
    expect(second.isOtc).toBe(true);
    expect(await repositories.assets.list()).toHaveLength(1);
  });

  it('returns null for an unknown symbol rather than throwing', async () => {
    expect(await repositories.assets.findBySymbol('NOPE')).toBeNull();
  });
});

describe('candle repository', () => {
  const series = (): CandleSeries => {
    const generated = syntheticUptrend(50);
    return { ...generated, asset: 'SYNTH' };
  };

  it('writes a series and reads it back in chronological order', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    const written = await repositories.candles.upsertSeries(series());
    expect(written).toBe(50);

    const stored = await repositories.candles.findRange({ assetSymbol: 'SYNTH', timeframe: '1m' });
    expect(stored?.candles).toHaveLength(50);

    const timestamps = stored?.candles.map((candle) => candle.timestamp) ?? [];
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it('preserves the declared source, so synthetic data stays labelled synthetic', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    await repositories.candles.upsertSeries(series());

    const stored = await repositories.candles.findRange({ assetSymbol: 'SYNTH', timeframe: '1m' });
    expect(stored?.source).toBe('synthetic');
  });

  it('round-trips prices without precision loss', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    const original = series();
    await repositories.candles.upsertSeries(original);

    const stored = await repositories.candles.findRange({ assetSymbol: 'SYNTH', timeframe: '1m' });
    const first = original.candles[0];
    const readBack = stored?.candles[0];
    expect(readBack?.timestamp).toBe(first?.timestamp);
    expect(readBack?.close).toBeCloseTo(first?.close ?? 0, 8);
  });

  it('is idempotent: re-delivering the same bars updates rather than duplicates', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    await repositories.candles.upsertSeries(series());
    await repositories.candles.upsertSeries(series());

    expect(await repositories.candles.count('SYNTH', '1m')).toBe(50);
  });

  it('filters by time range', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    const original = series();
    await repositories.candles.upsertSeries(original);

    const from = original.candles[10]?.timestamp ?? 0;
    const to = original.candles[19]?.timestamp ?? 0;
    const stored = await repositories.candles.findRange({
      assetSymbol: 'SYNTH',
      timeframe: '1m',
      from,
      to,
    });
    expect(stored?.candles).toHaveLength(10);
  });

  it('returns the most recent bars in ascending order', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    const original = series();
    await repositories.candles.upsertSeries(original);

    const latest = await repositories.candles.latest('SYNTH', '1m', 5);
    expect(latest?.candles).toHaveLength(5);
    expect(latest?.candles.at(-1)?.timestamp).toBe(original.candles.at(-1)?.timestamp);
    expect(latest?.candles[0]?.timestamp).toBeLessThan(latest?.candles.at(-1)?.timestamp ?? 0);
  });

  it('returns null when nothing is stored', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    expect(
      await repositories.candles.findRange({ assetSymbol: 'SYNTH', timeframe: '1m' }),
    ).toBeNull();
  });

  it('refuses to write candles for an unregistered asset', async () => {
    await expect(repositories.candles.upsertSeries(series())).rejects.toThrow(RecordNotFoundError);
  });

  it('writes a batch larger than one insert statement', async () => {
    await seedAsset(context.persistence, 'SYNTH');
    const large = { ...syntheticUptrend(1200), asset: 'SYNTH' };
    // 1200 bars x 10 columns exceeds PostgreSQL's 65535 parameter ceiling if
    // sent as one statement, so this exercises the batching path.
    expect(await repositories.candles.upsertSeries(large)).toBe(1200);
    expect(await repositories.candles.count('SYNTH', '1m')).toBe(1200);
  });
});

describe('strategy repository', () => {
  it('registers a strategy version with its parameter specs', async () => {
    const stored = await repositories.strategies.register(
      trendMomentumStrategy.meta,
      trendMomentumStrategy.parameters,
    );

    expect(stored.strategyKey).toBe('trend-momentum');
    expect(stored.version).toBe('1.0.0');
    expect(stored.parameters.length).toBe(trendMomentumStrategy.parameters.length);
    expect(stored.parameters[0]?.key).toBe('emaFastPeriod');
  });

  it('keeps the row id stable when the same version is re-registered', async () => {
    const first = await repositories.strategies.register(
      trendMomentumStrategy.meta,
      trendMomentumStrategy.parameters,
    );
    const second = await repositories.strategies.register(
      trendMomentumStrategy.meta,
      trendMomentumStrategy.parameters,
    );
    expect(second.id).toBe(first.id);
    expect(await repositories.strategies.list()).toHaveLength(1);
  });

  it('treats a different version as a different row, so old signals stay attributable', async () => {
    await repositories.strategies.register(
      trendMomentumStrategy.meta,
      trendMomentumStrategy.parameters,
    );
    await repositories.strategies.register(
      { ...trendMomentumStrategy.meta, version: '2.0.0' },
      trendMomentumStrategy.parameters,
    );

    expect(await repositories.strategies.list()).toHaveLength(2);
    expect(await repositories.strategies.find('trend-momentum', '1.0.0')).not.toBeNull();
    expect(await repositories.strategies.find('trend-momentum', '9.9.9')).toBeNull();
  });
});

describe('event repositories', () => {
  it('records and lists system events', async () => {
    await repositories.systemEvents.record({
      level: 'warning',
      category: 'market_data',
      code: 'provider_disconnected',
      message: 'Provider dropped the connection',
      executionMode: 'demo',
      context: { attempts: 3 },
    });

    const events = await repositories.systemEvents.list({ category: 'market_data' });
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('provider_disconnected');
    expect(events[0]?.context['attempts']).toBe(3);
    expect(events[0]?.at).toBeGreaterThan(0);
  });

  it('records and lists risk events', async () => {
    await repositories.riskEvents.record({
      code: 'consecutive_loss_limit',
      severity: 'warning',
      message: 'Halted after 3 consecutive losses',
      executionMode: 'demo',
      context: { consecutiveLosses: 3 },
    });

    const events = await repositories.riskEvents.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('consecutive_loss_limit');
    expect(events[0]?.executionMode).toBe('demo');
  });

  it('filters events by code and time', async () => {
    await repositories.systemEvents.record({
      level: 'info',
      category: 'api',
      code: 'startup',
      message: 'started',
      executionMode: 'demo',
      context: {},
      at: 1_000_000,
    });
    await repositories.systemEvents.record({
      level: 'info',
      category: 'api',
      code: 'shutdown',
      message: 'stopped',
      executionMode: 'demo',
      context: {},
      at: 2_000_000,
    });

    expect(await repositories.systemEvents.list({ code: 'startup' })).toHaveLength(1);
    expect(await repositories.systemEvents.list({ since: 1_500_000 })).toHaveLength(1);
  });
});
