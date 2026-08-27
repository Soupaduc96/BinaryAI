import { describe, expect, it } from 'vitest';
import type { AnalyticsAggregateRow } from '@binaryai/types';
import { buildBuckets } from './buckets.js';
import { assessRelationship, buildCalibrationReport, confidenceDivergence } from './calibration.js';

/**
 * Confidence measurement.
 *
 * These tests defend two properties above all others:
 *
 *  1. `implemented` never becomes true from sample volume alone.
 *  2. A relationship between confidence and accuracy is reported as
 *     "not_established" unless the evidence actually establishes one.
 */

/** A bucket row with `wins`/`losses` and a mean confidence at the midpoint. */
function bucket(
  id: string,
  wins: number,
  losses: number,
  meanConfidence: number,
): AnalyticsAggregateRow {
  const settled = wins + losses;
  return {
    key: id,
    version: null,
    wins,
    losses,
    ties: 0,
    unresolved: 0,
    invalid: 0,
    skipped: 0,
    total: settled,
    confidenceSum: meanConfidence * settled,
    confidenceCount: settled,
  };
}

describe('assessRelationship', () => {
  it('is not established with no data', () => {
    expect(assessRelationship(buildBuckets([]))).toBe('not_established');
  });

  it('is not established from a single populated bucket', () => {
    // One point describes no relationship, however many samples back it.
    const buckets = buildBuckets([bucket('0.60-0.79', 300, 200, 0.7)]);
    expect(assessRelationship(buckets)).toBe('not_established');
  });

  it('is not established when buckets lack sufficient evidence', () => {
    // Two buckets, but four observations between them. The shape is
    // meaningless and must not be reported as a trend.
    const buckets = buildBuckets([bucket('0.20-0.39', 1, 1, 0.3), bucket('0.80-1.00', 2, 0, 0.9)]);
    expect(assessRelationship(buckets)).toBe('not_established');
  });

  it('detects a rising relationship', () => {
    const buckets = buildBuckets([
      bucket('0.20-0.39', 15, 35, 0.3),
      bucket('0.60-0.79', 30, 30, 0.7),
      bucket('0.80-1.00', 45, 25, 0.9),
    ]);
    expect(assessRelationship(buckets)).toBe('monotonic_increasing');
  });

  it('detects a falling relationship, which is a real finding', () => {
    // Confidence anti-correlating with accuracy is important information, not
    // an error to be smoothed away.
    const buckets = buildBuckets([
      bucket('0.20-0.39', 40, 10, 0.3),
      bucket('0.80-1.00', 10, 40, 0.9),
    ]);
    expect(assessRelationship(buckets)).toBe('monotonic_decreasing');
  });

  it('reports non-monotonic when accuracy moves both ways', () => {
    const buckets = buildBuckets([
      bucket('0.20-0.39', 30, 20, 0.3),
      bucket('0.60-0.79', 10, 40, 0.7),
      bucket('0.80-1.00', 35, 15, 0.9),
    ]);
    expect(assessRelationship(buckets)).toBe('non_monotonic');
  });

  it('treats a flat relationship as not established', () => {
    // Identical accuracy everywhere satisfies both monotonic tests and means
    // the score carried no information. Calling that "increasing" would be a
    // false positive of exactly the kind this metric exists to avoid.
    const buckets = buildBuckets([
      bucket('0.20-0.39', 25, 25, 0.3),
      bucket('0.60-0.79', 30, 30, 0.7),
      bucket('0.80-1.00', 40, 40, 0.9),
    ]);
    expect(assessRelationship(buckets)).toBe('not_established');
  });
});

describe('confidenceDivergence', () => {
  it('is null without sufficient evidence', () => {
    expect(confidenceDivergence(buildBuckets([]))).toBeNull();
    expect(confidenceDivergence(buildBuckets([bucket('0.80-1.00', 2, 1, 0.9)]))).toBeNull();
  });

  it('is zero when observed accuracy matches confidence exactly', () => {
    // 70% accuracy at mean confidence 0.70.
    const buckets = buildBuckets([bucket('0.60-0.79', 70, 30, 0.7)]);
    expect(confidenceDivergence(buckets)).toBeCloseTo(0, 10);
  });

  it('measures the gap when confidence overstates accuracy', () => {
    // Mean confidence 0.90, observed accuracy 0.50 -> gap of 0.40.
    const buckets = buildBuckets([bucket('0.80-1.00', 50, 50, 0.9)]);
    expect(confidenceDivergence(buckets)).toBeCloseTo(0.4, 10);
  });

  it('weights by sample count, not by bucket', () => {
    // 400 samples at gap 0.0 and 100 samples at gap 0.5 -> 0.1, not 0.25.
    const buckets = buildBuckets([
      bucket('0.60-0.79', 280, 120, 0.7),
      bucket('0.20-0.39', 80, 20, 0.3),
    ]);
    expect(confidenceDivergence(buckets)).toBeCloseTo(0.1, 8);
  });
});

