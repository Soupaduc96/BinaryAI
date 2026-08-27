import { TIMEFRAME_SECONDS, type Timeframe } from '@binaryai/types';

export function timeframeToMs(timeframe: Timeframe): number {
  return TIMEFRAME_SECONDS[timeframe] * 1000;
}

/** Floor an epoch-ms timestamp to the start of its candle for `timeframe`. */
export function alignToTimeframe(timestampMs: number, timeframe: Timeframe): number {
  const step = timeframeToMs(timeframe);
  return Math.floor(timestampMs / step) * step;
}

export function toIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

/**
 * A clock, injected rather than read from `Date.now()` directly, so that
 * analysis and simulation stay testable and deterministic.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function fixedClock(timestampMs: number): Clock {
  return { now: () => timestampMs };
}
