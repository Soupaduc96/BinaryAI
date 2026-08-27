import { describe, expect, it } from 'vitest';
import type { Candle, CandleSeries } from '@binaryai/types';
import { COINBASE_CAPABILITIES } from './providers/coinbase.js';
import { validateIngestedBatch, withoutRejectedCandles } from './quality.js';

/** Base time on a clean 1-minute boundary so alignment checks are meaningful. */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MINUTE = 60_000;
const NOW = T0 + 60 * MINUTE;

function candle(offsetMinutes: number, overrides: Partial<Candle> = {}): Candle {
  return {
    timestamp: T0 + offsetMinutes * MINUTE,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
    complete: true,
    ...overrides,
  };
}

function series(candles: Candle[]): CandleSeries {
  return { asset: 'BTCUSD', timeframe: '1m', source: 'historical_provider', candles };
}

const options = { now: NOW, capabilities: COINBASE_CAPABILITIES };

describe('valid batches', () => {
  it('accepts a clean consecutive series', () => {
    // Evaluated just after the last candle closed: anything older would be
    // legitimately flagged stale, which is the scanner working, not a bug.
    const report = validateIngestedBatch(series([candle(0), candle(1), candle(2)]), {
      ...options,
      now: T0 + 3 * MINUTE,
    });
    expect(report.accepted).toBe(3);
    expect(report.rejected).toBe(0);
    expect(report.usable).toBe(true);
    expect(report.score).toBe(1);
  });

  it('flags a clean but old batch as stale', () => {
    const report = validateIngestedBatch(series([candle(0), candle(1)]), options);
    expect(report.rejected).toBe(0);
    expect(report.issues.map((i) => i.code)).toContain('stale_data');
    expect(report.score).toBeLessThan(1);
  });

  it('reports an empty response without pretending it is valid', () => {
    const report = validateIngestedBatch(series([]), options);
    expect(report.usable).toBe(false);
    expect(report.issues[0]?.code).toBe('empty_response');
    expect(report.accepted).toBe(0);
  });
});

describe('OHLC integrity', () => {
  it('rejects high below the body', () => {
    const report = validateIngestedBatch(series([candle(0, { high: 99.5 })]), options);
    expect(report.rejected).toBe(1);
    expect(report.usable).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('invalid_ohlc');
  });

  it('rejects low above the body', () => {
    const report = validateIngestedBatch(series([candle(0, { low: 100.4 })]), options);
    expect(report.issues.map((i) => i.code)).toContain('invalid_ohlc');
  });

  it('rejects a non-positive price', () => {
    const report = validateIngestedBatch(series([candle(0, { open: 0, low: 0 })]), options);
    expect(report.issues.map((i) => i.code)).toContain('non_positive_price');
    expect(report.rejected).toBe(1);
  });

  it('flags negative volume as a warning, not a rejection', () => {
    const report = validateIngestedBatch(series([candle(0, { volume: -5 })]), options);
    expect(report.issues.map((i) => i.code)).toContain('negative_volume');
    expect(report.rejected).toBe(0);
  });
});

describe('timestamp integrity', () => {
  it('rejects a candle from beyond the future tolerance', () => {
    const future = candle(0, { timestamp: NOW + 10 * MINUTE });
    const report = validateIngestedBatch(series([future]), options);
    expect(report.issues.map((i) => i.code)).toContain('future_timestamp');
    expect(report.rejected).toBe(1);
  });

  it('tolerates small clock skew', () => {
    const slightlyAhead = candle(0, { timestamp: NOW + 30_000 });
    const report = validateIngestedBatch(series([slightlyAhead]), {
      ...options,
      futureToleranceSeconds: 120,
    });
    expect(report.issues.map((i) => i.code)).not.toContain('future_timestamp');
  });

  it('rejects a candle not aligned to the timeframe boundary', () => {
    // A "1m" bar starting at 00:00:37 is not the bar it claims to be, and would
    // misalign every indicator derived from it.
    const misaligned = candle(0, { timestamp: T0 + 37_000 });
    const report = validateIngestedBatch(series([misaligned]), options);
    expect(report.issues.map((i) => i.code)).toContain('unaligned_candle_boundary');
    expect(report.rejected).toBe(1);
  });
});

describe('sequence integrity', () => {
  it('detects duplicates', () => {
    const report = validateIngestedBatch(series([candle(0), candle(0)]), options);
    expect(report.duplicates).toBe(1);
    expect(report.issues.map((i) => i.code)).toContain('duplicate_candle');
  });

  it('detects missing intervals without filling them', () => {
    const report = validateIngestedBatch(series([candle(0), candle(5)]), options);
    expect(report.missingIntervals).toBe(4);
    expect(report.issues.map((i) => i.code)).toContain('missing_interval');
    // Gaps are reported, never interpolated: an invented candle is fabricated data.
    expect(report.accepted).toBe(2);
  });

  it('detects out-of-order candles', () => {
    const report = validateIngestedBatch(series([candle(5), candle(2)]), options);
    expect(report.issues.map((i) => i.code)).toContain('out_of_order');
  });

  it('detects overlapping candles', () => {
    const overlapping = [candle(0), candle(0, { timestamp: T0 + 30_000 })];
    const report = validateIngestedBatch(series(overlapping), options);
    const codes = report.issues.map((i) => i.code);
    expect(codes.some((c) => c === 'overlapping_candle' || c === 'unaligned_candle_boundary')).toBe(
      true,
    );
  });
});

describe('provider integrity', () => {
  it('rejects a timeframe the provider does not serve', () => {
    const thirtyMinute: CandleSeries = { ...series([candle(0)]), timeframe: '30m' };
    const report = validateIngestedBatch(thirtyMinute, options);
    expect(report.issues.map((i) => i.code)).toContain('unsupported_timeframe');
    expect(report.usable).toBe(false);
  });

  it('flags stale data against the threshold', () => {
    const report = validateIngestedBatch(series([candle(0)]), {
      now: NOW,
      stalenessThresholdSeconds: 60,
    });
    expect(report.issues.map((i) => i.code)).toContain('stale_data');
  });

  it('does not flag staleness during a historical backfill', () => {
    const report = validateIngestedBatch(series([candle(0)]), {
      now: NOW,
      stalenessThresholdSeconds: Number.MAX_SAFE_INTEGER,
    });
    expect(report.issues.map((i) => i.code)).not.toContain('stale_data');
  });
});

describe('withoutRejectedCandles', () => {
  it('drops only the rejected candles', () => {
    const batch = series([candle(0), candle(1, { high: 1 }), candle(2)]);
    const report = validateIngestedBatch(batch, options);
    const clean = withoutRejectedCandles(batch, report);

    expect(report.rejected).toBe(1);
    expect(clean.candles).toHaveLength(2);
    expect(clean.candles.map((c) => c.timestamp)).toEqual([T0, T0 + 2 * MINUTE]);
  });

  it('returns the batch untouched when nothing was rejected', () => {
    const batch = series([candle(0), candle(1)]);
    const report = validateIngestedBatch(batch, options);
    expect(withoutRejectedCandles(batch, report)).toBe(batch);
  });

  it('keeps the report describing the full batch', () => {
    // The report must not shrink to match the cleaned series; the rejection has
    // to stay visible rather than being implied by a smaller number.
    const batch = series([candle(0), candle(1, { low: 500 })]);
    const report = validateIngestedBatch(batch, options);
    expect(report.accepted + report.rejected).toBe(2);
  });
});
