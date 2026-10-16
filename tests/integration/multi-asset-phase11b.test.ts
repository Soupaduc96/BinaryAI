import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11B — hardening regressions.
 *
 * Covers R4 (per-instrument risk), R5 (calibration provenance), R10 (scoped
 * positions and ledger), R17 (fair settlement) and R8 (backtest identity).
 *
 * Every assertion here would have FAILED before the change it guards, and each
 * describe block names the defect so a reintroduction says what broke.
 */

let context: TestDatabase;
let app: FastifyInstance;

const ORIGIN = { origin: 'http://localhost:3000' };
const PASSWORD = 'Phase11B-Password-4471';

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  await truncateAll(context.database);
  app = await buildApp(
    createAppContext({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        MARKET_DATA_PROVIDER: 'coinbase',
        MARKET_DATA_EQUITY_PROVIDER: 'yahoo',
        AUTH_ALLOW_REGISTRATION: 'true',
        AUTH_COOKIE_SECURE: 'false',
      }),
      persistence: context.persistence,
    }),
  );
}, 60_000);

afterAll(async () => {
  await app?.close();
  await context?.close();
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

/** A trending 1m series aligned to the UTC grid. */
function series(asset: string, base = 100, bars = 320) {
  const step = 60_000;
  const start = Math.floor((Date.now() - bars * step) / step) * step;
  return {
    asset,
    timeframe: '1m' as const,
    source: 'historical_file' as const,
    candles: Array.from({ length: bars }, (_unused, index) => {
      const price = base * (1 + index * 0.002);
      return {
        timestamp: start + index * step,
        open: price,
        high: price * 1.002,
        low: price * 0.999,
        close: price * 1.0015,
        volume: 100,
        complete: true,
      };
    }),
  };
}

// ══════════════════════════════════════════════════════════════ R4 ══
describe('R4 — risk limits can be set per instrument', () => {
  it('rejects a per-instrument limit for an instrument outside the catalogue', async () => {
    const cookie = await signUp('r4-unknown@p11b.local');
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie, ...ORIGIN },
      payload: { perInstrument: { 'PHANTOM-XYZ': { maxOpenPositions: 1 } } },
    });

    // The same gate D1 established: an instrument nobody can name must not
    // become a risk policy key, because the policy would never match anything
    // and would read as protection that does not exist.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });

  it('stores a per-instrument limit under the CANONICAL symbol', async () => {
    const cookie = await signUp('r4-canonical@p11b.local');
    // Written with the provider's spelling; must come back catalogue-canonical,
    // or a limit set as 'BTC-USD' would never match a signal on 'BTCUSD'.
    const written = await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie, ...ORIGIN },
      payload: { perInstrument: { 'BTC-USD': { maxOpenPositions: 2 } } },
    });
    expect(written.statusCode).toBe(200);

    const read = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/risk',
      headers: { cookie, ...ORIGIN },
    });
    const perInstrument = read.json().policy.perInstrument;
    expect(Object.keys(perInstrument)).toEqual(['BTCUSD']);
    expect(perInstrument.BTCUSD.maxOpenPositions).toBe(2);
  });

  it('leaves the ACCOUNT limits untouched when only per-instrument changes', async () => {
    const cookie = await signUp('r4-ceiling@p11b.local');
    const before = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/risk',
      headers: { cookie, ...ORIGIN },
    });
    const accountLimits = before.json().policy.limits;

    await app.inject({
      method: 'PATCH',
      url: '/v1/accounts/me/risk',
      headers: { cookie, ...ORIGIN },
      payload: { perInstrument: { ETHUSD: { maxOpenPositions: 1 } } },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/risk',
      headers: { cookie, ...ORIGIN },
    });
    // Per-instrument limits NARROW; they never replace or widen the account
    // ceiling. This is the guard against the brief's explicit prohibition.
    expect(after.json().policy.limits).toEqual(accountLimits);
  });
});

