/**
 * Shared internals for the indicator library.
 *
 * CONTRACT (applies to every exported indicator):
 *  - Output arrays have the SAME LENGTH as the input.
 *  - Positions that cannot be computed yet (warm-up) are `null`, never 0 and
 *    never silently dropped. Alignment bugs are the classic source of
 *    look-ahead errors, so the shape of the output makes them visible.
 *  - Functions are pure: no clocks, no randomness, no I/O.
 *  - Non-finite input is a programming error and throws. Market data is
 *    validated in @binaryai/engine before it ever reaches this package.
 */

export type IndicatorSeries = (number | null)[];

export class IndicatorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndicatorInputError';
  }
}

export function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new IndicatorInputError(`${name} must be a positive integer, received ${period}`);
  }
}

/** Bounds-checked read. Keeps `noUncheckedIndexedAccess` honest inside loops. */
export function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new IndicatorInputError(`index ${index} is out of bounds (length ${values.length})`);
  }
  if (!Number.isFinite(value)) {
    throw new IndicatorInputError(`non-finite value at index ${index}: ${value}`);
  }
  return value;
}

export function filled(length: number): IndicatorSeries {
  return new Array<number | null>(length).fill(null);
}

/**
 * Wilder's smoothing (RMA): seed with the simple average of the first `period`
 * samples, then rma[i] = (rma[i-1] * (period - 1) + x[i]) / period.
 * Used by RSI, ATR and ADX -- Wilder's indicators are defined in terms of it,
 * and substituting an EMA would produce subtly different (wrong) values.
 */
export function wilderSmooth(
  values: readonly (number | null)[],
  period: number,
  startIndex: number,
): IndicatorSeries {
  assertPeriod(period);
  const out = filled(values.length);
  const seedEnd = startIndex + period - 1;
  if (seedEnd >= values.length) return out;

  let sum = 0;
  for (let i = startIndex; i <= seedEnd; i += 1) {
    const value = values[i];
    if (value === null || value === undefined) return out;
    sum += value;
  }
  let previous = sum / period;
  out[seedEnd] = previous;

  for (let i = seedEnd + 1; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined) return out;
    previous = (previous * (period - 1) + value) / period;
    out[i] = previous;
  }
  return out;
}

/** Last non-null value of an indicator series, or null if there is none. */
export function lastValue(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Value at `index`, normalized to null for out-of-range or undefined. */
export function valueAt(series: readonly (number | null)[], index: number): number | null {
  const value = series[index];
  return value === undefined ? null : value;
}
