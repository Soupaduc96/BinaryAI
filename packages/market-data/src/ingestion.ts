import {
  TIMEFRAME_SECONDS,
  type CandleSeries,
  type IngestionIssue,
  type IngestionRequest,
  type IngestionRunResult,
  type MarketAsset,
  type MarketDataProvider,
  type Repositories,
  type Timeframe,
} from '@binaryai/types';
import { createPrefixedId } from '@binaryai/utils';
import { errorKind, isRetryable, ProviderError } from './provider-error.js';
import { normalizeProviderResult } from './normalize.js';
import { validateIngestedBatch, withoutRejectedCandles } from './quality.js';
import type { IngestionTracker } from './observability.js';
import type { RateBudget } from './rate-budget.js';

/**
 * Historical ingestion worker.
 *
 *   FETCH -> NORMALIZE -> VALIDATE -> QUALITY SCAN -> UPSERT
 *
 * Bounded at every step, deliberately:
 *  - `from` and `to` are required; there is no "fetch everything" path.
 *  - A run stops at `maxCandles`, and says so rather than truncating silently.
 *  - Retries are capped with exponential backoff, never an infinite loop.
 *  - Requests are spaced to respect the provider's documented rate limit.
 *  - Only retryable failures are retried; a 401 or an unsupported timeframe
 *    fails immediately instead of burning the rate budget.
 *
 * The worker is pure orchestration: clock, sleep and provider are injected, so
 * the whole pipeline is testable without a network or a real delay.
 */

