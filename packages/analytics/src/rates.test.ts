import { describe, expect, it } from 'vitest';
import type { OutcomeCounts } from '@binaryai/types';
import {
  EMPTY_COUNTS,
  addCounts,
  assertCoherent,
  countsFrom,
  decidedOutcomes,
  evidenceLevelFor,
  meanConfidence,
  observedAccuracy,
} from './rates.js';

/**
 * Observed rates.
 *
 * The single most important behaviour in this file: a rate that cannot be
 * computed is null, never zero. Every "insufficient evidence" state in the
 * product depends on that distinction surviving, so these tests assert it from
 * several directions rather than once.
 */

function counts(overrides: Partial<OutcomeCounts> = {}): OutcomeCounts {
  return { ...EMPTY_COUNTS, ...overrides };
}

describe('decidedOutcomes', () => {
  it('counts only wins and losses', () => {
    // Ties settled, but the direction was neither right nor wrong; unresolved
    // has not settled at all. Neither belongs in an accuracy denominator.
    expect(
      decidedOutcomes(counts({ wins: 10, losses: 5, ties: 3, unresolved: 7, skipped: 2 })),
    ).toBe(15);
  });
});

describe('observedAccuracy', () => {
  it('returns null, not zero, when nothing has settled', () => {
    const rate = observedAccuracy(EMPTY_COUNTS);

    // The defining assertion of the whole analytics layer. Zero wins from zero
    // signals is not "0% accurate"; it is no evidence.
    expect(rate.value).toBeNull();
    expect(rate.sampleSize).toBe(0);
    expect(rate.sufficient).toBe(false);
    expect(rate.evidence).toBe('insufficient');
  });

  it('withholds a rate below the minimum sample size but still reports the count', () => {
    const rate = observedAccuracy(counts({ wins: 3, losses: 1 }));

    // 75% from four observations is arithmetically true and editorially
    // useless. The count is still surfaced so the UI can say "4 settled, not
    // enough to report a rate".
    expect(rate.value).toBeNull();
    expect(rate.sampleSize).toBe(4);
    expect(rate.sufficient).toBe(false);
  });

  it('reports a rate once the minimum is met', () => {
    const rate = observedAccuracy(counts({ wins: 18, losses: 12 }));

    expect(rate.sampleSize).toBe(30);
    expect(rate.sufficient).toBe(true);
    expect(rate.value).toBeCloseTo(0.6, 10);
  });

  it('treats the threshold as inclusive', () => {
    expect(observedAccuracy(counts({ wins: 15, losses: 14 })).sufficient).toBe(false);
    expect(observedAccuracy(counts({ wins: 15, losses: 15 })).sufficient).toBe(true);
  });

  it('reports a genuine zero rate when it is genuinely measured', () => {
    // Distinct from the no-evidence case above: 40 settled signals that all
    // lost really is 0%, and withholding that would be its own dishonesty.
    const rate = observedAccuracy(counts({ wins: 0, losses: 40 }));

    expect(rate.value).toBe(0);
    expect(rate.sufficient).toBe(true);
  });

  it('never produces a rate outside [0,1]', () => {
    for (const [wins, losses] of [
      [0, 40],
      [40, 0],
      [20, 20],
      [1, 999],
    ]) {
      const rate = observedAccuracy(counts({ wins, losses }));
      if (rate.value !== null) {
        expect(rate.value).toBeGreaterThanOrEqual(0);
        expect(rate.value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('ignores ties, unresolved and skipped in the denominator', () => {
    const rate = observedAccuracy(
      counts({ wins: 20, losses: 20, ties: 100, unresolved: 100, skipped: 100 }),
    );

    // If any of those leaked in, the rate would not be 0.5.
    expect(rate.sampleSize).toBe(40);
    expect(rate.value).toBeCloseTo(0.5, 10);
  });

  it('honours custom thresholds', () => {
    const lenient = { minimumSamples: 2, preliminary: 2, developing: 5, established: 10 };
    const rate = observedAccuracy(counts({ wins: 2, losses: 1 }), lenient);

    expect(rate.sufficient).toBe(true);
    expect(rate.value).toBeCloseTo(2 / 3, 10);
  });
});

describe('evidenceLevelFor', () => {
  it('maps counts onto levels at the documented boundaries', () => {
    expect(evidenceLevelFor(0)).toBe('insufficient');
    expect(evidenceLevelFor(29)).toBe('insufficient');
    expect(evidenceLevelFor(30)).toBe('preliminary');
    expect(evidenceLevelFor(99)).toBe('preliminary');
    expect(evidenceLevelFor(100)).toBe('developing');
    expect(evidenceLevelFor(499)).toBe('developing');
    expect(evidenceLevelFor(500)).toBe('established');
    expect(evidenceLevelFor(50_000)).toBe('established');
  });
});

describe('meanConfidence', () => {
  it('is null with no contributing samples', () => {
    // A database SUM over no rows is NULL; coercing that to 0 would render as
    // "mean confidence 0.00", a very different claim from "no samples".
    expect(meanConfidence(0, 0)).toBeNull();
    expect(meanConfidence(12.5, 0)).toBeNull();
  });

  it('averages when samples exist', () => {
    expect(meanConfidence(15, 20)).toBeCloseTo(0.75, 10);
  });

  it('is null for a non-finite sum', () => {
    expect(meanConfidence(Number.NaN, 5)).toBeNull();
  });
});

describe('addCounts', () => {
  it('sums every field', () => {
    const total = addCounts(
      counts({ wins: 1, losses: 2, ties: 3, unresolved: 4, invalid: 5, skipped: 6, total: 21 }),
      counts({
        wins: 10,
        losses: 20,
        ties: 30,
        unresolved: 40,
        invalid: 50,
        skipped: 60,
        total: 210,
      }),
    );

    expect(total).toEqual({
      wins: 11,
      losses: 22,
      ties: 33,
      unresolved: 44,
      invalid: 55,
      skipped: 66,
      total: 231,
    });
  });
});

describe('countsFrom', () => {
  it('projects a storage aggregate row', () => {
    expect(
      countsFrom({
        key: 'x',
        version: null,
        wins: 3,
        losses: 2,
        ties: 1,
        unresolved: 4,
        invalid: 0,
        skipped: 5,
        total: 15,
        confidenceSum: 3.5,
        confidenceCount: 5,
      }),
    ).toEqual({ wins: 3, losses: 2, ties: 1, unresolved: 4, invalid: 0, skipped: 5, total: 15 });
  });
});

describe('assertCoherent', () => {
  it('accepts well-formed counts', () => {
    expect(() => assertCoherent(counts({ wins: 5, losses: 5, total: 10 }))).not.toThrow();
  });

  it('rejects negative counts', () => {
    // Sample counts are never negative. If storage says otherwise, the
    // aggregation is wrong and must not become a published statistic.
    expect(() => assertCoherent(counts({ wins: -1, total: 0 }))).toThrow(/incoherent/i);
  });

  it('rejects non-integer counts', () => {
    expect(() => assertCoherent(counts({ wins: 1.5, total: 2 }))).toThrow(/incoherent/i);
  });

  it('rejects parts exceeding the total', () => {
    expect(() => assertCoherent(counts({ wins: 10, losses: 10, total: 5 }))).toThrow(/exceed/i);
  });
});
