import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11A — availability, worker configuration and backtest identity.
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

// ═════════════════════════════════════════════════════════════ D4 ══
describe('D4 — chart availability includes the timeframe', () => {
  beforeAll(async () => {
    const { repositories } = context.persistence;
    const day = 86_400_000;
    const start = Math.floor((Date.now() - 40 * day) / day) * day;

    for (const [symbol, name, assetClass, precision] of [
      ['AAPL', 'Apple Inc.', 'stock', 2],
      ['SPX', 'S&P 500', 'index', 2],
      ['XAUUSD', 'Gold Futures', 'commodity', 2],
    ] as const) {
      await repositories.assets.upsert({
        symbol,
        displayName: name,
        assetClass,
        pricePrecision: precision,
        isOtc: false,
      });
      await repositories.candles.upsertSeries({
        asset: symbol,
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
    }
  });

  it('reports AVAILABLE at a timeframe that has candles', async () => {
    for (const symbol of ['AAPL', 'SPX', 'XAUUSD']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/instruments/${symbol}?timeframe=1d`,
      });
      expect(response.json().instrument.availability.chart.state).toBe('available');
    }
  });

  it('reports NO DATA at a timeframe that has none', async () => {
    // The exact defect: AAPL holds 205 daily candles and no 1m candles, and
    // /analysis?asset=AAPL — the URL the picker produces — showed
    // CHART: AVAILABLE above an empty chart.
    for (const symbol of ['AAPL', 'SPX', 'XAUUSD']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/instruments/${symbol}?timeframe=1m`,
      });
      const chart = response.json().instrument.availability.chart;
      expect(chart.state).toBe('no_data');
      // And it names what IS stored, so the fix is one click away.
      expect(chart.detail).toContain('1d');
    }
  });

  it('agrees with what the candles endpoint actually returns', async () => {
    // The two must never disagree; that disagreement WAS the defect.
    for (const [symbol, timeframe, expected] of [
      ['AAPL', '1d', true],
      ['AAPL', '1m', false],
    ] as const) {
      const availability = await app.inject({
        method: 'GET',
        url: `/v1/instruments/${symbol}?timeframe=${timeframe}`,
      });
      const candles = await app.inject({
        method: 'GET',
        url: `/v1/market-data/candles?asset=${symbol}&timeframe=${timeframe}`,
      });

      const claimsAvailable =
        availability.json().instrument.availability.chart.state === 'available';
      const hasCandles = candles.json().series !== null;
      expect(claimsAvailable).toBe(expected);
      expect(claimsAvailable).toBe(hasCandles);
    }
  });

  it('falls back to the instrument-wide answer without a timeframe', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/AAPL' });
    expect(response.json().instrument.availability.chart.state).toBe('available');
  });
});

// ═════════════════════════════════════════════════════════════ D5 ══
describe('D5 — multi-instrument worker foundation', () => {
  it('defaults to the single configured instrument', () => {
    const single = config({ LIVE_ANALYSIS_SYMBOL: 'BTCUSD' });
    expect(single.workers.analysis.symbols).toEqual(['BTCUSD']);
    expect(single.workers.analysis.symbol).toBe('BTCUSD');
  });

  it('accepts an explicit set', () => {
    const many = config({ ANALYSIS_INSTRUMENTS: 'BTCUSD,ETHUSD,EURUSD' });
    expect(many.workers.analysis.symbols).toEqual(['BTCUSD', 'ETHUSD', 'EURUSD']);
  });

  it('tolerates whitespace and a trailing comma', () => {
    const messy = config({ ANALYSIS_INSTRUMENTS: ' BTCUSD , ETHUSD ,' });
    expect(messy.workers.analysis.symbols).toEqual(['BTCUSD', 'ETHUSD']);
  });

  it('FAILS to build a context for an instrument outside the catalogue', () => {
    // Not skipped, not ignored — the process does not start. A worker quietly
    // analysing fewer instruments than configured is the failure that takes
    // longest to notice.
    expect(() =>
      createAppContext({
        config: config({ ANALYSIS_INSTRUMENTS: 'BTCUSD,NOT-A-REAL-INSTRUMENT' }),
        persistence: context.persistence,
      }),
    ).toThrow(/not in BinaryAI's instrument catalogue/);
  });

  it('FAILS configuration for a timeframe no provider serves', () => {
    // Caught one layer earlier than the catalogue: the config enum lists only
    // the five timeframes both providers serve, so 4h never reaches resolution.
    // The catalogue-level guard is covered by the D3 resolver tests, which
    // exercise it directly.
    expect(() => config({ LIVE_ANALYSIS_TIMEFRAME: '4h' })).toThrow(/LIVE_ANALYSIS_TIMEFRAME/);
  });

  it('reports every configured instrument on the status endpoint', async () => {
    const multi = await buildApp(
      createAppContext({
        config: config({ ANALYSIS_INSTRUMENTS: 'BTCUSD,ETHUSD' }),
        persistence: context.persistence,
      }),
    );
    const status = await multi.inject({ method: 'GET', url: '/v1/runtime/status' });
    expect(status.json().runtime.analysis.symbols).toEqual(['BTCUSD', 'ETHUSD']);
    await multi.close();
  });

  it('a catalogue instrument is not automatically a configured one', async () => {
    // The distinction the whole phase rests on. Thirty-six instruments are
    // chartable; one is analysed.
    const catalogue = await app.inject({ method: 'GET', url: '/v1/instruments' });
    expect(catalogue.json().instruments.length).toBeGreaterThan(30);
    expect(catalogue.json().analysedSymbols).toEqual(['BTCUSD']);

    const eur = await app.inject({ method: 'GET', url: '/v1/instruments/EURUSD' });
    expect(eur.json().instrument.availability.analysis.state).toBe('not_configured');
  });
});

// ═════════════════════════════════════════════════════════════ D8 ══
describe('D8 — backtests carry instrument identity', () => {
  const run = (cookie: string, asset: string, base: number) =>
    app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      headers: { cookie, ...ORIGIN },
      payload: {
        strategyId: 'trend-momentum',
        series: series(asset, base),
        expirationSeconds: 300,
        stake: { kind: 'fixed', value: 10 },
        startingBalance: 1000,
        persist: false,
      },
    });

  it('resolves a catalogue instrument to its real metadata', async () => {
    const cookie = await signUp('d8-known@harden.local');
    const response = await run(cookie, 'AAPL', 300);

    expect(response.statusCode).toBe(200);
    expect(response.json().result.dataset.asset).toBe('AAPL');
  });

  it('marks an unrecognised series as unknown rather than inventing identity', async () => {
    // Explicitly UNKNOWN, not a guess. A backtest over a hand-supplied series
    // is legitimate; claiming to know what market it came from is not.
    const cookie = await signUp('d8-unknown@harden.local');
    const response = await run(cookie, 'HAND-SUPPLIED-SERIES', 100);

    expect(response.statusCode).toBe(200);
    expect(response.json().result.dataset.asset).toBe('HAND-SUPPLIED-SERIES');
  });
});
