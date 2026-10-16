import type { AppConfig } from '@binaryai/config';
import { createRuleBasedAiProvider } from '@binaryai/engine';
import { createDefaultRegistry, type StrategyRegistry } from '@binaryai/strategies';
import {
  buildMarketDataStatus,
  createIngestionTracker,
  createFixedRouter,
  createProviderRouter,
  findInstrument,
  type IngestionTracker,
  type ProviderRouter,
} from '@binaryai/market-data';
import {
  createRuntime,
  resolvePlanFromConfig,
  type Runtime,
  type RuntimeEvent,
} from '@binaryai/runtime';
import {
  createMemoryRateLimitStore,
  createRateLimiter,
  type RateLimiter,
  type RateLimitStore,
} from '@binaryai/rate-limit';
import { DEFAULT_EVIDENCE_THRESHOLDS } from '@binaryai/analytics';
import { validatePolicy } from '@binaryai/engine';
import { createAnalyticsService, type AnalyticsService } from './analytics-service.js';
import { createPaperService, type PaperService } from './paper-service.js';
import { createAuthService, type AuthService } from './auth-service.js';
import type {
  AiProvider,
  EvidenceThresholds,
  MarketAsset,
  MarketDataProvider,
  MarketDataStatus,
  PersistenceLayer,
} from '@binaryai/types';

/**
 * Everything the routes are allowed to depend on, assembled once at boot and
 * injected. No route reaches for a global, which is what makes the API testable
 * without a running server or a database.
 */
export interface AppContext {
  readonly config: AppConfig;
  readonly registry: StrategyRegistry;
  readonly aiProvider: AiProvider;
  /**
   * Null when no database is configured. The API stays fully functional
   * without it -- analysis is stateless -- so every route that touches
   * persistence must handle null with a stated reason, never an error.
   */
  readonly persistence: PersistenceLayer | null;
  /**
   * Identity. Null without a database, because sessions and users are stored
   * rows -- the shared machine token still works in that configuration, which
   * is what keeps a stateless deployment usable.
   */
  readonly auth: AuthService | null;
  /**
   * Outcome analytics. Null without a database: there are no stored outcomes to
   * measure, and every analytics route says so rather than returning zeros.
   */
  readonly analytics: AnalyticsService | null;
  /** Paper accounts, risk enforcement and positions. Null without a database. */
  readonly paper: PaperService | null;
  /** Policy coherence check, exposed so routes can refuse an incoherent update. */
  readonly validatePolicy: typeof validatePolicy;
  /**
   * Market-data plane.
   *
   * Nothing here is required: with no provider configured the API stays fully
   * usable and simply reports that ingestion is unavailable. What changed in
   * Phase 10 is that there is no longer ONE provider — an instrument's asset
   * class chooses its provider, which is what `router` is for.
   */
  readonly marketData: {
    /**
     * The provider used where no instrument is in hand — the status indicator
     * and the ingestion worker's default. Null when nothing is configured.
     *
     * Prefer `router` at any call site that HAS an instrument: which provider
     * serves an instrument is a function of its asset class, and reading this
     * field instead is how a crypto adapter ends up being asked for AAPL.
     */
    readonly provider: MarketDataProvider | null;
    /** Routes an instrument to the provider for its asset class. */
    readonly router: ProviderRouter;
    readonly tracker: IngestionTracker;
    status(): Promise<MarketDataStatus>;
  };
  /**
   * The continuous workers. Constructed always, started only when enabled --
   * so `/v1/runtime/status` can report "configured but stopped" rather than
   * the route having to guess.
   */
  readonly runtime: Runtime;
  /**
   * The canonical symbols the analysis worker is configured to run.
   *
   * R6. Exposed so routes report the ACTUAL set rather than re-deriving one
   * symbol from configuration. Always resolved through the catalogue, so a
   * deployment configured with the legacy `BTC-USD` spelling still reports
   * `BTCUSD` — one instrument, named as the rest of the system names it.
   */
  readonly analysisInstruments: readonly string[];
  /** The canonical symbols the ingestion worker keeps fresh. */
  readonly ingestionInstruments: readonly string[];
  /**
   * Request budgets. Always present — an API with no limiter is an API with no
   * limit, so there is no null case to handle at a call site.
   */
  readonly rateLimiter: RateLimiter;
  readonly startedAt: number;
  readonly version: string;
}

