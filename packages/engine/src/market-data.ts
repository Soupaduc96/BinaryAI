import {
  TIMEFRAME_SECONDS,
  type Candle,
  type CandleSeries,
  type DataQualityIssue,
  type DataQualityReport,
  type MarketDataSource,
  type Timeframe,
} from '@binaryai/types';
import { clamp01, err, ok, type Result } from '@binaryai/utils';
import { z } from 'zod';

/**
 * The market-data boundary.
 *
 * Everything from outside the process -- provider websockets, CSV files, API
 * request bodies -- must pass through `normalizeCandleSeries` before any other
 * package sees it. Downstream code is then allowed to assume the data is
 * structurally valid, which is why the indicators can simply throw on garbage.
 */

const finiteNumber = z
  .number()
  .refine((value) => Number.isFinite(value), { message: 'must be a finite number' });

export const rawCandleSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  open: finiteNumber,
  high: finiteNumber,
  low: finiteNumber,
  close: finiteNumber,
  volume: finiteNumber.nullable().optional(),
  complete: z.boolean().optional(),
});

export type RawCandle = z.infer<typeof rawCandleSchema>;

export const rawCandleSeriesSchema = z.object({
  asset: z.string().min(1).max(32),
  timeframe: z.enum(Object.keys(TIMEFRAME_SECONDS) as [Timeframe, ...Timeframe[]]),
  source: z.enum([
    'live_provider',
    'historical_provider',
    'historical_file',
    'synthetic',
    'unknown',
  ] as [MarketDataSource, ...MarketDataSource[]]),
  label: z.string().max(200).optional(),
  candles: z.array(rawCandleSchema).max(50_000),
});

export type RawCandleSeries = z.input<typeof rawCandleSeriesSchema>;

function issue(
  code: DataQualityIssue['code'],
  severity: DataQualityIssue['severity'],
  message: string,
  index?: number,
): DataQualityIssue {
  return index === undefined ? { code, severity, message } : { code, severity, message, index };
}

/**
 * Parse and normalize an untrusted payload into a `CandleSeries`.
 * Sorts by timestamp; does NOT silently repair bad data -- integrity problems
 * are reported by `assessDataQuality` so the risk engine can act on them.
 */
