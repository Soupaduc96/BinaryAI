import type {
  AnalyticsAggregateRow,
  EvidenceLevel,
  EvidenceThresholds,
  ObservedRate,
  OutcomeCounts,
} from '@binaryai/types';
import { DEFAULT_EVIDENCE_THRESHOLDS } from './methodology.js';

/**
 * Observed rates and evidence levels.
 *
 * The one rule this module exists to enforce: **a rate that cannot be computed
 * is `null`, never `0`.** Zero wins from zero settled signals is not "0%
 * accurate"; it is no evidence. Every other honesty property downstream depends
 * on that distinction surviving all the way to the pixel.
 */

export const EMPTY_COUNTS: OutcomeCounts = {
  wins: 0,
  losses: 0,
  ties: 0,
  unresolved: 0,
  invalid: 0,
  skipped: 0,
  total: 0,
};

/**
 * The accuracy denominator: settled outcomes where a direction was either right
 * or wrong.
 *
 * Ties are excluded deliberately. A tie is a real settlement — the price landed
 * exactly on the entry — but the prediction was neither correct nor incorrect,
 * so including it in the denominator would drag every rate toward zero while
 * including it in the numerator would inflate them. It is counted and reported
 * separately instead.
 */
export function decidedOutcomes(counts: OutcomeCounts): number {
  return counts.wins + counts.losses;
}

export function evidenceLevelFor(
  sampleSize: number,
  thresholds: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS,
): EvidenceLevel {
  if (sampleSize >= thresholds.established) return 'established';
  if (sampleSize >= thresholds.developing) return 'developing';
  if (sampleSize >= thresholds.preliminary) return 'preliminary';
  return 'insufficient';
}

/**
 * Observed accuracy for a set of counts.
 *
 * Returns `value: null` in two distinct situations, and the caller can tell
 * them apart by `sampleSize`:
 *
 *  - **no denominator** (`sampleSize === 0`) — nothing has settled.
 *  - **below the minimum** (`0 < sampleSize < minimumSamples`) — something has
 *    settled, but too little to quote a rate. The count is still reported, so
 *    the interface can say "6 settled, not enough to report a rate" rather than
 *    pretending nothing happened.
 *
 * Withholding the number in the second case is the point of the minimum-sample
 * policy. Three wins from four signals is 75%, and displaying that alongside a
 * figure backed by 4,000 observations would imply a comparability that does not
 * exist.
 */
export function observedAccuracy(
  counts: OutcomeCounts,
  thresholds: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS,
): ObservedRate {
  const sampleSize = decidedOutcomes(counts);
  const evidence = evidenceLevelFor(sampleSize, thresholds);
  const sufficient = sampleSize >= thresholds.minimumSamples;

  return {
    value: sufficient && sampleSize > 0 ? counts.wins / sampleSize : null,
    sampleSize,
    evidence,
    sufficient,
  };
}

/**
 * Mean confidence over the samples that contributed to a rate.
 *
 * Null when nothing contributed — the same rule as accuracy. Guards against a
 * zero count rather than trusting the sum, because a database `SUM` over no
 * rows returns NULL and a coerced 0 would otherwise read as "mean confidence
 * 0.00", which is a very different statement from "no samples".
 */
export function meanConfidence(sum: number, count: number): number | null {
  if (count <= 0 || !Number.isFinite(sum)) return null;
  return sum / count;
}

/** Counts from one storage aggregate row. */
export function countsFrom(row: AnalyticsAggregateRow): OutcomeCounts {
  return {
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    unresolved: row.unresolved,
    invalid: row.invalid,
    skipped: row.skipped,
    total: row.total,
  };
}

/** Adds two count sets, for rolling group rows into a total. */
export function addCounts(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  return {
    wins: a.wins + b.wins,
    losses: a.losses + b.losses,
    ties: a.ties + b.ties,
    unresolved: a.unresolved + b.unresolved,
    invalid: a.invalid + b.invalid,
    skipped: a.skipped + b.skipped,
    total: a.total + b.total,
  };
}

/**
 * Sanity check on counts arriving from storage.
 *
 * A negative count, or parts exceeding the total, means the aggregation query
 * is wrong. Failing loudly here beats publishing a rate derived from it —
 * a corrupt statistic that looks plausible is worse than an error.
 */
export function assertCoherent(counts: OutcomeCounts): void {
  const values = [
    counts.wins,
    counts.losses,
    counts.ties,
    counts.unresolved,
    counts.invalid,
    counts.skipped,
    counts.total,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`Incoherent outcome counts: ${JSON.stringify(counts)}`);
  }
  const classified =
    counts.wins + counts.losses + counts.ties + counts.unresolved + counts.invalid + counts.skipped;
  if (classified > counts.total) {
    throw new Error(
      `Outcome parts (${classified}) exceed the total (${counts.total}): ${JSON.stringify(counts)}`,
    );
  }
}
