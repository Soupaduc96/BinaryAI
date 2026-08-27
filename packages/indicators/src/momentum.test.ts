import { describe, expect, it } from 'vitest';
import { macd, rsi } from './momentum.js';
import { ema } from './moving-averages.js';

const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
const falling = Array.from({ length: 40 }, (_, i) => 100 - i);

describe('rsi', () => {
  it('starts at index `period`, not earlier', () => {
    const result = rsi(rising, 14);
    expect(result.slice(0, 14).every((value) => value === null)).toBe(true);
    expect(result[14]).not.toBeNull();
  });

  it('is 100 when every change is a gain', () => {
    expect(rsi(rising, 14).at(-1)).toBeCloseTo(100, 10);
  });

  it('is 0 when every change is a loss', () => {
    expect(rsi(falling, 14).at(-1)).toBeCloseTo(0, 10);
  });

  it('is 50 for a perfectly flat series', () => {
    const flat = new Array<number>(30).fill(50);
    expect(rsi(flat, 14).at(-1)).toBeCloseTo(50, 10);
  });

  it('stays within 0..100 on mixed data', () => {
    const mixed = [
      44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45,
    ];
    for (const value of rsi(mixed, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('returns all nulls when there is not enough history', () => {
    expect(rsi([1, 2, 3], 14).every((value) => value === null)).toBe(true);
  });
});

describe('macd', () => {
  it('equals fastEma - slowEma on the MACD line', () => {
    const { macd: line } = macd(rising, 12, 26, 9);
    const fast = ema(rising, 12);
    const slow = ema(rising, 26);
    const index = rising.length - 1;
    expect(line[index]).toBeCloseTo((fast[index] as number) - (slow[index] as number), 10);
  });

  it('produces no MACD value before the slow EMA exists', () => {
    const { macd: line } = macd(rising, 12, 26, 9);
    expect(line.slice(0, 25).every((value) => value === null)).toBe(true);
    expect(line[25]).not.toBeNull();
  });

  it('keeps histogram = macd - signal at every resolved index', () => {
    const { macd: line, signal, histogram } = macd(rising, 12, 26, 9);
    let checked = 0;
    for (let i = 0; i < line.length; i += 1) {
      const macdValue = line[i];
      const signalValue = signal[i];
      const histogramValue = histogram[i];
      if (macdValue === null || signalValue === null) continue;
      expect(histogramValue).toBeCloseTo((macdValue as number) - (signalValue as number), 10);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('rejects a fast period that is not shorter than the slow period', () => {
    expect(() => macd(rising, 26, 12, 9)).toThrow(/must be smaller/);
  });
});
