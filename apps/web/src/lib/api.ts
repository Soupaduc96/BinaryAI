import { cookies } from 'next/headers';
import { cache } from 'react';
import { SESSION_COOKIE, apiBaseUrl } from './api-base';
import type {
  BacktestRunSummary,
  CandleSeries,
  MarketDataStatus,
  ProviderCapabilities,
  StoredAsset,
  PersistedSignal,
  SignalSummary,
  StrategyMetadata,
  StrategyParameterSpec,
  SystemStatus,
} from '@binaryai/types';

/**
 * API client for server components.
 *
 * Every call can fail -- the API may simply not be running -- and failure is
 * modelled as a value, not an exception. The dashboard then renders an honest
 * "API unreachable" state instead of a blank page or, worse, placeholder
 * numbers that look like data.
 *
 * Each fetcher is wrapped in React's `cache`, so the header and the page body
 * asking for the same thing costs one request per render, not two.
 *
 * The session cookie is forwarded on every call. The dashboard renders on the
 * SERVER, so the browser's cookie reaches Next but would stop there -- without
 * this the API would see an anonymous caller and return only the shared
 * analysis stream, and a signed-in user would silently lose their own data.
 */

/**
 * Per-request ceiling.
 *
 * The API is local, so a slow response is usually a fault rather than load.
 * The exception is the local PGlite bridge, which serves exactly ONE
 * connection: the dashboard issues its feeds concurrently, and against the
 * bridge they queue rather than run in parallel. A ceiling tuned for a real
 * server therefore reports a HEALTHY local stack as unreachable — the page
 * fills with UNAVAILABLE panels that are describing a queue, not an outage.
 *
 * Against PostgreSQL these requests are genuinely concurrent and return well
 * inside this budget, so the higher ceiling costs nothing there.
 */
export const TIMEOUT_MS = 8000;

/**
 * A call's outcome.
 *
 * `unauthorized` is separate from a transport failure on purpose. A 401 means
 * the API is running and answering -- the caller simply is not signed in --
 * and rendering that as "OFFLINE" would send an operator to debug a server
 * that is working perfectly. The dashboard has to be able to tell the two
 * apart to describe either honestly.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      status?: number;
      unauthorized?: boolean;
      /**
       * The request was refused for asking too often, not because anything
       * failed. Kept separate from `unauthorized` and from a generic error
       * because the honest reading differs: this one resolves by waiting.
       */
      throttled?: boolean;
    };

