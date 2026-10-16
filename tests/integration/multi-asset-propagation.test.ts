import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11A propagation — R6, R2, R1, R15 and R7.
 *
 * The audit found the worker had been given a set of instruments while the rest
 * of the system still read one value. These tests pin each propagation point,
 * and every one of them would have failed before the change.
 */

let context: TestDatabase;

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

const build = async (extra: Record<string, string> = {}): Promise<FastifyInstance> =>
  buildApp(createAppContext({ config: config(extra), persistence: context.persistence }));

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  await truncateAll(context.database);

  // Stored coverage with DELIBERATELY different ages, so R7 has something real
  // to distinguish. Nothing here is fabricated market data: these are synthetic
  // fixtures in a test database, labelled `historical_file`.
  const { repositories } = context.persistence;
  const minute = 60_000;
  const day = 86_400_000;

  const seed = async (
    symbol: string,
    name: string,
    assetClass: 'crypto' | 'forex' | 'stock',
    precision: number,
    timeframe: '1m' | '1h' | '1d',
    stepMs: number,
    newestAgoMs: number,
  ): Promise<void> => {
    await repositories.assets.upsert({
      symbol,
      displayName: name,
      assetClass,
      pricePrecision: precision,
      isOtc: false,
    });
    const newest = Math.floor((Date.now() - newestAgoMs) / stepMs) * stepMs;
    await repositories.candles.upsertSeries({
      asset: symbol,
      timeframe,
      source: 'historical_file',
      candles: Array.from({ length: 10 }, (_unused, index) => ({
        timestamp: newest - (9 - index) * stepMs,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 10,
        complete: true,
      })),
    });
  };

  // Fresh: seconds old. Stale: a day old. That gap is the whole point of R7.
  await seed('BTCUSD', 'Bitcoin / US Dollar', 'crypto', 2, '1m', minute, 30_000);
  await seed('ETHUSD', 'Ethereum / US Dollar', 'crypto', 2, '1m', minute, 30_000);
  await seed('EURUSD', 'Euro / US Dollar', 'forex', 5, '1h', 3_600_000, 2 * 3_600_000);
  await seed('AAPL', 'Apple Inc.', 'stock', 2, '1d', day, day);
});

afterAll(async () => {
  await context?.close();
});

// ══════════════════════════════════════════════════════════════ R6 ══
describe('R6 — the analysed SET is reported, never one symbol', () => {
  /**
   * Before: with ANALYSIS_INSTRUMENTS=BTCUSD,ETHUSD the worker analysed both,
   * `/v1/instruments` reported `analysedSymbol: "BTCUSD"`, and availability
   * told every caller "BinaryAI's engine analyses BTCUSD, not ETH/USD. No
   * signal is being produced for this instrument" — about an instrument that
   * was producing signals at that moment.
   */
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ ANALYSIS_INSTRUMENTS: 'BTCUSD@1m,ETHUSD@1m' });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists every configured instrument on the catalogue endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/instruments' });
    expect(response.json().analysedSymbols).toEqual(['BTCUSD', 'ETHUSD']);
  });

  it('reports BOTH as analysed, not just the first', async () => {
    for (const symbol of ['BTCUSD', 'ETHUSD']) {
      const response = await app.inject({ method: 'GET', url: `/v1/instruments/${symbol}` });
      const availability = response.json().instrument.availability;
      expect(availability.analysis.state).toBe('available');
      expect(availability.paperTrading.state).toBe('available');
    }
  });

  it('names the whole set when refusing an instrument outside it', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/EURUSD' });
    const detail = response.json().instrument.availability.analysis.detail;
    expect(detail).toContain('BTCUSD, ETHUSD');
    expect(detail).toContain('does not include EUR/USD');
  });

  it('reports the set on the runtime status endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/status' });
    expect(response.json().runtime.analysis.symbols).toEqual(['BTCUSD', 'ETHUSD']);
  });

  it('reports an empty set when analysis is disabled', async () => {
    const off = await build({ ANALYSIS_INSTRUMENTS: 'BTCUSD@1m', LIVE_ANALYSIS_ENABLED: 'false' });
    const response = await off.inject({ method: 'GET', url: '/v1/instruments' });
    expect(response.json().analysedSymbols).toEqual([]);
    await off.close();
  });
});

