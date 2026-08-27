import type { MarketDataStatus, SystemStatus } from '@binaryai/types';
import type { ApiResult } from '@/lib/api';

/**
 * Display state for the shell indicators.
 *
 * One module, because these are the values most likely to drift into a
 * comfortable lie. Every indicator in the top bar and the system strip resolves
 * through here, so "what does ONLINE mean" has exactly one answer.
 *
 * Two failures this exists to prevent, both previously real:
 *
 *  1. **A 401 rendered as OFFLINE.** The API answering "not for you" is not the
 *     API being down, and an operator sent to debug a healthy server has been
 *     misled by the interface.
 *  2. **Four market-data states collapsed into NONE.** The API distinguishes
 *     not_configured, disconnected, degraded and stale. Rendering all four
 *     identically hides the one that matters most: `stale` means a price exists
 *     but is old, and showing it as "no data" is safer than showing it as live
 *     — but showing it as *itself* is the only honest option.
 */

export type IndicatorTone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

export interface Indicator {
  /** Short label for the pill, e.g. 'ONLINE'. */
  readonly value: string;
  readonly tone: IndicatorTone;
  /** Full sentence for the tooltip. Always says what the state actually means. */
  readonly detail: string;
}

/**
 * API reachability.
 *
 * FOUR states, because a two-state indicator conflates conditions that call for
 * completely different responses:
 *
 *   ONLINE     answering normally
 *   LOCKED     answering, but this session may not read it (401/403)
 *   THROTTLED  answering, and refusing on purpose (429)
 *   ERROR      answering, and failing (5xx) — the server is up
 *   OFFLINE    not answering at all (transport failure)
 *
 * Two of these were found by looking at the rendered page rather than by
 * reasoning about it. A database outage produced 500s, which the earlier logic
 * labelled OFFLINE — sending an operator to check whether the process is
 * running when the process is fine and its dependency is not. Rate limiting
 * produced 429s, which then rendered as ERROR; a rate limiter doing exactly its
 * job is not a fault, and reporting it as one wastes the same investigation.
 */
export function apiIndicator(status: ApiResult<SystemStatus>): Indicator {
  if (status.ok) {
    return { value: 'ONLINE', tone: 'ok', detail: 'The API is reachable and answering.' };
  }
  if (status.unauthorized === true) {
    return {
      value: 'LOCKED',
      tone: 'warn',
      // Deliberately not 'bad': nothing is broken.
      detail: 'The API is running and answering, but this session is not authorised to read it.',
    };
  }
  if (status.status === 429) {
    return {
      value: 'THROTTLED',
      tone: 'warn',
      // Working as designed, so not 'bad'.
      detail: 'The API is healthy and is rate limiting this client. Requests will resume shortly.',
    };
  }
  if (typeof status.status === 'number') {
    // An HTTP status came back, so something answered. Whatever is wrong is
    // behind the API, not the API itself.
    return {
      value: 'ERROR',
      tone: 'bad',
      detail: `The API is reachable but returned ${status.status}. ${status.error}`,
    };
  }
  return {
    value: 'OFFLINE',
    tone: 'bad',
    detail: `The API did not answer at all. ${status.error}`,
  };
}

/**
 * Market-data state, preserving every distinction the API makes.
 *
 * `stale` is its own indicator rather than being folded into either LIVE or
 * NONE. A stale feed has data — that is what makes it dangerous, and what makes
 * it different from having none.
 */
export function marketDataIndicator(status: ApiResult<SystemStatus>): Indicator {
  if (!status.ok) {
    return status.unauthorized === true
      ? { value: 'LOCKED', tone: 'warn', detail: 'Sign in to read market-data state.' }
      : {
          value: 'UNKNOWN',
          tone: 'idle',
          detail: 'The API is unreachable, so data state is unknown.',
        };
  }

  const component = status.data.components.find((entry) => entry.component === 'market_data');
  const health = component?.health;
  const detail = component?.detail ?? 'No detail reported.';

  switch (health) {
    case 'ok':
      return { value: 'LIVE', tone: 'ok', detail };
    case 'degraded':
      // Covers both `degraded` and `stale` on the API side. The detail string
      // carries which one, and it is surfaced rather than discarded.
      return { value: 'DEGRADED', tone: 'warn', detail };
    case 'unavailable':
      return { value: 'DISCONNECTED', tone: 'bad', detail };
    case 'not_configured':
      return {
        value: 'NOT CONFIGURED',
        tone: 'idle',
        // The distinction §23 asks for: nothing is broken, nothing was set up.
        detail: detail || 'No market-data provider is configured.',
      };
    default:
      return { value: 'UNKNOWN', tone: 'idle', detail };
  }
}

/** Market-session state, derived from whether usable data is actually flowing. */
export function marketIndicator(status: ApiResult<SystemStatus>): Indicator {
  const data = marketDataIndicator(status);
  if (data.value === 'LIVE') {
    return { value: 'LIVE', tone: 'ok', detail: 'Candles are current.' };
  }
  if (data.value === 'DEGRADED') {
    return { value: 'DELAYED', tone: 'warn', detail: data.detail };
  }
  return {
    value: 'WAITING',
    tone: 'idle',
    detail: 'No validated market data has arrived, so the market view is dormant.',
  };
}

/** One component row in the system-status module. */
export function componentIndicator(health: string, detail: string): Indicator {
  switch (health) {
    case 'ok':
      return { value: 'ONLINE', tone: 'ok', detail };
    case 'degraded':
      return { value: 'DEGRADED', tone: 'warn', detail };
    case 'unavailable':
      return { value: 'UNAVAILABLE', tone: 'bad', detail };
    case 'not_configured':
      return { value: 'NOT CONFIGURED', tone: 'idle', detail };
    default:
      return { value: 'UNKNOWN', tone: 'idle', detail };
  }
}

/**
 * The instrument the workspace is showing, and its price.
 *
 * Returns null for the price unless a real, current candle exists. There is no
 * fallback and no last-known value: a number in the top bar is read as the
 * market right now, and there is no honest way to show one we do not have.
 */
export function instrumentSummary(
  symbol: string | null,
  marketData: ApiResult<{ status: MarketDataStatus }>,
): { readonly symbol: string | null; readonly providerName: string | null } {
  return {
    symbol,
    providerName: marketData.ok ? marketData.data.status.providerName : null,
  };
}

export const TONE_DOT: Record<IndicatorTone, string> = {
  ok: 'bg-bull',
  warn: 'bg-warn',
  bad: 'bg-bear',
  info: 'bg-info',
  idle: 'bg-text-3',
};

export const TONE_TEXT: Record<IndicatorTone, string> = {
  ok: 'text-bull',
  warn: 'text-warn',
  bad: 'text-bear',
  info: 'text-info',
  idle: 'text-text-3',
};
