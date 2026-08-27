import { describe, expect, it } from 'vitest';
import { syntheticUptrend } from '@binaryai/fixtures';
import type { Candle, CandleSeries } from '@binaryai/types';
import { assessDataQuality, normalizeCandleSeries } from './market-data.js';

const baseCandle: Candle = {
  timestamp: 1_767_225_600_000,
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: null,
  complete: true,
};

function seriesOf(candles: readonly Candle[]): CandleSeries {
  return { asset: 'TEST', timeframe: '1m', source: 'historical_file', candles };
}

describe('normalizeCandleSeries', () => {
  it('accepts a well-formed payload and applies defaults', () => {
    const result = normalizeCandleSeries({
      asset: 'EURUSD',
      timeframe: '1m',
      source: 'historical_file',
      candles: [{ timestamp: 1_000, open: 1, high: 2, low: 0.5, close: 1.5 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candles[0]?.volume).toBeNull();
    expect(result.value.candles[0]?.complete).toBe(true);
  });

  it('sorts candles by timestamp', () => {
    const result = normalizeCandleSeries({
      asset: 'EURUSD',
      timeframe: '1m',
      source: 'historical_file',
      candles: [
        { timestamp: 2_000, open: 1, high: 2, low: 0.5, close: 1.5 },
        { timestamp: 1_000, open: 1, high: 2, low: 0.5, close: 1.5 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candles.map((candle) => candle.timestamp)).toEqual([1_000, 2_000]);
  });

  it('rejects an unknown timeframe with a readable path', () => {
    const result = normalizeCandleSeries({
      asset: 'EURUSD',
      timeframe: '7m',
      source: 'historical_file',
      candles: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.join(' ')).toContain('timeframe');
  });

  it('rejects non-finite prices', () => {
    const result = normalizeCandleSeries({
      asset: 'EURUSD',
      timeframe: '1m',
      source: 'live_provider',
      candles: [{ timestamp: 1_000, open: Number.POSITIVE_INFINITY, high: 2, low: 1, close: 1.5 }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a payload that is not an object', () => {
    expect(normalizeCandleSeries('not a series').ok).toBe(false);
    expect(normalizeCandleSeries(null).ok).toBe(false);
  });
});

describe('assessDataQuality', () => {
  it('marks an empty series unusable with a zero score', () => {
    const report = assessDataQuality(seriesOf([]));
    expect(report.usable).toBe(false);
    expect(report.score).toBe(0);
    expect(report.issues[0]?.code).toBe('empty_series');
  });

  it('passes a clean synthetic series', () => {
    const report = assessDataQuality(syntheticUptrend(120));
    expect(report.usable).toBe(true);
    expect(report.score).toBe(1);
    expect(report.issues).toHaveLength(0);
  });

  it('flags insufficient history as a blocking error', () => {
    const report = assessDataQuality(syntheticUptrend(10), { requiredHistory: 50 });
    expect(report.usable).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('insufficient_history');
  });

  it('detects duplicate timestamps', () => {
    const report = assessDataQuality(seriesOf([baseCandle, { ...baseCandle }]));
    expect(report.issues.map((issue) => issue.code)).toContain('duplicate_timestamp');
    expect(report.usable).toBe(false);
  });

  it('detects a gap in the series', () => {
    const later = { ...baseCandle, timestamp: baseCandle.timestamp + 600_000 };
    const report = assessDataQuality(seriesOf([baseCandle, later]));
    expect(report.issues.map((issue) => issue.code)).toContain('timestamp_gap');
    // A gap is a warning, not a hard error.
    expect(report.usable).toBe(true);
  });

  it('detects inconsistent OHLC', () => {
    const broken = { ...baseCandle, high: 98 };
    const report = assessDataQuality(seriesOf([broken]));
    expect(report.issues.map((issue) => issue.code)).toContain('invalid_ohlc_range');
    expect(report.usable).toBe(false);
  });

  it('reports an incomplete final candle as information, not an error', () => {
    const report = assessDataQuality(
      seriesOf([
        baseCandle,
        { ...baseCandle, timestamp: baseCandle.timestamp + 60_000, complete: false },
      ]),
    );
    expect(report.issues.map((issue) => issue.code)).toContain('incomplete_last_candle');
    expect(report.usable).toBe(true);
  });

  it('keeps the score inside 0..1 no matter how broken the data is', () => {
    const broken = Array.from({ length: 20 }, () => ({ ...baseCandle, high: 1, low: 100 }));
    const report = assessDataQuality(seriesOf(broken));
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(1);
  });
});
