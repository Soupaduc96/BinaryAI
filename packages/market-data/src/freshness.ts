import { TIMEFRAME_SECONDS, type Timeframe } from '@binaryai/types';

/**
 * Is an instrument's stored data current, for its own timeframe?
 *
 * THE BUG THIS REPLACES. Freshness was one fixed threshold — 300 seconds —
 * compared against the newest stored candle's OPEN timestamp. That is coherent
 * only at 1m and 5m. Above those it is guaranteed to be wrong:
 *
 *   EUR/USD @1h   newest bar opened 16:00, it is 16:07  →  age 413s  →  STALE
 *   AAPL    @1d   newest bar opened 13:30, it is 16:07  →  age 9413s →  STALE
 *
 * Both were perfectly current: the newest stored bar was the one being formed
 * at that moment. An hourly instrument cannot have a bar younger than an hour,
 * so measuring it against a five-minute threshold reports STALE for fifty-five
 * minutes out of every sixty.
 *
 * The honest question is not "how old is the newest bar" but "IS THE NEWEST BAR
 * THE ONE THAT SHOULD BE OPEN NOW". That is answered from the timeframe grid
 * alone.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: model market sessions. BinaryAI has no
 * exchange calendar and inventing one would be fabrication. So when a market is
 * closed — a weekend in FX, overnight in equities — the newest bar legitimately
 * falls behind and this reports `stale`, with a detail that says how many bars
 * are missing rather than asserting anything about why. "No new bar has
 * arrived" is true whether the cause is a closed market or a broken ingestion,
 * and BinaryAI cannot tell those apart without a calendar it does not have.
 */

export type FreshnessState = 'live' | 'stale' | 'no_data';

export interface Freshness {
  readonly state: FreshnessState;
  /** Seconds since the newest stored bar OPENED. Null when nothing is stored. */
  readonly ageSeconds: number | null;
  /**
   * How many complete bars are missing between the newest stored bar and the
   * one that should be open now. Zero when current.
   */
  readonly barsBehind: number;
  readonly detail: string;
}

/**
 * Bars of lag tolerated before an instrument is called stale.
 *
 * One bar of grace, because ingestion polls on its own interval: between a bar
 * closing and the next poll storing its successor there is a legitimate window
 * where the newest stored bar is the previous one. Zero grace would flap
 * between LIVE and STALE on every boundary.
 */
const GRACE_BARS = 1;

export function assessFreshness(options: {
  readonly timeframe: Timeframe;
  /** Open timestamp of the newest stored bar, epoch ms. Null when none. */
  readonly lastCandleAt: number | null;
  readonly displaySymbol: string;
  readonly now?: number;
}): Freshness {
  const { timeframe, lastCandleAt, displaySymbol, now = Date.now() } = options;

  if (lastCandleAt === null) {
    return {
      state: 'no_data',
      ageSeconds: null,
      barsBehind: 0,
      detail: `No ${timeframe} candles are stored for ${displaySymbol}.`,
    };
  }

  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  const ageSeconds = Math.max(Math.round((now - lastCandleAt) / 1000), 0);

  // The bar that should be open right now, on this timeframe's grid.
  //
  // Aligned to the SERIES' own grid rather than to UTC midnight, by taking the
  // stored bar's offset: a daily equity bar opens at the exchange session, not
  // at 00:00 UTC, and assuming otherwise is the same mistake the candle-quality
  // scanner had to unlearn.
  const offset = ((lastCandleAt % stepMs) + stepMs) % stepMs;
  const currentBarOpen = Math.floor((now - offset) / stepMs) * stepMs + offset;
  const barsBehind = Math.max(Math.round((currentBarOpen - lastCandleAt) / stepMs), 0);

  if (barsBehind <= GRACE_BARS) {
    return {
      state: 'live',
      ageSeconds,
      barsBehind,
      detail:
        barsBehind === 0
          ? `The newest stored ${timeframe} bar is the one currently forming.`
          : `The newest stored ${timeframe} bar is the previous one; the current bar has not been stored yet.`,
    };
  }

  return {
    state: 'stale',
    ageSeconds,
    barsBehind,
    // States the observation, not a cause. Without an exchange calendar
    // BinaryAI cannot distinguish a closed market from stopped ingestion, and
    // claiming either would be a guess presented as a fact.
    detail:
      `${barsBehind} ${timeframe} bars behind: the newest stored bar opened ` +
      `${ageSeconds}s ago. The market may be closed, or ingestion may have stopped — ` +
      'BinaryAI does not model exchange sessions and cannot tell which.',
  };
}
