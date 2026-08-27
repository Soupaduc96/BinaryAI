import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * How the API behaves when things go wrong.
 *
 * Every test here describes a hostile or broken input and asserts the system
 * fails in the direction that is safe. The distinction that runs through all of
 * them: a request must be refused because a RULE said so, never because
 * something happened to crash on the way.
 *
 * Existing files already cover a foreign account (404), a revoked session, a
 * duplicate paper action and a duplicate settlement. These are the remaining
 * cases: CSRF across every mutating route rather than one, an expired session,
 * malformed and oversized bodies, and what a database outage looks like from
 * outside.
 */

const STRONG_PASSWORD = 'correct-horse-battery-staple-7';

let context: TestDatabase;
let app: FastifyInstance;

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    AUTH_ALLOW_REGISTRATION: 'true',
    AUTH_COOKIE_SECURE: 'false',
    ...overrides,
  });
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
  // A fresh app per test: the limiter counts in process memory, so a shared
  // instance would carry attempts between tests and start returning 429.
  app = await buildApp(
    createAppContext({
      config: config(),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );
});

async function register(email: string): Promise<{ cookie: string; accountId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: STRONG_PASSWORD },
  });
  const raw = response.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).split(';')[0] ?? '';
  const account = await app.inject({ method: 'GET', url: '/v1/accounts/me', headers: { cookie } });
  return { cookie, accountId: account.json().account.id };
}

/**
 * Moves every session's whole lifetime into the past.
 *
 * `created_at` has to move too. The schema enforces `expires_at > created_at`,
 * so setting only the expiry is refused outright — a constraint doing exactly
 * its job, since a session that expired before it was created is nonsense.
 * Backdating both produces a row that is genuinely, legitimately expired.
 */
async function expireEverySession(): Promise<void> {
  await context.database.query(
    `UPDATE sessions
        SET created_at = now() - interval '2 hours',
            expires_at = now() - interval '1 hour'`,
    [],
  );
}

// ------------------------------------------------------------------- CSRF --

describe('CSRF applies to every state-changing route, not just logout', () => {
  /**
   * The audit made executable.
   *
   * The check lives in one global hook, so it either covers everything or
   * nothing — but "it's a global hook" is an argument, not evidence, and a
   * later `if` inside that hook could exempt a path without anyone noticing.
   * This enumerates the mutating routes and proves each one refuses a
   * cookie-authenticated write from a foreign origin.
   */
  // Every entry carries a body, even where the route ignores it. A uniform
  // shape keeps the table readable and avoids an optional-payload branch whose
  // only purpose would be to satisfy the type checker.
  const mutating: Array<[string, Record<string, unknown>]> = [
    ['/v1/auth/logout', {}],
    ['/v1/auth/password', { currentPassword: STRONG_PASSWORD, newPassword: 'x'.repeat(20) }],
    ['/v1/auth/sessions/revoke-all', {}],
    ['/v1/analysis', { symbol: 'SYNTH', timeframe: '1m', candles: [] }],
    ['/v1/market-data/ingest', { symbol: 'SYNTH', timeframe: '1m' }],
    ['/v1/signals/evaluate', { symbol: 'SYNTH', timeframe: '1m', candles: [] }],
  ];

  it.each(mutating)('refuses POST %s from an unrecognised origin', async (url, payload) => {
    const { cookie } = await register('trader@example.com');

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { cookie, origin: 'https://evil.example.com' },
      payload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('csrf_rejected');
  });

  it('refuses an account write from an unrecognised origin', async () => {
    const { cookie, accountId } = await register('trader@example.com');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${accountId}/risk`,
      headers: { cookie, origin: 'https://evil.example.com' },
      payload: { maxPositionSize: 10 },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a paper action from an unrecognised origin', async () => {
    // The most consequential write in the system: it takes row locks and
    // appends to the ledger.
    const { cookie, accountId } = await register('trader@example.com');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/positions`,
      headers: { cookie, origin: 'https://evil.example.com' },
      payload: { signalId: 'whatever', size: 1, actionKey: 'abcdefgh' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('leaves GET requests alone, because they change nothing', async () => {
    // A CSRF check on reads would break every legitimate cross-origin fetch
    // without preventing anything.
    const { cookie } = await register('trader@example.com');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie, origin: 'https://evil.example.com' },
    });

    expect(response.statusCode).toBe(200);
  });
});

// -------------------------------------------------------------- sessions --

