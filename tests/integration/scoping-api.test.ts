import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import { syntheticUptrend } from '@binaryai/fixtures';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Per-user data isolation.
 *
 * This file answers one question in as many ways as it can: can one user reach
 * another user's data? Every test here describes a specific route by which
 * that could happen -- a list query, a direct id lookup, a write against
 * someone else's row, a machine token standing in for a person.
 *
 * The ownership model under test (docs/adr/0011-ownership-model.md):
 *
 *   account_id IS NULL  ->  system signal, the shared analysis stream,
 *                           readable by every authenticated user
 *   account_id = X      ->  owned by account X and private to it
 */

const PASSWORD = 'correct-horse-battery-staple-7';

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

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies[0];
  return cookie ? `${cookie.name}=${cookie.value}` : '';
}

/** Runs the real decision pipeline and stores the result for this caller. */
/**
 * Logical test identities mapped to REAL catalogue instruments.
 *
 * These tests use a distinct symbol per caller to prove that ownership — not
 * the instrument — is what scopes a signal. Persisting now requires a catalogue
 * instrument (D1), so each logical name maps to a real one. The candles remain
 * synthetic and are still labelled as such.
 */
const SCOPE_INSTRUMENT: Record<string, string> = {
  SCOPE: 'BTCUSD',
  ALICE: 'ETHUSD',
  BOB: 'EURUSD',
};

async function evaluateAndStore(cookie: string | null, symbol = 'SCOPE'): Promise<string | null> {
  const series = { ...syntheticUptrend(300), asset: SCOPE_INSTRUMENT[symbol] ?? 'BTCUSD' };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/signals/evaluate',
    ...(cookie === null ? {} : { headers: { cookie, origin: 'http://localhost:3000' } }),
    payload: {
      strategyId: 'trend-momentum',
      persist: true,
      // No caller-supplied : it is no longer trusted, and the series
      // symbol is what the server resolves through the catalogue.
      series: {
        asset: series.asset,
        timeframe: series.timeframe,
        source: series.source,
        candles: series.candles,
      },
    },
  });
  const body = response.json();
  return body.persistence?.stored === true ? body.persistence.id : null;
}

async function listSignals(cookie: string): Promise<{ ids: string[]; total: number }> {
  const response = await app.inject({ method: 'GET', url: '/v1/signals', headers: { cookie } });
  const body = response.json();
  return { ids: body.signals.map((s: { id: string }) => s.id), total: body.total };
}

describe('signal ownership', () => {
  it('attributes a stored evaluation to the caller who asked for it', async () => {
    const cookie = await signUp('alice@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {
        strategyId: 'trend-momentum',
        persist: true,
        series: (() => {
          const series = syntheticUptrend(300);
          return {
            asset: SCOPE_INSTRUMENT['SCOPE'],
            timeframe: series.timeframe,
            source: series.source,
            candles: series.candles,
          };
        })(),
      },
    });

    expect(response.json().persistence.stored).toBe(true);
    expect(response.json().persistence.owner).toBe('account');
  });

  it('records an unauthenticated evaluation as a system signal', async () => {
    // Auth is disabled in this configuration, so there is no owner to attach.
    // The signal joins the shared stream rather than being silently assigned
    // to whichever account happens to be first.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: {
        strategyId: 'trend-momentum',
        persist: true,
        series: (() => {
          const series = syntheticUptrend(300);
          return {
            asset: SCOPE_INSTRUMENT['SCOPE'],
            timeframe: series.timeframe,
            source: series.source,
            candles: series.candles,
          };
        })(),
      },
    });

    expect(response.json().persistence.owner).toBe('system');
  });
});

describe('list isolation', () => {
  it('hides one user’s signal from another', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    const aliceSignal = await evaluateAndStore(alice, 'ALICE');
    expect(aliceSignal).not.toBeNull();

    const aliceList = await listSignals(alice);
    const bobList = await listSignals(bob);

    expect(aliceList.ids).toContain(aliceSignal);
    // The central assertion of the phase.
    expect(bobList.ids).not.toContain(aliceSignal);
    expect(bobList.total).toBe(0);
  });

  it('counts only what the caller can see', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    await evaluateAndStore(alice, 'ALICE');

    // A total that counted invisible rows would leak how much other users
    // have, and would break pagination against an empty page.
    expect((await listSignals(alice)).total).toBe(1);
    expect((await listSignals(bob)).total).toBe(0);
  });

  it('shows the shared analysis stream to every user', async () => {
    // A signal with no owner is what the runtime worker writes.
    const systemSignal = await evaluateAndStore(null, 'SHARED');
    expect(systemSignal).not.toBeNull();

    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');

    expect((await listSignals(alice)).ids).toContain(systemSignal);
    expect((await listSignals(bob)).ids).toContain(systemSignal);
  });

  it('shows a user their own signals alongside the shared stream', async () => {
    const systemSignal = await evaluateAndStore(null, 'SHARED');
    const alice = await signUp('alice@example.com');
    const aliceSignal = await evaluateAndStore(alice, 'ALICE');

    const list = await listSignals(alice);
    expect(list.ids).toContain(systemSignal);
    expect(list.ids).toContain(aliceSignal);
    expect(list.total).toBe(2);
  });
});

