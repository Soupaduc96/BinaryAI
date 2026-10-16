import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11 pre-flight — instrument identity across the whole system.
 *
 * Two kinds of test live here and they are labelled, because they behave
 * differently when Phase 11 lands:
 *
 *   SAFE      A property that already holds and MUST keep holding. These are
 *             ordinary regression tests. Breaking one is a regression.
 *
 *   DEFECT    A property that is currently WRONG. The assertion pins the
 *             defective behaviour so it cannot drift unnoticed, and names what
 *             the assertion must become once the defect is fixed. A failure
 *             here after Phase 11 is expected — it means the fix landed, and
 *             the test should be inverted at that point.
 *
 * No business logic was changed to make any of these pass. They describe the
 * system as it actually is, verified against a live stack first.
 */

let context: TestDatabase;
let app: FastifyInstance;

const ORIGIN = { origin: 'http://localhost:3000' };
const PASSWORD = 'Audit-Password-4417';

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
        LIVE_ANALYSIS_ENABLED: 'true',
        LIVE_ANALYSIS_SYMBOL: 'BTCUSD',
        AUTH_ALLOW_REGISTRATION: 'true',
        AUTH_COOKIE_SECURE: 'false',
      }),
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

/** A trending 1m series long enough for the strategy to reach a verdict. */
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

