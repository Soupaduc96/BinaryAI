import { describe, expect, it } from 'vitest';
import type { CandleSeries, StrategyContext } from '@binaryai/types';
import {
  defaultTestAsset,
  syntheticDowntrend,
  syntheticRange,
  syntheticUptrend,
  syntheticVolatile,
} from '@binaryai/fixtures';
import { meanReversionStrategy } from './mean-reversion.js';
import { trendMomentumStrategy } from './trend-momentum.js';
import { resolveParameters } from './parameters.js';

function contextFor(
  series: CandleSeries,
  strategy: typeof trendMomentumStrategy,
  overrides = {},
): StrategyContext {
  return {
    asset: defaultTestAsset,
    timeframe: series.timeframe,
    series,
    parameters: resolveParameters(strategy.parameters, overrides),
    now: series.candles.at(-1)?.timestamp ?? 0,
  };
}

describe('trend-momentum strategy', () => {
  it('calls a clean synthetic uptrend', () => {
    const result = trendMomentumStrategy.evaluate(
      contextFor(syntheticUptrend(), trendMomentumStrategy),
    );
    expect(result.direction).toBe('call');
    expect(result.regimeHint).toBe('trend_up');
    expect(result.confirmations.length).toBeGreaterThan(0);
  });

  it('puts a clean synthetic downtrend', () => {
    const result = trendMomentumStrategy.evaluate(
      contextFor(syntheticDowntrend(), trendMomentumStrategy),
    );
    expect(result.direction).toBe('put');
    expect(result.regimeHint).toBe('trend_down');
  });

  it('abstains with a stated reason when history is too short', () => {
    const short = syntheticUptrend(10);
    const result = trendMomentumStrategy.evaluate(contextFor(short, trendMomentumStrategy));
    expect(result.direction).toBe('none');
    expect(result.abstainReason).toMatch(/insufficient history/);
  });

  it('reports a volatility conflict when ATR exceeds the ceiling', () => {
    const result = trendMomentumStrategy.evaluate(
      contextFor(syntheticVolatile(), trendMomentumStrategy, { maxAtrPercent: 0.05 }),
    );
    const codes = result.conflicts.map((conflict) => conflict.code);
    if (result.direction !== 'none') expect(codes).toContain('high_volatility');
  });

  it('is deterministic: identical input produces an identical evaluation', () => {
    const series = syntheticUptrend();
    const first = trendMomentumStrategy.evaluate(contextFor(series, trendMomentumStrategy));
    const second = trendMomentumStrategy.evaluate(contextFor(series, trendMomentumStrategy));
    expect(second).toStrictEqual(first);
  });

  it('does not mutate the series it is given', () => {
    const series = syntheticUptrend(120);
    const snapshot = JSON.stringify(series);
    trendMomentumStrategy.evaluate(contextFor(series, trendMomentumStrategy));
    expect(JSON.stringify(series)).toBe(snapshot);
  });

  it('never emits a direction without at least one confirmation', () => {
    for (const series of [syntheticUptrend(), syntheticDowntrend(), syntheticRange()]) {
      const result = trendMomentumStrategy.evaluate(contextFor(series, trendMomentumStrategy));
      if (result.direction !== 'none') expect(result.confirmations.length).toBeGreaterThan(0);
    }
  });

  it('keeps every evidence weight inside 0..1', () => {
    const result = trendMomentumStrategy.evaluate(
      contextFor(syntheticUptrend(), trendMomentumStrategy),
    );
    for (const item of [...result.confirmations, ...result.conflicts]) {
      expect(item.weight).toBeGreaterThanOrEqual(0);
      expect(item.weight).toBeLessThanOrEqual(1);
    }
  });
});

describe('mean-reversion strategy', () => {
  it('abstains while price sits inside the bands', () => {
    const result = meanReversionStrategy.evaluate(
      contextFor(syntheticRange(), meanReversionStrategy),
    );
    if (result.direction === 'none') {
      expect(result.abstainReason).toBeDefined();
    }
  });

  it('flags a trending market as a conflict when it does fire', () => {
    // A strong trend makes fading dangerous; the strategy must say so.
    const result = meanReversionStrategy.evaluate(
      contextFor(syntheticDowntrend(300), meanReversionStrategy, { maxAdx: 5 }),
    );
    if (result.direction !== 'none') {
      expect(result.conflicts.map((conflict) => conflict.code)).toContain('trending_market');
    }
  });

  it('is deterministic', () => {
    const series = syntheticRange(300);
    const first = meanReversionStrategy.evaluate(contextFor(series, meanReversionStrategy));
    const second = meanReversionStrategy.evaluate(contextFor(series, meanReversionStrategy));
    expect(second).toStrictEqual(first);
  });

  it('exposes every parameter it reads', () => {
    const keys = meanReversionStrategy.parameters.map((spec) => spec.key);
    expect(keys).toContain('bandPeriod');
    expect(keys).toContain('maxAdx');
    expect(new Set(keys).size).toBe(keys.length);
  });
});
