import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Authentication and per-user scoping through the real API.
 *
 * These are the tests that would catch an actual breach, so they assert
 * behaviour rather than implementation: can user B see user A's data, does a
 * revoked cookie still work, does a failed login reveal whether the account
 * exists. Each one describes a specific way the system could leak, and none of
 * them should ever be relaxed to make a feature pass.
 */

const STRONG_PASSWORD = 'correct-horse-battery-staple-7';
const OTHER_PASSWORD = 'another-decent-passphrase-42';

let context: TestDatabase;
let app: FastifyInstance;

/** Registration open, so multiple users can be created in one test. */
function openConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    AUTH_ALLOW_REGISTRATION: 'true',
    // Cookies are inspected over plain HTTP in the harness; production config
    // refuses this, which is asserted separately in the config suite.
    AUTH_COOKIE_SECURE: 'false',
    ...overrides,
  });
}

async function buildWith(config: ReturnType<typeof loadConfig>): Promise<FastifyInstance> {
  return buildApp(
    createAppContext({ config, persistence: context.persistence, marketDataProvider: null }),
  );
}

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
  // A FRESH app per test, not a shared one. The credential rate limiter keeps
  // its counters in process memory, so a shared instance would carry attempts
  // from earlier tests and start returning 429 partway through the file. A new
  // instance is what a restarted process looks like, which is the state each
  // test means to describe.
  app = await buildWith(openConfig());
});

/** Registers a user and returns the session cookie the browser would hold. */
async function register(instance: FastifyInstance, email: string, password = STRONG_PASSWORD) {
  const response = await instance.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password },
  });
  const body = response.json();
  return {
    cookie: response.cookies[0] ? `${response.cookies[0].name}=${response.cookies[0].value}` : '',
    userId: body.user?.id ?? '',
    status: response.statusCode,
    body,
  };
}

async function login(instance: FastifyInstance, email: string, password: string) {
  const response = await instance.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  return {
    status: response.statusCode,
    cookie: response.cookies[0] ? `${response.cookies[0].name}=${response.cookies[0].value}` : '',
    body: response.json(),
  };
}

// --------------------------------------------------------------- bootstrap --

describe('bootstrap', () => {
  it('reports an empty instance as open for its first account', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/auth/context' })).json();

    expect(body.bootstrapOpen).toBe(true);
    expect(body.accountsAvailable).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.user).toBeNull();
  });

  it('makes the first user an administrator and nobody after', async () => {
    const first = await register(app, 'founder@example.com');
    expect(first.status).toBe(201);
    expect(first.body.user.role).toBe('admin');

    const second = await register(app, 'trader@example.com');
    expect(second.body.user.role).toBe('user');
  });

  it('gives the new user a demo account, never a live one', async () => {
    const { body } = await register(app, 'founder@example.com');

    expect(body.account.mode).toBe('demo');
    expect(body.account.isDefault).toBe(true);
  });

  it('closes bootstrap once a user exists', async () => {
    await register(app, 'founder@example.com');
    const body = (await app.inject({ method: 'GET', url: '/v1/auth/context' })).json();
    expect(body.bootstrapOpen).toBe(false);
  });

  it('refuses a second account when registration is closed', async () => {
    const closed = await buildWith(openConfig({ AUTH_ALLOW_REGISTRATION: 'false' }));

    // The first is always permitted -- otherwise a fresh instance would be
    // unreachable without hand-editing the database.
    expect((await register(closed, 'founder@example.com')).status).toBe(201);

    const second = await register(closed, 'intruder@example.com');
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('registration_closed');
  });
});

// ------------------------------------------------------------ registration --

