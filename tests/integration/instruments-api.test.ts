import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * The instrument catalogue through the real API.
 *
 * Three properties, each of which has a way of breaking quietly:
 *
 *  1. THE SERVER IS AUTHORITATIVE. A caller cannot ingest an instrument
 *     BinaryAI has not declared, and cannot choose the spelling under which one
 *     is stored. That used to be possible and is how the same asset ended up in
 *     the database twice.
 *
 *  2. AVAILABILITY IS COMPUTED, NOT ASSUMED. A class with no provider reports
 *     `not_configured`, and market data being available never implies analysis.
 *
 *  3. NO CROSS-INSTRUMENT LEAKAGE. Candles, signals and paper positions belong
 *     to the instrument that produced them, and a query for one must never
 *     return another's rows.
 */

let context: TestDatabase;
/** Crypto only — the shipped default, where four classes are unconfigured. */
let cryptoOnly: FastifyInstance;
/** Both providers, so the multi-asset paths are exercised. */
let multiAsset: FastifyInstance;

const config = (extra: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...extra });

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  await truncateAll(context.database);

  cryptoOnly = await buildApp(
    createAppContext({
      config: config({
        MARKET_DATA_PROVIDER: 'coinbase',
        LIVE_ANALYSIS_ENABLED: 'true',
        LIVE_ANALYSIS_SYMBOL: 'BTCUSD',
      }),
      persistence: context.persistence,
    }),
  );

  multiAsset = await buildApp(
    createAppContext({
      config: config({
        MARKET_DATA_PROVIDER: 'coinbase',
        MARKET_DATA_EQUITY_PROVIDER: 'yahoo',
        // Enabled so availability exercises the per-instrument comparison
        // rather than short-circuiting on a disabled worker.
        LIVE_ANALYSIS_ENABLED: 'true',
        LIVE_ANALYSIS_SYMBOL: 'BTCUSD',
      }),
      persistence: context.persistence,
    }),
  );
});

afterAll(async () => {
  await cryptoOnly?.close();
  await multiAsset?.close();
  await context?.close();
});

const get = async (app: FastifyInstance, url: string) => {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() };
};

describe('GET /v1/instruments', () => {
  it('serves the whole catalogue with all five asset classes', async () => {
    const { status, body } = await get(multiAsset, '/v1/instruments');
    expect(status).toBe(200);

    const classes = new Set(
      body.instruments.map(
        (entry: { instrument: { assetClass: string } }) => entry.instrument.assetClass,
      ),
    );
    expect(classes).toEqual(new Set(['crypto', 'forex', 'stock', 'index', 'commodity']));
  });

  it('returns unconfigured classes rather than hiding them', async () => {
    // Hiding forex would answer "does BinaryAI support forex?" with silence,
    // and silence reads as "no" when the answer is "yes, not enabled here".
    const { body } = await get(cryptoOnly, '/v1/instruments?assetClass=forex');
    expect(body.instruments.length).toBeGreaterThan(0);
    for (const entry of body.instruments) {
      expect(entry.availability.marketData.state).toBe('not_configured');
    }
  });

  it('reports each asset class with the provider that serves it', async () => {
    const { body } = await get(multiAsset, '/v1/instruments');
    const byClass = Object.fromEntries(
      body.assetClasses.map((entry: { assetClass: string }) => [entry.assetClass, entry]),
    );

    expect(byClass['crypto']).toMatchObject({ providerId: 'coinbase', state: 'available' });
    expect(byClass['forex']).toMatchObject({ providerId: 'yahoo', state: 'available' });
    expect(byClass['stock']).toMatchObject({ providerId: 'yahoo' });
  });

  it('marks equity classes not_configured when only crypto is set', async () => {
    const { body } = await get(cryptoOnly, '/v1/instruments');
    const byClass = Object.fromEntries(
      body.assetClasses.map((entry: { assetClass: string }) => [entry.assetClass, entry]),
    );

    expect(byClass['crypto'].state).toBe('available');
    for (const assetClass of ['forex', 'stock', 'index', 'commodity']) {
      expect(byClass[assetClass]).toMatchObject({ state: 'not_configured', providerId: null });
      // Still counted: the class is implemented, just not enabled.
      expect(byClass[assetClass].instrumentCount).toBeGreaterThan(0);
    }
  });

  it('filters by asset class without leaking another class in', async () => {
    const { body } = await get(multiAsset, '/v1/instruments?assetClass=commodity');
    expect(body.instruments.length).toBeGreaterThan(0);
    for (const entry of body.instruments) {
      expect(entry.instrument.assetClass).toBe('commodity');
    }
  });

  it('searches across symbol, name and currency', async () => {
    const { body } = await get(multiAsset, '/v1/instruments?q=gold');
    expect(
      body.instruments.map((e: { instrument: { symbol: string } }) => e.instrument.symbol),
    ).toContain('XAUUSD');
  });

  it('rejects an invalid query rather than ignoring it', async () => {
    const { status } = await get(multiAsset, '/v1/instruments?assetClass=nonsense');
    expect(status).toBe(400);
  });

  it('names EVERY analysed instrument canonically', async () => {
    // R6: a single `analysedSymbol` claimed one instrument was the only one
    // analysed while the worker ran the whole configured set.
    const { body } = await get(multiAsset, '/v1/instruments');
    expect(body.analysedSymbols).toEqual(['BTCUSD']);
  });
});

