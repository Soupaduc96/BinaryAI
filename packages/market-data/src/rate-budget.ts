/**
 * A request budget shared by everything that talks to one provider.
 *
 * R15. Ingestion throttling used to be a local `lastRequestAt` inside a single
 * run: correct for one instrument, and wrong the moment there are several.
 * Polling AAPL, SPX, XAUUSD and EUR/USD means four runs against the SAME Yahoo
 * adapter, each believing it holds the whole allowance — four times the
 * configured budget, with nothing in the code admitting it.
 *
 * A budget therefore belongs to the PROVIDER, not to a run. `ProviderRouter`
 * already builds one adapter instance per provider id, so a budget attached to
 * that instance is automatically shared by every asset class routed to it, and
 * two classes pointing at the same vendor cannot double it.
 *
 * WHAT THIS IS NOT: a claim about any vendor's real quota. Coinbase publishes
 * one; Yahoo's chart endpoint publishes nothing at all, and inventing a number
 * for it would be exactly the kind of confident fiction this codebase avoids.
 * The value enforced here is BinaryAI's own conservative safety spacing, taken
 * from `capabilities.rateLimitPerSecond` — a self-imposed ceiling, not a
 * discovered limit.
 */

export interface RateBudget {
  /**
   * Resolves when the caller may issue its request.
   *
   * Serialised: concurrent callers queue rather than all waking at once, which
   * is what makes the spacing hold under parallel ingestion runs.
   */
  acquire(): Promise<void>;
  /** Minimum spacing between requests, in milliseconds. */
  readonly minIntervalMs: number;
}

export interface RateBudgetOptions {
  /** Injected for tests; defaults to the real clock. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createRateBudget(
  requestsPerSecond: number,
  options: RateBudgetOptions = {},
): RateBudget {
  const { now = Date.now, sleep = defaultSleep } = options;
  const minIntervalMs = Math.ceil(1000 / Math.max(requestsPerSecond, 1));

  /**
   * The time the NEXT request is allowed to go out.
   *
   * Reserved up-front rather than measured afterwards, because measuring is
   * what breaks under concurrency: two callers arriving together would both
   * read the same `lastRequestAt`, both decide they need not wait, and both
   * fire. Reserving a slot means the second caller's wait is computed against
   * the first caller's slot even though that request has not happened yet.
   */
  let nextSlotAt = 0;

  return {
    minIntervalMs,
    async acquire(): Promise<void> {
      const at = now();
      const slot = Math.max(at, nextSlotAt);
      nextSlotAt = slot + minIntervalMs;
      const wait = slot - at;
      if (wait > 0) await sleep(wait);
    },
  };
}
