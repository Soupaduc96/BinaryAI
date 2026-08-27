/**
 * Confidence scoring.
 *
 * HONESTY CONSTRAINT: the current scorer is a weighted rule-based heuristic.
 * A score of 0.87 does NOT mean "87% of these win". Until real outcomes are
 * collected and the scorer is calibrated against them, every result carries
 * `calibration: 'uncalibrated_heuristic'` and the UI must render that label
 * next to the number. See docs/ai-architecture.md.
 */

export type ConfidenceCalibration =
  'uncalibrated_heuristic' | 'backtest_calibrated' | 'model_calibrated';

export interface ConfidenceComponent {
  readonly key: string;
  readonly label: string;
  /** Raw component score, 0..1. */
  readonly score: number;
  /** Relative weight of this component within the model, 0..1. */
  readonly weight: number;
  /** score * weight, precomputed so consumers do not re-derive it. */
  readonly contribution: number;
  readonly detail: string;
}

export interface ConfidenceResult {
  /** 0..1. Render as a percentage only alongside the calibration label. */
  readonly score: number;
  readonly components: readonly ConfidenceComponent[];
  readonly calibration: ConfidenceCalibration;
  /** Number of historical outcomes backing the calibration; null when none. */
  readonly sampleSize: number | null;
  /** Human-readable statement of what this number is, and what it is not. */
  readonly disclaimer: string;
}
