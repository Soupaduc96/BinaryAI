/**
 * Market data primitives.
 *
 * Every candle that enters the system is normalized into `Candle` before any
 * analysis happens. Nothing downstream may consume a provider payload directly
 * -- see docs/data-architecture.md.
 */

export const TIMEFRAMES = [
  '5s',
  '15s',
  '30s',
  '1m',
  '2m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> = {
  '5s': 5,
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export type AssetClass = 'forex' | 'crypto' | 'commodity' | 'index' | 'stock' | 'otc' | 'unknown';

export interface MarketAsset {
  /** Provider-independent symbol, e.g. "EURUSD". */
  readonly symbol: string;
  readonly displayName: string;
  readonly assetClass: AssetClass;
  /** Decimal places used when rendering prices. */
  readonly pricePrecision: number;
  /** OTC instruments are broker-synthesised and must be labelled as such in the UI. */
  readonly isOtc: boolean;
}

/**
 * Provenance of a candle series. This is deliberately part of the data model:
 * the UI must never present `synthetic` or `historical_file` data as live.
 */
export type MarketDataSource =
  'live_provider' | 'historical_provider' | 'historical_file' | 'synthetic' | 'unknown';

export interface Candle {
  /** Epoch milliseconds of the candle OPEN. */
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Null when the provider does not supply volume (common in forex/OTC). */
  readonly volume: number | null;
  /** False while the candle is still forming. Incomplete candles must not settle a trade. */
  readonly complete: boolean;
}

export interface CandleSeries {
  readonly asset: string;
  readonly timeframe: Timeframe;
  readonly source: MarketDataSource;
  /** Ascending by timestamp, gap-checked, validated. */
  readonly candles: readonly Candle[];
  /** Free-text provenance label, e.g. "synthetic:seed=42" or "provider:acme". */
  readonly label?: string;
}

export interface Quote {
  readonly asset: string;
  readonly bid: number;
  readonly ask: number;
  readonly at: number;
  readonly source: MarketDataSource;
}

export type DataQualityCode =
  | 'empty_series'
  | 'insufficient_history'
  | 'non_monotonic_timestamps'
  | 'duplicate_timestamp'
  | 'timestamp_gap'
  | 'invalid_ohlc_range'
  | 'non_finite_value'
  | 'non_positive_price'
  | 'negative_volume'
  | 'incomplete_last_candle'
  | 'unexpected_interval';

export type DataQualitySeverity = 'info' | 'warning' | 'error';

export interface DataQualityIssue {
  readonly code: DataQualityCode;
  readonly severity: DataQualitySeverity;
  readonly message: string;
  /** Index into the candle array where the issue was detected, when applicable. */
  readonly index?: number;
}

export interface DataQualityReport {
  /** False when at least one `error`-severity issue was found. */
  readonly usable: boolean;
  /** 0..1 heuristic summary, consumed by the risk engine as an input, not a verdict. */
  readonly score: number;
  readonly candleCount: number;
  readonly firstTimestamp: number | null;
  readonly lastTimestamp: number | null;
  readonly issues: readonly DataQualityIssue[];
}
