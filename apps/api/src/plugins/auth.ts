import cookie from '@fastify/cookie';
import { scopeForPrincipal } from '@binaryai/auth';
import type { AccessScope, Principal, User } from '@binaryai/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../lib/context.js';
import type { Credential } from '../lib/auth-service.js';
import { errorBody } from '../lib/http.js';

/**
 * Request identity.
 *
 * Every request carries a `principal` and a `scope`, always -- an
 * unauthenticated request gets the anonymous principal and the shared-data
 * scope rather than `undefined`. Routes therefore never test for the presence
 * of auth; they ask what this request is allowed to see, and there is always
 * an answer.
 *
 * Order matters here and is enforced by registration order:
 *
 *   1. resolve  -- who is this? (never rejects)
 *   2. CSRF     -- is a cookie-authenticated write coming from our own origin?
 *   3. guard    -- is this identity allowed on this route?
 *
 * Resolving before guarding is what lets the guard produce an accurate reason,
 * and lets public routes still know who is calling them.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Never undefined. Anonymous when no valid credential was presented. */
    principal: Principal;
    /** The ownership filter for this request, derived from the principal. */
    scope: AccessScope;
    /**
     * True when identity could not be resolved because the session store was
     * unreachable — as opposed to a credential that was absent or invalid.
     *
     * The distinction changes the correct response. A caller whose cookie could
     * not be CHECKED has not failed authentication, and telling them so would
     * send them to re-enter a password that was never the problem.
     */
    authDegraded: boolean;
  }
}

/**
 * Routes reachable without a credential.
 *
 * Kept as an explicit allowlist rather than a pattern: a typo in a regex that
 * accidentally makes `/v1/signals` public is a silent data leak, whereas a
 * missing entry here is an obvious 401 during development.
 */
const PUBLIC_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/v1/auth/login',
  '/v1/auth/register',
  '/v1/auth/context',
]);

/** Methods that change state and therefore need CSRF protection. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function registerAuth(app: FastifyInstance, context: AppContext): Promise<void> {
  const { config } = context;

  await app.register(cookie);

  // Deliberately NOT decorateRequest: Fastify 5 refuses reference-type
  // decorators (FST_ERR_DEC_REFERENCE_TYPE) because one object would be shared
  // by every request -- exactly the aliasing bug you least want on an identity
  // field. The hook below is the first to run after rate limiting, so both
  // properties are set before any route or later hook can read them.

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const credential = readCredential(request, config.auth.session.cookieName);
    const auth = context.auth;

    let principal: Principal;
    let degraded = false;

    try {
      // With no database there is no user table, so a session cannot be
      // resolved. The shared machine token still works, which is what keeps a
      // stateless deployment usable.
      principal = auth
        ? await auth.resolve(credential)
        : resolveWithoutPersistence(credential, config.auth.apiKey);
    } catch {
      // Resolving a session reads a row, so a database outage used to throw
      // here — and because this hook runs on EVERY request, every request
      // carrying a cookie became a 500. That included `/v1/system/status`, the
      // one endpoint an operator opens to find out what is wrong. The status
      // page reported "API UNREACHABLE" while the API was running perfectly and
      // the database was the thing that had failed.
      //
      // A credential that could not be CHECKED is not a credential that failed.
      // The request continues as anonymous so public routes and health checks
      // keep working, and the flag lets the guard answer 503 rather than 401.
      principal = { kind: 'anonymous' };
      degraded = true;
    }

    request.principal = principal;
    request.scope = scopeForPrincipal(principal);
    request.authDegraded = degraded;
  });

  /**
   * CSRF.
   *
   * Cookies are attached by the browser automatically, so a form on another
   * site could otherwise trigger an authenticated write. Two independent
   * defences apply:
   *
   *  - `SameSite=Lax` on the cookie, which stops the browser sending it on
   *    cross-site POSTs at all.
   *  - This check, which rejects a cookie-authenticated write whose `Origin`
   *    is not one we recognise.
   *
   * Bearer-token callers are exempt: a token has to be attached deliberately,
   * so there is nothing for a third-party site to abuse.
   */
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING.has(request.method)) return;
    // Only cookie-authenticated requests are forgeable this way.
    if (request.cookies[config.auth.session.cookieName] === undefined) return;

    const origin = request.headers.origin;
    if (origin === undefined) {
      // A same-origin fetch from a browser always sends Origin on a write.
      // Its absence means a non-browser client, which should use the bearer
      // token rather than a cookie.
      return;
    }
    if (!isAllowedOrigin(origin, config.server.corsOrigins)) {
      await reply
        .code(403)
        .send(
          errorBody(
            'csrf_rejected',
            'This request was rejected because its origin is not recognised.',
            [`origin: ${origin}`],
            request.id,
          ),
        );
    }
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.auth.enabled) return;
    if (PUBLIC_PATHS.has(pathOf(request.url))) return;
    if (request.principal.kind !== 'anonymous') return;

    if (request.authDegraded) {
      await unavailable(request, reply);
      return;
    }

    await reply
      .code(401)
      .header('www-authenticate', 'Bearer realm="binaryai", Cookie')
      .send(
        errorBody(
          'unauthorized',
          'Sign in, or present a valid bearer token.',
          undefined,
          request.id,
        ),
      );
  });
}

