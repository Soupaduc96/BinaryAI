import { valueAt } from './internal.js';

export type CrossDirection = 'above' | 'below' | 'none';

/**
 * Detect a crossing at `index` between two aligned series.
 * Returns 'none' when either series lacks a value at `index` or `index - 1`,
 * so warm-up regions can never be mistaken for a cross.
 */
export function crossAt(
  fast: readonly (number | null)[],
  slow: readonly (number | null)[],
  index: number,
): CrossDirection {
  if (index < 1) return 'none';
  const fastNow = valueAt(fast, index);
  const slowNow = valueAt(slow, index);
  const fastPrevious = valueAt(fast, index - 1);
  const slowPrevious = valueAt(slow, index - 1);
  if (fastNow === null || slowNow === null || fastPrevious === null || slowPrevious === null) {
    return 'none';
  }
  if (fastPrevious <= slowPrevious && fastNow > slowNow) return 'above';
  if (fastPrevious >= slowPrevious && fastNow < slowNow) return 'below';
  return 'none';
}

/** Convenience wrapper for the most recent bar. */
export function lastCross(
  fast: readonly (number | null)[],
  slow: readonly (number | null)[],
): CrossDirection {
  return crossAt(fast, slow, fast.length - 1);
}

/**
 * How many bars ago the most recent cross happened, searching back at most
 * `lookback` bars. Null when there is no cross in that window.
 */
export function barsSinceCross(
  fast: readonly (number | null)[],
  slow: readonly (number | null)[],
  lookback = 20,
): { direction: CrossDirection; barsAgo: number } | null {
  const lastIndex = fast.length - 1;
  const limit = Math.max(1, lastIndex - lookback + 1);
  for (let i = lastIndex; i >= limit; i -= 1) {
    const direction = crossAt(fast, slow, i);
    if (direction !== 'none') return { direction, barsAgo: lastIndex - i };
  }
  return null;
}