export function normalizeCandleSeries(input: unknown): Result<CandleSeries, string[]> {
  const parsed = rawCandleSeriesSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((item) => `${item.path.join('.') || '(root)'}: ${item.message}`),
    );
  }

  const candles: Candle[] = parsed.data.candles
    .map((raw) => ({
      timestamp: raw.timestamp,
      open: raw.open,
      high: raw.high,
      low: raw.low,
      close: raw.close,
      volume: raw.volume ?? null,
      complete: raw.complete ?? true,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  return ok({
    asset: parsed.data.asset,
    timeframe: parsed.data.timeframe,
    source: parsed.data.source,
    ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
    candles,
  });
}

/**
 * Slice a series to the first `endIndexInclusive + 1` candles.
 *
 * The backtester uses this to hand a strategy only the bars it could actually
 * have seen. Look-ahead bias becomes impossible rather than forbidden.
 */
export function sliceSeries(series: CandleSeries, endIndexInclusive: number): CandleSeries {
  return { ...series, candles: series.candles.slice(0, endIndexInclusive + 1) };
}

/**
 * How much ONE affected bar costs, by severity.
 *
 * These are per-bar weights, not per-series penalties: the score below divides
 * by the number of bars. An error bar is treated as wholly unusable, a warning
 * bar as half-compromised, an info bar as barely touched.
 */
const SEVERITY_PENALTY: Readonly<Record<DataQualityIssue['severity'], number>> = {
  error: 1,
  warning: 0.5,
  info: 0.1,
};

export interface DataQualityOptions {
  /** Minimum candles the caller needs; below this an error is raised. */
  readonly requiredHistory?: number;
  /** Tolerated deviation from the nominal interval, as a fraction. */
  readonly intervalTolerance?: number;
}

/**
 * Structural integrity report for a normalized series.
 * Cheap enough to run on every analysis call, and it is: silent data corruption
 * is far more expensive than the scan.
 */
export function assessDataQuality(
  series: CandleSeries,
  options: DataQualityOptions = {},
): DataQualityReport {
  const { requiredHistory = 0, intervalTolerance = 0.5 } = options;
  const { candles } = series;
  const issues: DataQualityIssue[] = [];

  if (candles.length === 0) {
    return {
      usable: false,
      score: 0,
      candleCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      issues: [issue('empty_series', 'error', 'The series contains no candles.')],
    };
  }

  if (candles.length < requiredHistory) {
    issues.push(
      issue(
        'insufficient_history',
        'error',
        `${candles.length} candles available, ${requiredHistory} required.`,
      ),
    );
  }

  const expectedStep = TIMEFRAME_SECONDS[series.timeframe] * 1000;
  let previous: Candle | null = null;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle === undefined) continue;

    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
      issues.push(issue('non_finite_value', 'error', 'Candle contains a non-finite price.', index));
      previous = candle;
      continue;
    }

    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      issues.push(
        issue('non_positive_price', 'error', 'Candle contains a non-positive price.', index),
      );
    }

    const maxBody = Math.max(candle.open, candle.close);
    const minBody = Math.min(candle.open, candle.close);
    if (candle.high < maxBody || candle.low > minBody || candle.high < candle.low) {
      issues.push(
        issue(
          'invalid_ohlc_range',
          'error',
          `OHLC is inconsistent (o=${candle.open} h=${candle.high} l=${candle.low} c=${candle.close}).`,
          index,
        ),
      );
    }

    if (candle.volume !== null && candle.volume < 0) {
      issues.push(issue('negative_volume', 'warning', 'Negative volume reported.', index));
    }

    if (previous !== null) {
      const delta = candle.timestamp - previous.timestamp;
      if (delta <= 0) {
        issues.push(
          issue(
            delta === 0 ? 'duplicate_timestamp' : 'non_monotonic_timestamps',
            'error',
            `Timestamp does not advance (previous=${previous.timestamp}, current=${candle.timestamp}).`,
            index,
          ),
        );
      } else if (delta > expectedStep * (1 + intervalTolerance)) {
        const missing = Math.round(delta / expectedStep) - 1;
        issues.push(
          issue(
            'timestamp_gap',
            'warning',
            `Gap of about ${missing} candle(s) before this bar.`,
            index,
          ),
        );
      } else if (delta < expectedStep * (1 - intervalTolerance)) {
        issues.push(
          issue(
            'unexpected_interval',
            'warning',
            `Interval ${delta}ms is shorter than the ${expectedStep}ms nominal step.`,
            index,
          ),
        );
      }
    }

    previous = candle;
  }

  const last = candles.at(-1);
  if (last && !last.complete) {
    issues.push(
      issue(
        'incomplete_last_candle',
        'info',
        'The final candle is still forming; decisions should use the previous close.',
        candles.length - 1,
      ),
    );
  }

  /*
   * The score is the PROPORTION of the series that is sound, not one minus a
   * running tally of complaints.
   *
   * The tally version made the score depend on how LONG a series was rather
   * than how healthy it was. Every market that closes leaves a gap at every
   * closure, so a 205-bar daily series of AAPL carried 45 perfectly ordinary
   * weekend gaps, each costing a flat 0.1, and saturated the score to 0 —
   * indistinguishable from a 30-bar series that was genuinely broken. Every
   * daily instrument was therefore blocked by the data-quality risk check no
   * matter how good its data was, which is this measure's purpose inverted.
   *
   * Dividing by the bar count fixes the dimension: 45 gaps in 205 bars is a
   * 22%-irregular series; 45 gaps in 50 bars is a broken one. Nothing here
   * knows what a weekend is, and nothing should — the gaps are still detected,
   * still counted, and still reported issue by issue. All that changed is that
   * their WEIGHT is relative to the series they were found in.
   */
  const bars = Math.max(candles.length, 1);
  let penalty = 0;
  for (const item of issues) penalty += SEVERITY_PENALTY[item.severity] / bars;
  const score = 1 - penalty;

  return {
    usable: !issues.some((item) => item.severity === 'error'),
    score: clamp01(score),
    candleCount: candles.length,
    firstTimestamp: candles[0]?.timestamp ?? null,
    lastTimestamp: last?.timestamp ?? null,
    issues,
  };
}
