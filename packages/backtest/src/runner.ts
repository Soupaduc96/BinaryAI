import {
  evaluateDecision,
  resolveRiskLimits,
  settleBinaryOutcome,
  sliceSeries,
} from '@binaryai/engine';
import {
  BACKTEST_DISCLAIMER,
  TIMEFRAME_SECONDS,
  type BacktestConfig,
  type BacktestResult,
  type BacktestTrade,
  type CandleSeries,
  type DatasetDescriptor,
  type MarketAsset,
  type PayoutModel,
  type StakeModel,
  type Strategy,
} from '@binaryai/types';
import { deterministicId, round } from '@binaryai/utils';
import { computeMetrics } from './metrics.js';

/**
 * The backtester.
 *
 * It runs the SAME pipeline as live analysis (@binaryai/engine's
 * `evaluateDecision`) over historical bars. There is no separate "backtest
 * strategy logic" to drift out of sync -- that duplication is the single most
 * common reason backtests lie.
 *
 * Modelling choices, stated plainly because they change results:
 *  - Entry fills at the decision bar's CLOSE. No slippage, no spread.
 *  - Settlement compares the expiry bar's close to the entry price.
 *  - One position at a time; the scan jumps to expiry after each entry.
 *  - Payout is a flat assumption, not a broker quote.
 * Real fills are worse than this. Treat every number as an upper bound.
 */

export const DEFAULT_PAYOUT_MODEL: PayoutModel = {
  winPayoutRate: 0.8,
  lossRefundRate: 0,
  tiePolicy: 'refund',
  note: 'Assumption: flat 80% payout, no refund on a loss, stake returned on an exact tie. Not a broker quote.',
};

export const DEFAULT_STAKE_MODEL: StakeModel = { kind: 'fixed', value: 10 };

export interface BacktestRequest {
  readonly asset: MarketAsset;
  /**
   * Whether `asset` came from the catalogue or is an unresolved caller label.
   *
   * R8. The runner does not guess this from the asset class, because a caller
   * could hand-build an asset with a plausible class and the run would then
   * claim an identity nobody established. Defaults to 'unresolved': an
   * identity has to be asserted, never assumed.
   */
  readonly instrumentIdentity?: DatasetDescriptor['instrumentIdentity'];
  readonly series: CandleSeries;
  readonly strategy: Strategy;
  readonly config: BacktestConfig;
  /** Injectable clock so a run is reproducible in tests. */
  readonly now?: () => number;
}

