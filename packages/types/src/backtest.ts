import type { MarketDataSource, Timeframe } from './market.js';
import type { RiskLimits } from './risk.js';
import type { SignalDirection, StrategyRef } from './signal.js';
import type { StrategyParameters } from './strategy.js';

/**
 * Backtest results are HISTORICAL SIMULATION. They are not, and must never be
 * presented as, real-world performance. The literal below is attached to every
 * result object and rendered by the UI.
 */
export const BACKTEST_DISCLAIMER =
  'Historical simulation on past data under stated payout and fill assumptions. ' +
  'This is not real trading performance and does not predict future results.';

export type BacktestResultType = 'historical_simulation';

/**
 * Payout assumptions. Real brokers vary payouts by asset, time of day and
 * account tier; these are OUR assumptions and are reported alongside results.
 */
export interface PayoutModel {
  /** Profit as a fraction of stake on a win, e.g. 0.8 means +80%. */
  readonly winPayoutRate: number;
  /** Fraction of stake returned on a loss, usually 0. */
  readonly lossRefundRate: number;
  /** How an exact-equal settlement price is treated. */
  readonly tiePolicy: 'refund' | 'loss';
  /** Where these numbers came from, e.g. "assumption: generic 80% payout". */
  readonly note: string;
}

export interface StakeModel {
  readonly kind: 'fixed' | 'fraction_of_balance';
  /** Currency amount when kind is 'fixed', fraction 0..1 when 'fraction_of_balance'. */
  readonly value: number;
}

export interface BacktestConfig {
  readonly strategyId: string;
  readonly parameters: StrategyParameters;
  readonly expirationSeconds: number;
  readonly payout: PayoutModel;
  readonly stake: StakeModel;
  readonly startingBalance: number;
  /** Bars skipped before the first possible entry, on top of requiredHistory. */
  readonly warmupBars: number;
  /** Minimum confidence for a simulated entry. */
  readonly minConfidence: number;
  /** Risk limits applied during the run; omit to use engine defaults. */
  readonly riskLimits?: Partial<RiskLimits>;
}

export interface BacktestTrade {
  readonly index: number;
  readonly entryTimestamp: number;
  readonly entryPrice: number;
  readonly direction: Exclude<SignalDirection, 'none'>;
  readonly expiryTimestamp: number;
  readonly expiryPrice: number | null;
  readonly stake: number;
  readonly confidence: number;
  readonly outcome: 'win' | 'loss' | 'tie' | 'unresolved';
  readonly pnl: number;
  readonly balanceAfter: number;
}

export interface BacktestMetrics {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly unresolved: number;
  /** wins / resolved trades. Null when there are no resolved trades. */
  readonly winRate: number | null;
  readonly lossRate: number | null;
  readonly netPnl: number;
  readonly returnPercent: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownPercent: number;
  readonly longestWinStreak: number;
  readonly longestLossStreak: number;
  /** Average PnL per trade in account currency. */
  readonly expectancyPerTrade: number | null;
  /** Gross win / gross loss. Null when there are no losses. */
  readonly profitFactor: number | null;
}

export interface DatasetDescriptor {
  /**
   * The instrument this run describes.
   *
   * R8. A CANONICAL catalogue symbol whenever the instrument could be
   * resolved, so a stored run can be joined to signals, positions and
   * analytics for the same market. When it could not be resolved this is the
   * caller's own text, and `instrumentIdentity` says so.
   */
  readonly asset: string;
  /**
   * Whether `asset` is an established identity or merely the caller's label.
   *
   * A backtest over a hand-supplied series is legitimate and is not rejected,
   * but a run whose market BinaryAI cannot name must not be presentable as
   * though it had one. Stated explicitly rather than left to be inferred from
   * an 'unknown' asset class.
   */
  readonly instrumentIdentity: 'catalogue' | 'unresolved';
  readonly timeframe: Timeframe;
  readonly source: MarketDataSource;
  readonly candleCount: number;
  readonly from: number | null;
  readonly to: number | null;
  /** Human-readable provenance, e.g. "synthetic:seed=42 (not market data)". */
  readonly label: string;
}

export interface BacktestResult {
  readonly resultType: BacktestResultType;
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly strategy: StrategyRef;
  readonly config: BacktestConfig;
  readonly dataset: DatasetDescriptor;
  readonly metrics: BacktestMetrics;
  readonly trades: readonly BacktestTrade[];
  readonly warnings: readonly string[];
  readonly disclaimer: string;
}
