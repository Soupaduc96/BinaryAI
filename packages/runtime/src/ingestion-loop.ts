import {
  runHistoricalIngestion,
  type IngestionTracker,
  type RateBudget,
} from '@binaryai/market-data';
import {
  TIMEFRAME_SECONDS,
  type IngestionRunResult,
  type MarketAsset,
  type MarketDataProvider,
  type Repositories,
  type Timeframe,
} from '@binaryai/types';

/**
 * Continuous ingestion.
 *
 * This is a thin planner around the EXISTING bounded ingestion worker — it
 * decides *which window* to fetch and then delegates. There is no second
 * ingestion implementation, so retries, backoff, rate limiting, validation and
 * idempotent upserts all behave identically to a manual backfill.
 *
 * Restart-safe by construction: the window is derived from the newest stored
 * candle, not from memory. After a crash the loop resumes from the database.
 */

export interface IngestionCycleDeps {
  readonly provider: MarketDataProvider;
  readonly repositories: Repositories | null;
  /**
   * Catalogue metadata for the instrument being polled.
   *
   * Without it the ingestion pipeline falls back to describing the asset as
   * 'unknown', and because the asset upsert overwrites the class on every run,
   * the polled instrument's class was being DOWNGRADED on every tick. Observed
   * live: BTCUSD stored as 'unknown' while every hand-ingested instrument kept
   * its correct class, because the ingest ROUTE passed a descriptor and this
   * worker did not.
   */
  readonly asset?: MarketAsset;
  /** Provider-scoped request spacing, shared across instruments (R15). */
  readonly budget?: RateBudget;
  readonly tracker?: IngestionTracker;
  readonly now?: () => number;
}

export interface IngestionCycleOptions {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /**
   * Bars re-fetched behind the newest stored candle every cycle.
   *
   * Overlap absorbs clock drift, provider lag and a missed cycle. It is safe
   * because upserts are idempotent: re-delivering a bar updates it rather than
   * duplicating, and a bar that was still forming last cycle gets its final
   * values this cycle.
   */
  readonly overlapCandles?: number;
  /** Bars fetched on a cold start when nothing is stored yet. */
  readonly coldStartCandles?: number;
  readonly maxCandles?: number;
  /**
   * Fetch the FULL cold-start window even when candles are already stored.
   *
   * The normal window is `newest - overlap`, which only ever extends forward.
   * That is right in steady state and wrong exactly once: if the very first
   * ingest for an instrument was cut short — an interrupted process, a partial
   * write, a provider hiccup — the missing history is never revisited, because
   * every later cycle starts from the newest bar it already has.
   *
   * Observed: AAPL held 31 daily bars spanning one month while Yahoo served
   * 206 for the same window BinaryAI had asked for. Nothing looked wrong.
   * Freshness read `live, 0 bars behind` because the NEWEST bar was current;
   * the chart drew; market data said available. Only the bar COUNT knew, and
   * nothing reads the bar count — so a daily instrument sat permanently below
   * the history its strategy needs and silently produced no signal.
   *
   * The caller decides when to spend this, and the runtime spends it once per
   * instrument per process. That bound is deliberate: retrying a deep window
   * every cycle would re-fetch the same bars forever whenever a provider
   * genuinely has no more history, which is the uncontrolled amplification
   * this budget exists to prevent.
   */
  readonly deepStart?: boolean;
}

export const DEFAULT_INGESTION_CYCLE = {
  overlapCandles: 3,
  coldStartCandles: 300,
  maxCandles: 1_000,
} as const;

export interface IngestionCycleResult {
  readonly ran: boolean;
  readonly reason?: string;
  readonly result?: IngestionRunResult;
  readonly from: number;
  readonly to: number;
}

export async function runIngestionCycle(
  deps: IngestionCycleDeps,
  options: IngestionCycleOptions,
): Promise<IngestionCycleResult> {
  const { provider, repositories, asset, budget, tracker, now = Date.now } = deps;
  const {
    symbol,
    timeframe,
    overlapCandles = DEFAULT_INGESTION_CYCLE.overlapCandles,
    coldStartCandles = DEFAULT_INGESTION_CYCLE.coldStartCandles,
    maxCandles = DEFAULT_INGESTION_CYCLE.maxCandles,
    deepStart = false,
  } = options;

  const at = now();
  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;

  if (!provider.capabilities.supportedTimeframes.includes(timeframe)) {
    return {
      ran: false,
      reason: `Provider ${provider.capabilities.id} does not serve ${timeframe} candles.`,
      from: at,
      to: at,
    };
  }

  // Window start: overlap behind the newest stored bar, or a bounded cold
  // start. `deepStart` forces the cold-start window so a truncated history can
  // be filled in rather than extended forward forever.
  let from = at - coldStartCandles * stepMs;
  if (repositories && !deepStart) {
    const latest = await repositories.candles.latest(symbol, timeframe, 1);
    const newest = latest?.candles.at(-1)?.timestamp ?? null;
    if (newest !== null) from = newest - overlapCandles * stepMs;
  }

  // Never request beyond the current bar; it has not closed yet.
  const to = at;
  if (to <= from) {
    return { ran: false, reason: 'Nothing new to fetch for this window.', from, to };
  }

  const result = await runHistoricalIngestion(
    { symbol, timeframe, from, to, maxCandles },
    {
      provider,
      repositories,
      ...(asset === undefined ? {} : { asset }),
      ...(budget === undefined ? {} : { budget }),
      ...(tracker === undefined ? {} : { tracker }),
      now,
    },
  );

  return { ran: true, result, from, to };
}
