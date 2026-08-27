import type { AppConfig } from '@binaryai/config';
import { createRuleBasedAiProvider } from '@binaryai/engine';
import { createDefaultRegistry, type StrategyRegistry } from '@binaryai/strategies';
import {
  buildMarketDataStatus,
  createIngestionTracker,
  createProvider,
  type IngestionTracker,
} from '@binaryai/market-data';
import { createRuntime, type Runtime, type RuntimeEvent } from '@binaryai/runtime';
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
   * Market-data plane. `provider` is null when MARKET_DATA_PROVIDER=none, which
   * is a valid configuration: the API stays fully usable without ingestion.
   */
  readonly marketData: {
    readonly provider: MarketDataProvider | null;
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
  const provider =
    options.marketDataProvider !== undefined
      ? options.marketDataProvider
      : createProvider(options.config.marketData.provider);
  const tracker = createIngestionTracker();
  const registry = options.registry ?? createDefaultRegistry();
  const workers = options.config.workers;

  // Fall back to a registered strategy rather than failing to boot over a
  // misconfigured id: the API must still serve analysis and status.
  const strategy = registry.has(workers.analysis.strategyId)
    ? registry.get(workers.analysis.strategyId)
    : registry.list()[0];

  const runtime = createRuntime(
    {
      symbol: workers.analysis.symbol,
      timeframe: workers.analysis.timeframe,
      ingestion: workers.ingestion,
      analysis: workers.analysis,
      settlement: workers.settlement,
      maintenance: workers.maintenance,
    },
    {
      provider,
      repositories: persistence?.repositories ?? null,
      strategy: strategy!,
      asset: {
        symbol: workers.analysis.symbol,
        displayName: workers.analysis.symbol,
        assetClass: 'crypto',
        pricePrecision: 2,
        isOtc: false,
      },
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
