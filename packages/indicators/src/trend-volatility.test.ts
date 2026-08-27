import { describe, expect, it } from 'vitest';
import { adx } from './trend.js';
import { atr, bollingerBands, trueRange, type OhlcInput } from './volatility.js';
import { sma } from './moving-averages.js';
import { barsSinceCross, crossAt } from './cross.js';

/** Deterministic OHLC where each bar moves by `step` and has a fixed range. */
function buildOhlc(count: number, start: number, step: number, range: number): OhlcInput {
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const price = start + step * i;
    close.push(price);
    high.push(price + range / 2);
    low.push(price - range / 2);
  }
  return { high, low, close };
}

describe('trueRange', () => {
  it('uses high - low for the first bar', () => {
    const input: OhlcInput = { high: [10], low: [8], close: [9] };
    expect(trueRange(input)).toEqual([2]);
  });

  it('accounts for gaps against the previous close', () => {
    const input: OhlcInput = { high: [10, 20], low: [8, 19], close: [9, 19.5] };
    // bar 1: max(20-19, |20-9|, |19-9|) = 11
    expect(trueRange(input)[1]).toBeCloseTo(11, 10);
  });

  it('rejects mismatched array lengths', () => {
    expect(() => trueRange({ high: [1, 2], low: [1], close: [1, 2] })).toThrow(/same length/);
  });
});

describe('atr', () => {
  it('equals the constant true range when every bar is identical', () => {
    const flat: OhlcInput = {
      high: new Array<number>(30).fill(101),
      low: new Array<number>(30).fill(99),
      close: new Array<number>(30).fill(100),
    };
    expect(atr(flat, 14).at(-1)).toBeCloseTo(2, 10);
  });

  it('lands its first value at index period - 1', () => {
    const input = buildOhlc(30, 100, 0.5, 1);
    const result = atr(input, 14);
    expect(result[12]).toBeNull();
    expect(result[13]).not.toBeNull();
  });

  it('is never negative', () => {
    const input = buildOhlc(60, 100, -0.3, 2);
    for (const value of atr(input, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('bollingerBands', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);

  it('uses the SMA as the middle band', () => {
    const { middle } = bollingerBands(values, 20, 2);
    expect(middle).toEqual(sma(values, 20));
  });

  it('keeps the bands symmetric around the middle', () => {
    const { middle, upper, lower } = bollingerBands(values, 20, 2);
    const index = values.length - 1;
    const centre = middle[index] as number;
    expect((upper[index] as number) - centre).toBeCloseTo(centre - (lower[index] as number), 10);
  });

  it('collapses to zero width on a flat series', () => {
    const flat = new Array<number>(30).fill(42);
    const { upper, lower, bandwidth, percentB } = bollingerBands(flat, 20, 2);
    const index = flat.length - 1;
    expect(upper[index]).toBeCloseTo(42, 10);
    expect(lower[index]).toBeCloseTo(42, 10);
    expect(bandwidth[index]).toBeCloseTo(0, 10);
    // Undefined position inside a zero-width band -- null, not a fabricated 0.5.
    expect(percentB[index]).toBeNull();
  });
});

describe('adx', () => {
  it('lands its first value at index 2 * period - 1', () => {
    const input = buildOhlc(60, 100, 0.5, 1);
    const { adx: strength } = adx(input, 14);
    expect(strength[26]).toBeNull();
    expect(strength[27]).not.toBeNull();
  });

  it('reports a strong trend with +DI above -DI in a clean uptrend', () => {
    const input = buildOhlc(80, 100, 1, 0.5);
    const { adx: strength, plusDi, minusDi } = adx(input, 14);
    expect(strength.at(-1) as number).toBeGreaterThan(25);
    expect(plusDi.at(-1) as number).toBeGreaterThan(minusDi.at(-1) as number);
  });

  it('reports -DI above +DI in a clean downtrend', () => {
    const input = buildOhlc(80, 200, -1, 0.5);
    const { plusDi, minusDi } = adx(input, 14);
    expect(minusDi.at(-1) as number).toBeGreaterThan(plusDi.at(-1) as number);
  });

  it('stays within 0..100', () => {
    const input = buildOhlc(80, 100, 0.4, 1.5);
    for (const value of adx(input, 14).adx) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('returns all nulls when history is too short', () => {
    const input = buildOhlc(20, 100, 1, 1);
    expect(adx(input, 14).adx.every((value) => value === null)).toBe(true);
  });
});

describe('cross detection', () => {
  const fast = [1, 2, 3, 4, 3, 2];
  const slow = [3, 3, 3, 3, 3, 3];

  it('detects an upward cross', () => {
    expect(crossAt(fast, slow, 3)).toBe('above');
  });

  it('detects a downward cross', () => {
    expect(crossAt(fast, slow, 5)).toBe('below');
  });

  it('never reports a cross inside a warm-up region', () => {
    expect(crossAt([null, null, 5], [null, null, 4], 2)).toBe('none');
    expect(crossAt(fast, slow, 0)).toBe('none');
  });

  it('reports how many bars ago the last cross happened', () => {
    expect(barsSinceCross(fast, slow, 10)).toEqual({ direction: 'below', barsAgo: 0 });
  });

  it('returns null when no cross falls inside the lookback', () => {
    expect(barsSinceCross([1, 1, 1, 1], [2, 2, 2, 2], 3)).toBeNull();
  });
});