describe('direct lookup isolation', () => {
  it('returns 404, not 403, for another user’s signal', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const aliceSignal = await evaluateAndStore(alice, 'ALICE');

    const asAlice = await app.inject({
      method: 'GET',
      url: `/v1/signals/${aliceSignal}`,
      headers: { cookie: alice },
    });
    const asBob = await app.inject({
      method: 'GET',
      url: `/v1/signals/${aliceSignal}`,
      headers: { cookie: bob },
    });

    expect(asAlice.statusCode).toBe(200);
    // 403 would confirm the id exists, which is itself a disclosure. An
    // unreachable record is indistinguishable from one that never existed.
    expect(asBob.statusCode).toBe(404);
    expect(asBob.json().error.code).toBe('signal_not_found');
  });

  it('lets any user fetch a shared signal by id', async () => {
    const systemSignal = await evaluateAndStore(null, 'SHARED');
    const bob = await signUp('bob@example.com');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/signals/${systemSignal}`,
      headers: { cookie: bob },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('write isolation', () => {
  it('refuses to record an outcome against another user’s signal', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const aliceSignal = await evaluateAndStore(alice, 'ALICE');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/signals/${aliceSignal}/outcome`,
      headers: { cookie: bob, origin: 'http://localhost:3000' },
      payload: { settlementPrice: 100, result: 'win' },
    });

    // Without the ownership check this would succeed, corrupting a dataset
    // Bob cannot even read.
    expect(response.statusCode).toBe(404);
  });

  it('lets the owner record an outcome on their own signal', async () => {
    const alice = await signUp('alice@example.com');
    const aliceSignal = await evaluateAndStore(alice, 'ALICE');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/signals/${aliceSignal}/outcome`,
      headers: { cookie: alice, origin: 'http://localhost:3000' },
      payload: { settlementPrice: 100, result: 'win' },
    });

    expect(response.statusCode).toBe(201);
  });
});

describe('machine token scope', () => {
  it('sees the shared stream but never a user’s private signals', async () => {
    const guarded = await buildApp(
      createAppContext({
        config: loadConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'fatal',
          AUTH_ENABLED: 'true',
          AUTH_API_KEY: 'a-machine-token-value',
          AUTH_ALLOW_REGISTRATION: 'true',
          AUTH_COOKIE_SECURE: 'false',
        }),
        persistence: context.persistence,
        marketDataProvider: null,
      }),
    );

    const register = await guarded.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'alice@example.com', password: PASSWORD },
    });
    const aliceCookie = `${register.cookies[0]?.name}=${register.cookies[0]?.value}`;

    const series = syntheticUptrend(300);
    const payload = (symbol: string) => ({
      strategyId: 'trend-momentum',
      persist: true,
      // The logical name maps to a real catalogue instrument; persisting a
      // signal for an unknown symbol is refused (D1). Ownership, not the
      // instrument, is what these tests are about.
      series: {
        asset: SCOPE_INSTRUMENT[symbol] ?? 'BTCUSD',
        timeframe: series.timeframe,
        source: series.source,
        candles: series.candles,
      },
    });

    const aliceSignal = (
      await guarded.inject({
        method: 'POST',
        url: '/v1/signals/evaluate',
        headers: { cookie: aliceCookie, origin: 'http://localhost:3000' },
        payload: payload('ALICE'),
      })
    ).json().persistence.id;

    const systemSignal = (
      await guarded.inject({
        method: 'POST',
        url: '/v1/signals/evaluate',
        headers: { authorization: 'Bearer a-machine-token-value' },
        payload: payload('SHARED'),
      })
    ).json().persistence.id;

    const listed = await guarded.inject({
      method: 'GET',
      url: '/v1/signals',
      headers: { authorization: 'Bearer a-machine-token-value' },
    });
    const ids = listed.json().signals.map((s: { id: string }) => s.id);

    // A shared token authenticates a machine with no owner. It must never
    // resolve to some user's data just because it is a valid credential.
    expect(ids).toContain(systemSignal);
    expect(ids).not.toContain(aliceSignal);
  });
});

describe('latest signals', () => {
  it('applies the same scope as the full list', async () => {
    const alice = await signUp('alice@example.com');
    const bob = await signUp('bob@example.com');
    const aliceSignal = await evaluateAndStore(alice, 'ALICE');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/signals/latest',
      headers: { cookie: bob },
    });

    // A second endpoint over the same table is exactly where a scoping rule
    // gets forgotten.
    expect(response.json().signals.map((s: { id: string }) => s.id)).not.toContain(aliceSignal);
  });
});
