import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../provider-error.js';
import {
  COINBASE_CAPABILITIES,
  createCoinbaseProvider,
  parseCandles,
  parseProducts,
  precisionFromIncrement,
  toBinaryAiSymbol,
  toProviderSymbol,
} from './coinbase.js';

/**
 * Adapter tests run against RECORDED PROVIDER RESPONSES captured from the live
 * Coinbase Exchange API (see fixtures/README.md). No test touches the network:
 * a suite that depends on an external API is not deterministic, and a provider
 * outage must never look like a BinaryAI regression.
 */

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));

const candles1m = fixture('coinbase-candles-1m.json');
const products = fixture('coinbase-products.json');

/** Minimal Response stand-in; only what the adapter reads. */
function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('symbol mapping', () => {
  it('maps BinaryAI symbols to provider symbols', () => {
    expect(toProviderSymbol('BTCUSD')).toBe('BTC-USD');
    expect(toProviderSymbol('ETHUSD')).toBe('ETH-USD');
    expect(toProviderSymbol('SOLEUR')).toBe('SOL-EUR');
  });

  it('prefers the longest matching quote currency', () => {
    // USDT must not be split as USD + T.
    expect(toProviderSymbol('BTCUSDT')).toBe('BTC-USDT');
    expect(toProviderSymbol('BTCUSDC')).toBe('BTC-USDC');
  });

  it('passes through a symbol that is already provider-shaped', () => {
    expect(toProviderSymbol('BTC-USD')).toBe('BTC-USD');
  });

  it('round-trips', () => {
    expect(toBinaryAiSymbol(toProviderSymbol('BTCUSD'))).toBe('BTCUSD');
    expect(toBinaryAiSymbol('ETH-EUR')).toBe('ETHEUR');
  });
});

