import type {
  CalibrationReport,
  ConfidenceBucket,
  ConfidenceRelationship,
  EvidenceThresholds,
  ExclusionReason,
} from '@binaryai/types';
import {
  CALIBRATION_MODEL_MINIMUM_SAMPLES,
  CONFIDENCE_SEMANTICS,
  DEFAULT_EVIDENCE_THRESHOLDS,
  METHODOLOGY,
} from './methodology.js';
import { decidedOutcomes, evidenceLevelFor } from './rates.js';

/**
 * Measuring confidence against outcomes.
 *
 * The central constraint of this module, and the reason it is written the way
 * it is: **the engine's confidence is not a probability.** It is a rule-based
 * heuristic that combines indicator agreement, regime fit and data quality into
 * a 0–1 score. Nothing about its construction makes 0.80 mean "wins 80% of the
 * time".
 *
 * That rules out the obvious metrics as PRIMARY measures. A Brier score is
 * defined as the mean squared error of a *forecast probability*; computing one
 * over a heuristic score does not fail loudly, it silently answers a question
 * nobody asked, and the number looks exactly like a real Brier score. Expected
 * Calibration Error has the same problem.
 *
 * So the primary measure here is **rank-based**: does observed accuracy rise as
 * confidence rises? That question is meaningful for any ordered score,
 * probability or not. The ECE-shaped `divergence` is computed as a secondary
 * diagnostic and labelled with exactly what it would mean *if* the score were a
 * probability — which it is not.
 *
 * See docs/adr/0012-calibration-methodology.md.
 */

/** Buckets with enough settled outcomes to quote a rate. */
function sufficientBuckets(buckets: readonly ConfidenceBucket[]): readonly ConfidenceBucket[] {
  return buckets.filter(
    (bucket) => bucket.observedAccuracy.sufficient && bucket.observedAccuracy.value !== null,
  );
}

/**
 * Whether higher confidence corresponded to higher observed accuracy.
 *
 * Requires at least two buckets with sufficient evidence. With fewer there is
 * no relationship to describe, and `not_established` is the honest answer — not
 * a hedge. Monotonicity is checked over the buckets that qualify, in ascending
 * confidence order.
 *
 * Note what this deliberately does NOT do: it does not fit a trend line, and it
 * does not test significance. A three-bucket increasing sequence is reported as
 * increasing without any claim that the increase is statistically
 * distinguishable from noise.
 */
export function assessRelationship(buckets: readonly ConfidenceBucket[]): ConfidenceRelationship {
  const usable = sufficientBuckets(buckets);
  if (usable.length < 2) return 'not_established';

  const accuracies = usable.map((bucket) => bucket.observedAccuracy.value as number);

  let increasing = true;
  let decreasing = true;
  for (let index = 1; index < accuracies.length; index += 1) {
    const previous = accuracies[index - 1] as number;
    const current = accuracies[index] as number;
    if (current < previous) increasing = false;
    if (current > previous) decreasing = false;
  }

  // Flat across every bucket satisfies both tests and means the score carried
  // no information. That is not a monotonic relationship in any useful sense.
  if (increasing && decreasing) return 'not_established';
  if (increasing) return 'monotonic_increasing';
  if (decreasing) return 'monotonic_decreasing';
  return 'non_monotonic';
}

/**
 * Sample-weighted mean gap between a bucket's confidence midpoint and its
 * observed accuracy.
 *
 * Structurally this is Expected Calibration Error. It is NOT reported as a
 * calibration error, because that name asserts the score is a probability
 * estimate. Read it as: "if one insisted on reading the heuristic as a
 * probability, it would be off by this much on average." The report carries
 * that caveat in `semantics`.
 *
 * Null when no bucket has sufficient evidence — a divergence computed from two
 * observations is noise with a decimal point.
 */
export function confidenceDivergence(buckets: readonly ConfidenceBucket[]): number | null {
  const usable = sufficientBuckets(buckets);
  if (usable.length === 0) return null;

  let weighted = 0;
  let weight = 0;
  for (const bucket of usable) {
    const samples = decidedOutcomes(bucket.counts);
    // Prefer the observed mean confidence over the band midpoint: it is what
    // the samples actually scored. The midpoint is the fallback for a bucket
    // whose mean is missing.
    const reference = bucket.meanConfidence ?? bucket.midpoint;
    weighted += samples * Math.abs(reference - (bucket.observedAccuracy.value as number));
    weight += samples;
  }
  return weight === 0 ? null : weighted / weight;
}