/**
 * Extracts the credential a request is presenting.
 *
 * The bearer header wins over the cookie. That ordering is deliberate: an
 * explicit header is a deliberate act by the caller, whereas a cookie is
 * attached automatically and may simply be left over from a browser session.
 */
export function readCredential(request: FastifyRequest, cookieName: string): Credential {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token.length > 0) return { kind: 'bearer', token };
  }
  const cookieToken = request.cookies[cookieName];
  if (cookieToken !== undefined && cookieToken.length > 0) {
    return { kind: 'session', token: cookieToken };
  }
  return { kind: 'none' };
}

/** Bearer-only resolution for a deployment with no database. */
function resolveWithoutPersistence(credential: Credential, apiKey: string | undefined): Principal {
  if (credential.kind !== 'bearer' || !apiKey) return { kind: 'anonymous' };
  return constantTimeEquals(credential.token, apiKey)
    ? { kind: 'service', label: 'api_key' }
    : { kind: 'anonymous' };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true;
  return allowed.includes(origin);
}

export function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

/**
 * The response when identity could not be established for an infrastructure
 * reason rather than a credential one.
 *
 * 503, not 401 and not 500. A 401 would be a false accusation — the caller's
 * credential was never examined. A 500 would say the request was malformed or
 * the server broke handling it, when in fact the server is working and a
 * dependency is not. The code is stable so a client can distinguish "sign in
 * again" from "try again shortly".
 */
async function unavailable(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply
    .code(503)
    .header('retry-after', '5')
    .send(
      errorBody(
        'authentication_unavailable',
        'Sessions cannot be verified right now. This is not a problem with your credentials.',
        undefined,
        request.id,
      ),
    );
}

// ------------------------------------------------------------- route guards --

/**
 * Requires an authenticated USER, not merely an authenticated caller.
 *
 * The distinction matters: the shared machine token authenticates a machine
 * with no owner, so a route that reads or writes account-scoped data must
 * reject it rather than fall back to some default account. Returns null and
 * sends the response when the check fails, so callers `if (!user) return;`.
 */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<User | null> {
  if (request.principal.kind === 'user') return request.principal.user;

  // Checked before the 401: a caller whose session could not be READ has not
  // presented a bad credential, and a 401 would send them to sign in again
  // against a store that cannot answer either.
  if (request.authDegraded) {
    await unavailable(request, reply);
    return null;
  }

  if (request.principal.kind === 'service') {
    await reply
      .code(403)
      .send(
        errorBody(
          'user_required',
          'This endpoint acts on a user account. A shared API token has no user behind it; sign in instead.',
          undefined,
          request.id,
        ),
      );
    return null;
  }

  await reply
    .code(401)
    .send(errorBody('unauthorized', 'Sign in to continue.', undefined, request.id));
  return null;
}

/** Requires an authenticated administrator. */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<User | null> {
  const user = await requireUser(request, reply);
  if (!user) return null;
  if (user.role !== 'admin') {
    await reply
      .code(403)
      .send(
        errorBody('forbidden', 'This endpoint requires an administrator.', undefined, request.id),
      );
    return null;
  }
  return user;
}
