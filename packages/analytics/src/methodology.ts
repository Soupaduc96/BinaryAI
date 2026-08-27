import type { CalibrationMethodology, EvidenceThresholds } from '@binaryai/types';

/**
 * Versioned methodology constants.
 *
 * Every published figure names the methodology that produced it. Without that,
 * changing a bucket boundary or an eligibility rule silently rewrites how every
 * historical number should be read — the same figure would mean two different
 * things depending on when it was generated, with nothing to distinguish them.
 *
 * Bumping any version here is a deliberate act: old results keep their recorded
 * version and stay interpretable, new ones get the new version, and the two are
 * never compared as though they were the same measurement.
 */

/**
 * The measurement method.
 *
 * `bucketed_frequency` means: partition settled outcomes by the confidence the
 * engine assigned, then report the observed win frequency inside each band. It
 * is a frequency count, not a fitted model. See
 * docs/adr/0012-calibration-methodology.md.
 */
export const CALIBRATION_METHOD = 'bucketed_frequency';

/** Bump when the calculation changes in a way that alters published numbers. */
export const CALIBRATION_METHOD_VERSION = '1.0.0';

/** Bump when the eligibility rules in `calibration_eligibility` change. */
export const SAMPLE_DEFINITION_VERSION = '1.0.0';

/** Bump when bucket boundaries change. */
export const BUCKET_VERSION = '1.0.0';

/**
 * What the confidence number is, at source.
 *
 * Recorded verbatim on every report so no consumer has to guess. It is the
 * engine's rule-based heuristic score — NOT a modelled probability of winning.
 */
export const CONFIDENCE_SOURCE = 'uncalibrated_heuristic';

/** Version stamped on analytics responses generally. */
export const ANALYTICS_VERSION = '1.0.0';

export const METHODOLOGY: CalibrationMethodology = {
  method: CALIBRATION_METHOD,
  version: CALIBRATION_METHOD_VERSION,
  sampleDefinitionVersion: SAMPLE_DEFINITION_VERSION,
  bucketVersion: BUCKET_VERSION,
  confidenceSource: CONFIDENCE_SOURCE,
};

/**
 * Default evidence thresholds. Configurable; these are the conservative
 * defaults.
 *
 * The numbers are not arbitrary but neither are they derived from a power
 * analysis, and claiming otherwise would be exactly the false precision this
 * layer exists to avoid. The reasoning is:
 *
 *  - **30** is the conventional floor at which a binomial proportion stops
 *    being dominated by individual observations. Below it, one flipped result
 *    moves the rate by more than three percentage points, so no rate is
 *    reported at all.
 *  - **100** gives a 95% interval of roughly ±10 points — enough to see a large
 *    effect, not enough to rank anything.
 *  - **500** narrows that to roughly ±4.5 points.
 *  - **2000** reaches roughly ±2 points, where a genuine calibration model
 *    could begin to be fitted and validated.
 *
 * These bound *reporting*, not truth: a rate at 2,000 samples is still an
 * observation about the past, not a prediction.
 */
export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = {
  minimumSamples: 30,
  preliminary: 30,
  developing: 100,
  established: 500,
};

/**
 * Samples required before a calibration MODEL could be considered, as opposed
 * to the frequency measurement this phase implements.
 *
 * Reaching it is necessary, not sufficient: a model also needs walk-forward
 * validation on held-out periods (see `temporal.ts`) and a demonstrated
 * confidence/accuracy relationship. Nothing sets `implemented: true`
 * automatically on sample count alone.
 */
export const CALIBRATION_MODEL_MINIMUM_SAMPLES = 2000;

/**
 * What the settlement numbers mean, carried on every response.
 *
 * Repeated verbatim from the settlement worker so the two cannot drift.
 */
export const SETTLEMENT_SEMANTICS =
  'Directional outcome measured against the close of the last exchange bar ending at or before ' +
  'expiry. No broker terms and no payout are applied, so these are not profit figures.';

/**
 * The sentence that must accompany any confidence-versus-accuracy figure.
 *
 * Stated once, exported, and reused everywhere rather than being re-worded per
 * call site — a paraphrase is how a hedge quietly becomes a claim.
 */
export const CONFIDENCE_SEMANTICS =
  'Confidence is an uncalibrated rule-based score, not a probability of winning. These figures ' +
  'report how often signals in each confidence band were directionally correct; they do not ' +
  'establish that the score predicts that rate.';
