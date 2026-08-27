import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@binaryai/auth';
import type { Account, Session, User } from '@binaryai/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody, parseBody } from '../lib/http.js';
import { requireUser } from '../plugins/auth.js';

/**
 * Authentication routes.
 *
 * The shapes here are as important as the logic. In particular:
 *
 *  - The session token is returned ONLY as a `Set-Cookie` header, never in a
 *    response body. A token in JSON ends up in browser storage, in logs, and
 *    in whatever a client decides to cache; in an httpOnly cookie it is
 *    unreachable from JavaScript, which is what makes XSS non-fatal.
 *  - Login failures are uniform. "No such user" and "wrong password" produce
 *    the identical status, code and message, so the endpoint cannot be used to
 *    discover which addresses have accounts.
 */

const NO_PERSISTENCE =
  'No database is configured (DATABASE_URL is unset), so user accounts do not exist. ' +
  'Set DATABASE_URL and run the migrations to enable sign-in.';

const emailSchema = z.string().trim().min(3).max(254);

const registerSchema = z.object({
  email: emailSchema,
  // Bounds only. The real strength rules live in @binaryai/auth so that the
  // API and any future client apply exactly the same policy.
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  displayName: z.string().trim().min(1).max(80).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

/** The user shape sent to clients. Never contains credential material. */
function publicUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function publicAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    name: account.name,
    mode: account.mode,
    currency: account.currency,
    balance: account.balance,
    isDefault: account.isDefault,
  };
}

