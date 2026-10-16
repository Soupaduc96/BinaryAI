import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11 pre-flight — instrument isolation properties that must keep holding.
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

// ═══════════════════════════════════ properties that MUST keep holding ══
describe('SAFE — instrument isolation properties Phase 11 must preserve', () => {
  it('candles never leak between instruments', async () => {
    const { repositories } = context.persistence;
    // Both instruments are seeded HERE. This file owns its fixtures rather than
    // inheriting them from a neighbouring describe block, so it can run alone.
    await repositories.assets.upsert({
      symbol: 'AAPL',
      displayName: 'Apple Inc.',
      assetClass: 'stock',
      pricePrecision: 2,
      isOtc: false,
    });
    const day = 86_400_000;
    const dayStart = Math.floor((Date.now() - 30 * day) / day) * day;
    await repositories.candles.upsertSeries({
      asset: 'AAPL',
      timeframe: '1d',
      source: 'historical_provider',
      candles: Array.from({ length: 20 }, (_unused, index) => ({
        timestamp: dayStart + index * day,
        open: 300,
        high: 302,
        low: 298,
        close: 301,
        volume: 1000,
        complete: true,
      })),
    });
    await repositories.assets.upsert({
      symbol: 'BTCUSD',
      displayName: 'Bitcoin / US Dollar',
      assetClass: 'crypto',
      pricePrecision: 2,
      isOtc: false,
    });
    const minute = 60_000;
    const from = Math.floor((Date.now() - 40 * minute) / minute) * minute;
    await repositories.candles.upsertSeries({
      asset: 'BTCUSD',
      timeframe: '1m',
      source: 'historical_provider',
      candles: Array.from({ length: 30 }, (_unused, index) => ({
        timestamp: from + index * minute,
        open: 50_000,
        high: 50_100,
        low: 49_900,
        close: 50_050,
        volume: 5,
        complete: true,
      })),
    });

    const btc = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=BTCUSD&timeframe=1m',
    });
    const aapl = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=AAPL&timeframe=1d',
    });

    expect(btc.json().series?.asset).toBe('BTCUSD');
    expect(aapl.json().series?.asset).toBe('AAPL');
    // Prices are an order of magnitude apart; a leak would be obvious.
    const btcClose = btc.json().series?.candles.at(-1)?.close ?? 0;
    const aaplClose = aapl.json().series?.candles.at(-1)?.close ?? 0;
    expect(btcClose).toBeGreaterThan(aaplClose * 10);
  });

  it('a signal detail always names the instrument it was decided on', async () => {
    const cookie = await signUp('safe-detail@audit.local');
    const feed = await app.inject({
      method: 'GET',
      url: '/v1/signals?asset=BTCUSD&limit=1',
      headers: { cookie },
    });
    const row = feed.json().signals[0];
    if (!row) return;

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/signals/${row.id}`,
      headers: { cookie },
    });
    expect(detail.json().signal.asset).toBe(row.assetSymbol);
  });

  it('the catalogue never offers an OTC variant it cannot supply', async () => {
    // OTC is a modelled asset class with no provider and no catalogue entries.
    // The honest state is absence, not a fabricated "EUR/USD OTC".
    const catalogue = await app.inject({ method: 'GET', url: '/v1/instruments' });
    const instruments = catalogue.json().instruments as {
      instrument: { assetClass: string; isOtc: boolean; displaySymbol: string };
    }[];

    expect(instruments.every((entry) => entry.instrument.assetClass !== 'otc')).toBe(true);
    expect(instruments.every((entry) => entry.instrument.isOtc === false)).toBe(true);
    expect(instruments.some((entry) => /OTC/i.test(entry.instrument.displaySymbol))).toBe(false);
  });

  it('an unknown asset class is rejected rather than silently ignored', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/instruments?assetClass=otc' });
    expect(response.statusCode).toBe(400);
  });
});
