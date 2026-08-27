import { describe, expect, it } from 'vitest';
import { settleBinaryOutcome } from './settlement.js';

/**
 * The single settlement rule, shared by live settlement and the backtester.
 * If these two ever disagree about the same price pair, every calibration
 * sample built from them is worthless.
 */
describe('settleBinaryOutcome', () => {
  it('settles a correct CALL as a win', () => {
    expect(settleBinaryOutcome('call', 100, 101)).toBe('win');
  });

  it('settles an incorrect CALL as a loss', () => {
    expect(settleBinaryOutcome('call', 100, 99)).toBe('loss');
  });

  it('settles a correct PUT as a win', () => {
    expect(settleBinaryOutcome('put', 100, 99)).toBe('win');
  });

  it('settles an incorrect PUT as a loss', () => {
    expect(settleBinaryOutcome('put', 100, 101)).toBe('loss');
  });

  it('treats an exactly unchanged price as a tie', () => {
    // Exact equality is why prices are NUMERIC rather than FLOAT: float drift
    // would silently turn ties into losses.
    expect(settleBinaryOutcome('call', 100, 100)).toBe('tie');
    expect(settleBinaryOutcome('put', 100, 100)).toBe('tie');
  });

  it('resolves a hair-thin move rather than rounding it to a tie', () => {
    expect(settleBinaryOutcome('call', 100, 100.00000001)).toBe('win');
  });

  it('returns unresolved for non-finite prices instead of guessing', () => {
    expect(settleBinaryOutcome('call', Number.NaN, 100)).toBe('unresolved');
    expect(settleBinaryOutcome('call', 100, Number.POSITIVE_INFINITY)).toBe('unresolved');
  });
});