export interface CalibrationInput {
  readonly buckets: readonly ConfidenceBucket[];
  readonly eligibleSamples: number;
  readonly settledSamples: number;
  readonly exclusions: Readonly<Partial<Record<ExclusionReason, number>>>;
  readonly generatedAt: number;
  readonly thresholds?: EvidenceThresholds;
}

/**
 * Assembles the calibration report.
 *
 * `implemented` is hard-coded false and that is the correct behaviour, not an
 * oversight. It answers "does a validated calibration MODEL exist?" — and one
 * does not. Accumulating samples is a prerequisite for building a model, never
 * evidence that one has been built, and no sample count may flip this flag on
 * its own. Turning it true requires a fitted model, walk-forward validation on
 * held-out periods, and a demonstrated confidence/accuracy relationship.
 */
export function buildCalibrationReport(input: CalibrationInput): CalibrationReport {
  const thresholds = input.thresholds ?? DEFAULT_EVIDENCE_THRESHOLDS;
  const relationship = assessRelationship(input.buckets);
  const divergence = confidenceDivergence(input.buckets);

  const excludedSamples = Object.values(input.exclusions).reduce(
    (total, count) => total + (count ?? 0),
    0,
  );

  return {
    methodology: METHODOLOGY,
    implemented: false,
    generatedAt: input.generatedAt,
    buckets: input.buckets,
    eligibleSamples: input.eligibleSamples,
    settledSamples: input.settledSamples,
    excludedSamples,
    exclusions: { ...input.exclusions } as Readonly<Record<string, number>>,
    evidence: evidenceLevelFor(input.eligibleSamples, thresholds),
    minimumSampleSize: thresholds.minimumSamples,
    relationship,
    divergence,
    semantics: CONFIDENCE_SEMANTICS,
    limitations: buildLimitations(input, relationship, divergence, thresholds),
  };
}

/**
 * The caveats that apply to this particular report.
 *
 * Generated from the actual state rather than hard-coded, so the list shrinks
 * as evidence accumulates instead of becoming boilerplate everyone stops
 * reading.
 */
function buildLimitations(
  input: CalibrationInput,
  relationship: ConfidenceRelationship,
  divergence: number | null,
  thresholds: EvidenceThresholds,
): readonly string[] {
  const limitations: string[] = [
    'No calibration model exists. These are observed frequencies, not fitted predictions.',
  ];

  if (input.eligibleSamples < thresholds.minimumSamples) {
    limitations.push(
      `Only ${input.eligibleSamples} eligible settled outcome(s); ${thresholds.minimumSamples} ` +
        'are required before any rate is reported.',
    );
  }
  if (input.eligibleSamples < CALIBRATION_MODEL_MINIMUM_SAMPLES) {
    limitations.push(
      `A calibration model would need at least ${CALIBRATION_MODEL_MINIMUM_SAMPLES} eligible ` +
        `samples plus walk-forward validation; ${input.eligibleSamples} are available.`,
    );
  }
  if (relationship === 'not_established') {
    limitations.push(
      'The relationship between confidence and observed accuracy is not established: fewer than ' +
        'two confidence buckets have sufficient evidence, or accuracy is flat across them.',
    );
  }
  if (divergence === null) {
    limitations.push('Confidence divergence is not computable: no bucket has sufficient evidence.');
  }
  if (input.settledSamples > 0 && input.eligibleSamples === 0) {
    limitations.push(
      `All ${input.settledSamples} settled outcome(s) were excluded from calibration. See ` +
        '"exclusions" for the reason each was rejected.',
    );
  }

  // Always last: the statement that matters most, positioned where a reader
  // who skims to the end still sees it.
  limitations.push(
    'Observed accuracy describes past directional correctness. It is not a profit figure, an ' +
      'expected return, or a prediction of future results.',
  );
  return limitations;
}