describe('buildCalibrationReport', () => {
  const base = {
    exclusions: {},
    generatedAt: 1_800_000_000_000,
  };

  it('reports no model with an empty dataset, and says why', () => {
    const report = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([]),
      eligibleSamples: 0,
      settledSamples: 0,
    });

    expect(report.implemented).toBe(false);
    expect(report.evidence).toBe('insufficient');
    expect(report.relationship).toBe('not_established');
    expect(report.divergence).toBeNull();
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it('keeps implemented false no matter how many samples exist', () => {
    // The load-bearing assertion of Phase 4. Sample volume is a prerequisite
    // for building a calibration model, never evidence that one was built.
    const buckets = buildBuckets([
      bucket('0.20-0.39', 3_000, 7_000, 0.3),
      bucket('0.80-1.00', 8_000, 2_000, 0.9),
    ]);
    const report = buildCalibrationReport({
      ...base,
      buckets,
      eligibleSamples: 20_000,
      settledSamples: 20_000,
    });

    expect(report.implemented).toBe(false);
    expect(report.evidence).toBe('established');
    expect(report.relationship).toBe('monotonic_increasing');
  });

  it('never describes the score as a probability', () => {
    const report = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([]),
      eligibleSamples: 0,
      settledSamples: 0,
    });
    const text = `${report.semantics} ${report.limitations.join(' ')}`.toLowerCase();

    expect(report.semantics).toMatch(/not a probability/i);
    // No marketing or financial framing anywhere in the prose.
    expect(text).not.toMatch(/guaranteed|expected profit|profitable|risk-free|winning system/);
  });

  it('totals exclusions and keeps their reasons', () => {
    const report = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([]),
      eligibleSamples: 0,
      settledSamples: 12,
      exclusions: { not_accepted: 7, missing_strategy: 3, synthetic_data: 2 },
    });

    expect(report.excludedSamples).toBe(12);
    expect(report.exclusions['not_accepted']).toBe(7);
    // Excluding everything is a statement worth making loudly.
    expect(report.limitations.join(' ')).toMatch(/all 12 settled outcome/i);
  });

  it('stamps the methodology on every report', () => {
    const report = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([]),
      eligibleSamples: 0,
      settledSamples: 0,
    });

    // Without this, changing a bucket boundary later would silently rewrite how
    // every historical figure should be read.
    expect(report.methodology.method).toBe('bucketed_frequency');
    expect(report.methodology.version).toBeTruthy();
    expect(report.methodology.sampleDefinitionVersion).toBeTruthy();
    expect(report.methodology.bucketVersion).toBeTruthy();
    expect(report.methodology.confidenceSource).toBe('uncalibrated_heuristic');
  });

  it('does not mutate the methodology between reports', () => {
    const first = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([]),
      eligibleSamples: 0,
      settledSamples: 0,
    });
    const second = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([bucket('0.60-0.79', 60, 40, 0.7)]),
      eligibleSamples: 100,
      settledSamples: 100,
    });

    expect(second.methodology).toEqual(first.methodology);
  });

  it('drops the minimum-sample caveat once the threshold is met', () => {
    const sparse = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([]),
      eligibleSamples: 4,
      settledSamples: 4,
    });
    const ample = buildCalibrationReport({
      ...base,
      buckets: buildBuckets([bucket('0.60-0.79', 60, 40, 0.7)]),
      eligibleSamples: 100,
      settledSamples: 100,
    });

    // Limitations describe this report, not a fixed boilerplate block.
    expect(sparse.limitations.join(' ')).toMatch(/are required before any rate/);
    expect(ample.limitations.join(' ')).not.toMatch(/are required before any rate/);
  });
});
