import { describe, expect, it } from 'vitest';
import type { AnalyticsAggregateRow } from '@binaryai/types';
import { buildPeriods, intervalMs, recencyCutoff, splitAt, suggestInterval } from './temporal.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function period(startsAt: number, wins: number, losses: number): AnalyticsAggregateRow {
  const settled = wins + losses;
  return {
    key: String(startsAt),
    version: null,
    wins,
    losses,
    ties: 0,
    unresolved: 0,
    invalid: 0,
    skipped: 0,
    total: settled,
    confidenceSum: 0.65 * settled,
    confidenceCount: settled,
  };
}

describe('intervalMs', () => {
  it('spans the documented widths', () => {
    expect(intervalMs('day')).toBe(DAY);
    expect(intervalMs('week')).toBe(7 * DAY);
    expect(intervalMs('month')).toBe(30 * DAY);
  });
});

describe('suggestInterval', () => {
  it('widens the bucket when observations are sparse', () => {
    // 12 outcomes over 30 days as 30 daily buckets is 30 buckets of nothing.
    expect(suggestInterval(12, 30 * DAY)).toBe('month');
    expect(suggestInterval(150, 30 * DAY)).toBe('week');
    expect(suggestInterval(900, 30 * DAY)).toBe('day');
  });

  it('defaults to day with no samples', () => {
    expect(suggestInterval(0, 0)).toBe('day');
  });
});

describe('buildPeriods', () => {
  it('is empty when nothing settled', () => {
    expect(buildPeriods([])).toEqual([]);
  });

  it('omits periods with no observations rather than emitting zeros', () => {
    // Day 1 and day 3 have data; day 2 has none. A continuous line through a
    // zero at day 2 would be a fabricated performance curve.
    const periods = buildPeriods([period(NOW, 20, 20), period(NOW + 2 * DAY, 25, 15)]);

    expect(periods).toHaveLength(2);
    expect(periods.map((p) => p.startsAt)).toEqual([NOW, NOW + 2 * DAY]);
  });

  it('orders ascending regardless of row order', () => {
    const periods = buildPeriods([period(NOW + DAY, 1, 1), period(NOW, 1, 1)]);
    expect(periods[0]?.startsAt).toBe(NOW);
  });

  it('applies the same evidence rules as every other rate', () => {
    const periods = buildPeriods([period(NOW, 2, 1), period(NOW + DAY, 40, 20)]);

    expect(periods[0]?.observedAccuracy.value).toBeNull();
    expect(periods[1]?.observedAccuracy.value).toBeCloseTo(2 / 3, 10);
  });

  it('drops rows with an unparseable bucket key', () => {
    const periods = buildPeriods([{ ...period(NOW, 5, 5), key: 'not-a-number' }]);
    expect(periods).toEqual([]);
  });
});

describe('splitAt', () => {
  it('splits by time, not at random', () => {
    const split = splitAt(0, 1_000);
    expect(split).toEqual({ trainingEndsAt: 700, evaluationStartsAt: 701 });
  });

  it('leaves no overlap between the periods', () => {
    const split = splitAt(NOW, NOW + 10 * DAY, 0.5);
    // An overlapping boundary is how a model ends up evaluated on an
    // observation it was fitted to.
    expect(split!.evaluationStartsAt).toBeGreaterThan(split!.trainingEndsAt);
  });

  it('refuses a degenerate window', () => {
    expect(splitAt(NOW, NOW)).toBeNull();
    expect(splitAt(NOW, NOW - 1)).toBeNull();
    expect(splitAt(NOW, NOW + DAY, 0)).toBeNull();
    expect(splitAt(NOW, NOW + DAY, 1)).toBeNull();
  });
});

describe('recencyCutoff', () => {
  it('computes the window lower bound', () => {
    expect(recencyCutoff('last_7d', NOW)).toBe(NOW - 7 * DAY);
    expect(recencyCutoff('last_30d', NOW)).toBe(NOW - 30 * DAY);
    expect(recencyCutoff('last_90d', NOW)).toBe(NOW - 90 * DAY);
  });

  it('has no lower bound for the full history', () => {
    expect(recencyCutoff('all', NOW)).toBeNull();
  });
});
