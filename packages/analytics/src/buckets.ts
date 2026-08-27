import type {
  AnalyticsAggregateRow,
  ConfidenceBucket,
  EvidenceThresholds,
  OutcomeCounts,
} from '@binaryai/types';
import { DEFAULT_EVIDENCE_THRESHOLDS } from './methodology.js';
import { EMPTY_COUNTS, countsFrom, meanConfidence, observedAccuracy } from './rates.js';

/**
 * Confidence buckets.
 *
 * Boundaries are explicit, versioned (`BUCKET_VERSION`) and deliberately NOT
 * claimed to be statistically optimal. Five equal bands are a reporting choice
 * made before any data existed, which is precisely what makes them honest:
 * choosing boundaries after seeing outcomes is how a flat relationship gets
 * shaped into a convincing curve.
 *
 * Re-cutting them later is allowed and expected — it requires bumping
 * `BUCKET_VERSION`, so old figures keep their own boundaries and are never
 * silently recompared against new ones.
 */

export interface BucketDefinition {
  readonly id: string;
  readonly lowerInclusive: number;
  readonly upperInclusive: number;
}

/**
 * Five equal-width bands over [0, 1].
 *
 * Bounds are inclusive at both ends, and the bands are contiguous with no
 * overlap: 0.19 falls in the first, 0.20 in the second. `assignBucket` is the
 * single implementation of that rule, so a boundary value cannot land in two
 * buckets depending on which caller asked.
 */
export const CONFIDENCE_BUCKETS: readonly BucketDefinition[] = [
  { id: '0.00-0.19', lowerInclusive: 0.0, upperInclusive: 0.19 },
  { id: '0.20-0.39', lowerInclusive: 0.2, upperInclusive: 0.39 },
  { id: '0.40-0.59', lowerInclusive: 0.4, upperInclusive: 0.59 },
  { id: '0.60-0.79', lowerInclusive: 0.6, upperInclusive: 0.79 },
  { id: '0.80-1.00', lowerInclusive: 0.8, upperInclusive: 1.0 },
];

/**
 * The bucket a confidence score belongs to, or null when it is out of range.
 *
 * Out-of-range is null rather than clamped: a confidence outside [0, 1] means
 * the engine or the database produced something impossible, and quietly filing
 * it under the nearest bucket would hide that.
 *
 * The upper bound of each band is treated as a half-open boundary against the
 * NEXT band's lower bound, which is why 0.195 lands in the first bucket rather
 * than falling through the gap between 0.19 and 0.20.
 */
export function assignBucket(confidence: number): BucketDefinition | null {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  for (let index = 0; index < CONFIDENCE_BUCKETS.length; index += 1) {
    const bucket = CONFIDENCE_BUCKETS[index];
    if (!bucket) continue;
    const next = CONFIDENCE_BUCKETS[index + 1];
    // The last bucket owns everything up to and including 1.0; every other
    // bucket owns up to (but excluding) the next bucket's lower bound.
    if (
      next === undefined ? confidence <= bucket.upperInclusive : confidence < next.lowerInclusive
    ) {
      return bucket;
    }
  }
  return null;
}

/** SQL boundary for a bucket: the half-open range `[lower, upperExclusive)`. */
export function bucketBounds(definition: BucketDefinition): {
  lower: number;
  upperExclusive: number;
} {
  const index = CONFIDENCE_BUCKETS.findIndex((bucket) => bucket.id === definition.id);
  const next = CONFIDENCE_BUCKETS[index + 1];
  return {
    lower: definition.lowerInclusive,
    // The final bucket must include 1.0 exactly, so its exclusive bound is
    // nudged past it rather than sitting on it.
    upperExclusive: next ? next.lowerInclusive : 1.0000001,
  };
}

/** Midpoint of a band, used as its representative confidence. */
export function bucketMidpoint(definition: BucketDefinition): number {
  const { lower, upperExclusive } = bucketBounds(definition);
  const upper = Math.min(upperExclusive, 1);
  return (lower + upper) / 2;
}

/**
 * Builds the full bucket series from storage aggregates.
 *
 * Every defined bucket appears in the output, including empty ones. That is
 * deliberate: an absent bucket reads as "no data collected here", while a
 * present bucket with zero samples reads as "measured, nothing landed here" —
 * and the second is what is actually true. Omitting empty buckets would also
 * let a chart silently change shape as data arrives.
 */
export function buildBuckets(
  rows: readonly AnalyticsAggregateRow[],
  thresholds: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS,
): readonly ConfidenceBucket[] {
  const byId = new Map(rows.map((row) => [row.key, row]));

  return CONFIDENCE_BUCKETS.map((definition) => {
    const row = byId.get(definition.id);
    const counts: OutcomeCounts = row ? countsFrom(row) : EMPTY_COUNTS;

    return {
      id: definition.id,
      lowerInclusive: definition.lowerInclusive,
      upperInclusive: definition.upperInclusive,
      midpoint: bucketMidpoint(definition),
      counts,
      observedAccuracy: observedAccuracy(counts, thresholds),
      meanConfidence: row ? meanConfidence(row.confidenceSum, row.confidenceCount) : null,
    };
  });
}