// ═══════════════════════════════════════════════════════════ D1 ══
describe('D1 (FIXED) — /v1/signals/evaluate is gated by the instrument catalogue', () => {
  /**
   * `POST /v1/market-data/ingest` is gated by the catalogue. This route is not,
   * and it accepts a caller-supplied `asset` AND `persist: true` — so a caller
   * can write a signal, and an asset row, for an instrument BinaryAI has never
   * heard of, has no provider for, and holds no candles for.
   *
   * Reproduced live: an accepted signal for PHANTOM-XYZ, a paper position
   * opened on it, and exposure committed against the append-only ledger. The
   * result is IRREVERSIBLE — the ledger trigger refuses DELETE and the RESTRICT
   * foreign keys chain back through positions to signals.
   *
   * FIXED in Phase 11A: the route resolves through `findInstrument`, refuses an
   * unknown symbol on any persisting path, and takes ALL metadata from the
   * catalogue rather than from the caller. The assertions below are the
   * originals, inverted.
   */
  it('FIXED: an uncatalogued instrument evaluates but is marked unpersistable', async () => {
    const cookie = await signUp('d1-accept@audit.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, ...ORIGIN },
      payload: {
        strategyId: 'trend-momentum',
        series: series('NOT-IN-CATALOGUE'),
        asset: { symbol: 'NOT-IN-CATALOGUE', assetClass: 'crypto', pricePrecision: 9 },
        persist: false,
      },
    });

    // Stateless evaluation stays available — it writes nothing — but the
    // response says plainly that it cannot be stored, and the class is not the
    // caller's 'crypto' claim.
    expect(response.statusCode).toBe(200);
    expect(response.json().signal.asset).toBe('NOT-IN-CATALOGUE');
    expect(response.json().instrument.persistable).toBe(false);
    expect(response.json().instrument.assetClass).toBe('unknown');
  });

  it('FIXED: refuses to persist, and writes nothing at all', async () => {
    const cookie = await signUp('d1-persist@audit.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, ...ORIGIN },
      payload: {
        strategyId: 'trend-momentum',
        series: series('PHANTOM-AUDIT'),
        asset: { symbol: 'PHANTOM-AUDIT', assetClass: 'stock', pricePrecision: 2 },
        persist: true,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');

    // No asset row was created, so the database and the catalogue agree.
    const stored = await context.persistence.repositories.assets.findBySymbol('PHANTOM-AUDIT');
    expect(stored).toBeNull();

    const lookup = await app.inject({ method: 'GET', url: '/v1/instruments/PHANTOM-AUDIT' });
    expect(lookup.statusCode).toBe(404);
  });

  it('SAFE: the ingest route DOES refuse an uncatalogued instrument', async () => {
    // The gate Phase 10 added. This must not regress while D1 is fixed.
    const cookie = await signUp('d1-ingest@audit.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      headers: { cookie, ...ORIGIN },
      payload: {
        asset: 'NOT-IN-CATALOGUE',
        timeframe: '1m',
        from: Date.now() - 60_000,
        to: Date.now(),
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });
});

// ═══════════════════════════════════════════════════════════ D2 ══
describe('DEFECT D2 — the signal feed is not instrument-scoped', () => {
  /**
   * `GET /v1/signals` supports `?asset=`. The dashboard never passes it:
   * `loadDecision()` fetches the unfiltered feed and takes `signals[0]`.
   *
   * Invisible today because exactly one instrument is analysed. The moment
   * Phase 11 analyses two, the Overview will show a decision for whichever
   * instrument produced the newest signal, beside a chart for whichever
   * instrument is selected.
   *
   * FIX: `loadDecision()` must take the resolved instrument and pass
   * `?asset=`, and the scope notice must compare against THAT.
   */
  it('SAFE: the API can scope signals by instrument', async () => {
    const cookie = await signUp('d2-scope@audit.local');
    for (const [symbol, base] of [
      ['BTCUSD', 50_000],
      ['ETHUSD', 3_000],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/v1/signals/evaluate',
        headers: { cookie, ...ORIGIN },
        payload: { strategyId: 'trend-momentum', series: series(symbol, base), persist: true },
      });
    }

    const btc = await app.inject({
      method: 'GET',
      url: '/v1/signals?asset=BTCUSD',
      headers: { cookie },
    });
    const eth = await app.inject({
      method: 'GET',
      url: '/v1/signals?asset=ETHUSD',
      headers: { cookie },
    });

    const btcSymbols = btc.json().signals.map((s: { assetSymbol: string }) => s.assetSymbol);
    const ethSymbols = eth.json().signals.map((s: { assetSymbol: string }) => s.assetSymbol);

    expect(btcSymbols.length).toBeGreaterThan(0);
    expect(ethSymbols.length).toBeGreaterThan(0);
    expect(new Set(btcSymbols)).toEqual(new Set(['BTCUSD']));
    expect(new Set(ethSymbols)).toEqual(new Set(['ETHUSD']));
  });

  it('DEFECT: the unfiltered feed mixes instruments, and it is what the UI reads', async () => {
    // The SAME account that persisted both instruments above: signals are
    // account-scoped, so a fresh account would correctly see an empty feed.
    const cookie = await signUp('d2-mixed@audit.local');
    for (const [symbol, base] of [
      ['BTCUSD', 50_000],
      ['ETHUSD', 3_000],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/v1/signals/evaluate',
        headers: { cookie, ...ORIGIN },
        payload: { strategyId: 'trend-momentum', series: series(symbol, base), persist: true },
      });
    }
    const all = await app.inject({
      method: 'GET',
      url: '/v1/signals?limit=50',
      headers: { cookie },
    });
    const symbols = new Set(all.json().signals.map((s: { assetSymbol: string }) => s.assetSymbol));

    // More than one instrument in the feed the dashboard consumes unfiltered.
    expect(symbols.size).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════ D3 ══
describe('D3 (FIXED) — analysis identity has one source of truth', () => {
  /**
   * `runAnalysisCycle` takes `deps.asset` (a MarketAsset — upserted, and handed
   * to the strategy) and `options.symbol` (which candles to load, and what the
   * signal is stamped with). Nothing cross-checks them.
   *
   * Production passes matching values. Phase 11 introduces a loop over
   * instruments, which is precisely the shape where a mismatched pair is easy
   * to build, and the failure would be silent.
   *
   * FIXED in Phase 11A: the cycle takes ONE resolved instrument carrying
   * symbol, timeframe and asset row together, built only by
   * `resolveAnalysisInstrument` from the catalogue. An incoherent pair is
   * rejected before anything is written.
   */
  it('FIXED: a resolved instrument cannot disagree with itself', async () => {
    const { resolveAnalysisInstrument } = await import('@binaryai/runtime');
    const resolved = resolveAnalysisInstrument('BTCUSD', '1m');

    // One object answers both questions the cycle used to ask separately:
    // which candles to load, and which asset row to write.
    expect(resolved.symbol).toBe(resolved.asset.symbol);
    expect(resolved.asset.assetClass).toBe('crypto');
  });

  it('FIXED: an incoherent instrument is refused before persistence', async () => {
    const { runAnalysisCycle } = await import('@binaryai/runtime');
    const { createDefaultRegistry } = await import('@binaryai/strategies');

    await expect(
      runAnalysisCycle({
        repositories: context.persistence.repositories,
        strategy: createDefaultRegistry().get('trend-momentum'),
        instrument: {
          symbol: 'BTCUSD',
          timeframe: '1m',
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

  it('SAFE: the signal is stamped from the SERIES, so it matches the candles', async () => {
    // The saving grace of the current design: signal identity follows the data
    // that was actually analysed, not the descriptor passed alongside it.
    const cookie = await signUp('d3-series@audit.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      headers: { cookie, ...ORIGIN },
      payload: {
        strategyId: 'trend-momentum',
        series: series('BTCUSD', 50_000),
        // A DIFFERENT instrument in the descriptor.
        asset: { symbol: 'EURUSD', assetClass: 'forex', pricePrecision: 5 },
        persist: false,
      },
    });

    // The signal follows the series, which is the correct precedence.
    expect(response.json().signal.asset).toBe('BTCUSD');
  });
});

// ═══════════════════════════════════════════════════════════ D4 ══
describe('DEFECT D4 — chart availability ignores the selected timeframe', () => {
  /**
   * `availability.chart` is computed from "any stored timeframe exists", while
   * the chart renders at the workspace-global timeframe. AAPL holds 205 daily
   * candles and no 1m candles, so `/analysis?asset=AAPL` (the URL the picker
   * produces) shows CHART=AVAILABLE beside an empty chart reading
   * "No stored candles for AAPL 1m".
   *
   * Reproduced in a real browser at 1440px.
   *
   * FIX: either scope `chart` to the selected timeframe, or make instrument
   * selection carry a timeframe the instrument actually has.
   */
  it('DEFECT: chart reports available for a timeframe with no candles', async () => {
    const { repositories } = context.persistence;
    await repositories.assets.upsert({
      symbol: 'AAPL',
      displayName: 'Apple Inc.',
      assetClass: 'stock',
      pricePrecision: 2,
      isOtc: false,
    });
    // Daily candles only — deliberately no 1m, matching the live system.
    const day = 86_400_000;
    const start = Math.floor((Date.now() - 30 * day) / day) * day;
    await repositories.candles.upsertSeries({
      asset: 'AAPL',
      timeframe: '1d',
      source: 'historical_provider',
      candles: Array.from({ length: 20 }, (_unused, index) => ({
        timestamp: start + index * day,
        open: 300,
        high: 302,
        low: 298,
        close: 301,
        volume: 1000,
        complete: true,
      })),
    });

    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/AAPL' });
    const body = instrument.json().instrument;

    // Says available…
    expect(body.availability.chart.state).toBe('available');
    expect(body.storedTimeframes).toEqual(['1d']);

    // …while the workspace default timeframe has nothing to draw.
    const candles = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=AAPL&timeframe=1m',
    });
    expect(candles.json().series).toBeNull();
    expect(candles.json().reason).toContain('No stored candles for AAPL 1m');
  });

  it('SAFE: the correct timeframe does return the stored candles', async () => {
    const candles = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=AAPL&timeframe=1d',
    });
    expect(candles.json().series?.candles.length).toBeGreaterThan(0);
    expect(candles.json().series?.asset).toBe('AAPL');
  });
});

// ═══════════════════════════════════════════════════════════ D5 ══
describe('DEFECT D5 — only the configured instrument is kept fresh', () => {
  /**
   * The ingestion worker polls ONE symbol — `LIVE_ANALYSIS_SYMBOL`. An
   * instrument added through the picker gets a one-shot backfill and then ages
   * indefinitely. Measured on the live stack: BTC/USD 20s old, EUR/USD 56min,
   * AAPL and SPX ~23h.
   *
   * FIX: Phase 11 must decide what "kept fresh" means per instrument, and the
   * UI must show per-instrument freshness rather than implying all are live.
   */
  it('DEFECT: worker configuration names exactly one instrument', async () => {
    const status = await app.inject({ method: 'GET', url: '/v1/runtime/status' });
    const analysis = status.json().runtime.analysis;

    expect(analysis.symbol).toBe('BTCUSD');
    // A single string, not a list. This is the shape Phase 11 must change.
    expect(typeof analysis.symbol).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════ D6 ══
describe('DEFECT D6 — market-data state is global, freshness is per-instrument', () => {
  /**
   * `/v1/market-data/status` reports ONE connection state derived from the
   * newest candle across ALL instruments. The context strip renders it beside a
   * per-instrument "last update", so AAPL shows `MARKET LIVE` next to
   * `LAST UPDATE 23h ago`. Reproduced in a real browser.
   *
   * FIX: derive the MARKET cell per instrument, or relabel it as a global
   * provider-connection indicator so the two stop appearing to contradict.
   */
  it('DEFECT: status carries no per-instrument dimension', async () => {
    const status = await app.inject({ method: 'GET', url: '/v1/market-data/status' });
    const body = status.json().status;

    // One state, one lastCandleAt, for the whole system.
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('lastCandleAt');
    expect(body).not.toHaveProperty('instruments');
    expect(body).not.toHaveProperty('perInstrument');
  });

  it('SAFE: per-instrument freshness IS available on the instruments endpoint', async () => {
    // The data a fix needs already exists; it is simply not what the strip reads.
    const instrument = await app.inject({ method: 'GET', url: '/v1/instruments/AAPL' });
    expect(instrument.json().instrument).toHaveProperty('lastCandleAt');
  });
});

// ═══════════════════════════════════════════════════════════ D7 ══
describe('DEFECT D7 — analytics are pooled across instruments in the UI', () => {
  /**
   * The analytics endpoints accept `?asset=`; the dashboard never sends it. The
   * Performance workspace therefore shows accuracy pooled across every
   * instrument, beside a workspace scoped to one.
   *
   * Harmless while one instrument is analysed. After Phase 11 it becomes a
   * figure attributed to nothing in particular.
   */
  it('SAFE: the API supports instrument-scoped analytics', async () => {
    const cookie = await signUp('d7-analytics@audit.local');
    const scoped = await app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?asset=BTCUSD',
      headers: { cookie },
    });
    expect(scoped.statusCode).toBe(200);
  });

  it('DEFECT: the default response is pooled, with no instrument named', async () => {
    const cookie = await signUp('d7-pooled@audit.local');
    const pooled = await app.inject({
      method: 'GET',
      url: '/v1/analytics/overview',
      headers: { cookie },
    });
    const body = pooled.json();

    expect(pooled.statusCode).toBe(200);
    // Nothing in the payload says which instruments it covers.
    expect(body.overview).not.toHaveProperty('assetSymbol');
    expect(body.overview).not.toHaveProperty('instruments');
  });

  it('SAFE: the asset DIMENSION does separate instruments correctly', async () => {
    const cookie = await signUp('d7-dimension@audit.local');
    const byAsset = await app.inject({
      method: 'GET',
      url: '/v1/analytics/assets',
      headers: { cookie },
    });
    const groups = byAsset.json().groups as { key: string }[];
    // Each group is one instrument; no group pools two.
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });
});

// ═══════════════════════════════════════════════════════════ D8 ══
describe('DEFECT D8 — backtesting discards instrument metadata', () => {
  /**
   * `/v1/backtest/run` builds its MarketAsset inline as
   * `{ assetClass: 'unknown', pricePrecision: 5 }` from the caller's series
   * symbol, without consulting the catalogue. Backtesting AAPL therefore
   * records a 5-decimal instrument of unknown class.
   *
   * Low impact today — strategies ignore the descriptor — but it is the same
   * "caller names the instrument" gap D1 describes, and it writes a stored
   * backtest row under an arbitrary symbol.
   */
  it('DEFECT: a backtest accepts and records an arbitrary instrument symbol', async () => {
    const cookie = await signUp('d8-backtest@audit.local');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      headers: { cookie, ...ORIGIN },
      payload: {
        strategyId: 'trend-momentum',
        series: series('NOT-A-REAL-TICKER', 300),
        expirationSeconds: 300,
        stake: { kind: 'fixed', value: 10 },
        startingBalance: 1000,
        persist: false,
      },
    });

    expect(response.statusCode).toBe(200);
    // The run records the caller's arbitrary string as its dataset identity.
    expect(response.json().result.dataset.asset).toBe('NOT-A-REAL-TICKER');
    expect(response.json().result.dataset.label).toContain('NOT-A-REAL-TICKER');
  });
});
