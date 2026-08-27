import { assertPeriod, at, filled, type IndicatorSeries, wilderSmooth } from './internal.js';
import { sma } from './moving-averages.js';

export interface OhlcInput {
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
}

export function assertSameLength(input: OhlcInput): number {
  const { high, low, close } = input;
  if (high.length !== low.length || low.length !== close.length) {
    throw new Error(
      `OHLC arrays must be the same length (high=${high.length}, low=${low.length}, close=${close.length})`,
    );
  }
  return close.length;
}

/**
 * True Range. TR[0] is high - low because there is no previous close.
 */
export function trueRange(input: OhlcInput): IndicatorSeries {
  const length = assertSameLength(input);
  const out = filled(length);
  if (length === 0) return out;

  out[0] = at(input.high, 0) - at(input.low, 0);
  for (let i = 1; i < length; i += 1) {
    const high = at(input.high, i);
    const low = at(input.low, i);
    const previousClose = at(input.close, i - 1);
    out[i] = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }
  return out;
}

/** Wilder's ATR. First value lands at index `period - 1`. */
export function atr(input: OhlcInput, period = 14): IndicatorSeries {
  assertPeriod(period);
  return wilderSmooth(trueRange(input), period, 0);
}

export interface BollingerResult {
  readonly middle: IndicatorSeries;
  readonly upper: IndicatorSeries;
  readonly lower: IndicatorSeries;
  /** (upper - lower) / middle, as a fraction. A squeeze/expansion measure. */
  readonly bandwidth: IndicatorSeries;
  /** Where price sits inside the bands: 0 = lower, 1 = upper. */
  readonly percentB: IndicatorSeries;
}

/**
 * Bollinger Bands using the POPULATION standard deviation over the same window
 * as the middle SMA (Bollinger's original definition).
 */
export function bollingerBands(
  values: readonly number[],
  period = 20,
  multiplier = 2,
): BollingerResult {
  assertPeriod(period);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`multiplier must be a positive number, received ${multiplier}`);
  }

  const middle = sma(values, period);
  const upper = filled(values.length);
  const lower = filled(values.length);
  const bandwidth = filled(values.length);
  const percentB = filled(values.length);

  for (let i = period - 1; i < values.length; i += 1) {
    const average = middle[i];
    if (average === null || average === undefined) continue;

    let sumSquares = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      const diff = at(values, k) - average;
      sumSquares += diff * diff;
    }
    const deviation = Math.sqrt(sumSquares / period);

    const upperValue = average + multiplier * deviation;
    const lowerValue = average - multiplier * deviation;
    upper[i] = upperValue;
    lower[i] = lowerValue;
    bandwidth[i] = average === 0 ? null : (upperValue - lowerValue) / average;

    const span = upperValue - lowerValue;
    percentB[i] = span === 0 ? null : (at(values, i) - lowerValue) / span;
  }

  return { middle, upper, lower, bandwidth, percentB };
}
