import { TIMEFRAMES, type Timeframe } from '@binaryai/types';

/**
 * Timeframe helpers shared by the server page and the client control.
 *
 * Deliberately NOT in the `'use client'` module: a pure function exported from
 * a client module cannot be called during server rendering, only rendered as a
 * component. Keeping the parser here lets both sides use one implementation.
 */

export const DEFAULT_TIMEFRAME: Timeframe = '1m';

/** Parses `?tf=` from the URL, falling back rather than trusting the input. */
export function readTimeframe(value: string | string[] | undefined): Timeframe {
  const candidate = Array.isArray(value) ? value[0] : value;
  return (TIMEFRAMES as readonly string[]).includes(candidate ?? '')
    ? (candidate as Timeframe)
    : DEFAULT_TIMEFRAME;
}

/** Timeframes offered in the chart toolbar. */
export const OFFERED_TIMEFRAMES = TIMEFRAMES.slice(0, 8);
