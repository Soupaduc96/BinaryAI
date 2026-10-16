import { describe, expect, it } from 'vitest';
import { assessDataQuality } from './market-data.js';
import type { Candle, CandleSeries } from '@binaryai/types';

/**
 * Phase 11C — the data-quality score measures HEALTH, not length.
 *
 * The defect, found by running the engine over real stored candles: the score
 * was `1 - Σ(flat penalty per issue)`. Every market that closes leaves a gap at
 * every closure, so 205 daily bars of AAPL carried 45 perfectly ordinary
 * weekend gaps at 0.1 each and saturated the score to 0 — the same score as a
 * 30-bar series that was genuinely broken.
 *
 * The consequence reached the risk engine: `data_quality_too_low` blocked
 * AAPL, SPX and XAUUSD outright, so NO daily instrument could ever produce an
 * accepted signal regardless of how good its data was.
 *
 * The fix weights each issue against the series it was found in. No exchange
 * calendar is involved and none is wanted: the gaps are still detected, still
 * counted, and still reported one by one.
 */

const DAY = 86_400_000;

function bar(timestamp: number, close = 100): Candle {
  return { timestamp, open: close, high: close, low: close, close, volume: 1, complete: true };
}

/**
 * A daily series that skips weekends, exactly as a real equity feed does.
 * Nothing simulated about the shape — Mon–Fri bars, no Sat/Sun.
 */
function weekdaySeries(weeks: number): CandleSeries {
  const candles: Candle[] = [];
  // A Monday, so the pattern starts cleanly.
  let cursor = Date.UTC(2026, 0, 5);
  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 5; day += 1) candles.push(bar(cursor + day * DAY));
    cursor += 7 * DAY;
  }
  return { asset: 'AAPL', timeframe: '1d', source: 'live_provider', candles };
}

describe('data-quality score is proportional to the series', () => {
  it('does not zero a long, healthy series that has one gap per market closure', () => {
    const series = weekdaySeries(41);
    const report = assessDataQuality(series);

    // The gaps are REAL and must still be reported — they are simply not
    // evidence that the data is unusable.
    const gaps = report.issues.filter((issue) => issue.code === 'timestamp_gap');
    expect(gaps.length).toBeGreaterThan(30);

    // Before the fix this was 0, which blocked every daily instrument.
    expect(report.score).toBeGreaterThan(0.8);
    expect(report.usable).toBe(true);
  });

  it('still marks a genuinely irregular short series as poor', () => {
    // Same number of gaps, a fraction of the bars: this series really is bad,
    // and must score far below the long healthy one.
    const candles: Candle[] = [];
    let cursor = Date.UTC(2026, 0, 5);
    for (let index = 0; index < 30; index += 1) {
      candles.push(bar(cursor));
      // Every other bar jumps three days, so most bars carry a gap.
      cursor += index % 2 === 0 ? 3 * DAY : DAY;
    }
    const report = assessDataQuality({
      asset: 'AAPL',
      timeframe: '1d',
      source: 'live_provider',
      candles,
    });

    expect(report.score).toBeLessThan(0.8);
  });

  it('scores the same DEFECT RATE the same at any series length', () => {
    // The property the old formula lacked: doubling a series without changing
    // how irregular it is must not change the verdict.
    const short = assessDataQuality(weekdaySeries(10));
    const long = assessDataQuality(weekdaySeries(40));
    expect(Math.abs(short.score - long.score)).toBeLessThan(0.05);
  });

  it('still gives a flawless series a perfect score', () => {
    const candles = Array.from({ length: 50 }, (_unused, index) =>
      bar(Date.UTC(2026, 0, 5) + index * DAY),
    );
    const report = assessDataQuality({
      asset: 'BTCUSD',
      timeframe: '1d',
      source: 'live_provider',
      candles,
    });
    expect(report.score).toBe(1);
  });

  it('still refuses a series containing a structural error', () => {
    const candles = [bar(1_000), bar(1_000)];
    const report = assessDataQuality({
      asset: 'BTCUSD',
      timeframe: '1d',
      source: 'live_provider',
      candles,
    });
    // A duplicate timestamp is an ERROR, not a warning: usable must stay false
    // however the score is computed.
    expect(report.usable).toBe(false);
  });
});
