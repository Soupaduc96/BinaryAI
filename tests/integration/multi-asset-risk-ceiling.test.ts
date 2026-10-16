import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11C Step 4 — the account ceiling is ABSOLUTE.
 *
 * The rule this file exists to protect, stated as the gate stated it:
 *
 *   account maxOpenPositions = 2
 *   BTCUSD  maxOpenPositions = 2
 *   ETHUSD  maxOpenPositions = 2
 *
 *   The system must NEVER allow 4 total positions merely because each
 *   instrument has a limit of 2.
 *
 * Per-instrument limits CONSTRAIN each instrument; the account limit
 * constrains the whole account. They compose by narrowing, never by adding.
 * Every assertion below is checked against database state, not just the
 * response body, because the response is the thing that would be wrong if the
 * accounting were wrong.
 */

const MINUTE = 60_000;
const PASSWORD = 'Ceiling-Password-3310';
const ORIGIN = { origin: 'http://localhost:3000' };

let context: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
}, 60_000);

afterAll(async () => {
  await app?.close();
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

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies[0];
  return cookie ? `${cookie.name}=${cookie.value}` : '';
}

/** One accepted, unexpired signal on a REAL catalogue instrument. */
async function makeSignal(asset: string, index: number): Promise<string> {
  await context.database.query(
    `INSERT INTO strategies (strategy_key, version, name, description)
     VALUES ('trend-momentum', '1.0.0', 'T', 't') ON CONFLICT DO NOTHING`,
  );
  const strategy = await context.database.query<{ id: string }>(
    `SELECT id FROM strategies WHERE strategy_key = 'trend-momentum' LIMIT 1`,
  );
  const now = Date.now();
  const expiresAt = now + 30 * MINUTE;
  const decidedAt = now - 5 * MINUTE;
  const result = await context.database.query<{ id: string }>(
    `INSERT INTO signals (asset_symbol, timeframe, strategy_id, direction, status, market_regime,
                          confidence, price, decided_at, expires_at, expiration_seconds,
                          data_source, snapshot)
     VALUES ($1, '5m', $2, 'call', 'accepted', 'trend_up', 0.7, 100,
             to_timestamp($3::double precision / 1000),
             to_timestamp($4::double precision / 1000), 300, 'live_provider', $5::jsonb)
     RETURNING id`,
    [
      asset,
      strategy.rows[0]?.id,
      decidedAt,
      expiresAt,
      JSON.stringify({
        id: `sig_${asset}_${index}`,
        asset,
        timeframe: '5m',
        direction: 'call',
        status: 'accepted',
        price: 100,
        strategy: { id: 'trend-momentum', version: '1.0.0' },
        expiration: { seconds: 300, expiresAt },
        dataSource: 'live_provider',
      }),
    ],
  );
  return result.rows[0]?.id ?? '';
}

const open = (cookie: string, signalId: string, key: string, size = 1) =>
  app.inject({
    method: 'POST',
    url: '/v1/accounts/me/positions',
    headers: { cookie, ...ORIGIN },
    payload: { signalId, size, actionKey: key },
  });

const setPolicy = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/v1/accounts/me/risk',
    headers: { cookie, ...ORIGIN },
    payload,
  });

/** Open positions actually recorded, straight from the table. */
async function openCount(assetSymbol?: string): Promise<number> {
  const result = assetSymbol
    ? await context.database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM paper_positions
          WHERE status IN ('open','pending_settlement') AND asset_symbol = $1`,
        [assetSymbol],
      )
    : await context.database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM paper_positions
          WHERE status IN ('open','pending_settlement')`,
      );
  return Number(result.rows[0]?.n ?? 0);
}