export async function getJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
      headers: { accept: 'application/json', ...(await forwardedCookies()) },
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        // 401 and 403 both mean "answered, but not for you".
        unauthorized: response.status === 401 || response.status === 403,
        throttled: response.status === 429,
        error:
          response.status === 401
            ? `Not signed in (${path}).`
            : response.status === 429
              ? // 429 is not a failure. Saying "API responded 429" invites the
                // reader to conclude something is broken; it is a request-rate
                // ceiling and it clears on its own.
                'Request limit reached. This is a rate limit, not an error — the data returns shortly.'
              : `API responded ${response.status} for ${path}`,
      };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not reach the API at ${apiBaseUrl} (${message})` };
  }
}

export type StrategySummary = StrategyMetadata & { parameters: StrategyParameterSpec[] };

/** A list plus the API's own explanation of why it may be empty. */
export interface SignalFeed {
  readonly signals: readonly SignalSummary[];
  readonly total: number;
  readonly reason?: string;
}

export interface BacktestFeed {
  readonly runs: readonly BacktestRunSummary[];
  readonly reason?: string;
}

export interface CalibrationStatus {
  readonly calibration: string;
  readonly implemented: boolean;
  readonly settledOutcomes: number;
  readonly persistenceConfigured: boolean;
  readonly reason: string;
}

export const fetchSystemStatus = cache((): Promise<ApiResult<SystemStatus>> =>
  getJson<SystemStatus>('/v1/system/status'),
);

export const fetchStrategies = cache(async (): Promise<ApiResult<StrategySummary[]>> => {
  const result = await getJson<{ strategies: StrategySummary[] }>('/v1/strategies');
  return result.ok ? { ok: true, data: result.data.strategies } : result;
});

/**
 * Signals for ONE instrument.
 *
 * D2. This used to take no argument and fetch the newest signals across every
 * instrument; the workspace then displayed signals[0] as "the decision" beside
 * a chart for whatever instrument was selected. Invisible while exactly one
 * instrument was analysed, and a guaranteed mix-up the moment a second is.
 *
 * The symbol is now REQUIRED. A caller with no resolved instrument has no
 * business asking for its decision, and making the parameter optional would
 * leave the old bug one default away.
 */
export const fetchSignals = cache(
  (assetSymbol: string, limit = 10): Promise<ApiResult<SignalFeed>> =>
    getJson<SignalFeed>(`/v1/signals?asset=${encodeURIComponent(assetSymbol)}&limit=${limit}`),
);

export const fetchBacktestRuns = cache((): Promise<ApiResult<BacktestFeed>> =>
  getJson<BacktestFeed>('/v1/backtest/runs'),
);

export const fetchCalibrationStatus = cache((): Promise<ApiResult<CalibrationStatus>> =>
  getJson<CalibrationStatus>('/v1/calibration/status'),
);

/**
 * The full decision behind a stored signal: indicators, confirmations,
 * conflicts and the reasoning the engine recorded. Only called when a signal
 * actually exists -- there is nothing to show, and nothing to invent, otherwise.
 */
export const fetchSignalDetail = cache((id: string): Promise<ApiResult<PersistedSignal>> =>
  getJson<PersistedSignal>(`/v1/signals/${encodeURIComponent(id)}`),
);

/** Market-data plane. Everything here comes from the API, never the provider. */
export interface MarketDataFeed {
  readonly status: MarketDataStatus;
  readonly provider: ProviderCapabilities | null;
  readonly ingestion: {
    readonly runs: number;
    readonly lastSuccessAt: number | null;
    readonly lastError: string | null;
    readonly candlesStoredTotal: number;
    readonly candlesRejectedTotal: number;
    readonly lastLatencyMs: number | null;
  };
}

export interface AssetFeed {
  readonly assets: readonly StoredAsset[];
  readonly reason?: string;
}

export interface CandleFeed {
  readonly series: CandleSeries | null;
  readonly count?: number;
  readonly reason?: string;
}

export const fetchMarketDataStatus = cache((): Promise<ApiResult<MarketDataFeed>> =>
  getJson<MarketDataFeed>('/v1/market-data/status'),
);

export const fetchAssets = cache((): Promise<ApiResult<AssetFeed>> =>
  getJson<AssetFeed>('/v1/assets'),
);

/**
 * Stored candles for one instrument and timeframe. Reads what BinaryAI
 * validated and persisted -- never straight from the provider, so the chart
 * cannot show a bar that failed the quality scan.
 */
export const fetchCandles = cache(
  (asset: string, timeframe: string, limit = 300): Promise<ApiResult<CandleFeed>> =>
    getJson<CandleFeed>(
      `/v1/market-data/candles?asset=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}`,
    ),
);

/**
 * The incoming request's cookies, ready to forward.
 *
 * Only the session cookie is passed on -- forwarding everything would hand the
 * API unrelated cookies from the same domain, which it has no business seeing.
 * Outside a request context (a build-time render) there is nothing to forward
 * and the call proceeds anonymously.
 */
export async function forwardedCookies(): Promise<Record<string, string>> {
  try {
    const store = await cookies();
    const session = store.get(SESSION_COOKIE);
    return session ? { cookie: `${session.name}=${session.value}` } : {};
  } catch {
    return {};
  }
}

// Re-exported so existing server-side imports keep working unchanged.
export { SESSION_COOKIE, apiBaseUrl } from './api-base';

// ------------------------------------------------------------------- auth --

/**
 * Who the current request belongs to, and what sign-in options exist.
 *
 * Public by necessity: it is the first thing a login screen asks, before any
 * credential exists to present.
 */
export interface AuthContext {
  readonly authEnabled: boolean;
  readonly accountsAvailable: boolean;
  readonly bootstrapOpen: boolean;
  readonly registrationOpen: boolean;
  readonly authenticated: boolean;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly role: 'user' | 'admin';
  } | null;
  readonly reason?: string;
}

export const fetchAuthContext = cache((): Promise<ApiResult<AuthContext>> =>
  getJson<AuthContext>('/v1/auth/context'),
);

// -------------------------------------------------------------- analytics --

/**
 * Outcome analytics.
 *
 * Note `value: number | null` on every rate. Null is not "loading" and not
 * zero: it means the rate is undefined, either because nothing settled or
 * because too little did to report one. Components must render it as an absence.
 */
export interface ObservedRate {
  readonly value: number | null;
  readonly sampleSize: number;
  readonly evidence: 'insufficient' | 'preliminary' | 'developing' | 'established';
  readonly sufficient: boolean;
}

export interface OutcomeCounts {
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly unresolved: number;
  readonly invalid: number;
  readonly skipped: number;
  readonly total: number;
}

export interface AnalyticsOverviewFeed {
  readonly overview: {
    readonly counts: OutcomeCounts;
    readonly observedAccuracy: ObservedRate;
    readonly meanConfidence: number | null;
    readonly settledSamples: number;
    readonly pendingSettlement: number;
    readonly firstSettledAt: number | null;
    readonly lastSettledAt: number | null;
    readonly provenance: { readonly scope: string; readonly settlementSemantics: string };
  };
  readonly evidence: { readonly minimumSampleSize: number };
  readonly semantics: string;
}

export interface ConfidenceBucketView {
  readonly id: string;
  readonly midpoint: number;
  readonly counts: OutcomeCounts;
  readonly observedAccuracy: ObservedRate;
  readonly meanConfidence: number | null;
}

export interface CalibrationFeed {
  readonly calibration: {
    readonly implemented: boolean;
    readonly methodology: {
      readonly method: string;
      readonly version: string;
      readonly bucketVersion: string;
      readonly confidenceSource: string;
    };
    readonly buckets: readonly ConfidenceBucketView[];
    readonly eligibleSamples: number;
    readonly settledSamples: number;
    readonly excludedSamples: number;
    readonly exclusions: Readonly<Record<string, number>>;
    readonly evidence: ObservedRate['evidence'];
    readonly minimumSampleSize: number;
    readonly relationship:
      'not_established' | 'monotonic_increasing' | 'monotonic_decreasing' | 'non_monotonic';
    readonly divergence: number | null;
    readonly semantics: string;
    readonly limitations: readonly string[];
  };
}

export interface AnalyticsGroupView {
  readonly key: string;
  readonly version?: string | null;
  readonly counts: OutcomeCounts;
  readonly observedAccuracy: ObservedRate;
  readonly meanConfidence: number | null;
}

export interface AnalyticsGroupFeed {
  readonly dimension: string;
  readonly groups: readonly AnalyticsGroupView[];
  readonly ranking: string;
}

// ----------------------------------------------------------- paper account --

export interface PaperAccountFeed {
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly mode: string;
    readonly kind: string;
    readonly isDefault: boolean;
  };
  readonly paper: {
    readonly accountingModel: 'exposure_only' | 'not_configured';
    readonly unit: string;
    readonly allocatedUnits: number;
    readonly committedUnits: number;
    readonly availableUnits: number;
    readonly openPositions: number;
    readonly settledPositions: number;
    readonly lastActivityAt: number | null;
    readonly accountingNote: string;
  };
}

export interface RiskPolicyFeed {
  readonly policy: {
    readonly version: number;
    readonly updatedAt: number;
    readonly maxPositionSize: number;
    readonly maxDailyExposure: number;
    readonly allowedStrategies: readonly string[] | null;
    readonly allowedTimeframes: readonly string[] | null;
    readonly allowedAssets: readonly string[] | null;
    readonly limits: {
      readonly maxOpenPositions: number;
      readonly maxConsecutiveLosses: number;
      readonly cooldownSecondsAfterLoss: number;
      readonly minConfidence: number;
      readonly allowLiveExecution: boolean;
    };
  };
  readonly enforcement: string;
}

export interface PaperPositionView {
  readonly id: string;
  /** The analysis this action was taken on. Relates a position to its signal. */
  readonly signalId: string;
  readonly assetSymbol: string;
  readonly timeframe: string;
  readonly direction: 'call' | 'put';
  readonly size: number;
  readonly entryPrice: number;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly status: 'open' | 'pending_settlement' | 'settled' | 'cancelled' | 'rejected';
  readonly settledAt: number | null;
  readonly settlementPrice: number | null;
  readonly result: 'win' | 'loss' | 'tie' | 'unresolved' | null;
  /** Provenance of the settling price. Never 'broker'. */
  readonly dataOrigin: string | null;
  /**
   * The bar that settles this position, computed by the SAME rule the
   * settlement worker applies. Never re-derived in the client: a UI computing
   * its own bar could disagree with the one that actually settled it.
   */
  readonly settlementCandleAt: number | null;
  /**
   * What a model made of the outcome. Null when none did — which is not the
   * same as a computed zero, and is rendered differently.
   */
  readonly simulation: {
    readonly delta: number;
    readonly modelKey: string;
    readonly modelVersion: string;
    readonly modelName: string;
  } | null;
}

/**
 * What SCOPE a feed's rows were drawn from.
 *
 * R10. Positions and ledger entries can be read account-wide or for one
 * instrument, and the two look identical once rendered — a user seeing three
 * open positions has no way to tell whether that is three in total or three on
 * EUR/USD. The API states the scope on every response and the UI shows it,
 * rather than either side inferring it from the presence of a query parameter.
 */
export interface FeedScope {
  readonly scope: 'account' | 'instrument';
  /** Canonical symbol when instrument-scoped; null when account-wide. */
  readonly assetSymbol: string | null;
}

export interface PositionsFeed extends FeedScope {
  readonly positions: readonly PaperPositionView[];
  readonly accounting: string;
}

export interface RiskEventView {
  readonly id: string;
  readonly at: number;
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly message: string;
}

export interface RiskEventsFeed {
  readonly events: readonly RiskEventView[];
}

export const fetchPaperAccount = cache((): Promise<ApiResult<PaperAccountFeed>> =>
  getJson<PaperAccountFeed>('/v1/accounts/me'),
);

export const fetchRiskPolicy = cache((): Promise<ApiResult<RiskPolicyFeed>> =>
  getJson<RiskPolicyFeed>('/v1/accounts/me/risk'),
);

/**
 * Paper positions.
 *
 * ACCOUNT-WIDE by default, deliberately: an account has one exposure and one
 * set of open positions, and hiding the ones on other instruments behind the
 * workspace's current selection would let a user believe they were flat while
 * exposure sat elsewhere. Pass `assetSymbol` to narrow it; the response says
 * which scope it answered in either way.
 */
export const fetchPositions = cache((assetSymbol?: string): Promise<ApiResult<PositionsFeed>> =>
  getJson<PositionsFeed>(
    assetSymbol === undefined
      ? '/v1/accounts/me/positions?limit=12'
      : `/v1/accounts/me/positions?limit=12&asset=${encodeURIComponent(assetSymbol)}`,
  ),
);

/**
 * One append-only ledger entry.
 *
 * `simulationModelId`/`Version` are present only on `simulated_return` rows,
 * enforced by a database CHECK: a simulated figure that cannot name the model
 * that produced it cannot be written. The UI relies on that rather than
 * re-deriving attribution.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly type: string;
  readonly amount: number;
  readonly positionId: string | null;
  readonly occurredAt: number;
  readonly source: string;
  readonly metadata: Record<string, unknown>;
  readonly simulationModelId: string | null;
  readonly simulationModelVersion: string | null;
}

export interface LedgerFeed extends FeedScope {
  readonly entries: readonly LedgerEntry[];
  readonly reason?: string;
}

/**
 * The ledger itself, not the summary derived from it.
 *
 * `GET /v1/accounts/:id/ledger` has existed since Phase 5 with no caller — the
 * dashboard only ever showed totals computed from the account. The Ledger
 * workspace is what surfaces the entries those totals are made of.
 */
export interface RuntimeFeed {
  readonly runtime: {
    readonly analysis: {
      readonly enabled: boolean;
      /** Null when analysis is not running; never a guess. */
      readonly symbol: string | null;
      readonly timeframe: string | null;
      readonly ticks: number;
      readonly lastError: string | null;
    };
    readonly ingestion: { readonly enabled: boolean; readonly ticks: number };
    readonly settlement: { readonly enabled: boolean; readonly settledTotal: number };
    readonly maintenance: { readonly enabled: boolean; readonly sessionsDeleted: number | null };
  };
}

/**
 * Worker state.
 *
 * Needed by Analysis to name the instrument the engine actually runs on, which
 * is not necessarily the one being viewed — the difference is stated in the UI
 * rather than glossed over.
 */
export const fetchRuntimeStatus = cache((): Promise<ApiResult<RuntimeFeed>> =>
  getJson<RuntimeFeed>('/v1/runtime/status'),
);

/**
 * Ledger entries. Account-wide by default, for the same reason as positions.
 *
 * An instrument-scoped read reaches entries THROUGH their position, so
 * allocations, adjustments and resets — which belong to no instrument — are
 * correctly absent from it. The scope label is what makes that legible.
 */
export const fetchLedger = cache((assetSymbol?: string): Promise<ApiResult<LedgerFeed>> =>
  getJson<LedgerFeed>(
    assetSymbol === undefined
      ? '/v1/accounts/me/ledger?limit=50'
      : `/v1/accounts/me/ledger?limit=50&asset=${encodeURIComponent(assetSymbol)}`,
  ),
);

export const fetchRiskEvents = cache((): Promise<ApiResult<RiskEventsFeed>> =>
  getJson<RiskEventsFeed>('/v1/accounts/me/risk-events?limit=8'),
);

// --------------------------------------------------- paper simulation --

/**
 * A published simulation model.
 *
 * The parameters are carried to the client so the rules behind a figure can be
 * read rather than taken on trust. They are display-only: the client cannot
 * send them back, and the API would reject a body that tried.
 */
export interface SimulationModelView {
  readonly id: string;
  readonly modelKey: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly status: 'draft' | 'active' | 'deprecated';
  readonly parameters: {
    readonly startingUnits: number;
    readonly simulatedReturnRate: number;
    readonly lossRule: string;
    readonly lossRefundRate: number;
    readonly tieRule: string;
    readonly roundingDecimals: number;
    readonly settlementRule: string;
  };
}

export interface SimulationFeed {
  readonly simulation: {
    readonly enabled: boolean;
    readonly model: SimulationModelView | null;
    /**
     * Null when no model is selected, never zero.
     *
     * "This account has no simulation" and "this account has simulated zero
     * units" are different statements. Rendering the first as a number would
     * report a result the account does not have.
     */
    readonly startingUnits: number | null;
    readonly currentUnits: number | null;
    readonly simulatedReturn: number | null;
    readonly returnFraction: number | null;
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    readonly simulatedPositions: number;
    /** Expired with no usable candle. Never folded into losses. */
    readonly unresolved: number;
    readonly disclosure: string;
  };
  readonly separation: string;
}

export const fetchSimulation = cache((): Promise<ApiResult<SimulationFeed>> =>
  getJson<SimulationFeed>('/v1/accounts/me/performance'),
);

export interface SimulationModelsFeed {
  readonly models: readonly SimulationModelView[];
  readonly disclosure: string;
}

export const fetchSimulationModels = cache((): Promise<ApiResult<SimulationModelsFeed>> =>
  getJson<SimulationModelsFeed>('/v1/simulation/models'),
);
