/**
 * What gets limited, keyed by what, and how hard.
 *
 * One global budget per IP is the wrong shape for this API. A dashboard polling
 * status and a script guessing passwords are the same traffic to a single
 * counter, so a limit loose enough for the first is useless against the second,
 * and a limit tight enough for the second breaks the first. Splitting into
 * classes lets each be sized for its own risk.
 *
 * The failure that matters is picking the wrong KEY. A key that is easy for an
 * attacker to change is not a limit — and a key derived from a secret is a
 * secret-handling bug. Both hazards are handled in `rateLimitKey`.
 */

/**
 * Traffic classes.
 *
 *  - `auth_attempt`  — unauthenticated credential submission. The one class
 *                      where the limit is a security control rather than a
 *                      capacity control, so it fails closed.
 *  - `api_request`   — the general budget. Sized for a polling dashboard.
 *  - `analytics`     — aggregation over an account's whole outcome history.
 *                      Cheap to ask for, expensive to answer.
 *  - `ingestion`     — backfill requests, which fan out to an external provider
 *                      and write candles. Limited so one caller cannot exhaust
 *                      the provider's budget for everybody.
 *  - `paper_action`  — opening paper positions. Bounded because each one takes
 *                      row locks and writes to the append-only ledger.
 */
export type RateLimitClass =
  'auth_attempt' | 'api_request' | 'analytics' | 'ingestion' | 'paper_action';

/** What a class does when the shared store cannot be reached. */
export type StoreFailurePolicy = 'fail_closed' | 'fail_open';

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
  /**
   * `fail_closed` refuses the request when the counter is unreachable.
   *
   * Only credential traffic uses it. There, an unreachable counter means
   * unlimited password guessing, so refusing is strictly safer than serving.
   * Everywhere else the counter protects capacity rather than a secret, and
   * refusing every read during a cache outage would convert a degraded
   * dependency into a full outage — a worse result than the unmetered traffic
   * it prevents. The limiter reports itself degraded either way, so the choice
   * is visible rather than silent.
   */
  readonly onStoreFailure: StoreFailurePolicy;
}

export type RateLimitRules = Readonly<Record<RateLimitClass, RateLimitRule>>;

export interface RateLimitTuning {
  /** The general per-window budget, from RATE_LIMIT_MAX_REQUESTS. */
  readonly generalLimit: number;
  /** The general window, from RATE_LIMIT_WINDOW_MS. */
  readonly generalWindowMs: number;
}

const MINUTE = 60_000;

/**
 * Only the general class is operator-tunable.
 *
 * The rest are fixed because they exist to bound specific costs — a password
 * guessing budget, a provider's quota, a write path that takes row locks — and
 * an operator raising them from an env var would be removing the protection
 * without the review that adding it got.
 */
export function defaultRules(tuning: RateLimitTuning): RateLimitRules {
  return {
    auth_attempt: { limit: 10, windowMs: MINUTE, onStoreFailure: 'fail_closed' },
    api_request: {
      limit: tuning.generalLimit,
      windowMs: tuning.generalWindowMs,
      onStoreFailure: 'fail_open',
    },
    /**
     * Sized in PAGE RENDERS, not in raw requests.
     *
     * This was 30/minute, chosen by thinking about how often a person would
     * ask for an aggregation. That reasoning was wrong, because the caller is
     * not a person typing URLs — it is the dashboard, and one render of it
     * fetches FOUR analytics endpoints (overview, calibration, strategies,
     * regimes). Thirty therefore bought about seven page views a minute, and
     * every timeframe click is a page view. Browser-testing the UI hit the
     * limit within six navigations and the analytics panels went blank.
     *
     * 120 is 30 renders a minute, with headroom for a second tab. It still
     * bounds the thing the limit exists to bound — a caller looping expensive
     * aggregations — while no longer throttling the product's own normal use.
     */
    analytics: { limit: 120, windowMs: MINUTE, onStoreFailure: 'fail_open' },
    ingestion: { limit: 12, windowMs: MINUTE, onStoreFailure: 'fail_open' },
    paper_action: { limit: 30, windowMs: MINUTE, onStoreFailure: 'fail_open' },
  };
}

/**
 * Who a request is being counted against.
 *
 * Deliberately NOT a session token, an API key, a password, a cookie value or
 * any hash of one. Two independent reasons:
 *
 *  1. A key travels into the store, into logs when a limit is hit, and into
 *     metrics. A secret that reaches any of those has leaked, and "it was only
 *     used as a map key" is not a mitigation.
 *  2. A token-keyed limit is trivially defeated: the attacker holding the token
 *     also holds every other token they care to mint, and an unauthenticated
 *     attacker simply sends no token at all and shares one bucket with every
 *     other anonymous caller.
 *
 * So authenticated traffic is keyed by the STABLE identifier the credential
 * resolves to — the account or user id, which is not a secret and cannot be
 * rotated by the caller — and unauthenticated traffic by network identity.
 */
export type RateLimitIdentity =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'service'; readonly label: string }
  | { readonly kind: 'network'; readonly address: string };

/**
 * Normalises a remote address to the unit an attacker cannot cheaply rotate.
 *
 * An IPv6 client is routinely handed a /64 and can use every address in it, so
 * keying on the full address means 18 quintillion login buckets. Truncating to
 * the /64 makes the bucket the thing that was actually allocated to them. IPv4
 * has no equivalent — a /24 would sweep up unrelated customers behind one
 * carrier NAT — so it is kept whole.
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (trimmed.length === 0) return 'unknown';

  // ::ffff:203.0.113.4 — an IPv4 client on a dual-stack socket. Unwrap it so it
  // shares a bucket with the same client arriving over plain IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  if (mapped?.[1]) return mapped[1];

  if (!trimmed.includes(':')) return trimmed;

  const expanded = expandIpv6(trimmed);
  return expanded === null ? trimmed : `${expanded.slice(0, 4).join(':')}::/64`;
}

/** Expands an IPv6 address to its eight groups, or null if it does not parse. */
function expandIpv6(address: string): string[] | null {
  const [head = '', tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;

  const left = head.length > 0 ? head.split(':') : [];
  const right = tail !== undefined && tail.length > 0 ? tail.split(':') : [];
  if (tail === undefined) {
    return left.length === 8 ? left : null;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<string>(missing).fill('0'), ...right];
}

/**
 * Builds the store key.
 *
 * The `v1` segment is a kill switch: changing it abandons every open window at
 * once, which is the only way to recover from a key-shape mistake without
 * flushing a Redis that other things share.
 */
export function rateLimitKey(traffic: RateLimitClass, identity: RateLimitIdentity): string {
  return `v1:${traffic}:${identitySegment(identity)}`;
}

function identitySegment(identity: RateLimitIdentity): string {
  switch (identity.kind) {
    case 'user':
      return `u:${identity.userId}`;
    case 'account':
      return `a:${identity.accountId}`;
    case 'service':
      return `s:${identity.label}`;
    case 'network':
      return `ip:${normalizeAddress(identity.address)}`;
  }
}
