/**
 * The counter behind a rate limit.
 *
 * Pulled out behind an interface for one reason: the limiter's correctness
 * argument changes completely depending on where the counter lives. An
 * in-process Map is exactly right for one instance and silently wrong for two —
 * two instances each allow the full budget, so the effective limit is double
 * what the operator configured, and with N instances it is N times.
 *
 * Making the store explicit means the API can REPORT which one it is running,
 * rather than a deployment quietly getting a limit it never asked for.
 */

/** One increment of a fixed window. */
export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  readonly count: number;
  /** When the current window ends, epoch ms. */
  readonly resetAt: number;
}

export type RateLimitStoreKind = 'memory' | 'redis';

export interface RateLimitStore {
  readonly kind: RateLimitStoreKind;
  /**
   * True when this store is shared by every instance of the application.
   *
   * The limiter uses this to decide what it may claim, not what it may do — a
   * non-shared store still enforces a limit, just a per-instance one.
   */
  readonly shared: boolean;
  /**
   * Counts one request against `key`, starting a `windowMs` window if none is
   * open. Throws if the backing store is unreachable; the caller decides
   * whether that fails open or closed.
   */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  /** Cheap reachability probe for the status endpoint. Never throws. */
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Bounds the map so a flood of distinct keys cannot grow it without limit.
 * Reached only under a spray attack across many identities; a legitimate
 * instance holds one entry per active caller per class.
 */
const MAX_TRACKED_KEYS = 50_000;

/**
 * In-process fixed window.
 *
 * Correct for exactly one instance. It is the default in development and the
 * store the tests run against, and production refuses it unless the operator
 * opts in by name — see `RATE_LIMIT_STORE` in @binaryai/config.
 */
export function createMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, Window>();

  return {
    kind: 'memory',
    shared: false,

    async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
      const open = windows.get(key);
      if (!open || now >= open.resetAt) {
        const fresh = { count: 1, resetAt: now + windowMs };
        windows.set(key, fresh);
        if (windows.size > MAX_TRACKED_KEYS) evictExpired(windows, now);
        return { count: 1, resetAt: fresh.resetAt };
      }
      open.count += 1;
      return { count: open.count, resetAt: open.resetAt };
    },

    // Nothing to reach: an in-process map is available whenever the process is.
    async healthy(): Promise<boolean> {
      return true;
    },

    async close(): Promise<void> {
      windows.clear();
    },
  };
}

function evictExpired(windows: Map<string, Window>, now: number): void {
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
}
