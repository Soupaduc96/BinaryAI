import { assertPeriod, at, filled, type IndicatorSeries } from './internal.js';

/** Simple moving average. First value lands at index `period - 1`. */
export function sma(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  const out = filled(values.length);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += at(values, i);
    if (i >= period) sum -= at(values, i - period);
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * samples (the conventional seed; a from-first-sample seed converges to the
 * same curve but disagrees early, which would break short backtests).
 */
export function ema(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  const out = filled(values.length);
  if (values.length < period) return out;

  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += at(values, i);

  let previous = sum / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = (at(values, i) - previous) * multiplier + previous;
    out[i] = previous;
  }
  return out;
}

/**
 * Rate of change, in percent, over `period` bars.
 * roc[i] = (v[i] - v[i - period]) / |v[i - period]| * 100
 */
export function roc(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  const out = filled(values.length);
  for (let i = period; i < values.length; i += 1) {
    const previous = at(values, i - period);
    if (previous === 0) continue;
    out[i] = ((at(values, i) - previous) / Math.abs(previous)) * 100;
  }
  return out;
}

/**
 * Least-squares slope over a rolling window, expressed as price change per bar.
 * Used by the regime classifier as a direction cue that is less jumpy than
 * comparing two moving averages.
 */
export function linearSlope(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period);
  const out = filled(values.length);
  if (period < 2 || values.length < period) return out;

  // x is 0..period-1 within each window, so these sums are constant.
  const n = period;
  const sumX = ((n - 1) * n) / 2;
  const sumXX = ((n - 1) * n * (2 * n - 1)) / 6;
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return out;

  for (let i = period - 1; i < values.length; i += 1) {
    let sumY = 0;
    let sumXY = 0;
    for (let k = 0; k < n; k += 1) {
      const y = at(values, i - (n - 1) + k);
      sumY += y;
      sumXY += k * y;
    }
    out[i] = (n * sumXY - sumX * sumY) / denominator;
  }
  return out;
}
