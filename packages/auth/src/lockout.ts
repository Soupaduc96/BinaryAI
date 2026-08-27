/**
 * Login throttling.
 *
 * Rate limiting by IP is not enough on its own: a distributed attacker spreads
 * guesses across many addresses while targeting one account. Counting failures
 * per USER closes that, and the escalating delay keeps a legitimate typo cheap
 * while making sustained guessing impractical.
 *
 * The lock is time-based rather than permanent on purpose. A permanent lock
 * hands an attacker a denial-of-service: anyone who knows an email address
 * could lock its owner out indefinitely.
 */

/** Failures tolerated before the first lock. */
export const FAILURE_THRESHOLD = 5;

/** Lock duration after the threshold, doubling each further failure. */
export const BASE_LOCK_MS = 60_000;

/** Ceiling on the backoff, so an account is never locked out for a day. */
export const MAX_LOCK_MS = 15 * 60_000;

/**
 * The lock expiry after `failures` consecutive failures, or null while still
 * under the threshold.
 */
export function lockUntil(failures: number, now: number): number | null {
  if (failures < FAILURE_THRESHOLD) return null;
  const overage = failures - FAILURE_THRESHOLD;
  const duration = Math.min(BASE_LOCK_MS * 2 ** overage, MAX_LOCK_MS);
  return now + duration;
}

/** True while a lock is in force. */
export function isLocked(lockedUntil: number | null, now: number): boolean {
  return lockedUntil !== null && lockedUntil > now;
}

/** Whole seconds remaining on a lock; 0 when not locked. */
export function lockRemainingSeconds(lockedUntil: number | null, now: number): number {
  if (!isLocked(lockedUntil, now)) return 0;
  return Math.ceil(((lockedUntil as number) - now) / 1000);
}