export interface CreateContextOptions {
  readonly config: AppConfig;
  readonly registry?: StrategyRegistry;
  readonly aiProvider?: AiProvider;
  readonly persistence?: PersistenceLayer | null;
  readonly marketDataProvider?: MarketDataProvider | null;
  readonly onRuntimeEvent?: (event: RuntimeEvent) => void;
  /**
   * Overrides the store chosen by configuration.
   *
   * Two callers use it: the server, which builds a Redis-backed store from
   * REDIS_URL, and tests, which supply a store with a controlled clock. Without
   * an override the context builds the in-process store, because a context
   * assembled with no arguments must still enforce a limit.
   */
  readonly rateLimitStore?: RateLimitStore;
  readonly startedAt?: number;
  readonly version?: string;
}

/**
 * Evidence tiers for a configured minimum.
 *
 * Each tier is clamped up to the minimum so the ladder stays ordered. Without
 * the clamp, raising the minimum to 500 would leave `developing` at 100 — and a
 * figure could report evidence "developing" while its rate was withheld for
 * being below the minimum, which reads as a contradiction.
 *
 * The effect of raising the minimum is therefore to collapse the lower tiers
 * into "insufficient", which is the honest reading: the operator has declared
 * that less than that much data does not support a rate at all.
 */
function evidenceThresholds(minimumSamples: number): EvidenceThresholds {
  return {
    minimumSamples,
    preliminary: Math.max(minimumSamples, DEFAULT_EVIDENCE_THRESHOLDS.preliminary),
    developing: Math.max(minimumSamples, DEFAULT_EVIDENCE_THRESHOLDS.developing),
    established: Math.max(minimumSamples, DEFAULT_EVIDENCE_THRESHOLDS.established),
  };
}