function publicSession(session: Session, currentId: string): Record<string, unknown> {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    // Lets the UI mark "this device" without the client having to guess.
    current: session.id === currentId,
  };
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const { config } = context;
  const cookieName = config.auth.session.cookieName;

  /**
   * Cookie attributes, in one place so no endpoint can set them inconsistently.
   *
   *  - `httpOnly`  keeps the token out of reach of JavaScript, so an XSS bug
   *                cannot read it.
   *  - `sameSite`  'lax' stops the browser attaching it to cross-site writes,
   *                which is the primary CSRF defence.
   *  - `secure`    refuses to send it over plain HTTP. Production config
   *                refuses to turn this off.
   *  - `path: '/'` so it is presented to every API route, not just /v1/auth.
   */
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.auth.session.secureCookie,
    path: '/',
    ...(config.auth.session.cookieDomain === undefined
      ? {}
      : { domain: config.auth.session.cookieDomain }),
  };

  function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number): void {
    reply.setCookie(cookieName, token, {
      ...cookieOptions,
      // Seconds, and floored: a rounded-up value would leave a cookie alive
      // fractionally longer than the session row it points at.
      maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    // Same attributes as when it was set -- a browser will not replace a
    // cookie whose path or domain differs, and the stale one would linger.
    reply.clearCookie(cookieName, cookieOptions);
  }

  function requireAuthService(reply: FastifyReply): NonNullable<AppContext['auth']> | null {
    if (context.auth) return context.auth;
    void reply
      .code(503)
      .send(errorBody('no_persistence', NO_PERSISTENCE, undefined, reply.request.id));
    return null;
  }

  /**
   * What a client needs before rendering a sign-in screen: whether accounts
   * exist at all, whether signup is open, and who (if anyone) is already
   * signed in. Public by necessity -- it is what the login page asks first.
   */
  app.get('/v1/auth/context', async (request) => {
    // Counting users reads a row, so a database outage would throw here — and
    // this route is what the sign-in page asks before it renders anything. A
    // 500 would turn "the database is down" into a blank, unexplained page.
    //
    // `bootstrapOpen` therefore falls back to FALSE rather than to a guess.
    // False is the closed, safe direction: the worst outcome is that a genuinely
    // empty instance briefly declines to offer its first-account flow, which
    // resolves as soon as the database answers. True would offer to create an
    // administrator on an instance that may already have one.
    let bootstrapOpen = false;
    let storeReachable = true;
    if (context.auth) {
      try {
        bootstrapOpen = await context.auth.isBootstrapOpen();
      } catch {
        storeReachable = false;
      }
    }
    const principal = request.principal;

    return {
      authEnabled: config.auth.enabled,
      accountsAvailable: context.auth !== null,
      // True only on a genuinely empty instance: the first account may be
      // created without an invitation and becomes the administrator.
      bootstrapOpen,
      registrationOpen: (config.auth.allowRegistration || bootstrapOpen) && storeReachable,
      authenticated: principal.kind === 'user',
      user: principal.kind === 'user' ? publicUser(principal.user) : null,
      // Stated rather than implied: a client that sees `authenticated: false`
      // needs to know whether that means "signed out" or "could not check".
      ...(storeReachable ? {} : { degraded: true }),
      ...(context.auth ? {} : { reason: NO_PERSISTENCE }),
    };
  });

  app.post('/v1/auth/register', async (request, reply) => {
    const auth = requireAuthService(reply);
    if (!auth) return reply;

    const parsed = parseBody(registerSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const result = await auth.register({
      email: parsed.data.email,
      password: parsed.data.password,
      displayName: parsed.data.displayName ?? null,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (!result.ok) {
      switch (result.failure.kind) {
        case 'registration_closed':
          return reply
            .code(403)
            .send(
              errorBody(
                'registration_closed',
                'This instance does not accept open registration. Ask an administrator for an account.',
                undefined,
                request.id,
              ),
            );
        case 'invalid_email':
          return reply
            .code(400)
            .send(
              errorBody('invalid_email', 'That email address is not valid.', undefined, request.id),
            );
        case 'weak_password':
          return reply
            .code(400)
            .send(errorBody('weak_password', result.failure.message, undefined, request.id));
        case 'email_taken':
          // A deliberate trade-off. Registration cannot hide that an address is
          // taken without silently doing nothing, which is worse for the
          // legitimate user. The rate limit on this path is what keeps it from
          // becoming a bulk enumeration oracle.
          return reply
            .code(409)
            .send(
              errorBody(
                'email_taken',
                'An account with that email already exists.',
                undefined,
                request.id,
              ),
            );
      }
    }

    setSessionCookie(reply, result.issued.token, result.issued.session.expiresAt);
    return reply.code(201).send({
      user: publicUser(result.user),
      account: publicAccount(result.account),
      session: { expiresAt: result.issued.session.expiresAt },
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const auth = requireAuthService(reply);
    if (!auth) return reply;

    const parsed = parseBody(loginSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const result = await auth.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (!result.ok) {
      if (result.failure.kind === 'locked') {
        return reply
          .code(429)
          .header('retry-after', String(result.failure.retryAfterSeconds))
          .send(
            errorBody(
              'account_locked',
              `Too many failed attempts. Try again in ${result.failure.retryAfterSeconds}s.`,
              undefined,
              request.id,
            ),
          );
      }
      if (result.failure.kind === 'account_disabled') {
        return reply
          .code(403)
          .send(
            errorBody(
              'account_disabled',
              'This account has been disabled. Contact an administrator.',
              undefined,
              request.id,
            ),
          );
      }
      // Identical for an unknown address and a wrong password.
      return reply
        .code(401)
        .send(
          errorBody(
            'invalid_credentials',
            'Email or password is incorrect.',
            undefined,
            request.id,
          ),
        );
    }

    setSessionCookie(reply, result.issued.token, result.issued.session.expiresAt);
    return reply.send({
      user: publicUser(result.user),
      session: { expiresAt: result.issued.session.expiresAt },
    });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    // Always clears the cookie, even with no session to revoke. Logging out
    // must never leave a credential behind in the browser.
    clearSessionCookie(reply);

    if (context.auth && request.principal.kind === 'user') {
      await context.auth.logout(request.principal.sessionId);
    }
    return reply.send({ loggedOut: true });
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    // Narrowed by requireUser; re-read for the account and session ids.
    const principal = request.principal;
    if (principal.kind !== 'user') return reply;

    const account =
      context.auth && principal.accountId
        ? await context.persistence?.repositories.accounts.findById(principal.accountId)
        : null;

    return reply.send({
      user: publicUser(user),
      account: account ? publicAccount(account) : null,
      scope: request.scope.kind,
    });
  });

  app.get('/v1/auth/sessions', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const auth = requireAuthService(reply);
    if (!auth) return reply;
    const principal = request.principal;
    if (principal.kind !== 'user') return reply;

    const sessions = await auth.listSessions(user.id);
    return reply.send({
      sessions: sessions.map((session) => publicSession(session, principal.sessionId)),
    });
  });

  /** Signs out every device. The obvious response to a suspected compromise. */
  app.post('/v1/auth/sessions/revoke-all', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const auth = requireAuthService(reply);
    if (!auth) return reply;

    const revoked = await auth.logoutEverywhere(user.id);
    clearSessionCookie(reply);
    return reply.send({ revoked });
  });

  app.post('/v1/auth/password', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const auth = requireAuthService(reply);
    if (!auth) return reply;

    const parsed = parseBody(changePasswordSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const result = await auth.changePassword({
      userId: user.id,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });

    if (!result.ok) {
      return reply
        .code(result.reason === 'weak_password' ? 400 : 401)
        .send(errorBody(result.reason, result.message, undefined, request.id));
    }

    // changePassword revokes every session, including this one, so the cookie
    // in the browser now points at a dead row. Clearing it makes the client
    // sign in again rather than discover this on its next request.
    clearSessionCookie(reply);
    return reply.send({ changed: true, sessionsRevoked: result.sessionsRevoked });
  });
}
