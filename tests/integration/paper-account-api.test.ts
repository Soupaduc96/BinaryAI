import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Paper position idempotency, isolation and terminology through the real API.
 *
 * Companion to paper-actions-api.test.ts, which covers creation and limits.
 */

const PASSWORD = 'correct-horse-battery-staple-7';
const ORIGIN = { origin: 'http://localhost:3000' };
const MINUTE = 60_000;

let context: TestDatabase;
let app: FastifyInstance;
let signalId = '';

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
  signalId = await makeSignal();
});

/** An accepted, directional, unexpired signal with a real strategy row. */
async function makeSignal(
  options: { status?: string; direction?: string; expiresInMs?: number; asset?: string } = {},
): Promise<string> {
  await context.database.query(
    `INSERT INTO strategies (strategy_key, version, name, description)
     VALUES ('trend-momentum', '1.0.0', 'T', 't') ON CONFLICT DO NOTHING`,
  );
  const strategy = await context.database.query<{ id: string }>(
    `SELECT id FROM strategies WHERE strategy_key = 'trend-momentum' LIMIT 1`,
  );
  const now = Date.now();
  const expiresAt = now + (options.expiresInMs ?? 30 * MINUTE);
  // decided_at must precede expires_at (signals_expiry_after_decision), so an
  // "already expired" fixture is built by moving the DECISION back rather than
  // by moving expiry before it.
  const decidedAt = Math.min(now, expiresAt - 5 * MINUTE);
  const result = await context.database.query<{ id: string }>(
    `INSERT INTO signals (asset_symbol, timeframe, strategy_id, direction, status, market_regime,
                          confidence, price, decided_at, expires_at, expiration_seconds,
                          data_source, snapshot)
     VALUES ($1, '5m', $2, $3::signal_direction, $4::signal_status, 'trend_up', 0.7, 100,
             to_timestamp($5::double precision / 1000),
             to_timestamp($6::double precision / 1000), 300, 'live_provider', $7::jsonb)
     RETURNING id`,
    [
      options.asset ?? 'BTC-USD',
      strategy.rows[0]?.id,
      options.direction ?? 'call',
      options.status ?? 'accepted',
      decidedAt,
      expiresAt,
      // findById requires a replayable snapshot; this mirrors what the engine
      // stores so the paper service can read the candidate back.
      JSON.stringify({
        id: `sig_${Math.random().toString(16).slice(2)}`,
        asset: options.asset ?? 'BTC-USD',
        timeframe: '5m',
        direction: options.direction ?? 'call',
        status: options.status ?? 'accepted',
        price: 100,
        strategy: { id: 'trend-momentum', version: '1.0.0' },
        expiration: { seconds: 300, expiresAt },
        dataSource: 'live_provider',
      }),
    ],
  );
  return result.rows[0]?.id ?? '';
}

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

const openPosition = (
  cookie: string,
  payload: { signalId?: string; size?: number; actionKey?: string } = {},
) =>
  app.inject({
    method: 'POST',
    url: '/v1/accounts/me/positions',
    headers: { cookie, ...ORIGIN },
    payload: {
      signalId: payload.signalId ?? signalId,
      size: payload.size ?? 5,
      actionKey: payload.actionKey ?? 'action-key-0001',
    },
  });

describe('idempotency', () => {
  it('returns the same position for a repeated action key', async () => {
    const alice = await signUp('alice@example.com');
    const first = await openPosition(alice.cookie, { actionKey: 'retry-key-0001' });
    const second = await openPosition(alice.cookie, { actionKey: 'retry-key-0001' });

    expect(first.statusCode).toBe(201);
    // 200, not 201: nothing was created the second time.
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().position.id).toBe(first.json().position.id);
  });

  it('commits exposure only once for a repeated action', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie, { actionKey: 'retry-key-0001', size: 6 });
    await openPosition(alice.cookie, { actionKey: 'retry-key-0001', size: 6 });

    const ledger = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/ledger',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(ledger.state.committedUnits).toBe(6);
  });

  it('requires an action key long enough to be meaningful', async () => {
    const alice = await signUp('alice@example.com');
    const response = await openPosition(alice.cookie, { actionKey: 'short' });
    expect(response.statusCode).toBe(400);
  });
});