export function createAppContext(options: CreateContextOptions): AppContext {
  const persistence = options.persistence ?? null;
  /**
   * One router per context, so two asset classes assigned the same provider id
   * share a single adapter instance and therefore a single rate budget.
   *
   * An explicitly injected provider wins for EVERY class. That option means
   * "use this provider", and honouring it only for `marketData.provider` while
   * the router kept answering from configuration split the two apart: the
   * status endpoint saw the injected stub and the ingest route did not, so
   * ingestion 503'd with "no provider configured" against a context that
   * plainly had one.
   */
  const router =
    options.marketDataProvider !== undefined
      ? createFixedRouter(options.marketDataProvider)
      : createProviderRouter({
          crypto: options.config.marketData.provider,
          equity: options.config.marketData.equityProvider,
        });
  const provider = router.primary;
  const tracker = createIngestionTracker();
  const registry = options.registry ?? createDefaultRegistry();
  const workers = options.config.workers;

  // Fall back to a registered strategy rather than failing to boot over a
  // misconfigured id: the API must still serve analysis and status.
  const strategy = registry.has(workers.analysis.strategyId)
    ? registry.get(workers.analysis.strategyId)
    : registry.list()[0];

  /**
   * The instrument the analysis worker runs against.
   *
   * Resolved through the catalogue rather than described inline. This block
   * used to assert `assetClass: 'crypto', pricePrecision: 2` for whatever
   * LIVE_ANALYSIS_SYMBOL happened to be — so configuring the worker for EURUSD
   * would have labelled a currency pair as crypto and rendered five-decimal FX
   * to two places, with nothing in the system disagreeing.
   *
   * A symbol the catalogue does not know keeps its literal form and reports
   * `unknown`, which is the honest description of it. It does not silently
   * become crypto.
   */
  /*
   * D5 — resolve every CONFIGURED analysis instrument against the catalogue.
   *
   * This is where "fail configuration validation" actually bites. The config
   * package is a zod-only leaf and cannot see the catalogue, so the symbol set
   * is structurally validated there and resolved here — and an unknown symbol
   * throws, which means the process does not start.
   *
   * Refusing to boot is the point. A worker that skipped a misconfigured
   * instrument would report itself healthy while analysing less than the
   * operator asked for, and nothing on the status endpoint would say so.
   */
  const analysisInstruments = resolvePlanFromConfig({
    configured: workers.analysis.configured,
    fallbackSymbol: workers.analysis.symbol,
    defaultTimeframe: workers.analysis.timeframe,
    setting: 'ANALYSIS_INSTRUMENTS',
    purpose: 'analysis',
  });

  /*
   * R1 — the ingestion plan, resolved SEPARATELY.
   *
   * An instrument may have market data without being analysed, and that is the
   * normal case: it is what makes a chart available for something the engine
   * has no opinion about. Deriving one from the other would force a choice
   * between analysing everything chartable and letting every unanalysed chart
   * go stale — measured before this change: BTC/USD 49s old, gold 11 hours.
   *
   * Empty falls back to the single analysis symbol, which is exactly what the
   * ingestion worker polled before this setting existed.
   */
  const ingestionInstruments = resolvePlanFromConfig({
    configured: workers.ingestion.configured,
    fallbackSymbol: workers.analysis.symbol,
    defaultTimeframe: workers.analysis.timeframe,
    setting: 'INGESTION_INSTRUMENTS',
    purpose: 'ingestion',
  });

  const analysedInstrument = findInstrument(workers.analysis.symbol);
  const analysisAsset: MarketAsset = analysedInstrument
    ? {
        symbol: analysedInstrument.symbol,
        displayName: analysedInstrument.name,
        assetClass: analysedInstrument.assetClass,
        pricePrecision: analysedInstrument.quoting.pricePrecision,
        isOtc: analysedInstrument.isOtc,
        displaySymbol: analysedInstrument.displaySymbol,
        baseCurrency: analysedInstrument.quoting.base,
        quoteCurrency: analysedInstrument.quoting.quote,
        providerId: analysedInstrument.providerId,
        providerSymbol: analysedInstrument.providerSymbol,
        quantityPrecision: analysedInstrument.quoting.quantityPrecision,
        minimumSize: analysedInstrument.quoting.minimumSize,
        tradingSchedule: analysedInstrument.schedule,
        supportedTimeframes: analysedInstrument.supportedTimeframes,
        inCatalogue: true,
      }
    : {
        symbol: workers.analysis.symbol,
        displayName: workers.analysis.symbol,
        assetClass: 'unknown',
        pricePrecision: 2,
        isOtc: false,
      };

  /**
   * The runtime ingests its OWN instrument, so it needs the provider for that
   * instrument's asset class rather than the primary one. Configure
   * LIVE_ANALYSIS_SYMBOL=EURUSD with only a crypto provider enabled and this is
   * correctly null — the worker then reports "no provider" instead of asking a
   * crypto exchange for a currency pair.
   */
  const runtimeProvider =
    options.marketDataProvider !== undefined
      ? options.marketDataProvider
      : analysedInstrument
        ? router.resolve(analysedInstrument)
        : router.primary;

  const runtime = createRuntime(
    {
      symbol: analysisAsset.symbol,
      timeframe: workers.analysis.timeframe,
      ingestion: workers.ingestion,
      analysis: workers.analysis,
      settlement: workers.settlement,
      maintenance: workers.maintenance,
    },
    {
      provider: runtimeProvider,
      repositories: persistence?.repositories ?? null,
      strategy: strategy!,
      asset: analysisAsset,
      analysisInstruments,
      ingestionInstruments,
      budgetFor: (assetClass) => router.budgetFor(assetClass),
      // Per-class routing for ingestion. Without it every configured
      // instrument was polled through the ANALYSED instrument's provider.
      providerFor: (assetClass) => router.forClass(assetClass),
      tracker,
      ...(options.onRuntimeEvent === undefined ? {} : { onEvent: options.onRuntimeEvent }),
    },
  );

  return {
    config: options.config,
    registry,
    auth: persistence
      ? createAuthService({ repositories: persistence.repositories, config: options.config })
      : null,
    paper: persistence ? createPaperService({ repositories: persistence.repositories }) : null,
    validatePolicy,
    analytics: persistence
      ? createAnalyticsService({
          repositories: persistence.repositories,
          thresholds: evidenceThresholds(options.config.analytics.minimumSamples),
        })
      : null,
    // When AI_PROVIDER=http_service is implemented it is swapped in here; every
    // consumer depends on the AiProvider interface, not on this choice.
    aiProvider: options.aiProvider ?? createRuleBasedAiProvider(),
    persistence,
    marketData: {
      provider,
      router,
      tracker,
      status: () =>
        buildMarketDataStatus({
          provider,
          tracker,
          repositories: persistence?.repositories ?? null,
          stalenessThresholdSeconds: options.config.marketData.stalenessThresholdSeconds,
        }),
    },
    runtime,
    analysisInstruments: analysisInstruments.map((entry) => entry.symbol),
    ingestionInstruments: ingestionInstruments.map((entry) => entry.symbol),
    rateLimiter: createRateLimiter({
      store: options.rateLimitStore ?? createMemoryRateLimitStore(),
      tuning: {
        generalLimit: options.config.server.rateLimit.maxRequests,
        generalWindowMs: options.config.server.rateLimit.windowMs,
      },
    }),
    startedAt: options.startedAt ?? Date.now(),
    version: options.version ?? '0.1.0',
  };
}
