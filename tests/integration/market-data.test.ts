import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import { COINBASE_CAPABILITIES } from '@binaryai/market-data';
import type { Candle, MarketDataProvider, ProviderFetchResult } from '@binaryai/types';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Market data end to end: provider -> normalize -> validate -> PostgreSQL,
 * driven through the real API.
 *
 * The provider is a deterministic stub. The database is a real PostgreSQL
 * engine. That combination is deliberate: the network is the part that must not
 * be in the test, and storage is the part that must be real.
 */

const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

function candles(count: number, startMs = T0): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: startMs + index * MINUTE,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1.5,
    complete: true,
  }));
}

function stubProvider(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  return {
    capabilities: COINBASE_CAPABILITIES,
    listAssets: async () => [
      {
        symbol: 'BTCUSD',
        providerSymbol: 'BTC-USD',
        displayName: 'BTC/USD',
        assetClass: 'crypto',
        pricePrecision: 2,
        quoteCurrency: 'USD',
        tradable: true,
      },
    ],
    ping: async () => true,
    fetchCandles: async (request): Promise<ProviderFetchResult> => ({
      symbol: request.symbol,
      timeframe: request.timeframe,
      source: 'historical_provider',
      origin: 'exchange',
      candles: candles(120, request.from ?? T0),
      meta: {
        providerId: 'coinbase',
        providerSymbol: 'BTC-USD',
        requestedAt: Date.now(),
        receivedAt: Date.now() + 30,
        latencyMs: 30,
        candlesReturned: 120,
        endpoint: '/products/BTC-USD/candles',
      },
    }),
    ...overrides,
  };
}

let context: TestDatabase;
let app: FastifyInstance;
let appWithoutProvider: FastifyInstance;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);

  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  app = await buildApp(
    createAppContext({
      config,
      persistence: context.persistence,
      marketDataProvider: stubProvider(),
    }),
  );
  appWithoutProvider = await buildApp(
    createAppContext({ config, persistence: null, marketDataProvider: null }),
  );
});

beforeEach(async () => {
  await truncateAll(context.database);
});

afterAll(async () => {
  await context?.close();
});

describe('without a provider configured', () => {
  it('reports not_configured rather than pretending', async () => {
    const body = (
      await appWithoutProvider.inject({ method: 'GET', url: '/v1/market-data/status' })
    ).json();
    expect(body.status.state).toBe('not_configured');
    expect(body.provider).toBeNull();
  });

  it('returns an empty asset list with the reason', async () => {
    const body = (
      await appWithoutProvider.inject({ method: 'GET', url: '/v1/market-data/assets' })
    ).json();
    expect(body.assets).toEqual([]);
    expect(body.reason).toMatch(/MARKET_DATA_PROVIDER/);
  });

  it('refuses ingestion with a 503', async () => {
    const response = await appWithoutProvider.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 60 * MINUTE },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('provider_not_configured');
  });
});

describe('provider metadata', () => {
  it('exposes capabilities but never a credential', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/market-data/status' })).json();
    const serialized = JSON.stringify(body);

    expect(body.provider.id).toBe('coinbase');
    expect(body.provider.dataOrigin).toBe('exchange');
    expect(body.provider.requiresCredentials).toBe(false);
    expect(serialized).not.toMatch(/apiKey|api_key|secret|token|password/i);
    // Capabilities describe the provider; they never carry configuration.
    expect(serialized).not.toContain('MARKET_DATA_API_KEY');
  });

  it('states the timeframes it actually serves', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/market-data/status' })).json();
    expect(body.provider.supportedTimeframes).toEqual(['1m', '5m', '15m', '1h', '1d']);
  });

  it('lists assets as BinaryAI symbols', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/market-data/assets' })).json();
    expect(body.assets[0].symbol).toBe('BTCUSD');
    expect(body.assets[0].providerSymbol).toBe('BTC-USD');
    expect(body.origin).toBe('exchange');
  });
});

