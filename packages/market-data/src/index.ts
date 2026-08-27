/**
 * @binaryai/market-data — provider adapters and the ingestion pipeline.
 *
 *   Provider API -> Adapter -> normalize -> validate -> CandleRepository
 *
 * Nothing outside this package knows which provider is in use. The engine, the
 * repositories, the API and the dashboard depend on `MarketDataProvider` and
 * the shared candle types in @binaryai/types, so adding a second provider is
 * additive rather than a rewrite.
 *
 * See docs/market-data.md and docs/adr/0008-market-data-provider.md.
 */

export { ProviderError, errorKind, isRetryable, type HttpFetch } from './provider-error.js';

export {
  createCoinbaseProvider,
  COINBASE_CAPABILITIES,
  parseCandles,
  parseProducts,
  precisionFromIncrement,
  toBinaryAiSymbol,
  toProviderSymbol,
  type CoinbaseProviderOptions,
} from './providers/coinbase.js';

export { createProvider, listAvailableProviders, type ProviderId } from './registry.js';

export { normalizeProviderResult, type NormalizedBatch } from './normalize.js';

export { validateIngestedBatch, withoutRejectedCandles, type QualityOptions } from './quality.js';

export {
  runHistoricalIngestion,
  planWindows,
  DEFAULT_INGESTION_OPTIONS,
  type IngestionDeps,
  type IngestionOptions,
} from './ingestion.js';

export {
  buildMarketDataStatus,
  createIngestionTracker,
  type IngestionSnapshot,
  type IngestionTracker,
  type StatusInputs,
} from './observability.js';
