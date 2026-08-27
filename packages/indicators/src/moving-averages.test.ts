import { describe, expect, it } from 'vitest';
import { ema, linearSlope, roc, sma } from './moving-averages.js';
import { IndicatorInputError } from './internal.js';

describe('sma', () => {
  it('returns nulls through the warm-up period and the mean afterwards', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('always returns an array the same length as the input', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
    expect(sma([], 3)).toEqual([]);
  });

  it('does not drift when the window rolls', () => {
    const values = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = sma(values, 10);
    // Mean of 41..50
    expect(result[49]).toBeCloseTo(45.5, 10);
  });

  it('rejects a non-positive period', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(IndicatorInputError);
    expect(() => sma([1, 2, 3], 1.5)).toThrow(IndicatorInputError);
  });

  it('rejects non-finite input rather than producing NaN', () => {
    expect(() => sma([1, Number.NaN, 3], 2)).toThrow(IndicatorInputError);
  });
});

describe('ema', () => {
  it('seeds with the SMA of the first period and then applies the multiplier', () => {
    // seed = mean(1,2,3) = 2; k = 2/(3+1) = 0.5
    // idx3 = (4 - 2) * 0.5 + 2 = 3; idx4 = (5 - 3) * 0.5 + 3 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('equals the constant value for a flat series', () => {
    const result = ema([7, 7, 7, 7, 7, 7], 3);
    expect(result[5]).toBeCloseTo(7, 10);
  });

  it('reacts faster than the SMA of the same period', () => {
    const values = [10, 10, 10, 10, 10, 20];
    const fastAverage = ema(values, 5).at(-1);
    const slowAverage = sma(values, 5).at(-1);
    expect(fastAverage).not.toBeNull();
    expect(slowAverage).not.toBeNull();
    expect(fastAverage as number).toBeGreaterThan(slowAverage as number);
  });
});

describe('roc', () => {
  it('measures percentage change over the period', () => {
    // index 2 compares 120 against 100
    expect(roc([100, 110, 120], 2)?.[2]).toBeCloseTo(20, 10);
  });

  it('leaves the warm-up region null', () => {
    const result = roc([100, 110, 120], 2);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
  });
});

describe('linearSlope', () => {
  it('recovers the exact slope of a linear series', () => {
    const values = [10, 12, 14, 16, 18, 20];
    expect(linearSlope(values, 4).at(-1)).toBeCloseTo(2, 10);
  });

  it('is zero for a flat series', () => {
    expect(linearSlope([5, 5, 5, 5, 5], 5).at(-1)).toBeCloseTo(0, 10);
  });

  it('is negative for a falling series', () => {
    const slope = linearSlope([20, 18, 16, 14], 4).at(-1);
    expect(slope as number).toBeLessThan(0);
  });
});
