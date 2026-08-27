import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Account and risk-policy endpoints through the real API.
 *
 * The questions these answer: can a caller touch an account that is not theirs,
 * can they see whether one exists, and can they loosen a limit by asking nicely.
 */

const PASSWORD = 'correct-horse-battery-staple-7';
const ORIGIN = { origin: 'http://localhost:3000' };

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
  await context.database.query('TRUNCATE TABLE paper_ledger_entries, paper_positions CASCADE');
  app = await buildApp(
    createAppContext({
      config: config(),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );
});

async function signUp(email: string): Promise<{ cookie: string; accountId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies[0];
  return {
    cookie: cookie ? `${cookie.name}=${cookie.value}` : '',
    accountId: response.json().account.id,
  };
}

const ACCOUNT_ROUTES = (id: string) => [
  `/v1/accounts/${id}`,
  `/v1/accounts/${id}/risk`,
  `/v1/accounts/${id}/positions`,
  `/v1/accounts/${id}/ledger`,
  `/v1/accounts/${id}/risk-events`,
];

// ---------------------------------------------------------- provisioning --

describe('account provisioning', () => {
  it('gives a new user a funded paper account', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({ method: 'GET', url: '/v1/accounts/me', headers: { cookie: alice.cookie } })
    ).json();

    expect(body.account.kind).toBe('paper');
    expect(body.account.mode).toBe('demo');
    expect(body.paper.accountingModel).toBe('exposure_only');
    expect(body.paper.allocatedUnits).toBe(100);
    expect(body.paper.availableUnits).toBe(100);
  });

  it('states that units are not money', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({ method: 'GET', url: '/v1/accounts/me', headers: { cookie: alice.cookie } })
    ).json();

    // The accounting note travels with every units figure so no reader takes
    // them for a balance.
    expect(body.paper.accountingNote).toMatch(/not currency/i);
    expect(body.paper.unit).toBe('paper unit');
  });

  it('gives a new account a valid policy immediately', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk',
        headers: { cookie: alice.cookie },
      })
    ).json();

    expect(body.policy.version).toBe(1);
    expect(body.policy.limits.maxOpenPositions).toBeGreaterThan(0);
    expect(body.policy.limits.allowLiveExecution).toBe(false);
    // Null, not [] -- a new account that could act on nothing would look broken.
    expect(body.policy.allowedAssets).toBeNull();
  });

  it('says the limits are enforced, not advisory', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(body.enforcement).toMatch(/not advisory/i);
  });
});

// --------------------------------------------------------- authorization --

