import {
  TIMEFRAME_SECONDS,
  type CandleSeries,
  type IngestionIssue,
  type IngestionIssueCode,
  type IngestionQualityReport,
  type ProviderCapabilities,
} from '@binaryai/types';
import { clamp01 } from '@binaryai/utils';

/**
 * Market-data quality validation.
 *
 * The engine's `assessDataQuality` already covers structural integrity of a
 * series once it exists. This layer covers what only ingestion can know: that a
 * provider served a timeframe it supports, that candle timestamps sit on real
 * boundaries, that nothing arrived from the future, and that the batch is not
 * stale.
 *
 * Failures are recorded, counted and returned. Nothing is silently dropped and
 * nothing is silently repaired — a repaired candle is a fabricated candle, and
 * it would be indistinguishable from real data by the time a strategy saw it.
 */

const SEVERITY_PENALTY: Record<IngestionIssue['severity'], number> = {
  error: 0.35,
  warning: 0.08,
  info: 0.01,
};

export interface QualityOptions {
  /** Clock, injected so validation is deterministic in tests. */
  readonly now?: number;
  /**
   * How far ahead of `now` a candle may legitimately be. Clock skew between a
   * provider and this machine is normal; hours are not.
   */
  readonly futureToleranceSeconds?: number;
  /** Beyond this age the newest candle is reported stale. */
  readonly stalenessThresholdSeconds?: number;
  /** When known, lets the scan verify the provider serves this timeframe. */
  readonly capabilities?: ProviderCapabilities;
}

function issue(
  code: IngestionIssueCode,
  severity: IngestionIssue['severity'],
  message: string,
  at?: number,
): IngestionIssue {
  return at === undefined ? { code, severity, message } : { code, severity, message, at };
}