describe('ingestion through to PostgreSQL', () => {
  it('stores validated candles and reports metrics', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 120 * MINUTE },
    });

    expect(response.statusCode).toBe(200);
    const { result } = response.json();
    expect(result.status).toBe('completed');
    expect(result.persisted).toBe(true);
    expect(result.metrics.candlesStored).toBeGreaterThan(0);
    expect(result.metrics.candlesRejected).toBe(0);
    expect(result.providerId).toBe('coinbase');
  });

  it('makes the stored candles readable back with correct OHLC', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 120 * MINUTE },
    });

    const body = (
      await app.inject({ method: 'GET', url: '/v1/market-data/candles?asset=BTCUSD&timeframe=1m' })
    ).json();

    expect(body.series).not.toBeNull();
    expect(body.count).toBeGreaterThan(0);

    const first = body.series.candles[0];
    expect(first.high).toBeGreaterThanOrEqual(Math.max(first.open, first.close));
    expect(first.low).toBeLessThanOrEqual(Math.min(first.open, first.close));
    // Provenance survives the round trip.
    expect(body.series.source).toBe('historical_provider');
  });

  it('is idempotent: re-ingesting the same window does not duplicate', async () => {
    const payload = { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 120 * MINUTE };
    await app.inject({ method: 'POST', url: '/v1/market-data/ingest', payload });
    const countAfterFirst = await context.persistence.repositories.candles.count('BTCUSD', '1m');

    await app.inject({ method: 'POST', url: '/v1/market-data/ingest', payload });
    const countAfterSecond = await context.persistence.repositories.candles.count('BTCUSD', '1m');

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('registers the asset it ingested for', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 60 * MINUTE },
    });
    const asset = await context.persistence.repositories.assets.findBySymbol('BTCUSD');
    expect(asset).not.toBeNull();
  });

  it('records an ingestion event in the audit log', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 60 * MINUTE },
    });
    const events = await context.persistence.repositories.systemEvents.list({
      category: 'market_data',
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.code).toBe('ingestion_completed');
  });
});

describe('request validation', () => {
  it('rejects an unsupported timeframe with the supported list', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '30m', from: T0, to: T0 + 60 * MINUTE },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_timeframe');
    expect(response.json().error.message).toMatch(/1m, 5m, 15m, 1h, 1d/);
  });

  it('rejects an inverted range', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0 + MINUTE, to: T0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires an explicit window; there is no fetch-everything path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('caps the requested candle ceiling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + MINUTE, maxCandles: 99_999 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('validates the candles query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/market-data/candles?asset=BTCUSD&timeframe=nope',
    });
    expect(response.statusCode).toBe(400);
  });

  it('says why there are no candles rather than returning an empty array', async () => {
    const body = (
      await app.inject({ method: 'GET', url: '/v1/market-data/candles?asset=NOPEUSD&timeframe=1m' })
    ).json();
    expect(body.series).toBeNull();
    expect(body.reason).toMatch(/No stored candles/);
  });
});

describe('status reflects real ingestion state', () => {
  it('reports degraded before anything is ingested', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/market-data/status' })).json();
    expect(body.status.state).toBe('degraded');
    expect(body.status.reachable).toBe(true);
    expect(body.status.lastCandleAt).toBeNull();
  });

  it('reports stale for old data rather than presenting it as current', async () => {
    // The stub serves candles from 2026-01-01, which are far older than the
    // staleness threshold — the status must say so.
    await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 60 * MINUTE },
    });

    const body = (await app.inject({ method: 'GET', url: '/v1/market-data/status' })).json();
    expect(body.status.state).toBe('stale');
    expect(body.status.stalenessSeconds).toBeGreaterThan(300);
    expect(body.status.detail).toMatch(/not current/i);
  });

  it('surfaces ingestion counters', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/market-data/ingest',
      payload: { asset: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 60 * MINUTE },
    });

    const body = (await app.inject({ method: 'GET', url: '/v1/market-data/status' })).json();
    expect(body.ingestion.runs).toBeGreaterThan(0);
    expect(body.ingestion.candlesStoredTotal).toBeGreaterThan(0);
    expect(body.ingestion.lastSuccessAt).not.toBeNull();
    expect(body.ingestion.lastLatencyMs).toBe(30);
  });

  it('reports disconnected when the provider stops answering', async () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const offline = await buildApp(
      createAppContext({
        config,
        persistence: context.persistence,
        marketDataProvider: stubProvider({ ping: async () => false }),
      }),
    );

    const body = (await offline.inject({ method: 'GET', url: '/v1/market-data/status' })).json();
    expect(body.status.state).toBe('disconnected');
    expect(body.status.reachable).toBe(false);
  });
});
