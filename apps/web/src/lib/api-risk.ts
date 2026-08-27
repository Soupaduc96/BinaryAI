import { apiBaseUrl } from './api-base';
import { forwardedCookies, TIMEOUT_MS, type ApiResult } from './api';

/**
 * Risk evaluation, kept apart from the read-only feeds in `api`.
 *
 * This is the only client call that POSTs in order to READ: the signal id and
 * size travel in a body, but the call locks nothing and writes nothing. Fetching
 * it server-side is what lets the workspace state whether a paper action is
 * possible using the risk engine's own verdict, rather than reconstructing one
 * in the browser from account numbers that may disagree with the policy
 * actually in force.
 */

/** The POST-to-read helper described above. */
async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        // The API requires an Origin on state-changing verbs.
        origin: 'http://localhost:3000',
        ...(await forwardedCookies()),
      },
      body: JSON.stringify(body),
    });
    // A 422 carries the full decision and is the ANSWER here, not a failure:
    // "this action is refused, and these are the rules that refused it".
    if (!response.ok && response.status !== 422) {
      return {
        ok: false,
        status: response.status,
        unauthorized: response.status === 401 || response.status === 403,
        error:
          response.status === 401
            ? `Not signed in (${path}).`
            : `API responded ${response.status} for ${path}`,
      };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not reach the API at ${apiBaseUrl} (${message})` };
  }
}

export interface RuleEvaluationView {
  readonly code: string;
  readonly label: string;
  readonly passed: boolean;
  readonly observed: number | string | null;
  readonly limit: number | string | null;
  readonly detail: string;
}

export interface RiskDecisionView {
  readonly outcome:
    | 'allowed'
    | 'blocked'
    | 'cooldown'
    | 'limit_reached'
    | 'invalid_policy'
    | 'insufficient_context';
  readonly allowed: boolean;
  readonly evaluations: readonly RuleEvaluationView[];
  readonly blockedBy: readonly string[];
  readonly retryAfterMs: number | null;
}

/**
 * Whether this account may act on this signal AT ALL.
 *
 * Evaluated at the smallest meaningful size, so the verdict is about the rules
 * that do not depend on size — slots, cooldown, allowlists, exposure window,
 * whether the signal is actionable. A size-specific refusal (`exceeds the
 * maximum position size`) surfaces later, against the size actually requested.
 *
 * Uncached: the answer depends on account state that a paper action changes.
 */
export function fetchActionability(
  signalId: string,
): Promise<ApiResult<{ decision: RiskDecisionView }>> {
  return postJson<{ decision: RiskDecisionView }>('/v1/accounts/me/risk/evaluate', {
    signalId,
    size: 1,
  });
}
