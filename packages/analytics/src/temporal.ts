import type {
  AnalyticsAggregateRow,
  AnalyticsInterval,
  AnalyticsPeriod,
  EvidenceThresholds,
} from '@binaryai/types';
import { DEFAULT_EVIDENCE_THRESHOLDS } from './methodology.js';
import { countsFrom, meanConfidence, observedAccuracy } from './rates.js';

/**
 * Time-based analysis: series, splits and recency.
 *
 * Two independent concerns live here.
 *
 * **Reporting over time** — buckets of settled outcomes by day, week or month.
 * The rule is that a period with no observations stays absent, never appearing
 * as a zero. A chart drawn through zeros for quiet periods is a fabricated
 * performance curve; a chart with gaps is the truth.
 *
 * **Temporal splitting** — the framework for eventually fitting a calibration
 * model without evaluating it on the observations that produced it. That
 * leakage is the standard way a calibration result comes out convincing and
 * wrong. No model is fitted in this phase, so the split is currently a
 * *declaration* of how one would have to be done, and `splitAt` exists so the
 * boundary is explicit and reproducible rather than improvised later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds spanned by one bucket of the given interval. */
export function intervalMs(interval: AnalyticsInterval): number {
  switch (interval) {
    case 'day':
      return DAY_MS;
    case 'week':
      return 7 * DAY_MS;
    case 'month':
      // Calendar months vary; 30 days is the bucketing width, and the API
      // labels these as 30-day periods rather than named calendar months so
      // the approximation is never mistaken for "August".
      return 30 * DAY_MS;
  }
}

/**
 * Chooses a granularity that produces useful buckets for the data available.
 *
 * A day-by-day chart of 12 outcomes is twelve buckets of one, each below any
 * reporting threshold — technically accurate and completely uninformative.
 * Widening the bucket does not create evidence, but it stops the interface
 * implying there is more resolution than there is.
 */
export function suggestInterval(sampleCount: number, spanMs: number): AnalyticsInterval {
  if (sampleCount <= 0) return 'day';
  const days = Math.max(1, spanMs / DAY_MS);
  const perDay = sampleCount / days;

  if (perDay >= 20) return 'day';
  if (perDay >= 3) return 'week';
  return 'month';
}

/**
 * Builds the time series from storage aggregates.
 *
 * Rows arrive already bucketed by SQL (`date_trunc`), keyed by the bucket start
 * as an epoch-ms string. Periods with no rows are simply not present in the
 * output — see the module note on why gaps are preserved.
 */
export function buildPeriods(
  rows: readonly AnalyticsAggregateRow[],
  thresholds: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS,
): readonly AnalyticsPeriod[] {
  return rows
    .map((row) => {
      const counts = countsFrom(row);
      return {
        startsAt: Number(row.key),
        counts,
        observedAccuracy: observedAccuracy(counts, thresholds),
        meanConfidence: meanConfidence(row.confidenceSum, row.confidenceCount),
      };
    })
    .filter((period) => Number.isFinite(period.startsAt))
    .sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Where a training period would end and an evaluation period begin.
 *
 * Split by TIME, never by a random shuffle. Randomly holding out rows would let
 * the model learn from outcomes that occurred after the ones it is tested on,
 * which is not a thing that can happen in production and produces a score that
 * cannot be reproduced there either.
 *
 * `ratio` is the proportion of the span assigned to training. Returns null when
 * the window is degenerate — one instant cannot be split.
 */
export function splitAt(
  firstAt: number,
  lastAt: number,
  ratio = 0.7,
): { trainingEndsAt: number; evaluationStartsAt: number } | null {
  if (!Number.isFinite(firstAt) || !Number.isFinite(lastAt) || lastAt <= firstAt) return null;
  if (!(ratio > 0 && ratio < 1)) return null;

  const boundary = Math.floor(firstAt + (lastAt - firstAt) * ratio);
  return { trainingEndsAt: boundary, evaluationStartsAt: boundary + 1 };
}

export type RecencyWindow = 'last_7d' | 'last_30d' | 'last_90d' | 'all';

/**
 * The epoch-ms lower bound for a recency window, or null for "all".
 *
 * Recency is reported ALONGSIDE the full history, never blended into it. No
 * exponential decay, no recency weighting: weighting recent observations more
 * heavily is a modelling decision that changes what the number means, and it
 * would need its own methodology version and its own justification. Showing
 * both and letting the reader compare requires neither.
 */
export function recencyCutoff(window: RecencyWindow, now: number): number | null {
  switch (window) {
    case 'last_7d':
      return now - 7 * DAY_MS;
    case 'last_30d':
      return now - 30 * DAY_MS;
    case 'last_90d':
      return now - 90 * DAY_MS;
    case 'all':
      return null;
  }
}
