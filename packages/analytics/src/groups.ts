import type { AnalyticsAggregateRow, AnalyticsGroup, EvidenceThresholds } from '@binaryai/types';
import { DEFAULT_EVIDENCE_THRESHOLDS } from './methodology.js';
import { assertCoherent, countsFrom, meanConfidence, observedAccuracy } from './rates.js';

/**
 * Grouped breakdowns: by strategy, regime, timeframe, asset or direction.
 *
 * Every dimension shares one shape and one code path, because the honesty rules
 * are identical for all of them: a rate below the minimum sample size is
 * withheld, evidence level travels with the number, and groups are never
 * invented.
 *
 * That last point is why this module has no notion of "expected" values. A
 * timeframe with no settled outcomes does not appear as a zero row -- it does
 * not appear at all. Placeholder rows for BTC-USD, or for the 5m timeframe,
 * would imply BinaryAI has observations it does not have.
 */

export interface GroupOptions {
  readonly thresholds?: EvidenceThresholds;
  /** Ordering. Sample count is the default and is deliberate; see below. */
  readonly sort?: 'samples' | 'key';
}

/**
 * Builds group rows from storage aggregates.
 *
 * Sorted by SAMPLE COUNT by default, never by accuracy. Ranking by accuracy
 * would put a strategy with 3 wins from 3 signals above one with 2,800 wins
 * from 4,000 -- an ordering that is arithmetically correct and completely
 * misleading. Sorting by evidence puts the best-supported rows first and leaves
 * any judgement about which strategy is "better" to the reader, who can see
 * both numbers.
 */
export function buildGroups(
  rows: readonly AnalyticsAggregateRow[],
  options: GroupOptions = {},
): readonly AnalyticsGroup[] {
  const thresholds = options.thresholds ?? DEFAULT_EVIDENCE_THRESHOLDS;

  const groups = rows.map((row): AnalyticsGroup => {
    const counts = countsFrom(row);
    // Storage is trusted to count, not to be correct: a malformed aggregate
    // must fail here rather than become a published statistic.
    assertCoherent(counts);
    return {
      key: row.key,
      version: row.version,
      counts,
      observedAccuracy: observedAccuracy(counts, thresholds),
      meanConfidence: meanConfidence(row.confidenceSum, row.confidenceCount),
    };
  });

  if (options.sort === 'key') {
    return [...groups].sort((a, b) => a.key.localeCompare(b.key));
  }
  return [...groups].sort((a, b) => {
    const bySamples = b.observedAccuracy.sampleSize - a.observedAccuracy.sampleSize;
    // Stable tiebreak, so identical evidence produces a deterministic order
    // rather than one that depends on how the database returned the rows.
    return bySamples !== 0 ? bySamples : a.key.localeCompare(b.key);
  });
}