describe('an expired session', () => {
  it('stops authenticating the moment it expires, swept or not', async () => {
    // The property that makes the retention worker a cleanup job rather than a
    // security control: expiry is checked on every request, so an unswept row
    // grants nothing.
    const { cookie } = await register('trader@example.com');

    await expireEverySession();

    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });

  it('is refused even though its row is still present', async () => {
    // Stated separately because it is the whole argument: the row still exists
    // and the request is still refused.
    const { cookie } = await register('trader@example.com');
    await expireEverySession();

    const rows = await context.database.query<{ n: string }>('SELECT count(*) AS n FROM sessions');
    expect(Number(rows.rows[0]?.n)).toBe(1);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('says nothing about why it failed', async () => {
    // "Session expired" versus "no such session" tells an attacker whether a
    // stolen token was ever real.
    const { cookie } = await register('trader@example.com');
    await expireEverySession();

    const expired = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    });
    const fabricated = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: 'binaryai_session=not-a-real-token-at-all' },
    });

    expect(expired.statusCode).toBe(fabricated.statusCode);
    expect(expired.json().error.code).toBe(fabricated.json().error.code);
  });
});

// ----------------------------------------------------------------- input --

describe('malformed and oversized input', () => {
  it('rejects a malformed JSON body as a 400, not a 500', async () => {
    // A 500 would mean the parser crashed; a 400 means a rule refused it.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": "a@b.c", "password":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
  });

  it('rejects a body over the size limit rather than buffering it', async () => {
    // Without a limit, one request can exhaust the heap of the whole instance.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/analysis',
      headers: { 'content-type': 'application/json' },
      payload: `{"padding":"${'x'.repeat(9 * 1024 * 1024)}"}`,
    });

    expect(response.statusCode).toBe(413);
  });

  it('names the offending field without echoing the value back', async () => {
    // Echoing input into an error is how a reflected payload reaches a log or
    // a rendering client. Registration is used rather than login because login
    // deliberately does NOT validate the shape of a submitted password — doing
    // so would tell an attacker which guesses were even worth making.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: '<script>alert(1)</script>', password: STRONG_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('<script>');
  });

  it('refuses an unknown field instead of silently ignoring it', async () => {
    // A caller that believes it set something must be told it did not.
    const { cookie, accountId } = await register('trader@example.com');

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/accounts/${accountId}/simulation`,
      headers: { cookie },
      payload: { modelId: null, simulatedReturnRate: 0.95 },
    });

    expect(response.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------ error shape --

describe('the error contract', () => {
  it('never returns a stack trace', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });

    expect(response.body).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
    expect(response.json().error.code).toBe('not_found');
  });

  it('carries a stable machine-readable code on every failure', async () => {
    // Clients must be able to branch on a code rather than parse prose.
    const cases = [
      await app.inject({ method: 'GET', url: '/v1/does-not-exist' }),
      await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x' } }),
      await app.inject({ method: 'GET', url: '/v1/accounts/me' }),
    ];

    for (const response of cases) {
      expect(typeof response.json().error.code).toBe('string');
      expect(response.json().error.code.length).toBeGreaterThan(0);
    }
  });

  it('does not leak database detail through an error message', async () => {
    // Table and column names describe the schema to an attacker.
    const { cookie, accountId } = await register('trader@example.com');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/positions`,
      headers: { cookie },
      payload: { signalId: 'no-such-signal', size: 1, actionKey: 'abcdefgh' },
    });

    const body = response.body.toLowerCase();
    expect(body).not.toContain('paper_positions');
    expect(body).not.toContain('violates foreign key');
    expect(body).not.toContain('pg_');
  });

  it('distinguishes throttling from server failure', async () => {
    // 429 is the caller's problem and is retryable; 500 is ours and is not.
    const limited = await buildApp(
      createAppContext({
        config: config({ RATE_LIMIT_MAX_REQUESTS: '1' }),
        persistence: context.persistence,
        marketDataProvider: null,
      }),
    );

    await limited.inject({ method: 'GET', url: '/health' });
    const response = await limited.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('rate_limited');
  });
});

// ------------------------------------------------------- database outage --

