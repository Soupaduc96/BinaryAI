import { describe, expect, it } from 'vitest';
import {
  BASE_LOCK_MS,
  FAILURE_THRESHOLD,
  MAX_LOCK_MS,
  isLocked,
  lockRemainingSeconds,
  lockUntil,
} from './lockout.js';

const NOW = 1_800_000_000_000;

describe('lockUntil', () => {
  it('tolerates typos below the threshold', () => {
    for (let failures = 0; failures < FAILURE_THRESHOLD; failures += 1) {
      expect(lockUntil(failures, NOW)).toBeNull();
    }
  });

  it('locks at the threshold for the base duration', () => {
    expect(lockUntil(FAILURE_THRESHOLD, NOW)).toBe(NOW + BASE_LOCK_MS);
  });

  it('doubles with each further failure', () => {
    expect(lockUntil(FAILURE_THRESHOLD + 1, NOW)).toBe(NOW + BASE_LOCK_MS * 2);
    expect(lockUntil(FAILURE_THRESHOLD + 2, NOW)).toBe(NOW + BASE_LOCK_MS * 4);
  });

  it('caps the backoff', () => {
    // A permanent lock would let anyone who knows an email address deny its
    // owner access indefinitely. The ceiling is what stops sustained guessing
    // from becoming a denial-of-service against the victim.
    expect(lockUntil(FAILURE_THRESHOLD + 50, NOW)).toBe(NOW + MAX_LOCK_MS);
  });
});

describe('isLocked', () => {
  it('is false when never locked', () => {
    expect(isLocked(null, NOW)).toBe(false);
  });

  it('is true only while the lock is in the future', () => {
    expect(isLocked(NOW + 1, NOW)).toBe(true);
    expect(isLocked(NOW, NOW)).toBe(false);
    expect(isLocked(NOW - 1, NOW)).toBe(false);
  });
});

describe('lockRemainingSeconds', () => {
  it('rounds up, so a caller never retries a moment too early', () => {
    expect(lockRemainingSeconds(NOW + 1500, NOW)).toBe(2);
    expect(lockRemainingSeconds(NOW + 60_000, NOW)).toBe(60);
  });

  it('is zero when not locked', () => {
    expect(lockRemainingSeconds(null, NOW)).toBe(0);
    expect(lockRemainingSeconds(NOW - 1000, NOW)).toBe(0);
  });
});