describe('the account ceiling is absolute', () => {
  it('refuses a 3rd position when account=2 and each instrument allows 2', async () => {
    const cookie = await signUp('ceiling-absolute@p11c.local');
    await setPolicy(cookie, {
      limits: { maxOpenPositions: 2, maxExposureFraction: 0.9, maxConsecutiveLosses: 99 },
      perInstrument: { BTCUSD: { maxOpenPositions: 2 }, ETHUSD: { maxOpenPositions: 2 } },
    });

    const signals = [
      await makeSignal('BTCUSD', 1),
      await makeSignal('BTCUSD', 2),
      await makeSignal('ETHUSD', 1),
      await makeSignal('ETHUSD', 2),
    ];

    const statuses: number[] = [];
    for (const [index, signalId] of signals.entries()) {
      statuses.push((await open(cookie, signalId, `ceiling-${index}`)).statusCode);
    }

    // Two open, then the account rule stops everything — including the first
    // ETHUSD attempt, which its OWN instrument limit would have allowed.
    expect(statuses).toEqual([201, 201, 422, 422]);
    expect(await openCount()).toBe(2);
    expect(await openCount('BTCUSD')).toBe(2);
    expect(await openCount('ETHUSD')).toBe(0);
  });

  it('names the ACCOUNT rule when the account ceiling is what binds', async () => {
    const cookie = await signUp('ceiling-names@p11c.local');
    await setPolicy(cookie, {
      limits: { maxOpenPositions: 2, maxExposureFraction: 0.9, maxConsecutiveLosses: 99 },
      perInstrument: { BTCUSD: { maxOpenPositions: 2 }, ETHUSD: { maxOpenPositions: 2 } },
    });
    await open(cookie, await makeSignal('BTCUSD', 1), 'names-key-1');
    await open(cookie, await makeSignal('BTCUSD', 2), 'names-key-2');

    const blocked = await open(cookie, await makeSignal('ETHUSD', 1), 'names-key-3');
    const failed = (blocked.json().decision.evaluations as { code: string; passed: boolean }[])
      .filter((rule) => !rule.passed)
      .map((rule) => rule.code);

    // The refusal must say WHICH limit stopped it. "Blocked" without the rule
    // leaves a user editing the ETHUSD limit that was never the constraint.
    expect(failed).toContain('max_open_positions');
    expect(failed).not.toContain('instrument_max_open_positions');
  });

  it('lets the instrument limit bind first when it is the tighter one', async () => {
    const cookie = await signUp('ceiling-instrument@p11c.local');
    await setPolicy(cookie, {
      limits: { maxOpenPositions: 5, maxExposureFraction: 0.9, maxConsecutiveLosses: 99 },
      perInstrument: { BTCUSD: { maxOpenPositions: 1 } },
    });

    expect((await open(cookie, await makeSignal('BTCUSD', 1), 'inst-key-1')).statusCode).toBe(201);
    const blocked = await open(cookie, await makeSignal('BTCUSD', 2), 'inst-key-2');
    expect(blocked.statusCode).toBe(422);

    const failed = (blocked.json().decision.evaluations as { code: string; passed: boolean }[])
      .filter((rule) => !rule.passed)
      .map((rule) => rule.code);
    expect(failed).toContain('instrument_max_open_positions');

    // ETHUSD has no per-instrument limit, so the account ceiling still leaves
    // room: a limit on one instrument must not silently restrict another.
    expect((await open(cookie, await makeSignal('ETHUSD', 1), 'inst-key-3')).statusCode).toBe(201);
    expect(await openCount('BTCUSD')).toBe(1);
    expect(await openCount('ETHUSD')).toBe(1);
  });

  it('holds the ceiling under SIMULTANEOUS attempts', async () => {
    const cookie = await signUp('ceiling-concurrent@p11c.local');
    await setPolicy(cookie, {
      limits: { maxOpenPositions: 2, maxExposureFraction: 0.9, maxConsecutiveLosses: 99 },
      perInstrument: { BTCUSD: { maxOpenPositions: 2 }, ETHUSD: { maxOpenPositions: 2 } },
    });
    const signals = [
      await makeSignal('BTCUSD', 1),
      await makeSignal('BTCUSD', 2),
      await makeSignal('ETHUSD', 1),
      await makeSignal('ETHUSD', 2),
    ];

    // Fired together, not in sequence. A check-then-write race would let more
    // than two through here while every individual response still read 201.
    const responses = await Promise.all(
      signals.map((signalId, index) => open(cookie, signalId, `race-${index}`)),
    );
    const created = responses.filter((r) => r.statusCode === 201).length;

    expect(created).toBeLessThanOrEqual(2);
    // The database is the witness, not the response count.
    expect(await openCount()).toBeLessThanOrEqual(2);
    expect(await openCount()).toBe(created);
  });

  it('applies the exposure ceiling across instruments, not per instrument', async () => {
    const cookie = await signUp('ceiling-exposure@p11c.local');
    // maxDailyExposure is the ACCOUNT's absolute exposure ceiling over the
    // rolling window. Sizes stay within maxPositionSize (10) so that limit is
    // not what binds, and maxOpenPositions is high so position COUNT is not
    // what binds either — exposure must be the only thing under test.
    await setPolicy(cookie, {
      limits: { maxOpenPositions: 10, maxConsecutiveLosses: 99 },
      maxDailyExposure: 12,
    });

    const first = await open(cookie, await makeSignal('BTCUSD', 1), 'exp-key-1', 8);
    const second = await open(cookie, await makeSignal('ETHUSD', 1), 'exp-key-2', 8);

    // 8 + 8 = 16 exceeds the account's 12. Exposure is an ACCOUNT quantity:
    // spreading it over two instruments must not double it.
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(422);
    expect(await openCount()).toBe(1);
  });
});