describe('authorization', () => {
  it('refuses every account route without a session', async () => {
    const alice = await signUp('alice@example.com');
    for (const url of ACCOUNT_ROUTES(alice.accountId)) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} must require a session`).toBe(401);
    }
  });

  it('returns 404, not 403, for another user’s account', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    for (const url of ACCOUNT_ROUTES(alice.accountId)) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: bob.cookie } });
      // A 403 would confirm the id exists and turn this into an enumeration
      // oracle. "Not yours" and "does not exist" must be indistinguishable.
      expect(response.statusCode, `${url} must be 404 for a foreign account`).toBe(404);
      expect(response.json().error.code).toBe('account_not_found');
    }
  });

  it('gives the same response for a foreign account and a nonexistent one', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${alice.accountId}`,
      headers: { cookie: bob.cookie },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/accounts/00000000-0000-0000-0000-000000000000',
      headers: { cookie: bob.cookie },
    });

    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
    expect(foreign.json().error.message).toBe(missing.json().error.message);
  });

  it('refuses to modify another user’s policy', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${alice.accountId}/risk`,
      headers: { cookie: bob.cookie, ...ORIGIN },
      payload: { maxPositionSize: 999 },
    });
    expect(response.statusCode).toBe(404);

    // And Alice's policy is untouched.
    const alicePolicy = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(alicePolicy.policy.maxPositionSize).toBe(10);
  });

  it('refuses a machine token on account routes', async () => {
    const guarded = await buildApp(
      createAppContext({
        config: config({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'a-machine-token-value' }),
        persistence: context.persistence,
        marketDataProvider: null,
      }),
    );
    const response = await guarded.inject({
      method: 'GET',
      url: '/v1/accounts/me',
      headers: { authorization: 'Bearer a-machine-token-value' },
    });

    // A shared token has no user behind it, so it cannot own an account.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('user_required');
  });

  it('resolves "me" without the caller ever holding an id', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({ method: 'GET', url: '/v1/accounts/me', headers: { cookie: alice.cookie } })
    ).json();
    expect(body.account.id).toBe(alice.accountId);
  });
});

// --------------------------------------------------------- policy update --

describe('policy updates', () => {
  it('applies an update and bumps the version', async () => {
    const alice = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { maxPositionSize: 5, limits: { maxOpenPositions: 3 } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().policy.version).toBe(2);
    expect(response.json().policy.maxPositionSize).toBe(5);
    expect(response.json().policy.limits.maxOpenPositions).toBe(3);
  });

  it('persists the update across requests', async () => {
    const alice = await signUp('alice@example.com');
    await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { maxPositionSize: 7 },
    });

    const reread = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(reread.policy.maxPositionSize).toBe(7);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const alice = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { maxPositionSize: 5, somethingElse: true },
    });

    // A silently ignored field is how a caller comes to believe it set
    // something it did not.
    expect(response.statusCode).toBe(400);
  });

  it('offers no way to enable live execution', async () => {
    const alice = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { limits: { allowLiveExecution: true } },
    });

    // The schema is strict, so the field is a validation error rather than
    // being quietly dropped.
    expect(response.statusCode).toBe(400);

    const policy = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(policy.policy.limits.allowLiveExecution).toBe(false);
  });

  it('rejects a malformed numeric limit', async () => {
    const alice = await signUp('alice@example.com');
    for (const payload of [
      { maxPositionSize: -1 },
      { maxPositionSize: 0 },
      { limits: { maxOpenPositions: -3 } },
      { limits: { minConfidence: 2 } },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/accounts/me/risk',
        headers: { cookie: alice.cookie, ...ORIGIN },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('distinguishes clearing an allowlist from emptying it', async () => {
    const alice = await signUp('alice@example.com');

    const emptied = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { allowedAssets: [] },
    });
    expect(emptied.json().policy.allowedAssets).toEqual([]);

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { allowedAssets: null },
    });
    expect(cleared.json().policy.allowedAssets).toBeNull();
  });

  it('records a risk event for every policy change', async () => {
    const alice = await signUp('alice@example.com');
    await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { maxPositionSize: 5 },
    });

    const events = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk-events',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(events.events.some((e: { code: string }) => e.code === 'limits_updated')).toBe(true);
  });

  it('never leaks a session token or password into a risk event', async () => {
    const alice = await signUp('alice@example.com');
    await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { maxPositionSize: 5 },
    });

    const raw = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk-events',
        headers: { cookie: alice.cookie },
      })
    ).body;
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(alice.cookie.split('=')[1]);
  });

  it('treats a policy value as data, never as SQL', async () => {
    const alice = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie: alice.cookie, ...ORIGIN },
      // Kept within the 32-character asset bound so the value actually reaches
      // the query rather than being rejected on length first.
      payload: { allowedAssets: ["BTC'; DROP TABLE users; --"] },
    });

    expect(response.statusCode).toBe(200);
    const survived = await context.database.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = 'users'",
    );
    expect(Number(survived.rows[0]?.count)).toBe(1);
  });
});

// --------------------------------------------------------------- ledger --

describe('ledger', () => {
  it('shows the initial allocation and nothing else', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/ledger',
        headers: { cookie: alice.cookie },
      })
    ).json();

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].type).toBe('initial_allocation');
    expect(body.entries[0].amount).toBe(100);
    expect(body.state.availableUnits).toBe(100);
  });

  it('never exposes another account’s ledger', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${alice.accountId}/ledger`,
      headers: { cookie: bob.cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