describe('parseCandles', () => {
  it('maps the provider row order correctly', () => {
    // The row is [time, LOW, HIGH, open, close, volume] — low and high come
    // BEFORE open and close. Assuming conventional OHLC order would silently
    // corrupt every candle, so this is asserted against a recorded response.
    const parsed = parseCandles([
      [1_787_660_640, 78_814.65, 78_887.97, 78_833.32, 78_868.08, 2.07],
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      timestamp: 1_787_660_640_000,
      open: 78_833.32,
      high: 78_887.97,
      low: 78_814.65,
      close: 78_868.08,
      volume: 2.07,
      complete: true,
    });
  });

  it('produces internally consistent OHLC for every recorded candle', () => {
    for (const candle of parseCandles(candles1m)) {
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
      expect(candle.high).toBeGreaterThanOrEqual(candle.low);
      expect(candle.open).toBeGreaterThan(0);
    }
  });

  it('converts seconds to milliseconds', () => {
    const parsed = parseCandles(candles1m);
    expect(parsed[0]?.timestamp).toBeGreaterThan(1_000_000_000_000);
    expect(parsed[0]!.timestamp % 1000).toBe(0);
  });

  it('returns candles ascending regardless of provider order', () => {
    // The API returns newest-first; everything downstream assumes chronological.
    const parsed = parseCandles(candles1m);
    const timestamps = parsed.map((candle) => candle.timestamp);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it('skips malformed rows rather than inventing values', () => {
    const parsed = parseCandles([
      [1_787_660_640, 1, 2, 1.5, 1.8, 1],
      'not a row',
      [1],
      [1_787_660_700, 'x', 2, 1.5, 1.8, 1],
      null,
    ]);
    expect(parsed).toHaveLength(1);
  });

  it('records a missing volume as null, not zero', () => {
    const parsed = parseCandles([[1_787_660_640, 1, 2, 1.5, 1.8, 'n/a']]);
    expect(parsed[0]?.volume).toBeNull();
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseCandles({ message: 'NotFound' })).toThrow(ProviderError);
  });
});

describe('parseProducts', () => {
  it('maps recorded products into BinaryAI assets', () => {
    const assets = parseProducts(products);
    expect(assets.length).toBeGreaterThan(0);
    const first = assets[0]!;
    expect(first.providerSymbol).toContain('-');
    expect(first.symbol).not.toContain('-');
    expect(first.assetClass).toBe('crypto');
    expect(first.quoteCurrency).toBe('USD');
  });

  it('derives price precision from quote_increment', () => {
    expect(precisionFromIncrement('0.01')).toBe(2);
    expect(precisionFromIncrement('0.0001')).toBe(4);
    expect(precisionFromIncrement('1')).toBe(0);
    expect(precisionFromIncrement('garbage')).toBe(2);
  });

  it('marks offline products as not tradable', () => {
    const assets = parseProducts([
      { id: 'AAA-USD', quote_currency: 'USD', status: 'offline', quote_increment: '0.01' },
      { id: 'BBB-USD', quote_currency: 'USD', status: 'online', quote_increment: '0.01' },
    ]);
    expect(assets.find((a) => a.symbol === 'AAAUSD')?.tradable).toBe(false);
    expect(assets.find((a) => a.symbol === 'BBBUSD')?.tradable).toBe(true);
  });
});

describe('capabilities', () => {
  it('declares exchange origin, never broker pricing', () => {
    // Market data is not the price a binary-options broker settles on.
    expect(COINBASE_CAPABILITIES.dataOrigin).toBe('exchange');
    expect(COINBASE_CAPABILITIES.limitations.join(' ')).toMatch(/not binary-options broker/i);
  });

  it('needs no credentials', () => {
    expect(COINBASE_CAPABILITIES.requiresCredentials).toBe(false);
  });

  it('only claims timeframes the provider actually serves', () => {
    expect(COINBASE_CAPABILITIES.supportedTimeframes).toEqual(['1m', '5m', '15m', '1h', '1d']);
    expect(COINBASE_CAPABILITIES.supportedTimeframes).not.toContain('30m');
    expect(COINBASE_CAPABILITIES.supportedTimeframes).not.toContain('4h');
  });
});

describe('fetchCandles', () => {
  it('requests the right granularity and window', async () => {
    let captured = '';
    const provider = createCoinbaseProvider({
      fetchImpl: async (url) => {
        captured = url;
        return response(candles1m);
      },
    });

    await provider.fetchCandles({
      symbol: 'BTCUSD',
      timeframe: '1h',
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 0, 2),
    });

    expect(captured).toContain('/products/BTC-USD/candles');
    expect(captured).toContain('granularity=3600');
    expect(captured).toContain('start=2026-01-01T00%3A00%3A00.000Z');
    expect(captured).toContain('end=2026-01-02T00%3A00%3A00.000Z');
  });

  it('refuses an unsupported timeframe instead of resampling', async () => {
    const provider = createCoinbaseProvider({ fetchImpl: async () => response(candles1m) });
    await expect(provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '30m' })).rejects.toThrow(
      /does not serve 30m/,
    );
  });

  it('reports latency and provenance without leaking a full URL', async () => {
    const provider = createCoinbaseProvider({ fetchImpl: async () => response(candles1m) });
    const result = await provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' });

    expect(result.meta.providerId).toBe('coinbase');
    expect(result.meta.providerSymbol).toBe('BTC-USD');
    expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.meta.endpoint).toBe('/products/BTC-USD/candles');
    expect(result.meta.endpoint).not.toContain('http');
    expect(result.origin).toBe('exchange');
  });

  it('labels a windowed request as historical and an open one as live', async () => {
    const provider = createCoinbaseProvider({ fetchImpl: async () => response(candles1m) });
    const live = await provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' });
    const historical = await provider.fetchCandles({
      symbol: 'BTCUSD',
      timeframe: '1m',
      from: Date.UTC(2026, 0, 1),
    });
    expect(live.source).toBe('live_provider');
    expect(historical.source).toBe('historical_provider');
  });

  it('applies the caller limit to the newest candles', async () => {
    const provider = createCoinbaseProvider({ fetchImpl: async () => response(candles1m) });
    const result = await provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m', limit: 5 });
    expect(result.candles).toHaveLength(5);
  });

  it('handles an empty response without throwing', async () => {
    const provider = createCoinbaseProvider({ fetchImpl: async () => response([]) });
    const result = await provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' });
    expect(result.candles).toHaveLength(0);
  });
});

describe('failure classification', () => {
  const cases: Array<{ status: number; kind: string; retryable: boolean }> = [
    { status: 429, kind: 'rate_limited', retryable: true },
    { status: 401, kind: 'authentication', retryable: false },
    { status: 403, kind: 'authentication', retryable: false },
    { status: 404, kind: 'not_found', retryable: false },
    { status: 500, kind: 'server_error', retryable: true },
    { status: 503, kind: 'server_error', retryable: true },
    { status: 400, kind: 'bad_request', retryable: false },
  ];

  for (const { status, kind, retryable } of cases) {
    it(`classifies HTTP ${status} as ${kind} (retryable=${retryable})`, async () => {
      const provider = createCoinbaseProvider({
        fetchImpl: async () => response({ message: 'x' }, status),
      });
      try {
        await provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).kind).toBe(kind);
        expect((error as ProviderError).retryable).toBe(retryable);
      }
    });
  }

  it('classifies a timeout', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
    });
    await expect(
      provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' }),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('classifies a network failure', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(
      provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' }),
    ).rejects.toMatchObject({ kind: 'network', retryable: true });
  });

  it('classifies an unparseable body', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
        }) as unknown as Response,
    });
    await expect(
      provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1m' }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('reports ping failure as false rather than throwing', async () => {
    const provider = createCoinbaseProvider({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await provider.ping()).toBe(false);
  });
});
