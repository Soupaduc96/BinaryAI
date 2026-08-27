import type { CandleSeries, MarketAsset, Timeframe } from './market.js';
import type {
  Confirmation,
  Conflict,
  IndicatorSnapshot,
  MarketRegime,
  SignalDirection,
} from './signal.js';

export interface StrategyMetadata {
  readonly id: string;
  readonly name: string;
  /** Semver. Bumped whenever logic changes, so historical signals stay attributable. */
  readonly version: string;
  readonly description: string;
  /** Minimum number of candles required before the strategy may emit anything. */
  readonly requiredHistory: number;
  /** 'any' means the strategy is timeframe-agnostic. */
  readonly supportedTimeframes: readonly Timeframe[] | 'any';
  readonly tags: readonly string[];
}

export type StrategyParameterValue = number | boolean | string;

export interface StrategyParameterSpec {
  readonly key: string;
  readonly label: string;
  readonly type: 'number' | 'boolean' | 'enum';
  readonly defaultValue: StrategyParameterValue;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly description: string;
}

export type StrategyParameters = Readonly<Record<string, StrategyParameterValue>>;

/**
 * Everything a strategy is allowed to see.
 *
 * `series` contains ONLY candles up to and including the decision bar. The
 * backtester slices it that way, which makes look-ahead bias structurally
 * impossible rather than a thing we have to remember not to do.
 */
export interface StrategyContext {
  readonly asset: MarketAsset;
  readonly timeframe: Timeframe;
  readonly series: CandleSeries;
  readonly parameters: StrategyParameters;
  /** Epoch ms treated as "now". In a backtest this is the decision bar's close time. */
  readonly now: number;
}

/**
 * A strategy's opinion. It deliberately does NOT contain a confidence score:
 * scoring is the confidence engine's job, and keeping it separate stops each
 * strategy from inventing its own scale.
 */
export interface StrategyEvaluation {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly direction: SignalDirection;
  readonly indicators: readonly IndicatorSnapshot[];
  readonly confirmations: readonly Confirmation[];
  readonly conflicts: readonly Conflict[];
  /** The strategy's own read of the regime; the engine may override it. */
  readonly regimeHint: MarketRegime;
  /** Suggested expiry for this setup, in seconds. */
  readonly expirationSeconds: number;
  /** Plain-language notes that become part of the signal reasoning. */
  readonly notes: readonly string[];
  /** Set when the strategy declined to act, e.g. "insufficient history". */
  readonly abstainReason?: string;
}

/**
 * The strategy contract. Implementations MUST be pure and deterministic:
 * same context in, same evaluation out, no clocks, no randomness, no I/O.
 * This is what makes backtests reproducible.
 */
export interface Strategy {
  readonly meta: StrategyMetadata;
  readonly parameters: readonly StrategyParameterSpec[];
  evaluate(context: StrategyContext): StrategyEvaluation;
}
