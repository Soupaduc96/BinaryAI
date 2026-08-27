/**
 * @binaryai/analytics -- outcome statistics.
 *
 * Pure functions over counts. This package touches no database, no HTTP and no
 * process.env, so every statistical rule in it is testable in isolation and
 * cannot drift between the API, the workers and the dashboard.
 *
 * Storage aggregates (counts and sums); this package derives (rates, evidence
 * levels, calibration measures). That split is deliberate: SQL stays simple and
 * bounded, and the honesty rules -- withhold a rate below the minimum sample
 * size, never render a missing value as zero -- live in one testable place.
 */

export {
  ANALYTICS_VERSION,
  BUCKET_VERSION,
  CALIBRATION_METHOD,
  CALIBRATION_METHOD_VERSION,
  CALIBRATION_MODEL_MINIMUM_SAMPLES,
  CONFIDENCE_SEMANTICS,
  CONFIDENCE_SOURCE,
  DEFAULT_EVIDENCE_THRESHOLDS,
  METHODOLOGY,
  SAMPLE_DEFINITION_VERSION,
  SETTLEMENT_SEMANTICS,
} from './methodology.js';

export {
  EMPTY_COUNTS,
  addCounts,
  assertCoherent,
  countsFrom,
  decidedOutcomes,
  evidenceLevelFor,
  meanConfidence,
  observedAccuracy,
} from './rates.js';

export {
  CONFIDENCE_BUCKETS,
  assignBucket,
  bucketBounds,
  bucketMidpoint,
  buildBuckets,
  type BucketDefinition,
} from './buckets.js';

export {
  assessRelationship,
  buildCalibrationReport,
  confidenceDivergence,
  type CalibrationInput,
} from './calibration.js';

export {
  buildPeriods,
  intervalMs,
  recencyCutoff,
  splitAt,
  suggestInterval,
  type RecencyWindow,
} from './temporal.js';

export { buildGroups, type GroupOptions } from './groups.js';
