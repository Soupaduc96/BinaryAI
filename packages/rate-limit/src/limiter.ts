import {
  defaultRules,
  rateLimitKey,
  type RateLimitClass,
  type RateLimitIdentity,
  type RateLimitRules,
  type RateLimitTuning,
} from './policy.js';
import type { RateLimitStore, RateLimitStoreKind } from './store.js';

/**
 * The decision layer.
 *
 * Its whole job is to turn a counter into an answer the API can act on, and to
 * be honest about the case the counter could not be read. Three outcomes, not
 * two:
 *
 *   allowed            — under budget
 *   limited            — over budget, retry later
 *   unavailable        — the counter could not be reached
 *
 * Collapsing the third into either of the first two is what makes rate limiting
 * lie. Reported as `allowed` it silently removes the protection; reported as
 * `limited` it tells the caller to retry when retrying will not help.
 */

export interface RateLimitDecision {
  readonly outcome: 'allowed' | 'limited' | 'unavailable';
  /** The budget for this class, so the API can set the standard headers. */
  readonly limit: number;
  /** Requests left in the window. Zero when limited or unknown. */
  readonly remaining: number;
  /** End of the current window, epoch ms. Null when the counter was unreadable. */
  readonly resetAt: number | null;
  /** Whole seconds until a retry could succeed. Zero when allowed. */
  readonly retryAfterSeconds: number;
  readonly traffic: RateLimitClass;
  /**
   * True when the counter was unreachable and the class chose to serve anyway.
   * The request proceeds unmetered, and the caller must not report the limiter
   * as healthy on the strength of it.
   */
  readonly degraded: boolean;
}

export interface RateLimiterStatus {
  readonly store: RateLimitStoreKind;
  /** False for the in-process store: the limit is per instance, not per fleet. */
  readonly shared: boolean;
  /** Reachability at the last check. */
  readonly available: boolean;
  /** Store failures observed since boot. */
  readonly failures: number;
  /** Message from the most recent failure, or null. */
  readonly lastError: string | null;
}

export interface RateLimiter {
  check(traffic: RateLimitClass, identity: RateLimitIdentity): Promise<RateLimitDecision>;
  status(): Promise<RateLimiterStatus>;
  close(): Promise<void>;
  readonly rules: RateLimitRules;
}

export interface CreateRateLimiterOptions {
  readonly store: RateLimitStore;
  readonly tuning: RateLimitTuning;
  readonly rules?: RateLimitRules;
  readonly now?: () => number;
  /** Notified on every store failure, for the audit log. Never receives a key. */
  readonly onStoreFailure?: (detail: { traffic: RateLimitClass; message: string }) => void;
}

export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  const { store, now = Date.now, onStoreFailure } = options;
  const rules = options.rules ?? defaultRules(options.tuning);

  let failures = 0;
  let lastError: string | null = null;

  return {
    rules,

    async check(traffic, identity): Promise<RateLimitDecision> {
      const rule = rules[traffic];
      const at = now();

      let hit;
      try {
        hit = await store.hit(rateLimitKey(traffic, identity), rule.windowMs, at);
      } catch (error) {
        failures += 1;
        lastError = error instanceof Error ? error.message : String(error);
        // Deliberately no key and no identity: this message reaches the log.
        onStoreFailure?.({ traffic, message: lastError });

        if (rule.onStoreFailure === 'fail_closed') {
          return {
            outcome: 'unavailable',
            limit: rule.limit,
            remaining: 0,
            resetAt: null,
            // A store outage is not a window that expires; a fixed hint is
            // better than a fabricated reset time the caller would trust.
            retryAfterSeconds: Math.ceil(rule.windowMs / 1000),
            traffic,
            degraded: true,
          };
        }
        return {
          outcome: 'allowed',
          limit: rule.limit,
          remaining: 0,
          resetAt: null,
          retryAfterSeconds: 0,
          traffic,
          degraded: true,
        };
      }

      const remaining = Math.max(0, rule.limit - hit.count);
      if (hit.count > rule.limit) {
        return {
          outcome: 'limited',
          limit: rule.limit,
          remaining: 0,
          resetAt: hit.resetAt,
          // At least one second: `Retry-After: 0` invites an immediate retry
          // that is certain to be refused again.
          retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - at) / 1000)),
          traffic,
          degraded: false,
        };
      }

      return {
        outcome: 'allowed',
        limit: rule.limit,
        remaining,
        resetAt: hit.resetAt,
        retryAfterSeconds: 0,
        traffic,
        degraded: false,
      };
    },

    async status(): Promise<RateLimiterStatus> {
      return {
        store: store.kind,
        shared: store.shared,
        available: await store.healthy(),
        failures,
        lastError,
      };
    },

    close: () => store.close(),
  };
}