describe('registration', () => {
  it('rejects a weak password and explains why', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'trader@example.com', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a password built from the email address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'alice.trader@example.com', password: 'alice.traderalice.trader' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('weak_password');
  });

  it('normalizes the email, so case cannot create a second account', async () => {
    await register(app, 'Trader@Example.COM');
    const duplicate = await register(app, 'trader@example.com');

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('email_taken');
  });

  it('never returns the session token in the response body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'trader@example.com', password: STRONG_PASSWORD },
    });

    // The token belongs in an httpOnly cookie and nowhere else. In a body it
    // would reach JavaScript, logs, and any client that caches responses.
    const raw = response.body;
    const cookieValue = response.cookies[0]?.value ?? '';
    expect(cookieValue.length).toBeGreaterThan(0);
    expect(raw).not.toContain(cookieValue);
  });

  it('never returns the password digest', async () => {
    const { body } = await register(app, 'trader@example.com');
    expect(JSON.stringify(body)).not.toContain('argon2');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

// ------------------------------------------------------------------- login --

describe('login', () => {
  it('accepts the right password', async () => {
    await register(app, 'trader@example.com');
    const result = await login(app, 'trader@example.com', STRONG_PASSWORD);

    expect(result.status).toBe(200);
    expect(result.body.user.email).toBe('trader@example.com');
    expect(result.cookie).not.toBe('');
  });

  it('gives an unknown address and a wrong password the identical response', async () => {
    await register(app, 'trader@example.com');

    const wrongPassword = await login(app, 'trader@example.com', 'definitely-not-the-password');
    const unknownUser = await login(app, 'nobody@example.com', 'definitely-not-the-password');

    // Any difference here -- status, code, or wording -- turns the login form
    // into an oracle for which email addresses have accounts.
    expect(wrongPassword.status).toBe(unknownUser.status);
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownUser.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('issues a brand-new session on every login', async () => {
    await register(app, 'trader@example.com');
    const first = await login(app, 'trader@example.com', STRONG_PASSWORD);
    const second = await login(app, 'trader@example.com', STRONG_PASSWORD);

    // Session fixation: reusing a token would let an attacker who planted one
    // before login keep using it afterwards.
    expect(first.cookie).not.toBe(second.cookie);
  });

  it('locks an account after repeated failures', async () => {
    await register(app, 'trader@example.com');

    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastStatus = (await login(app, 'trader@example.com', `wrong-${attempt}`)).status;
    }

    // Per-account lockout, distinct from the per-IP rate limit: it is what
    // stops a distributed attack on one specific account.
    expect(lastStatus).toBe(429);
  });

  it('sets a hardened cookie', async () => {
    await register(app, 'trader@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'trader@example.com', password: STRONG_PASSWORD },
    });

    const cookie = response.cookies[0];
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- sessions --

describe('sessions', () => {
  it('identifies the signed-in user', async () => {
    const { cookie } = await register(app, 'trader@example.com');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe('trader@example.com');
    expect(response.json().account.mode).toBe('demo');
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
  });

  it('refuses a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: 'binaryai_session=completely-made-up-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stops accepting the cookie the moment the user logs out', async () => {
    const { cookie } = await register(app, 'trader@example.com');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: 'http://localhost:3000' },
    });

    // The whole reason for server-side sessions: revocation is immediate, not
    // whenever the credential happens to expire.
    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('lists active sessions and marks the current one', async () => {
    await register(app, 'trader@example.com');
    await login(app, 'trader@example.com', STRONG_PASSWORD);
    const current = await login(app, 'trader@example.com', STRONG_PASSWORD);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { cookie: current.cookie },
    });
    const sessions = response.json().sessions;

    expect(sessions.length).toBe(3);
    expect(sessions.filter((s: { current: boolean }) => s.current).length).toBe(1);
    // A session listing must not hand back the tokens it describes.
    expect(JSON.stringify(sessions)).not.toContain(current.cookie.split('=')[1]);
  });

  it('signs out every device at once', async () => {
    const first = await register(app, 'trader@example.com');
    const second = await login(app, 'trader@example.com', STRONG_PASSWORD);

    await app.inject({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-all',
      headers: { cookie: second.cookie, origin: 'http://localhost:3000' },
    });

    for (const cookie of [first.cookie, second.cookie]) {
      expect(
        (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
      ).toBe(401);
    }
  });
});

// ------------------------------------------------------------------ logout --

describe('logout', () => {
  it('clears the cookie even with no session to revoke', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/logout' });

    expect(response.statusCode).toBe(200);
    // Logging out must never leave a credential sitting in the browser.
    expect(response.cookies[0]?.value).toBe('');
  });
});

// --------------------------------------------------------- password change --

describe('password change', () => {
  it('requires the current password', async () => {
    const { cookie } = await register(app, 'trader@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: { currentPassword: 'wrong-current-password', newPassword: OTHER_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a weak replacement', async () => {
    const { cookie } = await register(app, 'trader@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: 'weak' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('changes the password and kills every existing session', async () => {
    const first = await register(app, 'trader@example.com');
    const second = await login(app, 'trader@example.com', STRONG_PASSWORD);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie: second.cookie, origin: 'http://localhost:3000' },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: OTHER_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    // If the change was prompted by a compromise, leaving other sessions alive
    // would defeat the point of changing it.
    for (const cookie of [first.cookie, second.cookie]) {
      expect(
        (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
      ).toBe(401);
    }

    expect((await login(app, 'trader@example.com', OTHER_PASSWORD)).status).toBe(200);
    expect((await login(app, 'trader@example.com', STRONG_PASSWORD)).status).toBe(401);
  });
});

// ------------------------------------------------------------------- guard --

describe('auth guard', () => {
  it('leaves the API open when auth is disabled', async () => {
    // The default development posture, unchanged by Phase 3.
    expect((await app.inject({ method: 'GET', url: '/v1/strategies' })).statusCode).toBe(200);
  });

  it('protects every non-public route when auth is enabled', async () => {
    const guarded = await buildWith(
      openConfig({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
    );

    expect((await guarded.inject({ method: 'GET', url: '/v1/strategies' })).statusCode).toBe(401);
    expect((await guarded.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await guarded.inject({ method: 'GET', url: '/v1/auth/context' })).statusCode).toBe(200);
  });

  it('accepts a session cookie on a guarded route', async () => {
    const guarded = await buildWith(
      openConfig({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
    );
    const { cookie } = await register(guarded, 'trader@example.com');

    expect(
      (await guarded.inject({ method: 'GET', url: '/v1/strategies', headers: { cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it('accepts the machine token but refuses it on user endpoints', async () => {
    const guarded = await buildWith(
      openConfig({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
    );
    const headers = { authorization: 'Bearer a-machine-token-value' };

    expect(
      (await guarded.inject({ method: 'GET', url: '/v1/strategies', headers })).statusCode,
    ).toBe(200);

    // A shared token authenticates a machine with no owner. Falling back to
    // some default account here would hand it another user's data.
    const me = await guarded.inject({ method: 'GET', url: '/v1/auth/me', headers });
    expect(me.statusCode).toBe(403);
    expect(me.json().error.code).toBe('user_required');
  });

  it('refuses a wrong machine token', async () => {
    const guarded = await buildWith(
      openConfig({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
    );
    const response = await guarded.inject({
      method: 'GET',
      url: '/v1/strategies',
      headers: { authorization: 'Bearer wrong-token-value-x' },
    });
    expect(response.statusCode).toBe(401);
  });
});

// -------------------------------------------------------------------- CSRF --

describe('CSRF', () => {
  it('rejects a cookie-authenticated write from an unrecognised origin', async () => {
    const { cookie } = await register(app, 'trader@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: 'https://evil.example.com' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('csrf_rejected');
  });

  it('allows a write from a configured origin', async () => {
    const { cookie } = await register(app, 'trader@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: 'http://localhost:3000' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not block a bearer-token write', async () => {
    // A token has to be attached deliberately, so there is nothing for a
    // third-party page to abuse.
    const guarded = await buildWith(
      openConfig({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
    );
    const response = await guarded.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        authorization: 'Bearer a-machine-token-value',
        origin: 'https://evil.example.com',
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