// ═════════════════════════════════════════════════════════════ R10 ══
describe('R10 — positions and the ledger report their scope', () => {
  it('reports account scope when no instrument is named', async () => {
    const cookie = await signUp('r10-account@p11b.local');
    const positions = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/positions',
      headers: { cookie, ...ORIGIN },
    });
    expect(positions.json().scope).toBe('account');
    expect(positions.json().assetSymbol).toBeNull();

    const ledger = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/ledger',
      headers: { cookie, ...ORIGIN },
    });
    expect(ledger.json().scope).toBe('account');
    expect(ledger.json().assetSymbol).toBeNull();
  });

  it('reports instrument scope under the canonical symbol', async () => {
    const cookie = await signUp('r10-instrument@p11b.local');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/positions?asset=BTC-USD',
      headers: { cookie, ...ORIGIN },
    });
    expect(response.json().scope).toBe('instrument');
    expect(response.json().assetSymbol).toBe('BTCUSD');
  });

  it('refuses an unknown instrument rather than silently answering account-wide', async () => {
    const cookie = await signUp('r10-unknown@p11b.local');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/positions?asset=PHANTOM-XYZ',
      headers: { cookie, ...ORIGIN },
    });
    // Answering account-wide would be the dangerous failure: the caller asked
    // a narrow question and would receive a broad answer labelled as theirs.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });

  it('keeps the ledger STATE account-wide even when entries are scoped', async () => {
    const cookie = await signUp('r10-state@p11b.local');
    const scoped = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/ledger?asset=BTCUSD',
      headers: { cookie, ...ORIGIN },
    });
    const wide = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/ledger',
      headers: { cookie, ...ORIGIN },
    });
    // An account has ONE balance and ONE exposure. A per-instrument subtotal
    // beside a subset of entries would be a figure the ledger cannot support.
    expect(scoped.json().state).toEqual(wide.json().state);
    expect(scoped.json().scope).toBe('instrument');
  });
});

// ══════════════════════════════════════════════════════════════ R5 ══
describe('R5 — analytics state which instrument they describe', () => {
  it('marks an unscoped request as pooling all instruments', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/analytics/overview' });
    const provenance = response.json().overview.provenance;
    expect(provenance.instrumentScope).toBe('all_instruments');
    expect(provenance.assetSymbol).toBeNull();
  });

  it('records the CANONICAL symbol for a scoped request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?asset=BTC-USD',
    });
    const provenance = response.json().overview.provenance;
    expect(provenance.instrumentScope).toBe('instrument');
    // Resolved server-side. A report that took its identity from the query
    // string could be labelled anything at all.
    expect(provenance.assetSymbol).toBe('BTCUSD');
  });

  it('carries the same provenance onto the calibration report', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/analytics/calibration?asset=ETHUSD',
    });
    expect(response.json().provenance.assetSymbol).toBe('ETHUSD');
    expect(response.json().provenance.instrumentScope).toBe('instrument');
  });
});

// ══════════════════════════════════════════════════════════════ R8 ══
describe('R8 — a backtest names the market it ran on', () => {
  it('stores the CANONICAL symbol, not the caller series label', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      headers: ORIGIN,
      payload: { series: series('BTC-USD', 30_000), strategyId: 'trend-momentum' },
    });
    expect(response.statusCode).toBe(200);
    const dataset = response.json().result.dataset;
    // 'BTC-USD' in, 'BTCUSD' out: a run filed under the provider's spelling
    // could never be joined to signals filed under the canonical one.
    expect(dataset.asset).toBe('BTCUSD');
    expect(dataset.instrumentIdentity).toBe('catalogue');
  });

  it('admits when it cannot establish the instrument', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      headers: ORIGIN,
      payload: { series: series('MYSTERY-SERIES'), strategyId: 'trend-momentum' },
    });
    // NOT rejected: a backtest over a hand-supplied series is legitimate and
    // creates no signal and no exposure. But it must not claim an identity.
    expect(response.statusCode).toBe(200);
    expect(response.json().result.dataset.instrumentIdentity).toBe('unresolved');
  });

  it('refuses a declared instrument that contradicts the series', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      headers: ORIGIN,
      payload: { series: series('BTCUSD', 30_000), asset: 'AAPL', strategyId: 'trend-momentum' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('instrument_mismatch');
  });

  it('accepts a declared instrument spelled differently from the series', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      headers: ORIGIN,
      payload: { series: series('BTC-USD', 30_000), asset: 'BTCUSD', strategyId: 'trend-momentum' },
    });
    // Compared AFTER resolution, so two spellings of one market agree.
    expect(response.statusCode).toBe(200);
    expect(response.json().result.dataset.asset).toBe('BTCUSD');
  });
});

