import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11A — the nine audit defects, each with a regression test.
 *
 * Every assertion here would have FAILED before the fix. They are written so
 * that reintroducing a defect breaks a test whose name says which one.
 *
 * The audit's characterisation tests live in `instrument-identity-audit.test.ts`
 * and were updated in the same change: assertions that pinned defective
 * behaviour now assert the corrected behaviour.
 */

let context: TestDatabase;
let app: FastifyInstance;

const ORIGIN = { origin: 'http://localhost:3000' };
const PASSWORD = 'Hardening-Password-8823';

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    MARKET_DATA_PROVIDER: 'coinbase',
    MARKET_DATA_EQUITY_PROVIDER: 'yahoo',
    LIVE_ANALYSIS_ENABLED: 'true',
    AUTH_ALLOW_REGISTRATION: 'true',
    AUTH_COOKIE_SECURE: 'false',
    ...extra,
  });

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  await truncateAll(context.database);
  app = await buildApp(
    createAppContext({
      config: config({ LIVE_ANALYSIS_SYMBOL: 'BTCUSD' }),
      persistence: context.persistence,
    }),
  );
});

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

/** A trending 1m series, aligned to the UTC grid, long enough for a verdict. */
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

const evaluate = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/signals/evaluate',
    headers: { cookie, ...ORIGIN },
    payload: { strategyId: 'trend-momentum', ...payload },
  });

const rowCount = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await context.database.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