describe('GET /v1/instruments/:symbol', () => {
  it('returns one instrument with its full metadata', async () => {
    const { status, body } = await get(multiAsset, '/v1/instruments/EURUSD');
    expect(status).toBe(200);
    expect(body.instrument.instrument).toMatchObject({
      symbol: 'EURUSD',
      displaySymbol: 'EUR/USD',
      assetClass: 'forex',
      providerId: 'yahoo',
      quoting: { base: 'EUR', quote: 'USD', pricePrecision: 5 },
    });
  });

  it('404s an unknown symbol and says where to look', async () => {
    const { status, body } = await get(multiAsset, '/v1/instruments/NOTREAL');
    expect(status).toBe(404);
    expect(body.error.code).toBe('unknown_instrument');
    expect(body.error.message).toContain('/v1/instruments');
  });

  it('resolves the legacy BTC-USD spelling to the canonical instrument', async () => {
    const { status, body } = await get(multiAsset, '/v1/instruments/BTC-USD');
    expect(status).toBe(200);
    expect(body.instrument.instrument.symbol).toBe('BTCUSD');
  });
});

describe('availability separates market data from analysis', () => {
  it('never reports analysis available for an unanalysed instrument', async () => {
    // The property the whole phase turns on. EUR/USD has a configured provider
    // and could have a full chart; it still produces no signal.
    const { body } = await get(multiAsset, '/v1/instruments/EURUSD');
    const { availability } = body.instrument;

    expect(availability.marketData.state).toBe('available');
    expect(availability.analysis.state).toBe('not_configured');
    expect(availability.analysis.detail).toContain('BTCUSD');
    expect(availability.paperTrading.state).not.toBe('available');
  });

  it('distinguishes not_configured from no_data', async () => {
    // Two different fixes: "configure a provider" versus "run an ingestion".
    const unconfigured = await get(cryptoOnly, '/v1/instruments/AAPL');
    expect(unconfigured.body.instrument.availability.marketData.state).toBe('not_configured');

    const configured = await get(multiAsset, '/v1/instruments/AAPL');
    expect(configured.body.instrument.availability.marketData.state).toBe('available');
    expect(configured.body.instrument.availability.chart.state).toBe('no_data');
  });
});

describe('GET /v1/instruments/asset-classes', () => {
  it('lists provider capabilities without leaking configuration', async () => {
    const { status, body } = await get(multiAsset, '/v1/instruments/asset-classes');
    expect(status).toBe(200);
    expect(body.providers.map((p: { id: string }) => p.id).sort()).toEqual(['coinbase', 'yahoo']);

    // Capabilities only. A credential appearing here would be a leak.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/apiKey|api_key|secret|password/i);
  });

  it("surfaces the vendor's limitations, including the undocumented warning", async () => {
    const { body } = await get(multiAsset, '/v1/instruments/asset-classes');
    const yahoo = body.providers.find((p: { id: string }) => p.id === 'yahoo');
    expect(yahoo.limitations.join(' ')).toContain('UNDOCUMENTED');
  });
});

