import { describe, expect, it } from 'vitest';
import type { AnalyticsAggregateRow } from '@binaryai/types';
import {
  CONFIDENCE_BUCKETS,
  assignBucket,
  bucketBounds,
  bucketMidpoint,
  buildBuckets,
} from './buckets.js';

function row(overrides: Partial<AnalyticsAggregateRow> & { key: string }): AnalyticsAggregateRow {
  return {
    version: null,
    wins: 0,
    losses: 0,
    ties: 0,
    unresolved: 0,
    invalid: 0,
    skipped: 0,
    total: 0,
    confidenceSum: 0,
    confidenceCount: 0,
    ...overrides,
  };
}

describe('bucket definitions', () => {
  it('covers [0,1] with no gap and no overlap', () => {
    for (let index = 1; index < CONFIDENCE_BUCKETS.length; index += 1) {
      const previous = CONFIDENCE_BUCKETS[index - 1]!;
      const current = CONFIDENCE_BUCKETS[index]!;
      // Contiguity is what makes assignBucket total: every score in range
      // lands somewhere.
      expect(current.lowerInclusive).toBeGreaterThan(previous.lowerInclusive);
      expect(bucketBounds(previous).upperExclusive).toBe(current.lowerInclusive);
    }
    expect(CONFIDENCE_BUCKETS[0]!.lowerInclusive).toBe(0);
    expect(CONFIDENCE_BUCKETS.at(-1)!.upperInclusive).toBe(1);
  });
});

describe('assignBucket', () => {
  it('places each band interior correctly', () => {
    expect(assignBucket(0.1)?.id).toBe('0.00-0.19');
    expect(assignBucket(0.3)?.id).toBe('0.20-0.39');
    expect(assignBucket(0.5)?.id).toBe('0.40-0.59');
    expect(assignBucket(0.7)?.id).toBe('0.60-0.79');
    expect(assignBucket(0.9)?.id).toBe('0.80-1.00');
  });

  it('assigns lower boundaries to the higher band', () => {
    // The rule that must not drift: 0.20 belongs to the second bucket, not the
    // first. A boundary landing in two buckets would double-count it.
    expect(assignBucket(0.2)?.id).toBe('0.20-0.39');
    expect(assignBucket(0.4)?.id).toBe('0.40-0.59');
    expect(assignBucket(0.6)?.id).toBe('0.60-0.79');
    expect(assignBucket(0.8)?.id).toBe('0.80-1.00');
  });

  it('keeps values in the gap between the printed bounds', () => {
    // 0.195 is above the printed upper bound of the first band but below the
    // second's lower bound. It must not fall through.
    expect(assignBucket(0.195)?.id).toBe('0.00-0.19');
    expect(assignBucket(0.399)?.id).toBe('0.20-0.39');
  });

  it('handles the exact extremes', () => {
    expect(assignBucket(0)?.id).toBe('0.00-0.19');
    expect(assignBucket(1)?.id).toBe('0.80-1.00');
  });

  it('returns null for impossible confidences rather than clamping', () => {
    // Out of range means the engine or the database produced something that
    // cannot exist. Filing it under the nearest bucket would hide that.
    expect(assignBucket(-0.01)).toBeNull();
    expect(assignBucket(1.01)).toBeNull();
    expect(assignBucket(Number.NaN)).toBeNull();
    expect(assignBucket(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('bucketMidpoint', () => {
  it('is the centre of the half-open band', () => {
    expect(bucketMidpoint(CONFIDENCE_BUCKETS[0]!)).toBeCloseTo(0.1, 10);
    expect(bucketMidpoint(CONFIDENCE_BUCKETS[4]!)).toBeCloseTo(0.9, 10);
  });
});

describe('buildBuckets', () => {
  it('returns every defined bucket even when no data exists', () => {
    const buckets = buildBuckets([]);

    // An absent bucket would read as "not measured here"; a present bucket with
    // zero samples reads as "measured, nothing landed here" -- which is true.
    expect(buckets).toHaveLength(CONFIDENCE_BUCKETS.length);
    for (const bucket of buckets) {
      expect(bucket.counts.total).toBe(0);
      expect(bucket.observedAccuracy.value).toBeNull();
      expect(bucket.meanConfidence).toBeNull();
    }
  });

  it('fills the buckets that have data and leaves the rest empty', () => {
    const buckets = buildBuckets([
      row({
        key: '0.60-0.79',
        wins: 24,
        losses: 16,
        total: 40,
        confidenceSum: 28,
        confidenceCount: 40,
      }),
    ]);

    const populated = buckets.find((bucket) => bucket.id === '0.60-0.79');
    expect(populated?.observedAccuracy.value).toBeCloseTo(0.6, 10);
    expect(populated?.observedAccuracy.sufficient).toBe(true);
    expect(populated?.meanConfidence).toBeCloseTo(0.7, 10);

    const empty = buckets.find((bucket) => bucket.id === '0.00-0.19');
    expect(empty?.observedAccuracy.value).toBeNull();
  });

  it('withholds a rate in an under-populated bucket', () => {
    const buckets = buildBuckets([row({ key: '0.80-1.00', wins: 2, losses: 0, total: 2 })]);
    const bucket = buckets.find((entry) => entry.id === '0.80-1.00');

    // Two out of two is 100%. Publishing that would be the most misleading
    // number the dashboard could show.
    expect(bucket?.observedAccuracy.value).toBeNull();
    expect(bucket?.observedAccuracy.sampleSize).toBe(2);
    expect(bucket?.counts.wins).toBe(2);
  });

  it('preserves bucket order regardless of row order', () => {
    const buckets = buildBuckets([
      row({ key: '0.80-1.00', wins: 1, total: 1 }),
      row({ key: '0.00-0.19', losses: 1, total: 1 }),
    ]);
    expect(buckets.map((bucket) => bucket.id)).toEqual(CONFIDENCE_BUCKETS.map((b) => b.id));
  });

  it('ignores an unrecognised bucket key from storage', () => {
    // 'out_of_range' rows exist when a confidence outside [0,1] was stored.
    // They must not become a sixth bucket.
    const buckets = buildBuckets([row({ key: 'out_of_range', wins: 99, total: 99 })]);
    expect(buckets).toHaveLength(CONFIDENCE_BUCKETS.length);
    expect(buckets.every((bucket) => bucket.counts.wins === 0)).toBe(true);
  });
});
