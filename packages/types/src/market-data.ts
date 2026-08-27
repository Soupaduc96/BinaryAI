import type { AssetClass, Candle, MarketDataSource, Timeframe } from './market.js';

/**
 * The market-data provider contract.
 *
 * Provider-neutral by construction: no vendor name, no vendor field, no vendor
 * symbol format appears in these types. `@binaryai/market-data` implements them
 * per provider, and the ingestion worker, repositories, engine and API depend
 * only on what is declared here.
 *
 * A CRITICAL DISTINCTION this model encodes (see docs/market-data.md):
 * market data is NOT broker pricing. Candles from an exchange describe trades
 * on that exchange. A binary-options broker quotes and settles on its own feed,
 * which may differ in price, timing and construction. `dataOrigin` records what
 * a provider actually supplies so this can never be silently conflated.
 */

/** What is actually behind a provider's numbers. */
export type MarketDataOrigin =
  /** Matched trades on a specific exchange. */
  | 'exchange'
  /** Combined from multiple venues by the provider. */
  | 'aggregated'
  /** Indicative/reference pricing, not necessarily tradable. */
  | 'indicative'
  /** A broker's own quote and settlement feed. */
  | 'broker'
  /** Generated. Test and demo use only. */
  | 'synthetic';

export interface ProviderCapabilities {
  readonly id: string;
  readonly displayName: string;
  /** True when the provider cannot be used without credentials. */
  readonly requiresCredentials: boolean;
  /** Only timeframes the provider serves natively. Never resampled silently. */
  readonly supportedTimeframes: readonly Timeframe[];
  /** Hard ceiling per request; the ingestion worker paginates around it. */
  readonly maxCandlesPerRequest: number;
  readonly supportsHistoricalRange: boolean;
  readonly supportsStreaming: boolean;
  /** Human description of how far back data reaches. */
  readonly historicalDepth: string;
  readonly dataOrigin: MarketDataOrigin;
  /** Requests per second the provider tolerates. Drives the rate limiter. */
  readonly rateLimitPerSecond: number;
  readonly documentationUrl: string;
  /** Known limitations, surfaced in the API and the docs. */
  readonly limitations: readonly string[];
}

/** An instrument as the provider describes it, mapped to BinaryAI's namespace. */
export interface ProviderAsset {
  /** BinaryAI symbol, e.g. "BTCUSD". */
  readonly symbol: string;
  /** The provider's own identifier, e.g. "BTC-USD". Never used outside adapters. */
  readonly providerSymbol: string;
  readonly displayName: string;
  readonly assetClass: AssetClass;
  readonly pricePrecision: number;
  readonly quoteCurrency: string;
  readonly tradable: boolean;
}

export interface CandleRequest {
  /** BinaryAI symbol. The adapter maps it to the provider's format. */
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Epoch ms, inclusive. Omit for the most recent window. */
  readonly from?: number;
  /** Epoch ms, inclusive. */
  readonly to?: number;
  readonly limit?: number;
}

/** Provenance recorded for every fetch, for observability and latency tracking. */
export interface FetchMetadata {
  readonly providerId: string;
  readonly providerSymbol: string;
  /** Epoch ms when the request left BinaryAI. */
  readonly requestedAt: number;
  /** Epoch ms when the response was parsed. */
  readonly receivedAt: number;
  readonly latencyMs: number;
  readonly candlesReturned: number;
  /** Endpoint path only — never includes credentials or a full external URL. */
  readonly endpoint: string;
}

export interface ProviderFetchResult {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly source: MarketDataSource;
  readonly origin: MarketDataOrigin;
  /** Ascending by timestamp. Structurally parsed but not yet quality-validated. */
  readonly candles: readonly Candle[];
  readonly meta: FetchMetadata;
}

/** Raised for provider failures the ingestion worker must classify and act on. */
export type ProviderErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'authentication'
  | 'not_found'
  | 'bad_request'
  | 'malformed_response'
  | 'server_error'
  | 'unsupported';

export interface MarketDataProvider {
  readonly capabilities: ProviderCapabilities;
  /** The instrument universe, already mapped into BinaryAI symbols. */
  listAssets(): Promise<readonly ProviderAsset[]>;
  fetchCandles(request: CandleRequest): Promise<ProviderFetchResult>;
  /** Cheap reachability check for the status endpoint. */
  ping(): Promise<boolean>;
}

// ------------------------------------------------------ quality validation --

export type IngestionIssueCode =
  | 'unsupported_timeframe'
  | 'unaligned_candle_boundary'
  | 'future_timestamp'
  | 'duplicate_candle'
  | 'out_of_order'
  | 'missing_interval'
  | 'overlapping_candle'
  | 'invalid_ohlc'
  | 'non_positive_price'
  | 'non_finite_value'
  | 'negative_volume'
  | 'empty_response'
  | 'stale_data';

export interface IngestionIssue {
  readonly code: IngestionIssueCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  /** Epoch ms of the offending candle, when one can be identified. */
  readonly at?: number;
}

/**
 * The verdict on one fetched batch.
 *
 * Rejected candles are counted and explained, never silently dropped and never
 * silently repaired — a "fixed" candle is fabricated data.
 */
export interface IngestionQualityReport {
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly missingIntervals: number;
  readonly issues: readonly IngestionIssue[];
  /** 0..1 summary. An input to decisions, not a verdict on its own. */
  readonly score: number;
  readonly usable: boolean;
}

// -------------------------------------------------------------- ingestion --

export interface IngestionRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Epoch ms. Required: unbounded historical pulls are refused. */
  readonly from: number;
  readonly to: number;
  /** Safety ceiling on total candles for one run. */
  readonly maxCandles?: number;
}

export interface IngestionMetrics {
  readonly requests: number;
  readonly candlesRequested: number;
  readonly candlesReceived: number;
  readonly candlesAccepted: number;
  readonly candlesRejected: number;
  readonly duplicates: number;
  readonly missingIntervals: number;
  readonly candlesStored: number;
  readonly retries: number;
  readonly providerLatencyMsAvg: number | null;
  readonly providerLatencyMsMax: number | null;
  readonly durationMs: number;
}

export interface IngestionRunResult {
  readonly runId: string;
  readonly providerId: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly requestedFrom: number;
  readonly requestedTo: number;
  /** Actual coverage achieved; may be narrower than requested. Never implied. */
  readonly coveredFrom: number | null;
  readonly coveredTo: number | null;
  readonly status: 'completed' | 'partial' | 'failed';
  readonly metrics: IngestionMetrics;
  readonly issues: readonly IngestionIssue[];
  readonly warnings: readonly string[];
  readonly error?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  /** True when results were written to the database rather than discarded. */
  readonly persisted: boolean;
}

export type MarketDataConnectionState =
  'not_configured' | 'connected' | 'degraded' | 'disconnected' | 'stale';

/**
 * What the dashboard's MARKET DATA indicator reflects.
 *
 * `stale` is a distinct state on purpose: showing a last-known price as if it
 * were current is the failure mode this field exists to prevent.
 */
export interface MarketDataStatus {
  readonly state: MarketDataConnectionState;
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly origin: MarketDataOrigin | null;
  readonly reachable: boolean;
  /** Epoch ms of the newest stored candle, across all instruments. */
  readonly lastCandleAt: number | null;
  readonly lastSuccessfulIngestionAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  readonly stalenessSeconds: number | null;
  readonly detail: string;
}