describe('POST /v1/market-data/ingest is gated by the catalogue', () => {
  const ingest = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/market-data/ingest', payload });

  it('refuses a symbol the catalogue does not declare', async () => {
    // Previously this string became a row in `market_assets` verbatim.
    const response = await ingest(multiAsset, {
      asset: 'MADE-UP-SYMBOL',
      timeframe: '1m',
      from: Date.now() - 60_000,
      to: Date.now(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('unknown_instrument');
  });

  it('refuses an instrument whose class has no provider', async () => {
    const response = await ingest(cryptoOnly, {
      asset: 'EURUSD',
      timeframe: '1m',
      from: Date.now() - 60_000,
      to: Date.now(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('provider_not_configured');
    expect(response.json().error.message).toContain('forex');
  });

  it('refuses a timeframe the instrument does not support', async () => {
    const response = await ingest(multiAsset, {
      asset: 'BTCUSD',
      timeframe: '30m',
      from: Date.now() - 3_600_000,
      to: Date.now(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_timeframe');
    // Names what IS supported, rather than only what is not.
    expect(response.json().error.message).toMatch(/1m/);
  });

  it('refuses an inverted range', async () => {
    const response = await ingest(multiAsset, {
      asset: 'BTCUSD',
      timeframe: '1m',
      from: Date.now(),
      to: Date.now() - 60_000,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_range');
  });

  it('rejects a malformed body before touching a provider', async () => {
    const response = await ingest(multiAsset, { asset: 'BTCUSD' });
    expect(response.statusCode).toBe(400);
  });
});

describe('no cross-instrument leakage', () => {
  /**
   * Two instruments, two candle histories, deliberately different prices.
   *
   * The bug this guards against is not hypothetical: every per-instrument query
   * joins through `market_assets`, and a join written one table too wide
   * returns both instruments' bars with nothing in the response admitting it.
   */
  beforeAll(async () => {
    const { repositories } = context.persistence;
    await repositories.assets.upsert({
      symbol: 'BTCUSD',
      displayName: 'Bitcoin / US Dollar',
      assetClass: 'crypto',
      pricePrecision: 2,
      isOtc: false,
    });
    await repositories.assets.upsert({
      symbol: 'EURUSD',
      displayName: 'Euro / US Dollar',
      assetClass: 'forex',
      pricePrecision: 5,
      isOtc: false,
    });

    const bars = (base: number) =>
      Array.from({ length: 5 }, (_unused, index) => ({
        timestamp: 1_700_000_000_000 + index * 60_000,
        open: base,
        high: base + 1,
        low: base - 1,
        close: base,
        volume: 10,
        complete: true,
      }));

    await repositories.candles.upsertSeries({
      asset: 'BTCUSD',
      timeframe: '1m',
      source: 'historical_provider',
      candles: bars(50_000),
    });
    await repositories.candles.upsertSeries({
      asset: 'EURUSD',
      timeframe: '1m',
      source: 'historical_provider',
      candles: bars(1.1),
    });
  });

  it('returns only the requested instrument’s candles', async () => {
    const btc = await get(multiAsset, '/v1/market-data/candles?asset=BTCUSD&timeframe=1m');
    const eur = await get(multiAsset, '/v1/market-data/candles?asset=EURUSD&timeframe=1m');

    expect(btc.body.series.asset).toBe('BTCUSD');
    expect(eur.body.series.asset).toBe('EURUSD');

    // A five-figure price appearing in the FX series is the leak.
    expect(btc.body.series.candles.every((c: { close: number }) => c.close === 50_000)).toBe(true);
    expect(eur.body.series.candles.every((c: { close: number }) => c.close === 1.1)).toBe(true);
  });

  it('reports coverage per instrument, not pooled', async () => {
    const rows = await context.persistence.repositories.candles.coverage();
    const btc = rows.find((row) => row.assetSymbol === 'BTCUSD' && row.timeframe === '1m');
    const eur = rows.find((row) => row.assetSymbol === 'EURUSD' && row.timeframe === '1m');

    expect(btc?.candles).toBe(5);
    expect(eur?.candles).toBe(5);
  });

  it('reflects real storage in each instrument’s chart capability', async () => {
    const stored = await get(multiAsset, '/v1/instruments/EURUSD');
    expect(stored.body.instrument.availability.chart.state).toBe('available');
    expect(stored.body.instrument.storedTimeframes).toEqual(['1m']);

    // An instrument with nothing stored must not inherit its neighbour's.
    const empty = await get(multiAsset, '/v1/instruments/SOLUSD');
    expect(empty.body.instrument.availability.chart.state).toBe('no_data');
    expect(empty.body.instrument.storedTimeframes).toEqual([]);
  });

  it('keeps analysis pinned to one instrument regardless of stored data', async () => {
    // Both have candles. Only the configured one is analysed.
    const btc = await get(multiAsset, '/v1/instruments/BTCUSD');
    const eur = await get(multiAsset, '/v1/instruments/EURUSD');

    expect(btc.body.instrument.availability.analysis.state).toBe('available');
    expect(eur.body.instrument.availability.analysis.state).toBe('not_configured');
  });
});