export function runBacktest(request: BacktestRequest): BacktestResult {
  const { asset, series, strategy, config } = request;
  const clock = request.now ?? Date.now;
  const startedAt = clock();

  const candles = series.candles;
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];

  const barSeconds = TIMEFRAME_SECONDS[series.timeframe];
  const expiryBars = Math.max(1, Math.ceil(config.expirationSeconds / barSeconds));
  const warmup = Math.max(strategy.meta.requiredHistory, config.warmupBars);
  const limits = resolveRiskLimits(config.riskLimits);

  if (series.source === 'synthetic') {
    warnings.push(
      'Dataset is SYNTHETIC. Results describe engine behaviour on generated data, not market edge.',
    );
  }
  if (candles.length <= warmup + expiryBars) {
    warnings.push(
      `Dataset too short: ${candles.length} candles for a ${warmup}-bar warm-up and ${expiryBars}-bar expiry.`,
    );
  }

  let balance = config.startingBalance;
  let consecutiveLosses = 0;
  let lastLossAt: number | null = null;
  let skippedByRisk = 0;
  let skippedByConfidence = 0;

  for (let index = warmup; index < candles.length; index += 1) {
    const entryCandle = candles[index];
    if (entryCandle === undefined) continue;

    const expiryIndex = index + expiryBars;
    const expiryCandle = candles[expiryIndex];
    if (expiryCandle === undefined) break; // Cannot settle -- stop rather than guess.

    const decision = evaluateDecision({
      asset,
      series: sliceSeries(series, index),
      strategy,
      parameters: config.parameters,
      executionMode: 'demo',
      riskLimits: config.riskLimits ?? {},
      riskContext: {
        executionMode: 'demo',
        accountBalance: balance,
        dayStartBalance: config.startingBalance,
        openPositions: 0,
        openExposure: 0,
        consecutiveLosses,
        lastLossAt,
        now: entryCandle.timestamp,
      },
      now: entryCandle.timestamp,
      idFactory: () => `sig_${deterministicId(`${strategy.meta.id}:${entryCandle.timestamp}`)}`,
    });

    const { signal, risk } = decision;
    if (signal.direction === 'none') continue;
    if (risk.outcome === 'block') {
      skippedByRisk += 1;
      continue;
    }
    if (signal.confidence.score < config.minConfidence) {
      skippedByConfidence += 1;
      continue;
    }

    const stake = resolveStake(config.stake, balance, risk.maxStake);
    if (stake <= 0) {
      skippedByRisk += 1;
      continue;
    }

    const entryPrice = entryCandle.close;
    const expiryPrice = expiryCandle.close;
    const outcome = settleBinaryOutcome(signal.direction, entryPrice, expiryPrice);
    const pnl = payoutFor(outcome, stake, config.payout);

    balance = round(balance + pnl, 8);
    if (outcome === 'loss') {
      consecutiveLosses += 1;
      lastLossAt = expiryCandle.timestamp;
    } else if (outcome === 'win') {
      consecutiveLosses = 0;
    }

    trades.push({
      index,
      entryTimestamp: entryCandle.timestamp,
      entryPrice,
      direction: signal.direction,
      expiryTimestamp: expiryCandle.timestamp,
      expiryPrice,
      stake: round(stake, 8),
      confidence: signal.confidence.score,
      outcome,
      pnl: round(pnl, 8),
      balanceAfter: balance,
    });

    // One position at a time: resume scanning after this trade settles.
    index = expiryIndex;
  }

  if (trades.length === 0) {
    warnings.push('No trades were taken. Metrics below are empty, not zero-performance.');
  }
  if (skippedByRisk > 0) warnings.push(`${skippedByRisk} setup(s) skipped by the risk engine.`);
  if (skippedByConfidence > 0) {
    warnings.push(
      `${skippedByConfidence} setup(s) skipped below the ${config.minConfidence} confidence floor.`,
    );
  }

  const dataset: DatasetDescriptor = {
    // The RESOLVED symbol, not the caller's series label. R8: a run stored
    // under 'btc-usd' cannot be joined to signals stored under 'BTCUSD'.
    asset: asset.symbol,
    instrumentIdentity: request.instrumentIdentity ?? 'unresolved',
    timeframe: series.timeframe,
    source: series.source,
    candleCount: candles.length,
    from: candles[0]?.timestamp ?? null,
    to: candles.at(-1)?.timestamp ?? null,
    label: series.label ?? `${series.source}:${series.asset}`,
  };

  return {
    resultType: 'historical_simulation',
    runId: `bt_${deterministicId(JSON.stringify({ strategy: strategy.meta, config, dataset }))}`,
    startedAt,
    finishedAt: clock(),
    strategy: {
      id: strategy.meta.id,
      version: strategy.meta.version,
      name: strategy.meta.name,
    },
    config: { ...config, riskLimits: limits },
    dataset,
    metrics: computeMetrics(trades, config.startingBalance),
    trades,
    warnings,
    disclaimer: BACKTEST_DISCLAIMER,
  };
}

function resolveStake(model: StakeModel, balance: number, maxStake: number): number {
  const requested = model.kind === 'fixed' ? model.value : balance * model.value;
  return Math.max(Math.min(requested, maxStake, balance), 0);
}

function payoutFor(outcome: BacktestTrade['outcome'], stake: number, payout: PayoutModel): number {
  switch (outcome) {
    case 'win':
      return stake * payout.winPayoutRate;
    case 'loss':
      return -stake * (1 - payout.lossRefundRate);
    case 'tie':
      return payout.tiePolicy === 'refund' ? 0 : -stake;
    case 'unresolved':
      return 0;
  }
}
