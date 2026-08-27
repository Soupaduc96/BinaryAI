import { describe, expect, it } from 'vitest';
import {
  defaultTestAsset,
  syntheticRange,
  syntheticUptrend,
  syntheticVolatile,
} from '@binaryai/fixtures';
import { trendMomentumStrategy } from '@binaryai/strategies';
import type { CandleSeries } from '@binaryai/types';
import { evaluateDecision, analyzeMarket } from './pipeline.js';

function decide(
  series: CandleSeries,
  overrides: Partial<Parameters<typeof evaluateDecision>[0]> = {},
) {
  return evaluateDecision({
    asset: defaultTestAsset,
    series,
    strategy: trendMomentumStrategy,
    idFactory: () => 'sig_fixed',
    ...overrides,
  });
}

describe('analyzeMarket', () => {
  it('reports a regime and a data-quality report without producing a signal', () => {
    const analysis = analyzeMarket(syntheticUptrend(200));
    expect(analysis.regime.regime).toBe('trend_up');
    expect(analysis.dataQuality.usable).toBe(true);
    expect(analysis.lastPrice).toBeGreaterThan(0);
  });

  it('flags insufficient history through the data-quality report', () => {
    const analysis = analyzeMarket(syntheticUptrend(5), { requiredHistory: 100 });
    expect(analysis.dataQuality.usable).toBe(false);
    expect(analysis.regime.regime).toBe('unknown');
  });
});

describe('evaluateDecision', () => {
  it('produces a fully-populated signal for a clean uptrend', () => {
    const { signal, risk, analysis } = decide(syntheticUptrend(240));

    expect(signal.direction).toBe('call');
    expect(signal.strategy.id).toBe('trend-momentum');
    expect(signal.confidence.calibration).toBe('uncalibrated_heuristic');
    expect(signal.executionMode).toBe('demo');
    expect(signal.dataSource).toBe('synthetic');
    expect(signal.reasoning.generatedBy).toBe('rule_engine');
    expect(signal.reasoning.summary).toContain('CALL');
    expect(signal.expiration.expiresAt).toBeGreaterThan(signal.createdAt);
    expect(analysis.regime.regime).toBe('trend_up');
    expect(risk.checks.length).toBeGreaterThan(0);
  });

  it('never recommends anything without a completed risk assessment', () => {
    const { signal, risk } = decide(syntheticUptrend(240));
    expect(['consider', 'wait_for_confirmation', 'skip']).toContain(signal.recommendation);
    if (risk.outcome === 'block') expect(signal.recommendation).toBe('skip');
    if (signal.recommendation !== 'skip') expect(risk.outcome).toBe('allow');
  });

  it('rejects and explains when the strategy finds no setup', () => {
    const { signal } = decide(syntheticRange(240));
    if (signal.direction === 'none') {
      expect(signal.status).toBe('rejected');
      expect(signal.recommendation).toBe('skip');
      expect(signal.reasoning.summary).toMatch(/No directional setup/);
    }
  });

  it('blocks live execution even when the setup is good', () => {
    const { signal, risk } = decide(syntheticUptrend(240), { executionMode: 'live' });
    expect(risk.blockedBy).toContain('live_execution_disabled');
    expect(signal.status).toBe('rejected');
    expect(signal.recommendation).toBe('skip');
  });

  it('rejects without evaluating the strategy when data fails validation', () => {
    const broken: CandleSeries = {
      asset: 'BROKEN',
      timeframe: '1m',
      source: 'historical_file',
      candles: [
        {
          timestamp: 1_000,
          open: 100,
          high: 90,
          low: 110,
          close: 100,
          volume: null,
          complete: true,
        },
      ],
    };
    const { signal, evaluation } = decide(broken);
    expect(signal.status).toBe('rejected');
    expect(evaluation.abstainReason).toMatch(/integrity/);
    expect(signal.dataQuality.usable).toBe(false);
  });

  it('raises the risk level in volatile conditions', () => {
    const calm = decide(syntheticUptrend(240)).signal.riskLevel;
    const rough = decide(syntheticVolatile(240)).signal.riskLevel;
    const order = { low: 0, medium: 1, high: 2, extreme: 3 } as const;
    expect(order[rough]).toBeGreaterThanOrEqual(order[calm]);
  });

  it('is deterministic when ids and time are injected', () => {
    const series = syntheticUptrend(240);
    // The clock must be at or after the decision candle; an earlier one is now
    // refused by the engine guard rather than producing an incoherent signal.
    const at = (series.candles.at(-1)?.timestamp ?? 0) + 1_000;
    const first = decide(series, { now: at });
    const second = decide(series, { now: at });
    expect(second).toStrictEqual(first);
  });

  it('refuses a now that precedes the decision candle', () => {
    // Guard added in Phase 2C. Such a signal would expire before the bar it was
    // decided on, and the database CHECK rejects it outright -- failing loudly
    // beats silently correcting the caller's clock.
    const series = syntheticUptrend(240);
    const lastCandle = series.candles.at(-1);
    expect(() => decide(series, { now: (lastCandle?.timestamp ?? 0) - 60_000 })).toThrow(
      /precedes the decision candle/,
    );
  });

  it('accepts a now at or after the decision candle', () => {
    const series = syntheticUptrend(240);
    const at = series.candles.at(-1)?.timestamp ?? 0;
    expect(() => decide(series, { now: at })).not.toThrow();
    expect(() => decide(series, { now: at + 60_000 })).not.toThrow();
  });

  it('never emits a signal whose expiry precedes its decision timestamp', () => {
    const { signal } = decide(syntheticUptrend(240));
    expect(signal.expiration.expiresAt).toBeGreaterThan(signal.timestamp);
  });

  it('carries the confidence disclaimer onto the signal', () => {
    const { signal } = decide(syntheticUptrend(240));
    expect(signal.confidence.disclaimer).toMatch(/not.*calibrated|not a win probability/i);
    expect(signal.reasoning.caveats.join(' ')).toMatch(/Demo mode/);
  });
});