// ══════════════════════════════════════════════ Step 7 audit findings ══
describe('S7 — the live multi-asset audit', () => {
  /**
   * S7-3. `?asset=EURUSD-OTC` returned 200 with provenance reading
   * `assetSymbol: "EURUSD-OTC", instrumentScope: "instrument"` — a provenance
   * record naming a market BinaryAI does not support, conjured by typing it
   * into a query string. Every figure in that response was correctly empty,
   * which made the label the only claim in it, and the label was false.
   *
   * OTC is UNSUPPORTED. The catalogue holds no OTC entry, so the fix is simply
   * that an unknown symbol is refused — not that OTC is special-cased.
   */
  it('refuses an OTC-looking symbol rather than labelling a report with it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?asset=EURUSD-OTC',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });

  it('refuses an unknown symbol on every analytics route alike', async () => {
    for (const path of ['/v1/analytics/overview', '/v1/analytics/calibration']) {
      const response = await app.inject({ method: 'GET', url: `${path}?asset=ZZZZ` });
      expect(response.statusCode, path).toBe(404);
    }
  });

  /**
   * S7-4. `/v1/signals?asset=BTC-USD` answered `total: 0` for an instrument
   * holding 218 signals, because the provider spelling was matched literally
   * against the canonical symbol stored on every row. "No signals recorded"
   * for a live instrument is the worst way to be wrong: it is indistinguishable
   * from a working, quiet market.
   */
  it('resolves a legacy spelling on the signals list', async () => {
    const canonical = await app.inject({ method: 'GET', url: '/v1/signals?asset=BTCUSD&limit=1' });
    const legacy = await app.inject({ method: 'GET', url: '/v1/signals?asset=BTC-USD&limit=1' });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().total).toBe(canonical.json().total);
  });

  it('refuses an unknown symbol on the signals list instead of answering empty', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/signals?asset=PHANTOM-XYZ' });
    // An empty list reads as "this market exists and is quiet". It does not
    // exist, and the two must not look the same.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });
});

// ═══════════════════════════════════════════ Phase 11C gate findings ══
describe('11C-1 — a catalogue ALIAS cannot split an instrument identity', () => {
  /**
   * REPRODUCED against the running stack: posting a series labelled `BTC-USD`
   * with `persist: true` stored a BTCUSD row in `market_assets` and a BTC-USD
   * row in `signals` — in the SAME transaction. `assets.upsert()` wrote the
   * resolved catalogue instrument while `signals.save()` wrote `signal.asset`,
   * which the engine takes from `series.asset`: the caller's spelling.
   *
   * The result was worse than a cosmetic split. Such a row is unreachable by
   * ANY valid query: `?asset=BTCUSD` does not match it, and `?asset=BTC-USD`
   * resolves to BTCUSD and does not match it either. It also earned the alias
   * its own partition in the R17 settlement round-robin and its own key in
   * every analytics grouping.
   */
  const step = 60_000;
  const seriesFor = (asset: string) => {
    const start = Math.floor((Date.now() - 320 * step) / step) * step;
    return {
      asset,
      timeframe: '1m' as const,
      source: 'historical_file' as const,
      candles: Array.from({ length: 320 }, (_unused, index) => {
        const price = 100 * (1 + index * 0.002);
        return {
          timestamp: start + index * step,
          open: price,
          high: price * 1.002,
          low: price * 0.999,
          close: price * 1.0015,
          volume: 100,
          complete: true,
        };
      }),
    };
  };

  it('reports the CANONICAL symbol for an alias series', async () => {
    const cookie = await signUp('c1-alias@p11c.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, ...ORIGIN },
      payload: { series: seriesFor('BTC-USD'), strategyId: 'trend-momentum' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().signal.asset).toBe('BTCUSD');
  });

  it('persists the canonical symbol, with the asset foreign key populated', async () => {
    const cookie = await signUp('c1-persist@p11c.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, ...ORIGIN },
      payload: { series: seriesFor('BTC-USD'), strategyId: 'trend-momentum', persist: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().persistence.stored).toBe(true);

    // No row may carry the alias spelling...
    const aliased = await context.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signals WHERE asset_symbol = 'BTC-USD'`,
    );
    expect(Number(aliased.rows[0]?.n)).toBe(0);

    // ...and every stored signal must actually point at its instrument.
    // A NULL asset_id is how the split stayed silent: the insert resolves
    // `(SELECT id FROM market_assets WHERE symbol = $3)`, which yields NULL
    // rather than failing when the spelling does not match.
    const unlinked = await context.database.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signals WHERE asset_id IS NULL`,
    );
    expect(Number(unlinked.rows[0]?.n)).toBe(0);
  });

  it('keeps the alias reachable through the canonical symbol', async () => {
    const cookie = await signUp('c1-reach@p11c.local');
    await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, ...ORIGIN },
      payload: { series: seriesFor('BTC-USD'), strategyId: 'trend-momentum', persist: true },
    });

    // Both spellings must reach the SAME rows. Before the fix the stored row
    // answered to neither.
    const canonical = await app.inject({
      method: 'GET',
      url: '/v1/signals?asset=BTCUSD&limit=50',
      headers: { cookie, ...ORIGIN },
    });
    const alias = await app.inject({
      method: 'GET',
      url: '/v1/signals?asset=BTC-USD&limit=50',
      headers: { cookie, ...ORIGIN },
    });
    expect(canonical.json().total).toBeGreaterThan(0);
    expect(alias.json().total).toBe(canonical.json().total);
  });
});
