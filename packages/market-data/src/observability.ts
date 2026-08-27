import type {
  IngestionRunResult,
  MarketDataProvider,
  MarketDataStatus,
  Repositories,
} from '@binaryai/types';

/**
 * Ingestion observability.
 *
 * Tracks what actually happened so the dashboard's MARKET DATA indicator
 * reflects reality rather than configuration. The distinction that matters most
 * is `stale`: a provider can be reachable while the newest candle is hours old,
 * and showing that as "connected" would present old prices as current.
 *
 * In-memory by design for this phase — process-local counters, with durable
 * history already going to `system_events`. A metrics backend is a later
 * concern and would sit behind this same interface.
 */

export interface IngestionSnapshot {
  readonly runs: number;
  readonly lastRunId: string | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastError: string | null;
  readonly candlesStoredTotal: number;
  readonly candlesRejectedTotal: number;
  readonly lastLatencyMs: number | null;
  readonly lastResult: IngestionRunResult | null;
}

export interface IngestionTracker {
  record(result: IngestionRunResult): void;
  snapshot(): IngestionSnapshot;
}

export function createIngestionTracker(): IngestionTracker {
  let runs = 0;
  let lastRunId: string | null = null;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let lastError: string | null = null;
  let candlesStoredTotal = 0;
  let candlesRejectedTotal = 0;
  let lastLatencyMs: number | null = null;
  let lastResult: IngestionRunResult | null = null;

  return {
    record(result: IngestionRunResult): void {
      runs += 1;
      lastRunId = result.runId;
      lastResult = result;
      candlesStoredTotal += result.metrics.candlesStored;
      candlesRejectedTotal += result.metrics.candlesRejected;
      lastLatencyMs = result.metrics.providerLatencyMsAvg;

      if (result.status === 'failed') {
        lastFailureAt = result.finishedAt;
        lastError = result.error ?? 'Ingestion failed without a stated reason.';
      } else {
        lastSuccessAt = result.finishedAt;
        // A partial run still succeeded in part; the warning carries the caveat.
        if (result.status === 'partial') {
          lastError = result.error ?? result.warnings[0] ?? null;
        } else {
          lastError = null;
        }
      }
    },

    snapshot(): IngestionSnapshot {
      return {
        runs,
        lastRunId,
        lastSuccessAt,
        lastFailureAt,
        lastError,
        candlesStoredTotal,
        candlesRejectedTotal,
        lastLatencyMs,
        lastResult,
      };
    },
  };
}

export interface StatusInputs {
  readonly provider: MarketDataProvider | null;
  readonly tracker: IngestionTracker | null;
  readonly repositories?: Repositories | null;
  readonly now?: number;
  /** Age beyond which stored data is reported stale. */
  readonly stalenessThresholdSeconds?: number;
  /** Newest stored candle, if the caller already knows it. */
  readonly lastCandleAt?: number | null;
}

/**
 * Builds the market-data status the API and dashboard consume.
 *
 * Ordering of states is deliberate: not configured -> unreachable -> never
 * ingested -> stale -> connected. Each earlier state is a stronger statement
 * about what the user should NOT trust.
 */
export async function buildMarketDataStatus(inputs: StatusInputs): Promise<MarketDataStatus> {
  const {
    provider,
    tracker,
    repositories = null,
    now = Date.now(),
    stalenessThresholdSeconds = 300,
  } = inputs;

  if (!provider) {
    return {
      state: 'not_configured',
      providerId: null,
      providerName: null,
      origin: null,
      reachable: false,
      lastCandleAt: null,
      lastSuccessfulIngestionAt: null,
      lastError: null,
      lastErrorAt: null,
      stalenessSeconds: null,
      detail:
        'No market-data provider is configured. Set MARKET_DATA_PROVIDER to enable ingestion.',
    };
  }

  const snapshot = tracker?.snapshot() ?? null;
  const reachable = await provider.ping();

  let lastCandleAt = inputs.lastCandleAt ?? null;
  if (lastCandleAt === null && repositories) {
    lastCandleAt = await newestStoredCandle(repositories);
  }

  const base = {
    providerId: provider.capabilities.id,
    providerName: provider.capabilities.displayName,
    origin: provider.capabilities.dataOrigin,
    reachable,
    lastCandleAt,
    lastSuccessfulIngestionAt: snapshot?.lastSuccessAt ?? null,
    lastError: snapshot?.lastError ?? null,
    lastErrorAt: snapshot?.lastFailureAt ?? null,
  };

  if (!reachable) {
    return {
      ...base,
      state: 'disconnected',
      stalenessSeconds: lastCandleAt === null ? null : Math.round((now - lastCandleAt) / 1000),
      detail: `${provider.capabilities.displayName} is not reachable. Stored data is not being refreshed.`,
    };
  }

  if (lastCandleAt === null) {
    return {
      ...base,
      state: 'degraded',
      stalenessSeconds: null,
      detail: `${provider.capabilities.displayName} is reachable, but no candles have been ingested yet.`,
    };
  }

  const stalenessSeconds = Math.round((now - lastCandleAt) / 1000);
  if (stalenessSeconds > stalenessThresholdSeconds) {
    return {
      ...base,
      state: 'stale',
      stalenessSeconds,
      detail: `Newest candle is ${stalenessSeconds}s old, beyond the ${stalenessThresholdSeconds}s threshold. Data is not current.`,
    };
  }

  return {
    ...base,
    state: 'connected',
    stalenessSeconds,
    detail: `${provider.capabilities.displayName} (${provider.capabilities.dataOrigin} data), newest candle ${stalenessSeconds}s old.`,
  };
}

/**
 * Newest stored candle, or null if it cannot be read.
 *
 * Null covers two cases on purpose: nothing is stored, and the database did not
 * answer. Both mean "there is no timestamp to report", and neither is allowed
 * to become an exception — this function is called while building the status
 * response, and a throw here would turn the one endpoint an operator consults
 * during a database outage into a 500.
 *
 * The alternative, reporting a stale timestamp or a zero, would be worse than
 * unknown: it would put a definite-looking figure above a chart with no data
 * behind it.
 */
async function newestStoredCandle(repositories: Repositories): Promise<number | null> {
  try {
    return await scanNewestStoredCandle(repositories);
  } catch {
    return null;
  }
}

async function scanNewestStoredCandle(repositories: Repositories): Promise<number | null> {
  const assets = await repositories.assets.list();
  let newest: number | null = null;
  for (const asset of assets) {
    for (const timeframe of ['1m', '5m', '15m', '1h', '1d'] as const) {
      const series = await repositories.candles.latest(asset.symbol, timeframe, 1);
      const at = series?.candles.at(-1)?.timestamp ?? null;
      if (at !== null && (newest === null || at > newest)) newest = at;
    }
  }
  return newest;
}