// ═════════════════════════════════════════════════════════════ D1 ══
describe('D1 — the catalogue bypass is closed', () => {
  /**
   * Before: `persist:true` with an arbitrary `asset` created a market_assets
   * row, an accepted signal, an actionable paper position and committed
   * exposure on the append-only ledger — irreversibly, because the ledger's
   * no-delete trigger and RESTRICT foreign keys chain back through positions
   * to signals.
   */
  it('refuses to persist an instrument outside the catalogue', async () => {
    const cookie = await signUp('d1-refuse@harden.local');
    const response = await evaluate(cookie, {
      series: series('PHANTOM-XYZ'),
      asset: { symbol: 'PHANTOM-XYZ', assetClass: 'forex', pricePrecision: 5 },
      persist: true,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });

  it('writes NOTHING when it refuses', async () => {
    // The acceptance criterion, stated as four independent counts. A partial
    // write would be worse than the original bug, because it would look clean.
    expect(
      await rowCount(`SELECT count(*)::text AS n FROM market_assets WHERE symbol = 'PHANTOM-XYZ'`),
    ).toBe(0);
    expect(
      await rowCount(`SELECT count(*)::text AS n FROM signals WHERE asset_symbol = 'PHANTOM-XYZ'`),
    ).toBe(0);
    expect(
      await rowCount(
        `SELECT count(*)::text AS n FROM paper_positions WHERE asset_symbol = 'PHANTOM-XYZ'`,
      ),
    ).toBe(0);
    expect(
      await rowCount(
        `SELECT count(*)::text AS n FROM paper_ledger_entries l
           JOIN paper_positions p ON p.id = l.position_id
          WHERE p.asset_symbol = 'PHANTOM-XYZ'`,
      ),
    ).toBe(0);
  });

  it('never trusts the caller’s classification for a KNOWN instrument', async () => {
    const cookie = await signUp('d1-class@harden.local');
    const response = await evaluate(cookie, {
      series: series('BTCUSD', 50_000),
      // BTCUSD is crypto at 2dp. The caller claims forex at 9dp.
      asset: { symbol: 'BTCUSD', assetClass: 'forex', pricePrecision: 9 },
      persist: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().instrument.assetClass).toBe('crypto');

    const stored = await context.persistence.repositories.assets.findBySymbol('BTCUSD');
    expect(stored?.assetClass).toBe('crypto');
    expect(stored?.pricePrecision).toBe(2);
  });

  it('resolves a legacy spelling instead of creating a duplicate', async () => {
    const cookie = await signUp('d1-legacy@harden.local');
    const response = await evaluate(cookie, {
      series: series('BTC-USD', 50_000),
      persist: true,
    });

    expect(response.statusCode).toBe(200);
    const rows = await context.database.query<{ symbol: string }>(
      `SELECT symbol FROM market_assets WHERE symbol IN ('BTCUSD', 'BTC-USD')`,
    );
    expect(rows.rows.map((row) => row.symbol)).toEqual(['BTCUSD']);
  });

  it('still allows STATELESS evaluation of an arbitrary series', async () => {
    // A calculator over hand-supplied candles is a legitimate use, and it
    // writes nothing. Refusing it would break backtest-style exploration for
    // no safety gain.
    const cookie = await signUp('d1-stateless@harden.local');
    const response = await evaluate(cookie, {
      series: series('SOME-RESEARCH-SERIES'),
      persist: false,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().instrument.persistable).toBe(false);
    expect(response.json().instrument.assetClass).toBe('unknown');
    expect(
      await rowCount(
        `SELECT count(*)::text AS n FROM market_assets WHERE symbol = 'SOME-RESEARCH-SERIES'`,
      ),
    ).toBe(0);
  });

  it('cannot be used to conjure an OTC instrument', async () => {
    // D13. OTC is a modelled market type with no provider and no catalogue
    // entry. Submitting marketType/isOtc must not create one.
    const cookie = await signUp('d1-otc@harden.local');
    const response = await evaluate(cookie, {
      series: series('EURUSD-OTC', 1.1),
      asset: { symbol: 'EURUSD-OTC', assetClass: 'otc', isOtc: true },
      persist: true,
    });

    expect(response.statusCode).toBe(404);
    expect(
      await rowCount(
        `SELECT count(*)::text AS n FROM market_assets WHERE asset_class = 'otc' OR is_otc = true`,
      ),
    ).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════ D2 ══
describe('D2 — signal queries are instrument-scoped', () => {
  let cookie = '';

  beforeAll(async () => {
    cookie = await signUp('d2-scope@harden.local');
    // Three real instruments, three genuinely different price bands.
    for (const [symbol, base] of [
      ['BTCUSD', 50_000],
      ['ETHUSD', 3_000],
      ['EURUSD', 1.1],
    ] as const) {
      const response = await evaluate(cookie, { series: series(symbol, base), persist: true });
      expect(response.statusCode).toBe(200);
    }
  });

  it('returns only the requested instrument’s signals', async () => {
    for (const symbol of ['BTCUSD', 'ETHUSD', 'EURUSD']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/signals?asset=${symbol}&limit=50`,
        headers: { cookie },
      });
      const symbols = new Set(
        response.json().signals.map((s: { assetSymbol: string }) => s.assetSymbol),
      );
      expect(symbols).toEqual(new Set([symbol]));
    }
  });

  it('proves zero cross-instrument leakage across all three', async () => {
    const byInstrument = await Promise.all(
      ['BTCUSD', 'ETHUSD', 'EURUSD'].map(async (symbol) => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/signals?asset=${symbol}&limit=50`,
          headers: { cookie },
        });
        return {
          symbol,
          ids: response.json().signals.map((s: { id: string }) => s.id) as string[],
        };
      }),
    );

    // No signal id appears under two instruments.
    const seen = new Map<string, string>();
    for (const { symbol, ids } of byInstrument) {
      for (const id of ids) {
        expect(seen.get(id) ?? symbol).toBe(symbol);
        seen.set(id, symbol);
      }
    }
    expect(byInstrument.every((entry) => entry.ids.length > 0)).toBe(true);
  });

  it('keeps signal DETAIL attributed to its own instrument', async () => {
    for (const symbol of ['BTCUSD', 'ETHUSD', 'EURUSD']) {
      const feed = await app.inject({
        method: 'GET',
        url: `/v1/signals?asset=${symbol}&limit=1`,
        headers: { cookie },
      });
      const row = feed.json().signals[0];
      const detail = await app.inject({
        method: 'GET',
        url: `/v1/signals/${row.id}`,
        headers: { cookie },
      });
      expect(detail.json().signal.asset).toBe(symbol);
    }
  });

  it('holds under concurrent requests for different instruments', async () => {
    // Scenario I, as a test: interleaved reads must not swap responses.
    const requests = Array.from({ length: 6 }).flatMap(() =>
      ['BTCUSD', 'ETHUSD', 'EURUSD'].map(async (symbol) => {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/signals?asset=${symbol}&limit=5`,
          headers: { cookie },
        });
        const symbols = new Set(
          response.json().signals.map((s: { assetSymbol: string }) => s.assetSymbol),
        );
        return { requested: symbol, returned: [...symbols] };
      }),
    );

    for (const result of await Promise.all(requests)) {
      expect(result.returned).toEqual([result.requested]);
    }
  });
});

// ═════════════════════════════════════════════════════════════ D3 ══
describe('D3 — one source of truth for analysis identity', () => {
  it('a resolved instrument carries symbol, timeframe and asset together', async () => {
    const { resolveAnalysisInstrument } = await import('@binaryai/runtime');
    const resolved = resolveAnalysisInstrument('EURUSD', '1h');

    expect(resolved.symbol).toBe('EURUSD');
    expect(resolved.timeframe).toBe('1h');
    // The asset row is derived from the SAME object, so it cannot disagree.
    expect(resolved.asset.symbol).toBe('EURUSD');
    expect(resolved.asset.assetClass).toBe('forex');
    expect(resolved.asset.pricePrecision).toBe(5);
  });

  it('canonicalises a legacy spelling', async () => {
    const { resolveAnalysisInstrument } = await import('@binaryai/runtime');
    expect(resolveAnalysisInstrument('BTC-USD', '1m').symbol).toBe('BTCUSD');
  });

  it('refuses an instrument the catalogue does not know', async () => {
    const { resolveAnalysisInstrument, UnknownAnalysisInstrumentError } =
      await import('@binaryai/runtime');
    expect(() => resolveAnalysisInstrument('NOT-REAL', '1m')).toThrow(
      UnknownAnalysisInstrumentError,
    );
  });

  it('refuses a timeframe the instrument is not served at', async () => {
    const { resolveAnalysisInstrument } = await import('@binaryai/runtime');
    expect(() => resolveAnalysisInstrument('BTCUSD', '4h')).toThrow(/not served at 4h/);
  });

  it('mismatched identity cannot reach persistence', async () => {
    // The invariant inside the cycle. Hand-building an incoherent instrument is
    // the only way to reach it, and it throws instead of writing.
    const { runAnalysisCycle } = await import('@binaryai/runtime');
    const { createDefaultRegistry } = await import('@binaryai/strategies');

    await expect(
      runAnalysisCycle({
        repositories: context.persistence.repositories,
        strategy: createDefaultRegistry().get('trend-momentum'),
        instrument: {
          symbol: 'BTCUSD',
          timeframe: '1m',
          // Deliberately incoherent: candles for BTC, asset row for EUR.
          asset: {
            symbol: 'EURUSD',
            displayName: 'Euro / US Dollar',
            assetClass: 'forex',
            pricePrecision: 5,
            isOtc: false,
          },
        },
      }),
    ).rejects.toThrow(/incoherent/);
  });

  it('REJECTS a plan naming the same instrument and timeframe twice', async () => {
    // Changed deliberately in Phase 11A: duplicates were collapsed silently,
    // which hid a configuration mistake that would produce two competing
    // writes for one decision bar. `BTC-USD@1m` and `BTCUSD@1m` are the same
    // entry written two ways, and both resolve to the same canonical symbol.
    const { resolveAnalysisInstruments, InvalidPlanEntryError } = await import('@binaryai/runtime');
    expect(() => resolveAnalysisInstruments(['BTC-USD', 'BTCUSD', 'ETHUSD'], '1m')).toThrow(
      InvalidPlanEntryError,
    );
    // The same instrument at DIFFERENT timeframes is legitimate.
    const { resolvePlan } = await import('@binaryai/runtime');
    const mixed = resolvePlan(
      [
        { symbol: 'BTCUSD', timeframe: '1m' },
        { symbol: 'BTCUSD', timeframe: '1h' },
      ],
      'ANALYSIS_INSTRUMENTS',
    );
    expect(mixed.map((entry) => `${entry.symbol}@${entry.timeframe}`)).toEqual([
      'BTCUSD@1m',
      'BTCUSD@1h',
    ]);
  });
});