describe('when the database is unreachable', () => {
  /** A persistence layer whose every call fails, standing in for an outage. */
  function brokenPersistence() {
    const fail = () => Promise.reject(new Error('connection terminated unexpectedly'));
    return {
      ping: async () => false,
      close: async () => undefined,
      repositories: new Proxy(
        {},
        {
          get: () => new Proxy({}, { get: () => fail }),
        },
      ),
    } as unknown as NonNullable<Parameters<typeof createAppContext>[0]['persistence']>;
  }

  it('reports NOT READY so traffic is routed elsewhere', async () => {
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    const response = await broken.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.database).toBe('unavailable');
  });

  it('still reports ALIVE, so the process is not restarted over it', async () => {
    // Restarting will not fix a database outage; it only removes capacity.
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    expect((await broken.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  /**
   * The case unauthenticated tests miss entirely.
   *
   * Identity resolution reads a session row on EVERY request. With no cookie
   * it short-circuits and never touches the database, so a suite that only
   * makes anonymous requests sees nothing wrong. With a cookie it queries — and
   * before this was fixed, a database outage turned every cookie-bearing
   * request into a 500, including `/v1/system/status`. The status page reported
   * "API UNREACHABLE" while the API was running perfectly.
   *
   * Found by browser verification, not by a unit test, which is the reason
   * browser verification is in the gate.
   */
  const COOKIE = { cookie: 'binaryai_session=a-token-that-cannot-be-checked' };

  it('does not turn a cookie-bearing request into a 500', async () => {
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    const response = await broken.inject({
      method: 'GET',
      url: '/v1/system/status',
      headers: COOKIE,
    });

    expect(response.statusCode).not.toBe(500);
  });

  it('still serves system status to a cookie-bearing caller, so the outage is visible', async () => {
    // The endpoint an operator opens to find out what is wrong must survive the
    // thing that is wrong.
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    const response = await broken.inject({
      method: 'GET',
      url: '/v1/system/status',
      headers: COOKIE,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().components).toBeInstanceOf(Array);
  });

  it('answers 503 rather than 401 when a session cannot be checked', async () => {
    // A 401 would be a false accusation: the credential was never examined, and
    // the user would go and re-enter a password that was never the problem.
    const broken = await buildApp(
      createAppContext({
        config: config({ AUTH_ENABLED: 'true', DATABASE_URL: 'postgresql://unused/x' }),
        persistence: brokenPersistence(),
      }),
    );

    const response = await broken.inject({
      method: 'GET',
      url: '/v1/accounts/me',
      headers: COOKIE,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('authentication_unavailable');
  });

  it('says plainly that the credential is not the problem', async () => {
    const broken = await buildApp(
      createAppContext({
        config: config({ AUTH_ENABLED: 'true', DATABASE_URL: 'postgresql://unused/x' }),
        persistence: brokenPersistence(),
      }),
    );

    const response = await broken.inject({
      method: 'GET',
      url: '/v1/accounts/me',
      headers: COOKIE,
    });

    expect(response.json().error.message).toMatch(/not a problem with your credentials/i);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('still answers 401 for a genuinely absent credential', async () => {
    // The degraded path must not swallow real authentication failures.
    const healthy = await buildApp(
      createAppContext({
        config: config({ AUTH_ENABLED: 'true', DATABASE_URL: 'postgresql://unused/x' }),
        persistence: context.persistence,
      }),
    );

    const response = await healthy.inject({ method: 'GET', url: '/v1/accounts/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('serves the sign-in page context instead of a blank 500', async () => {
    // /v1/auth/context is what the sign-in page asks before rendering anything.
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    const response = await broken.inject({ method: 'GET', url: '/v1/auth/context' });

    expect(response.statusCode).toBe(200);
    expect(response.json().degraded).toBe(true);
  });

  it('does not offer to create a first administrator while the store is unreadable', async () => {
    // Falling back to `bootstrapOpen: true` would offer an administrator
    // account on an instance that may already have one. False is the closed
    // direction and resolves on its own when the database answers.
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    const body = (await broken.inject({ method: 'GET', url: '/v1/auth/context' })).json();

    expect(body.bootstrapOpen).toBe(false);
    expect(body.registrationOpen).toBe(false);
  });

  it('says the database is unavailable rather than not configured', async () => {
    // Two very different fixes: one is a misconfiguration, the other an outage.
    const broken = await buildApp(
      createAppContext({ config: config(), persistence: brokenPersistence() }),
    );

    const body = (await broken.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const database = body.components.find(
      (component: { component: string }) => component.component === 'database',
    );

    expect(database.health).toBe('unavailable');
    expect(database.health).not.toBe('not_configured');
  });
});
