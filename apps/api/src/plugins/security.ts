import cors from '@fastify/cors';
import type { RateLimitClass, RateLimitDecision, RateLimitIdentity } from '@binaryai/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../lib/context.js';
import { errorBody } from '../lib/http.js';

/**
 * Transport-level protections: CORS and rate limiting.
 *
 * Rate limiting happens in two passes, and the split is load-bearing:
 *
 *   1. BEFORE identity (this plugin). Keyed on network. This is the pass that
 *      protects the password hash — an Argon2id verification is deliberately
 *      expensive, so an unauthenticated flood must be refused before it reaches
 *      one. It cannot key on an account because nobody has authenticated yet.
 *
 *   2. AFTER identity (`registerIdentityRateLimit`, registered after the auth
 *      plugin). Keyed on the authenticated account. This is the pass that stops
 *      one account monopolising the expensive endpoints regardless of how many
 *      addresses it calls from.
 *
 * Neither pass replaces the other: the first bounds a source, the second bounds
 * an identity, and an attacker who can change one usually cannot change both.
 *
 * Authentication itself is NOT here. Identity resolution, CSRF and the auth
 * guard live in plugins/auth.ts.
 */

/** Credential submission. The one class where the limit is a security control. */
const CREDENTIAL_PATHS = new Set(['/v1/auth/login', '/v1/auth/register']);

export async function registerSecurity(app: FastifyInstance, context: AppContext): Promise<void> {
  const { config } = context;

  // A wildcard cannot be combined with credentials: browsers reject the
  // response outright, which would look like a broken login rather than a
  // misconfiguration. Dropping it here fails loudly at the CORS layer instead.
  const allowedOrigins = config.server.corsOrigins.filter((origin) => origin !== '*');

  await app.register(cors, {
    // Session cookies are cross-origin in the normal setup (web on :3000, API
    // on :4000), so credentialed CORS is required. The spec forbids pairing
    // credentials with a wildcard origin, and config already refuses '*' in
    // production -- but a dev instance could still set it, so it is filtered
    // here rather than trusted.
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Liveness must answer while the API is being flooded. It is the signal an
    // orchestrator uses to decide whether to kill the process, and a 429 there
    // would get a healthy instance restarted in the middle of an attack.
    if (request.url === '/health/live') return;

    const traffic: RateLimitClass = isCredentialSubmission(request)
      ? 'auth_attempt'
      : 'api_request';

    // Network identity, because identity has not been resolved yet. The address
    // is normalised to a /64 for IPv6 inside the limiter, so an attacker with a
    // routine subnet allocation cannot mint a fresh budget per request.
    const identity: RateLimitIdentity = { kind: 'network', address: request.ip };

    await enforce(context, request, reply, traffic, identity);
  });
}

/**
 * The account-keyed pass.
 *
 * Registered after the auth plugin so `request.principal` exists. Anonymous
 * requests are skipped rather than counted again: they were already counted by
 * network in the pass above, and counting them a second time under a shared
 * "anonymous" key would let one caller exhaust a budget for everybody.
 */
export function registerIdentityRateLimit(app: FastifyInstance, context: AppContext): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const traffic = expensiveClassOf(request);
    if (traffic === null) return;

    const identity = identityOf(request);
    if (identity === null) return;

    await enforce(context, request, reply, traffic, identity);
  });
}

/**
 * Applies a decision to the reply.
 *
 * The three outcomes get three different responses on purpose. `limited` is a
 * 429 the caller can retry; `unavailable` is a 503 that says the limiter itself
 * could not answer, because telling a caller to retry in a minute when the
 * problem is an unreachable Redis is a lie about what is wrong.
 */
async function enforce(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  traffic: RateLimitClass,
  identity: RateLimitIdentity,
): Promise<void> {
  const decision = await context.rateLimiter.check(traffic, identity);
  setRateLimitHeaders(reply, decision);

  if (decision.outcome === 'allowed') return;

  if (decision.outcome === 'unavailable') {
    // Fail closed. Reached only by credential traffic, and only while the
    // shared counter is unreachable — serving would mean unmetered password
    // guessing for the duration of the outage.
    await reply
      .code(503)
      .header('retry-after', String(decision.retryAfterSeconds))
      .send(
        errorBody(
          'rate_limiter_unavailable',
          'Authentication is temporarily unavailable because request limits cannot be checked.',
          undefined,
          request.id,
        ),
      );
    return;
  }

  await reply
    .code(429)
    .header('retry-after', String(decision.retryAfterSeconds))
    .send(
      errorBody(
        'rate_limited',
        traffic === 'auth_attempt'
          ? `Too many authentication attempts. Retry in ${decision.retryAfterSeconds}s.`
          : `Too many requests. Retry in ${decision.retryAfterSeconds}s.`,
        undefined,
        request.id,
      ),
    );
}

/**
 * The standard advisory headers.
 *
 * Sent on every metered response, not only on rejections, so a well-behaved
 * client can slow down before it is refused. They carry a budget and a window
 * and nothing about who is being counted.
 */
function setRateLimitHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  void reply.header('ratelimit-limit', String(decision.limit));
  void reply.header('ratelimit-remaining', String(decision.remaining));
  if (decision.resetAt !== null) {
    void reply.header(
      'ratelimit-reset',
      String(Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000))),
    );
  }
}

function isCredentialSubmission(request: FastifyRequest): boolean {
  return request.method === 'POST' && CREDENTIAL_PATHS.has(pathOf(request.url));
}

/**
 * Classifies the endpoints whose cost justifies their own budget.
 *
 * Everything else falls under the general class already applied by network in
 * the first pass. Kept as explicit prefixes rather than a regex: a pattern that
 * accidentally stopped matching would silently remove a limit, and nothing
 * about the running system would look wrong.
 */
function expensiveClassOf(request: FastifyRequest): RateLimitClass | null {
  const path = pathOf(request.url);

  // Aggregation across an account's whole outcome history. Cheap to ask for,
  // expensive to answer.
  if (path.startsWith('/v1/analytics/')) return 'analytics';

  // Fans out to an external provider and writes candles. Bounded so one caller
  // cannot exhaust the provider's quota for every other account.
  if (request.method === 'POST' && path === '/v1/market-data/ingest') return 'ingestion';

  // Opening or cancelling a paper position: row locks plus an append-only
  // ledger write.
  if (request.method === 'POST' && /^\/v1\/accounts\/[^/]+\/positions/.test(path)) {
    return 'paper_action';
  }

  return null;
}

/**
 * The stable identifier this request is counted against.
 *
 * Never the session token, the API key, or a hash of either: a key travels into
 * the store, into logs when a limit is hit, and into metrics, and a token-keyed
 * limit is defeated by minting another token anyway.
 */
function identityOf(request: FastifyRequest): RateLimitIdentity | null {
  const principal = request.principal;
  if (principal.kind === 'user') return { kind: 'user', userId: principal.user.id };
  // A shared machine token has no user behind it; the label identifies which
  // token, which is a name and not the secret itself.
  if (principal.kind === 'service') return { kind: 'service', label: principal.label };
  return null;
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}
