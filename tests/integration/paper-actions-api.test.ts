import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Paper position creation and limit enforcement through the real API.
 *
 * The properties under test are the ones a user could otherwise bypass: a limit
 * that must bind at the BACKEND, and a refusal that must leave no position and
 * no ledger entry behind.
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

const setPolicy = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/v1/accounts/me/risk',
    headers: { cookie, ...ORIGIN },
    payload,
  });

describe('opening a position', () => {
  it('creates one when the policy permits it', async () => {
    const alice = await signUp('alice@example.com');
    const response = await openPosition(alice.cookie);

    expect(response.statusCode).toBe(201);
    expect(response.json().position.status).toBe('open');
    expect(response.json().decision.allowed).toBe(true);
    expect(response.json().position.result).toBeNull();
  });

  it('commits exposure against the ledger', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie, { size: 7 });

    const ledger = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/ledger',
        headers: { cookie: alice.cookie },
      })
    ).json();

    expect(ledger.state.committedUnits).toBe(7);
    expect(ledger.state.availableUnits).toBe(93);
    expect(ledger.entries.some((e: { type: string }) => e.type === 'exposure_committed')).toBe(
      true,
    );
  });

  it('rejects a malformed size before it reaches the engine', async () => {
    const alice = await signUp('alice@example.com');
    for (const size of [0, -1, -0.5]) {
      const response = await openPosition(alice.cookie, { size });
      expect(response.statusCode, `size ${size}`).toBe(400);
    }
  });

  it('rejects a non-numeric size', async () => {
    const alice = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts/me/positions',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: { signalId, size: 'lots', actionKey: 'action-key-0001' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to act on a rejected signal', async () => {
    const alice = await signUp('alice@example.com');
    const rejected = await makeSignal({ status: 'rejected' });

    const response = await openPosition(alice.cookie, { signalId: rejected });
    expect(response.statusCode).toBe(422);
    expect(response.json().decision.blockedBy).toContain('signal_actionable');

    // And no position exists.
    const positions = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/positions',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(positions.positions).toEqual([]);
  });

  it('refuses to act on an expired signal', async () => {
    const alice = await signUp('alice@example.com');
    const expired = await makeSignal({ expiresInMs: -MINUTE });
    expect((await openPosition(alice.cookie, { signalId: expired })).statusCode).toBe(422);
  });

  it('reports insufficient context for an unknown signal', async () => {
    const alice = await signUp('alice@example.com');
    const response = await openPosition(alice.cookie, {
      signalId: '00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().decision.outcome).toBe('insufficient_context');
  });
});

describe('limit enforcement', () => {
  it('blocks the second position when the limit is one', async () => {
    const alice = await signUp('alice@example.com');
    expect((await openPosition(alice.cookie, { actionKey: 'first-action-x' })).statusCode).toBe(
      201,
    );

    const second = await openPosition(alice.cookie, { actionKey: 'second-action-x' });

    // The BACKEND refuses. A disabled button is not a control.
    expect(second.statusCode).toBe(422);
    expect(second.json().decision.outcome).toBe('limit_reached');
    expect(second.json().decision.blockedBy).toContain('max_open_positions');
  });

  it('explains the refusal with the observed value and the limit', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie, { actionKey: 'first-action-x' });
    const second = await openPosition(alice.cookie, { actionKey: 'second-action-x' });

    const rule = second
      .json()
      .decision.evaluations.find((r: { code: string }) => r.code === 'max_open_positions');
    expect(rule.observed).toBe(1);
    expect(rule.limit).toBe(1);
  });

  it('creates no position and no ledger entry when blocked', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie, { actionKey: 'first-action-x' });
    await openPosition(alice.cookie, { actionKey: 'second-action-x' });

    const ledger = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/ledger',
        headers: { cookie: alice.cookie },
      })
    ).json();
    // One allocation + one commit. A blocked action must leave no trace in the
    // accounting.
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.state.committedUnits).toBe(5);
  });

  it('records a risk event for the refusal', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie, { actionKey: 'first-action-x' });
    await openPosition(alice.cookie, { actionKey: 'second-action-x' });

    const events = (
      await app.inject({
        method: 'GET',
        url: '/v1/accounts/me/risk-events',
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(events.events.some((e: { code: string }) => e.code === 'max_open_positions')).toBe(true);
  });

  it('allows more positions after the limit is raised', async () => {
    const alice = await signUp('alice@example.com');
    await openPosition(alice.cookie, { actionKey: 'first-action-x' });
    expect((await openPosition(alice.cookie, { actionKey: 'second-action-x' })).statusCode).toBe(
      422,
    );

    await setPolicy(alice.cookie, { limits: { maxOpenPositions: 3 } });
    expect((await openPosition(alice.cookie, { actionKey: 'third-action-xx' })).statusCode).toBe(
      201,
    );
  });

  it('enforces the maximum position size', async () => {
    const alice = await signUp('alice@example.com');
    await setPolicy(alice.cookie, { maxPositionSize: 3 });

    const response = await openPosition(alice.cookie, { size: 4 });
    expect(response.statusCode).toBe(422);
    expect(response.json().decision.blockedBy).toContain('max_position_size');
  });

  it('enforces an asset allowlist', async () => {
    const alice = await signUp('alice@example.com');
    await setPolicy(alice.cookie, { allowedAssets: ['ETH-USD'] });

    const response = await openPosition(alice.cookie);
    expect(response.statusCode).toBe(422);
    expect(response.json().decision.blockedBy).toContain('asset_allowed');
  });

  it('an empty allowlist blocks everything', async () => {
    const alice = await signUp('alice@example.com');
    await setPolicy(alice.cookie, { allowedTimeframes: [] });
    expect((await openPosition(alice.cookie)).statusCode).toBe(422);
  });

  it('cannot be bypassed by sending limits in the request', async () => {
    const alice = await signUp('alice@example.com');
    await setPolicy(alice.cookie, { maxPositionSize: 3 });

    // There is no field for it, so the strict schema refuses outright -- the
    // policy cannot be overridden per request under any spelling.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts/me/positions',
      headers: { cookie: alice.cookie, ...ORIGIN },
      payload: {
        signalId,
        size: 50,
        actionKey: 'bypass-attempt-1',
        maxPositionSize: 100,
        policy: { maxPositionSize: 100 },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * Instrument identity on paper positions.
 *
 * Multi-asset support makes a previously theoretical bug reachable: with one
 * instrument, "which instrument is this position on" had exactly one possible
 * answer. With thirty-six it does not, and a position that reported the wrong
 * one would misattribute exposure, settlement and every ledger entry behind it.
 *
 * Nothing about risk or settlement semantics changes here — these tests assert
 * that the instrument travels correctly through machinery that already worked.
 */
describe('instrument identity', () => {
  it('takes the position instrument from the SIGNAL, never from the request', async () => {
    // The client sends a signal id and a size. It does not get to name an
    // instrument, so it cannot open an ETH position against a BTC signal.
    const user = await signUp('identity-source@example.com');
    const ethSignal = await makeSignal({ asset: 'ETHUSD' });

    const response = await openPosition(user.cookie, {
      signalId: ethSignal,
      actionKey: 'identity-source',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().position.assetSymbol).toBe('ETHUSD');
  });

  it('keeps two instruments' + ' apart on the same account', async () => {
    const user = await signUp('identity-two@example.com');
    await setPolicy(user.cookie, { limits: { maxOpenPositions: 5 } });

    const btc = await makeSignal({ asset: 'BTCUSD' });
    const eth = await makeSignal({ asset: 'ETHUSD' });
    const gold = await makeSignal({ asset: 'XAUUSD' });

    for (const [signal, key] of [
      [btc, 'identity-two-btc'],
      [eth, 'identity-two-eth'],
      [gold, 'identity-two-gold'],
    ] as const) {
      const created = await openPosition(user.cookie, { signalId: signal, actionKey: key });
      expect(created.statusCode).toBe(201);
    }

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/positions',
      headers: { cookie: user.cookie },
    });

    const positions = listed.json().positions as { assetSymbol: string; signalId: string }[];
    const symbols = positions.map((position) => position.assetSymbol).sort();
    expect(symbols).toEqual(['BTCUSD', 'ETHUSD', 'XAUUSD']);

    // Each position points at its OWN signal. A shared or swapped signal id is
    // how a BTC position starts settling against a gold price.
    expect(new Set(positions.map((position) => position.signalId)).size).toBe(3);
  });

  it('does not let an idempotency key collide across instruments', async () => {
    // The unique index is (account, signal, action_key). The same key on two
    // DIFFERENT signals is two distinct actions and both must commit —
    // otherwise a client retrying with a stable key could never open a second
    // instrument's position.
    const user = await signUp('identity-key@example.com');
    await setPolicy(user.cookie, { limits: { maxOpenPositions: 5 } });

    const btc = await makeSignal({ asset: 'BTCUSD' });
    const eth = await makeSignal({ asset: 'ETHUSD' });

    const first = await openPosition(user.cookie, { signalId: btc, actionKey: 'shared-key' });
    const second = await openPosition(user.cookie, { signalId: eth, actionKey: 'shared-key' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().position.assetSymbol).toBe('BTCUSD');
    expect(second.json().position.assetSymbol).toBe('ETHUSD');
  });

  it('attributes each ledger entry to its own position', async () => {
    // The ledger reaches an instrument only through position_id. This is the
    // assertion that the link is per-position rather than per-account.
    const user = await signUp('identity-ledger@example.com');
    await setPolicy(user.cookie, { limits: { maxOpenPositions: 5 } });

    const btc = await makeSignal({ asset: 'BTCUSD' });
    const eth = await makeSignal({ asset: 'ETHUSD' });

    const btcPosition = (
      await openPosition(user.cookie, { signalId: btc, actionKey: 'ledger-btc', size: 5 })
    ).json().position;
    const ethPosition = (
      await openPosition(user.cookie, { signalId: eth, actionKey: 'ledger-eth', size: 7 })
    ).json().position;

    const rows = await context.database.query<{
      asset_symbol: string;
      amount: string;
    }>(
      `SELECT p.asset_symbol, l.amount
         FROM paper_ledger_entries l
         JOIN paper_positions p ON p.id = l.position_id
        WHERE l.account_id = $1 AND l.type = 'exposure_committed'
        ORDER BY p.asset_symbol`,
      [user.accountId],
    );

    expect(rows.rows.map((row) => row.asset_symbol)).toEqual(['BTCUSD', 'ETHUSD']);
    // Sizes are not swapped between them.
    expect(Number(rows.rows[0]?.amount)).toBe(-5);
    expect(Number(rows.rows[1]?.amount)).toBe(-7);
    expect(btcPosition.assetSymbol).toBe('BTCUSD');
    expect(ethPosition.assetSymbol).toBe('ETHUSD');
  });

  it('enforces the asset allowlist against the resolved instrument', async () => {
    // The allowlist is a risk control, and it must be applied to the
    // instrument the SIGNAL names — not to anything the caller supplies.
    const user = await signUp('identity-allow@example.com');
    await setPolicy(user.cookie, { allowedAssets: ['BTCUSD'] });

    const eth = await makeSignal({ asset: 'ETHUSD' });
    const blocked = await openPosition(user.cookie, {
      signalId: eth,
      actionKey: 'identity-allow-eth',
    });
    expect(blocked.statusCode).toBe(422);

    const btc = await makeSignal({ asset: 'BTCUSD' });
    const allowed = await openPosition(user.cookie, {
      signalId: btc,
      actionKey: 'identity-allow-btc',
    });
    expect(allowed.statusCode).toBe(201);
  });
});
