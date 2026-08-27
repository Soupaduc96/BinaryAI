import type { MarketDataSource, Timeframe } from './market.js';
import type { MarketRegime, SignalDirection } from './signal.js';

/**
 * Outcome intelligence and performance analytics.
 *
 * The whole vocabulary here exists to keep one distinction visible: what was
 * MEASURED versus what is merely UNKNOWN. Three conventions carry that:
 *
 *  1. A statistic that cannot be computed is `null`, never `0`. Zero wins out
 *     of zero settled signals is not "0% accurate", it is "no evidence", and
 *     collapsing the two is the single most misleading thing this layer could
 *     do.
 *  2. Every statistic carries its own `sampleSize` and `evidence` level, so a
 *     figure can never be read without knowing how much is behind it.
 *  3. Nothing here is called a probability. Confidence is an uncalibrated
 *     heuristic score; see `CalibrationReport` for why that matters.
 */

// ------------------------------------------------------------- taxonomy --

/**
 * How one signal ended, for analytics purposes.
 *
 * Wider than the database's `trade_outcome` enum because analytics must also
 * account for signals that never became a prediction at all. The distinctions
 * are not cosmetic -- each of these would corrupt accuracy if folded into
 * `loss`:
 *
 *  - `tie`        settled exactly at the entry price. A real settlement, but
 *                 the direction was neither right nor wrong, so it belongs in
 *                 neither numerator nor denominator.
 *  - `unresolved` expired with no settlement candle available yet. Pending, not
 *                 failed.
 *  - `invalid`    settled, but the source data cannot support the comparison.
 *  - `skipped`    the engine declined to predict, or risk rejected it. There
 *                 was no directional claim to be right or wrong about.
 */
export type OutcomeClass = 'win' | 'loss' | 'tie' | 'unresolved' | 'invalid' | 'skipped';

/**
 * Why a settled signal was kept out of calibration.
 *
 * Recorded rather than dropped: "we have 400 samples and excluded 37" is an
 * auditable statement, "we have 363 samples" is not.
 */
export type ExclusionReason =
  | 'not_settled'
  | 'no_direction'
  | 'not_accepted'
  | 'missing_strategy'
  | 'missing_confidence'
  | 'missing_market_context'
  | 'unknown_data_origin'
  | 'synthetic_data';

// ------------------------------------------------------------- evidence --

/**
 * How much weight a statistic can bear.
 *
 * Thresholds are configuration, not constants, and every metric reports its
 * level so four observations can never be presented with the authority of four
 * thousand.
 */
export type EvidenceLevel = 'insufficient' | 'preliminary' | 'developing' | 'established';

export interface EvidenceThresholds {
  /** Below this, no rate is reported at all. */
  readonly minimumSamples: number;
  readonly preliminary: number;
  readonly developing: number;
  readonly established: number;
}

/**
 * An observed rate, or an explicit absence of one.
 *
 * `value` is null whenever the rate is undefined -- no denominator, or a
 * denominator below the minimum sample policy. Callers cannot accidentally
 * render a missing measurement as zero, because there is no number to render.
 */
export interface ObservedRate {
  /** Wins / settled directional outcomes. Null when undefined. */
  readonly value: number | null;
  /** Settled directional outcomes: the denominator actually used. */
  readonly sampleSize: number;
  readonly evidence: EvidenceLevel;
  /** True when `sampleSize` meets the configured minimum. */
  readonly sufficient: boolean;
}

/** Counts behind a rate. `wins + losses` is always the accuracy denominator. */
export interface OutcomeCounts {
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly unresolved: number;
  readonly invalid: number;
  readonly skipped: number;
  /** Signals considered before eligibility filtering. */
  readonly total: number;
}

// -------------------------------------------------------------- buckets --

/** A confidence band and what actually happened inside it. */
export interface ConfidenceBucket {
  /** Stable identifier, e.g. '0.60-0.79'. */
  readonly id: string;
  readonly lowerInclusive: number;
  readonly upperInclusive: number;
  /** Midpoint of the band, used for divergence reporting. */
  readonly midpoint: number;
  readonly counts: OutcomeCounts;
  readonly observedAccuracy: ObservedRate;
  /** Mean confidence of the samples that landed here. Null when empty. */
  readonly meanConfidence: number | null;
}

// ---------------------------------------------------------- calibration --

/**
 * Whether higher confidence actually corresponded to higher observed accuracy.
 *
 * Deliberately NOT a probabilistic claim. See `CalibrationReport.semantics`.
 */
export type ConfidenceRelationship =
  'not_established' | 'monotonic_increasing' | 'monotonic_decreasing' | 'non_monotonic';

