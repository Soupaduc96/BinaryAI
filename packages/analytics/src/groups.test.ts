import { describe, expect, it } from 'vitest';
import type { AnalyticsAggregateRow } from '@binaryai/types';
import { buildGroups } from './groups.js';

function row(
  key: string,
  wins: number,
  losses: number,
  extra: Partial<AnalyticsAggregateRow> = {},
): AnalyticsAggregateRow {
  const settled = wins + losses;
  return {
    key,
    version: null,
    wins,
    losses,
    ties: 0,
    unresolved: 0,
    invalid: 0,
    skipped: 0,
    total: settled,
    confidenceSum: 0.6 * settled,
    confidenceCount: settled,
    ...extra,
  };
}

describe('buildGroups', () => {
  it('returns nothing for no rows rather than inventing placeholders', () => {
    // A timeframe with no observations must not appear as a zero row: that
    // would imply BinaryAI measured it and found nothing.
    expect(buildGroups([])).toEqual([]);
  });

  it('sorts by sample count, never by accuracy', () => {
    const groups = buildGroups([
      row('lucky-strategy', 3, 0), // 100% from 3
      row('measured-strategy', 2_800, 1_200), // 70% from 4,000
    ]);

    // Ranking by accuracy would put the 3-sample row on top. Evidence leads.
    expect(groups[0]?.key).toBe('measured-strategy');
    expect(groups[1]?.key).toBe('lucky-strategy');
    // And the small one still withholds its rate.
    expect(groups[1]?.observedAccuracy.value).toBeNull();
  });

  it('breaks ties on key so ordering is deterministic', () => {
    const groups = buildGroups([row('beta', 50, 50), row('alpha', 50, 50)]);
    expect(groups.map((group) => group.key)).toEqual(['alpha', 'beta']);
  });

  it('can sort by key when a stable dimension order is wanted', () => {
    const groups = buildGroups([row('range', 10, 10), row('trend_up', 500, 100)], {
      sort: 'key',
    });
    expect(groups.map((group) => group.key)).toEqual(['range', 'trend_up']);
  });

  it('carries the version for versioned dimensions', () => {
    const groups = buildGroups([row('trend-momentum', 100, 100, { version: '1.0.0' })]);
    expect(groups[0]?.version).toBe('1.0.0');
  });

  it('reports evidence level per group', () => {
    const groups = buildGroups([row('big', 400, 200), row('small', 5, 5)], { sort: 'key' });

    expect(groups[0]?.observedAccuracy.evidence).toBe('established');
    expect(groups[1]?.observedAccuracy.evidence).toBe('insufficient');
  });

  it('refuses an incoherent aggregate instead of publishing it', () => {
    // A corrupt statistic that looks plausible is worse than an error.
    expect(() => buildGroups([row('broken', 10, 10, { total: 2 })])).toThrow(/exceed/i);
  });

  it('never lets skipped or unresolved counts reach the accuracy denominator', () => {
    const groups = buildGroups([
      row('mixed', 30, 30, { skipped: 500, unresolved: 500, total: 1_060 }),
    ]);

    expect(groups[0]?.observedAccuracy.sampleSize).toBe(60);
    expect(groups[0]?.observedAccuracy.value).toBeCloseTo(0.5, 10);
  });
});