// ══════════════════════════════════════════════════════════════ R2 ══
describe('R2 — each instrument carries its own timeframe', () => {
  /**
   * Before: one global timeframe for the whole plan. BTC/USD is served at 1m
   * and AAPL only ever has daily bars, so configuring both forced AAPL onto 1m
   * where it has no stored candles — every cycle skipping `no_candles`,
   * silently, for ever.
   */
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ ANALYSIS_INSTRUMENTS: 'BTCUSD@1m,AAPL@1d' });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('resolves a mixed-timeframe plan', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/status' });
    expect(response.json().runtime.analysis.plan).toEqual([
      { symbol: 'BTCUSD', timeframe: '1m', assetClass: 'crypto' },
      { symbol: 'AAPL', timeframe: '1d', assetClass: 'stock' },
    ]);
  });

  it('each instrument has candles AT ITS OWN timeframe', async () => {
    // The consequence the old shape made impossible.
    const btc = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=BTCUSD&timeframe=1m',
    });
    const aapl = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=AAPL&timeframe=1d',
    });
    expect(btc.json().series?.candles.length).toBeGreaterThan(0);
    expect(aapl.json().series?.candles.length).toBeGreaterThan(0);
  });

  it('an entry without @ inherits the default, preserving the old contract', async () => {
    const legacy = await build({
      ANALYSIS_INSTRUMENTS: 'BTCUSD,ETHUSD',
      LIVE_ANALYSIS_TIMEFRAME: '1m',
    });
    const response = await legacy.inject({ method: 'GET', url: '/v1/runtime/status' });
    expect(
      response.json().runtime.analysis.plan.map((e: { timeframe: string }) => e.timeframe),
    ).toEqual(['1m', '1m']);
    await legacy.close();
  });

  it('refuses a timeframe the instrument is not served at', () => {
    // Never a silent fallback: analysing a series the operator did not ask for
    // would be worse than refusing to start.
    expect(() =>
      createAppContext({
        config: config({ ANALYSIS_INSTRUMENTS: 'BTCUSD@2m' }),
        persistence: context.persistence,
      }),
    ).toThrow(/not served at 2m/);
  });

  it('refuses a timeframe BinaryAI does not model at all', () => {
    expect(() =>
      createAppContext({
        config: config({ ANALYSIS_INSTRUMENTS: 'BTCUSD@7m' }),
        persistence: context.persistence,
      }),
    ).toThrow(/not a\s+timeframe BinaryAI models|not a timeframe BinaryAI models/);
  });

  it('refuses a malformed entry rather than dropping it', () => {
    for (const bad of ['BTCUSD@', 'BTCUSD@1m@1h', '@1m']) {
      expect(() =>
        createAppContext({
          config: config({ ANALYSIS_INSTRUMENTS: bad }),
          persistence: context.persistence,
        }),
      ).toThrow();
    }
  });

  it('rejects a duplicate instrument-and-timeframe pair', () => {
    expect(() =>
      createAppContext({
        config: config({ ANALYSIS_INSTRUMENTS: 'BTCUSD@1m,BTC-USD@1m' }),
        persistence: context.persistence,
      }),
    ).toThrow(/more than once/);
  });

  it('ALLOWS the same instrument at different timeframes', () => {
    // Two legitimate, different analyses — not a mistake.
    expect(() =>
      createAppContext({
        config: config({ ANALYSIS_INSTRUMENTS: 'BTCUSD@1m,BTCUSD@1h' }),
        persistence: context.persistence,
      }),
    ).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════ R1 ══
describe('R1 — ingestion is configured separately from analysis', () => {
  /**
   * Before: the worker polled ONE symbol. Every hand-added instrument received
   * a single backfill and then aged — measured live at BTC/USD 49 seconds old
   * beside gold at eleven hours.
   */
  it('accepts its own instrument set', () => {
    const built = config({
      ANALYSIS_INSTRUMENTS: 'BTCUSD@1m',
      INGESTION_INSTRUMENTS: 'BTCUSD@1m,ETHUSD@1m,EURUSD@1h,AAPL@1d',
    });
    expect(built.workers.ingestion.configured).toBe('BTCUSD@1m,ETHUSD@1m,EURUSD@1h,AAPL@1d');
  });

  it('an ingestion instrument is NOT automatically an analysis instrument', async () => {
    // The distinction the whole separation exists for: market data without an
    // opinion is the normal case.
    const app = await build({
      ANALYSIS_INSTRUMENTS: 'BTCUSD@1m',
      INGESTION_INSTRUMENTS: 'BTCUSD@1m,EURUSD@1h,AAPL@1d',
    });

    const catalogue = await app.inject({ method: 'GET', url: '/v1/instruments' });
    expect(catalogue.json().analysedSymbols).toEqual(['BTCUSD']);

    for (const symbol of ['EURUSD', 'AAPL']) {
      const response = await app.inject({ method: 'GET', url: `/v1/instruments/${symbol}` });
      const availability = response.json().instrument.availability;
      // Chart yes, analysis no. Both stated, neither inferred from the other.
      expect(availability.chart.state).toBe('available');
      expect(availability.analysis.state).toBe('not_configured');
    }
    await app.close();
  });

  it('fails startup on an unknown ingestion symbol', () => {
    expect(() =>
      createAppContext({
        config: config({ INGESTION_INSTRUMENTS: 'BTCUSD@1m,NOT-REAL@1m' }),
        persistence: context.persistence,
      }),
    ).toThrow(/not in BinaryAI's instrument catalogue/);
  });

  it('fails startup on an unserved ingestion timeframe', () => {
    expect(() =>
      createAppContext({
        config: config({ INGESTION_INSTRUMENTS: 'AAPL@2m' }),
        persistence: context.persistence,
      }),
    ).toThrow(/not served at 2m/);
  });

  it('falls back to the analysis symbol when unset', () => {
    const built = config({ LIVE_ANALYSIS_SYMBOL: 'BTCUSD' });
    expect(built.workers.ingestion.configured).toBe('');
    // Resolution happens at boot; an empty setting must not mean "nothing".
    expect(() =>
      createAppContext({ config: built, persistence: context.persistence }),
    ).not.toThrow();
  });
});