export interface IngestionDeps {
  readonly provider: MarketDataProvider;
  /** Omit to run without persistence; the result reports `persisted: false`. */
  readonly repositories?: Repositories | null;
  readonly tracker?: IngestionTracker;
  /**
   * Full instrument metadata for the asset row this run creates or refreshes.
   *
   * Optional so existing callers keep compiling, but every caller that HAS an
   * instrument should pass it: without one the asset is stored with an
   * 'unknown' class rather than a guessed one.
   */
  readonly asset?: MarketAsset;
  /**
   * Request spacing SHARED with every other run against this provider.
   *
   * R15. Without it each run keeps its own `lastRequestAt`, so N parallel
   * instruments on one vendor each believe they hold the whole allowance —
   * N times the configured budget. Optional so a single-run caller keeps
   * working unchanged; the router supplies one per provider instance.
   */
  readonly budget?: RateBudget;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface IngestionOptions {
  readonly maxRetries?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Hard ceiling on candles for one run. */
  readonly maxCandles?: number;
  readonly signal?: AbortSignal;
}

export const DEFAULT_INGESTION_OPTIONS = {
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
  maxCandles: 5_000,
} as const;

/** Split a range into windows no larger than the provider will serve at once. */
export function planWindows(
  from: number,
  to: number,
  timeframe: Timeframe,
  maxCandlesPerRequest: number,
): Array<{ from: number; to: number }> {
  if (to <= from) return [];
  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  const windowMs = Math.max(stepMs, stepMs * maxCandlesPerRequest);

  const windows: Array<{ from: number; to: number }> = [];
  for (let start = from; start < to; start += windowMs) {
    windows.push({ from: start, to: Math.min(start + windowMs - stepMs, to) });
  }
  return windows;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runHistoricalIngestion(
  request: IngestionRequest,
  deps: IngestionDeps,
  options: IngestionOptions = {},
): Promise<IngestionRunResult> {
  const {
    provider,
    repositories = null,
    tracker,
    asset,
    budget,
    now = Date.now,
    sleep = defaultSleep,
  } = deps;
  const {
    maxRetries = DEFAULT_INGESTION_OPTIONS.maxRetries,
    baseBackoffMs = DEFAULT_INGESTION_OPTIONS.baseBackoffMs,
    maxBackoffMs = DEFAULT_INGESTION_OPTIONS.maxBackoffMs,
    maxCandles = DEFAULT_INGESTION_OPTIONS.maxCandles,
    signal,
  } = options;

  const runId = createPrefixedId('ing');
  const startedAt = now();
  const issues: IngestionIssue[] = [];
  const warnings: string[] = [];

  let requests = 0;
  let candlesRequested = 0;
  let candlesReceived = 0;
  let candlesAccepted = 0;
  let candlesRejected = 0;
  let duplicates = 0;
  let missingIntervals = 0;
  let candlesStored = 0;
  let retries = 0;
  const latencies: number[] = [];
  let coveredFrom: number | null = null;
  let coveredTo: number | null = null;
  let failure: string | undefined;

  const finish = (status: IngestionRunResult['status']): IngestionRunResult => {
    const finishedAt = now();
    const result: IngestionRunResult = {
      runId,
      providerId: provider.capabilities.id,
      symbol: request.symbol,
      timeframe: request.timeframe,
      requestedFrom: request.from,
      requestedTo: request.to,
      coveredFrom,
      coveredTo,
      status,
      metrics: {
        requests,
        candlesRequested,
        candlesReceived,
        candlesAccepted,
        candlesRejected,
        duplicates,
        missingIntervals,
        candlesStored,
        retries,
        providerLatencyMsAvg:
          latencies.length === 0
            ? null
            : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
        providerLatencyMsMax: latencies.length === 0 ? null : Math.max(...latencies),
        durationMs: finishedAt - startedAt,
      },
      issues,
      warnings,
      ...(failure === undefined ? {} : { error: failure }),
      startedAt,
      finishedAt,
      persisted: repositories !== null && candlesStored > 0,
    };
    tracker?.record(result);
    return result;
  };

  // --- preconditions -------------------------------------------------------
  if (!provider.capabilities.supportedTimeframes.includes(request.timeframe)) {
    failure = `Provider ${provider.capabilities.id} does not serve ${request.timeframe} candles.`;
    issues.push({ code: 'unsupported_timeframe', severity: 'error', message: failure });
    return finish('failed');
  }
  if (request.to <= request.from) {
    failure = 'Ingestion range is empty: `to` must be after `from`.';
    return finish('failed');
  }

  const ceiling = Math.min(request.maxCandles ?? maxCandles, maxCandles);
  const windows = planWindows(
    request.from,
    request.to,
    request.timeframe,
    provider.capabilities.maxCandlesPerRequest,
  );
  const minIntervalMs = Math.ceil(1000 / Math.max(provider.capabilities.rateLimitPerSecond, 1));

  let lastRequestAt = 0;

  for (const window of windows) {
    if (signal?.aborted) {
      warnings.push('Run cancelled before completing the requested range.');
      return finish('partial');
    }
    if (candlesAccepted >= ceiling) {
      warnings.push(
        `Stopped at the ${ceiling}-candle ceiling for one run; the requested range was not fully covered.`,
      );
      return finish('partial');
    }

    // Rate limiting. When the caller supplies a provider-scoped budget, every
    // concurrent run against that provider queues through the SAME one; the
    // local fallback below is correct only for a single run (see R15).
    if (budget) {
      await budget.acquire();
    } else {
      const sinceLast = now() - lastRequestAt;
      if (lastRequestAt !== 0 && sinceLast < minIntervalMs) {
        await sleep(minIntervalMs - sinceLast);
      }
    }

    let attempt = 0;
    let batchDone = false;

    while (!batchDone) {
      try {
        lastRequestAt = now();
        requests += 1;
        candlesRequested += provider.capabilities.maxCandlesPerRequest;

        const fetched = await provider.fetchCandles({
          symbol: request.symbol,
          timeframe: request.timeframe,
          from: window.from,
          to: window.to,
        });
        latencies.push(fetched.meta.latencyMs);
        candlesReceived += fetched.candles.length;

        const normalized = normalizeProviderResult(fetched);
        if (!normalized.ok) {
          issues.push({
            code: 'invalid_ohlc',
            severity: 'error',
            message: `Normalization rejected the batch: ${normalized.error.join('; ')}`,
          });
          candlesRejected += fetched.candles.length;
          batchDone = true;
          break;
        }

        const report = validateIngestedBatch(normalized.value.series, {
          now: now(),
          capabilities: provider.capabilities,
          // Historical windows are old by definition; staleness is judged for
          // the run as a whole, not per backfill batch.
          stalenessThresholdSeconds: Number.MAX_SAFE_INTEGER,
        });

        candlesAccepted += report.accepted;
        candlesRejected += report.rejected;
        duplicates += report.duplicates;
        missingIntervals += report.missingIntervals;
        issues.push(...report.issues);

        const clean = withoutRejectedCandles(normalized.value.series, report);
        if (clean.candles.length > 0) {
          const first = clean.candles[0]?.timestamp ?? null;
          const last = clean.candles.at(-1)?.timestamp ?? null;
          if (first !== null)
            coveredFrom = coveredFrom === null ? first : Math.min(coveredFrom, first);
          if (last !== null) coveredTo = coveredTo === null ? last : Math.max(coveredTo, last);

          if (repositories) {
            candlesStored += await persist(repositories, clean, request.symbol, asset);
          }
        }

        batchDone = true;
      } catch (error) {
        const kind = errorKind(error);
        const message = error instanceof Error ? error.message : String(error);

        if (!isRetryable(error) || attempt >= maxRetries) {
          failure = `${kind}: ${message}`;
          issues.push({
            code: kind === 'unsupported' ? 'unsupported_timeframe' : 'empty_response',
            severity: 'error',
            message: failure,
          });
          // Partial data already stored stays stored, and the run says so.
          return finish(candlesStored > 0 ? 'partial' : 'failed');
        }

        attempt += 1;
        retries += 1;
        const backoff = Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs);
        warnings.push(`Retry ${attempt}/${maxRetries} after ${kind} (${backoff}ms backoff).`);
        await sleep(backoff);
      }
    }
  }

  if (repositories) {
    await recordEvent(repositories, provider, request, candlesStored, candlesRejected);
  }

  return finish('completed');
}

/**
 * Ensures the asset row exists, then writes the batch idempotently.
 *
 * The descriptor is supplied by the caller, which resolves it from the
 * catalogue. This used to assert `assetClass: 'crypto', pricePrecision: 2` for
 * every instrument it created — harmless while BinaryAI served one crypto pair,
 * and wrong the moment it served anything else: EUR/USD would have been stored
 * as crypto and rendered to two decimals.
 *
 * The upsert runs unconditionally rather than only on a missing row, so an
 * instrument stored before the catalogue existed gains its metadata on the next
 * ingest instead of keeping stale values forever. The repository COALESCEs, so
 * a caller with partial metadata cannot blank out what is already known.
 */
async function persist(
  repositories: Repositories,
  series: CandleSeries,
  symbol: string,
  asset: MarketAsset | undefined,
): Promise<number> {
  await repositories.assets.upsert(
    asset ?? {
      // No descriptor: record the symbol and say plainly that its class is not
      // known. Guessing 'crypto' here is what produced mislabelled rows.
      symbol,
      displayName: symbol,
      assetClass: 'unknown',
      pricePrecision: 2,
      isOtc: false,
    },
  );
  return repositories.candles.upsertSeries(series);
}

async function recordEvent(
  repositories: Repositories,
  provider: MarketDataProvider,
  request: IngestionRequest,
  stored: number,
  rejected: number,
): Promise<void> {
  await repositories.systemEvents.record({
    level: rejected > 0 ? 'warning' : 'info',
    category: 'market_data',
    code: 'ingestion_completed',
    message: `Ingested ${stored} candle(s) for ${request.symbol} ${request.timeframe} from ${provider.capabilities.id}`,
    executionMode: 'demo',
    context: {
      provider: provider.capabilities.id,
      symbol: request.symbol,
      timeframe: request.timeframe,
      stored,
      rejected,
      origin: provider.capabilities.dataOrigin,
    },
  });
}

export { ProviderError };