describe('account isolation', () => {
  it('never lists another account’s positions', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await openPosition(alice.cookie);

    const bobPositions = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/positions',
        headers: { cookie: bob.cookie },
      })
    ).json();
    expect(bobPositions.positions).toEqual([]);
  });

  it('never returns another account’s position by id', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const created = await openPosition(alice.cookie);
    const positionId = created.json().position.id;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/me/positions/${positionId}`,
      headers: { cookie: bob.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to cancel another account’s position', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const positionId = (await openPosition(alice.cookie)).json().position.id;

    const response = await app.inject({
      method: 'POST',
      url: `/v1/accounts/me/positions/${positionId}/cancel`,
      headers: { cookie: bob.cookie, ...ORIGIN },
    });
    expect(response.statusCode).toBe(409);

    // Alice's position is untouched.
    const mine = (
      await app.inject({
        method: 'GET',
        url: `/v1/accounts/me/positions/${positionId}`,
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(mine.position.status).toBe('open');
  });

  it('one account’s limit does not constrain another', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await openPosition(alice.cookie, { actionKey: 'alice-action-1' });

    // Alice is at her limit; Bob is not.
    expect((await openPosition(alice.cookie, { actionKey: 'alice-action-2' })).statusCode).toBe(
      422,
    );
    expect((await openPosition(bob.cookie, { actionKey: 'bob-action-1x' })).statusCode).toBe(201);
  });
});

describe('risk evaluation dry run', () => {
  it('reports a decision without creating anything', async () => {
    const alice = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts/me/risk/evaluate',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { signalId, size: 5 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision.allowed).toBe(true);

    const positions = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/positions',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(positions.positions).toEqual([]);
  });
});

describe('terminology', () => {
  /**
   * Finds uses of a sensitive word that are NOT inside a denial.
   *
   * "no payout applies to any outcome" is exactly the sentence these payloads
   * should carry; "payout: 0.8" is the one that must never ship. A plain
   * substring ban cannot tell them apart, and banning the word outright would
   * push the disclaimer out of the response.
   */
  function affirmativeUses(raw: string, word: string): string[] {
    const found: string[] = [];
    for (let i = raw.indexOf(word); i !== -1; i = raw.indexOf(word, i + 1)) {
      const preceding = raw.slice(Math.max(0, i - 30), i);
      if (!/(?:^|[^a-z])(no|not|never|nor)(?![a-z])[^.;]*$/.test(preceding)) {
        found.push(raw.slice(Math.max(0, i - 50), i + word.length + 20));
      }
    }
    return found;
  }

  it('never presents a position as a real trade or a profit', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie);

    // Words with no innocent reading in this domain.
    const banned = /guaranteed|pnl|order id/;
    // Words that legitimately appear inside a disclaimer -- "BinaryAI has no
    // broker terms" is precisely the sentence these payloads should carry.
    const claimOnly = ['profit', 'payout', 'broker'];

    for (const url of ['/v1/accounts/me/positions', '/v1/accounts/me/ledger', '/v1/accounts/me']) {
      const raw = (
        await app.inject({ method: 'GET', url, headers: { cookie: alice.cookie } })
      ).body.toLowerCase();
      expect(raw, url).not.toMatch(banned);
      for (const word of claimOnly) {
        expect(affirmativeUses(raw, word).join(' | '), `${url} asserts "${word}"`).toBe('');
      }
    }
  });

  it('states that positions are simulated', async () => {
    const alice = await signUp('alice@example.com');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/positions',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(body.accounting).toMatch(/simulated/i);
    expect(body.accounting).toMatch(/no order was placed/i);
  });
});
