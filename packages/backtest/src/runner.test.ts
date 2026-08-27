import { describe, expect, it } from 'vitest';
import { defaultTestAsset, syntheticDowntrend, syntheticUptrend } from '@binaryai/fixtures';
import { trendMomentumStrategy } from '@binaryai/strategies';
import type { BacktestConfig } from '@binaryai/types';
import { DEFAULT_PAYOUT_MODEL, runBacktest } from './runner.js';
import { computeMetrics } from './metrics.js';

const config: BacktestConfig = {
  strategyId: trendMomentumStrategy.meta.id,
  parameters: {},
  expirationSeconds: 180,
  payout: DEFAULT_PAYOUT_MODEL,
  stake: { kind: 'fixed', value: 10 },
  startingBalance: 1000,
  warmupBars: 60,
  minConfidence: 0.55,
};

function run(seriesLength = 400, overrides: Partial<BacktestConfig> = {}) {
  return runBacktest({
    asset: defaultTestAsset,
    series: syntheticUptrend(seriesLength),
    strategy: trendMomentumStrategy,
    config: { ...config, ...overrides },
    now: () => 1_700_000_000_000,
  });
}

describe('runBacktest', () => {
  it('labels every result as historical simulation, never as performance', () => {
    const result = run();
    expect(result.resultType).toBe('historical_simulation');
    expect(result.disclaimer).toMatch(/not real trading performance/i);
  });

  it('warns loudly when the dataset is synthetic', () => {
    expect(run().warnings.join(' ')).toMatch(/SYNTHETIC/);
  });

  it('is deterministic: identical inputs produce an identical result', () => {
    expect(run()).toStrictEqual(run());
  });

  it('reports the dataset it actually ran on', () => {
    const result = run(300);
    expect(result.dataset.source).toBe('synthetic');
    expect(result.dataset.candleCount).toBe(300);
    expect(result.dataset.label).toMatch(/NOT MARKET DATA/);
  });

  it('never opens a trade it cannot settle', () => {
    const result = run();
    const lastCandleTimestamp = syntheticUptrend(400).candles.at(-1)?.timestamp ?? 0;
    for (const trade of result.trades) {
      expect(trade.expiryTimestamp).toBeGreaterThan(trade.entryTimestamp);
      expect(trade.expiryTimestamp).toBeLessThanOrEqual(lastCandleTimestamp);
      expect(trade.outcome).not.toBe('unresolved');
    }
  });

  it('keeps only one position open at a time', () => {
    const result = run();
    for (let i = 1; i < result.trades.length; i += 1) {
      const previous = result.trades[i - 1];
      const current = result.trades[i];
      if (!previous || !current) continue;
      expect(current.entryTimestamp).toBeGreaterThanOrEqual(previous.expiryTimestamp);
    }
  });

  it('applies the stated payout model to every settled trade', () => {
    const result = run();
    for (const trade of result.trades) {
      if (trade.outcome === 'win') {
        expect(trade.pnl).toBeCloseTo(trade.stake * DEFAULT_PAYOUT_MODEL.winPayoutRate, 6);
      }
      if (trade.outcome === 'loss') expect(trade.pnl).toBeCloseTo(-trade.stake, 6);
      if (trade.outcome === 'tie') expect(trade.pnl).toBe(0);
    }
  });

  it('keeps the running balance consistent with the trade PnL', () => {
    const result = run();
    let balance = config.startingBalance;
    for (const trade of result.trades) {
      balance = Number((balance + trade.pnl).toFixed(8));
      expect(trade.balanceAfter).toBeCloseTo(balance, 6);
    }
  });

  it('respects the confidence floor', () => {
    const result = run(400, { minConfidence: 0.9 });
    for (const trade of result.trades) expect(trade.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('takes no trades when the dataset cannot cover warm-up plus expiry, and says so', () => {
    // 62 candles against a 60-bar warm-up and a 3-bar expiry: nothing can settle.
    const result = run(62);
    expect(result.trades).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/Dataset too short/);
    expect(result.warnings.join(' ')).toMatch(/No trades were taken/);
  });

  it('records the risk limits the run was executed under', () => {
    const result = run(400, { riskLimits: { minConfidence: 0.4 } });
    expect(result.config.riskLimits?.allowLiveExecution).toBe(false);
    expect(result.config.riskLimits?.minConfidence).toBe(0.4);
  });

  it('produces directionally sensible trades on a synthetic trend', () => {
    // Not a performance claim -- this asserts the engine follows the trend it
    // detected, on data whose direction we constructed.
    const result = run(400, { minConfidence: 0.5 });
    if (result.trades.length > 0) {
      expect(result.trades.every((trade) => trade.direction === 'call')).toBe(true);
    }
    const down = runBacktest({
      asset: defaultTestAsset,
      series: syntheticDowntrend(400),
      strategy: trendMomentumStrategy,
      config: { ...config, minConfidence: 0.5 },
      now: () => 1_700_000_000_000,
    });
    if (down.trades.length > 0) {
      expect(down.trades.every((trade) => trade.direction === 'put')).toBe(true);
    }
  });
});

describe('computeMetrics', () => {
  it('returns empty metrics rather than fabricated zeros for no trades', () => {
    const metrics = computeMetrics([], 1000);
    expect(metrics.trades).toBe(0);
    expect(metrics.winRate).toBeNull();
    expect(metrics.expectancyPerTrade).toBeNull();
    expect(metrics.profitFactor).toBeNull();
  });

  it('computes win rate over resolved trades only', () => {
    const metrics = computeMetrics(
      [
        trade('win', 8, 1008),
        trade('loss', -10, 998),
        trade('tie', 0, 998),
        trade('unresolved', 0, 998),
      ],
      1000,
    );
    expect(metrics.winRate).toBeCloseTo(0.5, 6);
    expect(metrics.ties).toBe(1);
    expect(metrics.unresolved).toBe(1);
  });

  it('tracks the longest streaks', () => {
    const metrics = computeMetrics(
      [
        trade('loss', -10, 990),
        trade('loss', -10, 980),
        trade('win', 8, 988),
        trade('win', 8, 996),
        trade('win', 8, 1004),
      ],
      1000,
    );
    expect(metrics.longestLossStreak).toBe(2);
    expect(metrics.longestWinStreak).toBe(3);
  });

  it('measures drawdown from the running peak', () => {
    const metrics = computeMetrics(
      [trade('win', 100, 1100), trade('loss', -300, 800), trade('win', 100, 900)],
      1000,
    );
    expect(metrics.maxDrawdown).toBeCloseTo(300, 6);
    expect(metrics.maxDrawdownPercent).toBeCloseTo(27.272727, 4);
  });
});

function trade(outcome: 'win' | 'loss' | 'tie' | 'unresolved', pnl: number, balanceAfter: number) {
  return {
    index: 0,
    entryTimestamp: 0,
    entryPrice: 100,
    direction: 'call' as const,
    expiryTimestamp: 60_000,
    expiryPrice: 101,
    stake: 10,
    confidence: 0.7,
    outcome,
    pnl,
    balanceAfter,
  };
}
