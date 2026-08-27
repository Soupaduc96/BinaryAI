/** Numeric helpers shared by the analysis, confidence and risk engines. */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError('clamp: min must be <= max');
  return Math.min(Math.max(value, min), max);
}

/** Clamp into 0..1. Used everywhere a score is produced. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Division that returns `fallback` instead of Infinity/NaN on a zero divisor. */
export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (denominator === 0 || !Number.isFinite(denominator)) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Population standard deviation. Returns null for an empty input. */
export function standardDeviation(values: readonly number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  let sumSquares = 0;
  for (const value of values) {
    const diff = value - average;
    sumSquares += diff * diff;
  }
  return Math.sqrt(sumSquares / values.length);
}

export function percentChange(from: number, to: number): number {
  return safeDivide(to - from, Math.abs(from)) * 100;
}

/**
 * Map a value onto 0..1 with a soft ramp between `low` and `high`.
 * Used to turn raw indicator readings into confidence components.
 */
export function normalizeRange(value: number, low: number, high: number): number {
  if (high === low) return 0;
  return clamp01((value - low) / (high - low));
}
