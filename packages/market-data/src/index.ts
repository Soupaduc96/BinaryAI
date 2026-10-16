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

export {
  createYahooProvider,
  YAHOO_CAPABILITIES,
  parseChart,
  type YahooProviderOptions,
} from './providers/yahoo.js';

export {
  createFixedRouter,
  createProvider,
  createProviderRouter,
  listAvailableProviders,
  providerCapabilities,
  type ProviderAssignment,
  type ProviderId,
  type ProviderRouter,
} from './registry.js';

export {
  ASSET_CLASS_LABELS,
  CATALOGUE_ASSET_CLASSES,
  INSTRUMENT_CATALOGUE,
  assetFromInstrument,
  findInstrument,
  instrumentsByClass,
  listInstruments,
  searchInstruments,
} from './catalogue.js';

export {
  resolveAvailability,
  resolveAssetClassState,
  type AvailabilityInputs,
} from './availability.js';

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

export { createRateBudget, type RateBudget, type RateBudgetOptions } from './rate-budget.js';

export { assessFreshness, type Freshness, type FreshnessState } from './freshness.js';
