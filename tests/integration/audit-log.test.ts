import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * The security audit trail.
 *
 * Two questions, and the second matters as much as the first:
 *
 *  1. Is the security-relevant thing recorded at all? An account takeover that
 *     leaves no trace cannot be investigated afterwards.
 *  2. Is the record itself safe to keep? An audit table holding passwords,
 *     tokens or digests is a second copy of the credentials, usually with
 *     weaker access controls than the table it was copied from. Auditing must
 *     not become the leak.
 */

const STRONG_PASSWORD = 'correct-horse-battery-staple-7';
const OTHER_PASSWORD = 'a-different-decent-passphrase-91';

let context: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
  app = await buildApp(
    createAppContext({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        AUTH_ALLOW_REGISTRATION: 'true',
        AUTH_COOKIE_SECURE: 'false',
      }),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );
});

interface EventRow {
  [column: string]: unknown;
  code: string;
  level: string;
  message: string;
  context: unknown;
}

async function events(): Promise<EventRow[]> {
  const result = await context.database.query<EventRow>(
    `SELECT code, level, message, context FROM system_events
      WHERE category = 'auth' ORDER BY occurred_at ASC`,
  );
  return [...result.rows];
}

async function codes(): Promise<string[]> {
  return (await events()).map((event) => event.code);
}

async function register(email = 'trader@example.com'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: STRONG_PASSWORD },
  });
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).split(';')[0] ?? '';
}

async function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
}

describe('what gets recorded', () => {
  it('records a registration', async () => {
    await register();
    expect(await codes()).toContain('user_registered');
  });

  it('records a successful login', async () => {
    await register();
    await login('trader@example.com', STRONG_PASSWORD);
    expect(await codes()).toContain('login_succeeded');
  });

  it('records a failed login against a real account', async () => {
    // The signal that someone is being targeted.
    await register();
    await login('trader@example.com', 'wrong-password-entirely');

    const failure = (await events()).find((event) => event.code === 'login_failed');
    expect(failure).toBeDefined();
    expect(failure?.level).toBe('warning');
  });

  it('records a failed login against an account that does not exist', async () => {
    // Credential stuffing shows up here first: many attempts, no such user.
    await login('nobody@example.com', 'whatever-they-guessed');
    expect(await codes()).toContain('login_failed');
  });

  it('records a lockout separately from the failure that caused it', async () => {
    // A lockout is an event an operator may need to explain to a user; burying
    // it inside the failure it followed makes it invisible.
    await register();
    for (let i = 0; i < 12; i += 1) {
      await login('trader@example.com', `guess-${i}`);
    }
    expect(await codes()).toContain('account_locked');
  });

  it('records a logout', async () => {
    const cookie = await register();
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(await codes()).toContain('session_revoked');
  });

  it('records a global session revocation with the number revoked', async () => {
    const cookie = await register();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-all',
      headers: { cookie },
    });

    const revocation = (await events()).find((event) => event.code === 'sessions_revoked_all');
    expect(revocation).toBeDefined();
    expect(JSON.stringify(revocation?.context)).toMatch(/"revoked":\s*\d+/);
  });

  it('records a password change as a warning, not as routine information', async () => {
    // It invalidates every session and is the last step of an account
    // takeover. It should stand out in a log.
    const cookie = await register();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: OTHER_PASSWORD },
    });

    const changed = (await events()).find((event) => event.code === 'password_changed');
    expect(changed?.level).toBe('warning');
  });

  it('records a password change attempt with the wrong current password', async () => {
    // Distinct from a failed login: this is an already-authenticated session
    // failing to prove it knows the password, which is what a hijacked session
    // looks like.
    const cookie = await register();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'not-the-current-one', newPassword: OTHER_PASSWORD },
    });

    expect(await codes()).toContain('password_change_failed');
  });
});

describe('what must never be recorded', () => {
  it('never stores a password', async () => {
    await register();
    await login('trader@example.com', STRONG_PASSWORD);
    await login('trader@example.com', 'a-wrong-password-value');
    const cookie = await register('second@example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: OTHER_PASSWORD },
    });

    const serialized = JSON.stringify(await events());
    expect(serialized).not.toContain(STRONG_PASSWORD);
    expect(serialized).not.toContain(OTHER_PASSWORD);
    expect(serialized).not.toContain('a-wrong-password-value');
  });

  it('never stores an Argon2 digest', async () => {
    await register();
    await login('trader@example.com', STRONG_PASSWORD);

    expect(JSON.stringify(await events())).not.toContain('$argon2');
  });

  it('never stores a session token', async () => {
    // The token is the credential. Only its digest is stored, in `sessions`,
    // and neither belongs in an event.
    const cookie = await register();
    const token = cookie.split('=')[1] ?? '';
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });

    expect(token.length).toBeGreaterThan(16);
    expect(JSON.stringify(await events())).not.toContain(token);
  });

  it('does not store the email submitted for an account that does not exist', async () => {
    // An unauthenticated caller can put any string here. It may be a third
    // party's real address typed by mistake, and an audit table is a poor
    // place for unvalidated input from strangers to accumulate. `userId` --
    // recorded when the account is real -- answers the operational question
    // without it.
    await login('someone-elses-address@example.com', 'guess');

    expect(JSON.stringify(await events())).not.toContain('someone-elses-address@example.com');
  });

  it('records the user id for a failed login against a REAL account', async () => {
    // Without this, "who is being attacked" would be unanswerable.
    await register();
    await login('trader@example.com', 'wrong');

    const failure = (await events()).find(
      (event) => event.code === 'login_failed' && JSON.stringify(event.context).includes('userId'),
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.context)).not.toContain('"userId":null');
  });
});

describe('auditing never breaks the request', () => {
  it('still logs the user out when the event cannot be written', async () => {
    // Auditing is observability, not authorisation. If a failed write threw,
    // an unreachable database would stop people logging OUT -- the opposite of
    // safe.
    //
    // The table is RENAMED rather than dropped, and restored in a `finally`.
    // Dropping it was the original approach and it was wrong in a way only a
    // real server revealed: `migrate()` applies PENDING migrations, and the
    // ledger still listed 0001 as applied, so the table was never recreated.
    // Against PGlite every test file gets its own database and the damage was
    // invisible; against one shared PostgreSQL server it destroyed the table
    // for every file that ran afterwards, failing 13 unrelated tests.
    const cookie = await register();
    await context.database.query('ALTER TABLE system_events RENAME TO system_events_hidden');

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await context.database.query('ALTER TABLE system_events_hidden RENAME TO system_events');
    }
  });
});