export function validateIngestedBatch(
  series: CandleSeries,
  options: QualityOptions = {},
): IngestionQualityReport {
  const {
    now = Date.now(),
    futureToleranceSeconds = 120,
    stalenessThresholdSeconds = 0,
    capabilities,
  } = options;

  const issues: IngestionIssue[] = [];
  const stepMs = TIMEFRAME_SECONDS[series.timeframe] * 1000;
  const candles = series.candles;

  if (candles.length === 0) {
    return {
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      missingIntervals: 0,
      issues: [issue('empty_response', 'warning', 'Provider returned no candles for this window.')],
      score: 0,
      usable: false,
    };
  }

  if (capabilities && !capabilities.supportedTimeframes.includes(series.timeframe)) {
    issues.push(
      issue(
        'unsupported_timeframe',
        'error',
        `Provider ${capabilities.id} does not serve ${series.timeframe}; the batch cannot be trusted.`,
      ),
    );
  }

  const seen = new Set<number>();
  let duplicates = 0;
  let rejected = 0;
  let missingIntervals = 0;
  let previousTimestamp: number | null = null;

  for (const candle of candles) {
    let candleRejected = false;

    // --- value integrity -------------------------------------------------
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (!prices.every(Number.isFinite)) {
      issues.push(
        issue('non_finite_value', 'error', 'Candle contains a non-finite price.', candle.timestamp),
      );
      candleRejected = true;
    } else {
      if (prices.some((price) => price <= 0)) {
        issues.push(
          issue(
            'non_positive_price',
            'error',
            'Candle contains a non-positive price.',
            candle.timestamp,
          ),
        );
        candleRejected = true;
      }
      const bodyHigh = Math.max(candle.open, candle.close);
      const bodyLow = Math.min(candle.open, candle.close);
      if (candle.high < candle.low || candle.high < bodyHigh || candle.low > bodyLow) {
        issues.push(
          issue(
            'invalid_ohlc',
            'error',
            `OHLC is inconsistent (o=${candle.open} h=${candle.high} l=${candle.low} c=${candle.close}).`,
            candle.timestamp,
          ),
        );
        candleRejected = true;
      }
    }

    if (candle.volume !== null && candle.volume < 0) {
      issues.push(
        issue('negative_volume', 'warning', 'Negative volume reported.', candle.timestamp),
      );
    }

    // --- timestamp integrity ---------------------------------------------
    if (candle.timestamp > now + futureToleranceSeconds * 1000) {
      issues.push(
        issue(
          'future_timestamp',
          'error',
          `Candle is ${Math.round((candle.timestamp - now) / 1000)}s in the future, beyond the ${futureToleranceSeconds}s tolerance.`,
          candle.timestamp,
        ),
      );
      candleRejected = true;
    }

    if (candle.timestamp % stepMs !== 0) {
      // A bar that does not sit on a timeframe boundary is not the bar it
      // claims to be, and would misalign every indicator computed from it.
      issues.push(
        issue(
          'unaligned_candle_boundary',
          'error',
          `Timestamp is not aligned to a ${series.timeframe} boundary.`,
          candle.timestamp,
        ),
      );
      candleRejected = true;
    }

    // --- sequence integrity ----------------------------------------------
    if (seen.has(candle.timestamp)) {
      duplicates += 1;
      issues.push(
        issue('duplicate_candle', 'warning', 'Duplicate candle timestamp.', candle.timestamp),
      );
    } else {
      seen.add(candle.timestamp);
    }

    if (previousTimestamp !== null) {
      const delta = candle.timestamp - previousTimestamp;
      if (delta < 0) {
        issues.push(
          issue(
            'out_of_order',
            'error',
            'Candle arrived out of chronological order.',
            candle.timestamp,
          ),
        );
        candleRejected = true;
      } else if (delta > 0 && delta < stepMs) {
        issues.push(
          issue(
            'overlapping_candle',
            'error',
            `Candle overlaps the previous one by ${stepMs - delta}ms.`,
            candle.timestamp,
          ),
        );
        candleRejected = true;
      } else if (delta > stepMs) {
        const missing = Math.round(delta / stepMs) - 1;
        missingIntervals += missing;
        // Gaps are normal (venue outage, thin market) and are reported, not
        // filled: an interpolated candle is invented data.
        issues.push(
          issue(
            'missing_interval',
            'warning',
            `${missing} interval(s) missing before this candle.`,
            candle.timestamp,
          ),
        );
      }
    }

    if (candleRejected) rejected += 1;
    previousTimestamp = candle.timestamp;
  }

  // --- staleness -----------------------------------------------------------
  const newest = candles.at(-1)?.timestamp ?? 0;
  const threshold = stalenessThresholdSeconds > 0 ? stalenessThresholdSeconds : (stepMs / 1000) * 3;
  const ageSeconds = Math.round((now - newest) / 1000);
  if (ageSeconds > threshold) {
    issues.push(
      issue(
        'stale_data',
        'warning',
        `Newest candle is ${ageSeconds}s old (threshold ${threshold}s).`,
        newest,
      ),
    );
  }

  let score = 1;
  for (const item of issues) score -= SEVERITY_PENALTY[item.severity];

  return {
    accepted: candles.length - rejected,
    rejected,
    duplicates,
    missingIntervals,
    issues,
    score: clamp01(score),
    usable: !issues.some((item) => item.severity === 'error'),
  };
}

/**
 * Drop the candles the scan rejected, keeping the rest.
 *
 * Separate from validation on purpose: the caller decides whether to store a
 * partially-valid batch, and the report always describes the full batch so the
 * rejection is visible rather than implied by a smaller number.
 */
export function withoutRejectedCandles(
  series: CandleSeries,
  report: IngestionQualityReport,
): CandleSeries {
  if (report.rejected === 0) return series;
  const rejectedAt = new Set(
    report.issues
      .filter((item) => item.severity === 'error' && item.at !== undefined)
      .map((item) => item.at as number),
  );
  return {
    ...series,
    candles: series.candles.filter((candle) => !rejectedAt.has(candle.timestamp)),
  };
}