export interface CalibrationMethodology {
  /** e.g. 'bucketed_frequency_v1'. */
  readonly method: string;
  readonly version: string;
  /** Version of the eligibility rules that produced the sample set. */
  readonly sampleDefinitionVersion: string;
  /** Version of the bucket boundaries. */
  readonly bucketVersion: string;
  /** What the confidence number actually is, at source. */
  readonly confidenceSource: string;
}

/**
 * The result of measuring confidence against outcomes.
 *
 * `implemented` answers "is there a calibration MODEL?" and stays false until
 * one exists and is validated. Producing this report is measurement, not
 * calibration, and the two must never be conflated -- accumulating samples is
 * a prerequisite for calibration, not evidence of it.
 */
export interface CalibrationReport {
  readonly methodology: CalibrationMethodology;
  /** True only when a validated calibration MODEL exists. */
  readonly implemented: boolean;
  readonly generatedAt: number;
  readonly buckets: readonly ConfidenceBucket[];
  readonly eligibleSamples: number;
  readonly settledSamples: number;
  readonly excludedSamples: number;
  readonly exclusions: Readonly<Record<string, number>>;
  readonly evidence: EvidenceLevel;
  readonly minimumSampleSize: number;
  readonly relationship: ConfidenceRelationship;
  /**
   * Mean |confidence midpoint − observed accuracy|, weighted by bucket size.
   *
   * Null when there is not enough evidence. This is an ECE-SHAPED diagnostic,
   * and reading it as a probabilistic calibration error would require
   * confidence to be a probability, which it is not. See `semantics`.
   */
  readonly divergence: number | null;
  /** Plain statement of what the numbers do and do not mean. */
  readonly semantics: string;
  readonly limitations: readonly string[];
}

// -------------------------------------------------------- aggregations --

/** One row of a grouped breakdown. */
export interface AnalyticsGroup {
  /** The group's value, e.g. 'trend-momentum', 'trend_up', '5m', 'BTC-USD'. */
  readonly key: string;
  /** Present where the dimension is versioned, e.g. a strategy. */
  readonly version?: string | null;
  readonly counts: OutcomeCounts;
  readonly observedAccuracy: ObservedRate;
  readonly meanConfidence: number | null;
}

export type AnalyticsDimension = 'strategy' | 'regime' | 'timeframe' | 'asset' | 'direction';

/** Aggregation granularity for the time series. */
export type AnalyticsInterval = 'day' | 'week' | 'month';

export interface AnalyticsPeriod {
  /** Epoch ms at the start of the bucket. */
  readonly startsAt: number;
  readonly counts: OutcomeCounts;
  readonly observedAccuracy: ObservedRate;
  readonly meanConfidence: number | null;
}

/**
 * Where every number in a response came from.
 *
 * Carried on every analytics payload so a figure can always be traced back to
 * persisted outcomes, and so exchange-derived settlement can never be mistaken
 * for broker settlement.
 */
export interface AnalyticsProvenance {
  readonly generatedAt: number;
  readonly methodologyVersion: string;
  readonly sampleDefinitionVersion: string;
  /** 'system' | 'account' | 'all' -- which rows were visible. */
  readonly scope: string;
  readonly dataOrigins: readonly MarketDataSource[];
  readonly settlementSemantics: string;
  /** Window actually queried, echoed back. */
  readonly range: { readonly from: number | null; readonly to: number | null };
}

export interface AnalyticsOverview {
  readonly counts: OutcomeCounts;
  readonly observedAccuracy: ObservedRate;
  readonly meanConfidence: number | null;
  readonly settledSamples: number;
  readonly pendingSettlement: number;
  readonly firstSettledAt: number | null;
  readonly lastSettledAt: number | null;
  readonly provenance: AnalyticsProvenance;
}

// --------------------------------------------------------------- query --

/**
 * The raw aggregate the storage layer returns for one group.
 *
 * Deliberately dumb: counts and sums only. Every derived statistic --
 * accuracy, evidence level, calibration divergence -- is computed in
 * @binaryai/analytics so it is testable without a database and cannot drift
 * between SQL dialects.
 */
export interface AnalyticsAggregateRow {
  readonly key: string;
  readonly version: string | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly unresolved: number;
  readonly invalid: number;
  readonly skipped: number;
  readonly total: number;
  /** Sum of confidence over eligible settled samples, for a mean. */
  readonly confidenceSum: number;
  readonly confidenceCount: number;
}

export interface AnalyticsQuery {
  /** Epoch ms, inclusive. Bounded by the caller; never unbounded by default. */
  readonly from?: number;
  readonly to?: number;
  readonly assetSymbol?: string;
  readonly timeframe?: Timeframe;
  readonly strategyKey?: string;
  readonly regime?: MarketRegime;
  readonly direction?: Exclude<SignalDirection, 'none'>;
  readonly limit?: number;
}
