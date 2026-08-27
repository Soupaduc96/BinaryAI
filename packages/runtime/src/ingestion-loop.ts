import { runHistoricalIngestion, type IngestionTracker } from '@binaryai/market-data';
import {
  TIMEFRAME_SECONDS,
  type IngestionRunResult,
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
  const { provider, repositories, tracker, now = Date.now } = deps;
  const {
    symbol,
    timeframe,
    overlapCandles = DEFAULT_INGESTION_CYCLE.overlapCandles,
    coldStartCandles = DEFAULT_INGESTION_CYCLE.coldStartCandles,
    maxCandles = DEFAULT_INGESTION_CYCLE.maxCandles,
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

  // Window start: overlap behind the newest stored bar, or a bounded cold start.
  let from = at - coldStartCandles * stepMs;
  if (repositories) {
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
      ...(tracker === undefined ? {} : { tracker }),
      now,
    },
  );

  return { ran: true, result, from, to };
}
