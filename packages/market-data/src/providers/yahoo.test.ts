import { describe, expect, it, vi } from 'vitest';
import { createYahooProvider, parseChart, YAHOO_CAPABILITIES } from './yahoo.js';
import { ProviderError } from '../provider-error.js';
import type { HttpFetch } from '../provider-error.js';

/**
 * The Yahoo adapter.
 *
 * Two things carry real risk here and both are tested against payload shapes
 * taken from the live endpoint:
 *
 *  1. NULL SLOTS. Yahoo pads its timestamp array across the whole requested
 *     range and writes null into the OHLC arrays where no bar exists —
 *     overnight, at weekends, on holidays. Carrying the previous close forward
 *     would manufacture a flat candle the market never printed.
 *
 *  2. ERROR CLASSIFICATION. 404, 400, 422 and 429 mean four different things
 *     and the UI shows four different states. Collapsing them loses the only
 *     information the user could act on.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** One chart result, in the shape the live endpoint returns. */
const chart = (timestamps: number[], quote: Record<string, (number | null)[]>) => ({
  chart: {
    result: [
      {
        meta: { currency: 'USD', instrumentType: 'EQUITY', symbol: 'AAPL' },
        timestamp: timestamps,
        indicators: { quote: [quote] },
      },
    ],
    error: null,
  },
});

describe('yahoo provider', () => {
  describe('capabilities', () => {
    it('declares the endpoint as undocumented, in the field the UI shows', () => {
      // Not a style point. This string is surfaced to the operator, and it is
      // the only warning they get before depending on an unsupported API.
      const text = YAHOO_CAPABILITIES.limitations.join(' ');
      expect(text).toContain('UNDOCUMENTED');
      expect(text).toContain('terms');
    });

    it('states that commodities are futures rather than spot', () => {
      // GC=F is COMEX gold, not spot XAU/USD. Real money rides on the
      // difference, so the adapter says so.
      expect(YAHOO_CAPABILITIES.limitations.join(' ')).toContain('FRONT-MONTH FUTURES');
    });

    it('is aggregated, never broker pricing', () => {
      expect(YAHOO_CAPABILITIES.dataOrigin).toBe('aggregated');
    });

    it('requires no credential', () => {
      expect(YAHOO_CAPABILITIES.requiresCredentials).toBe(false);
    });
  });

  describe('parseChart', () => {
    it('reads a well-formed response', () => {
      const candles = parseChart(
        chart([1000, 1060], {
          open: [10, 11],
          high: [12, 13],
          low: [9, 10],
          close: [11, 12],
          volume: [100, 200],
        }),
      );

      expect(candles).toHaveLength(2);
      expect(candles[0]).toMatchObject({
        timestamp: 1_000_000,
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 100,
      });
    });

    it('DROPS null slots instead of carrying the previous close forward', () => {
      // The single most important behaviour in this file. A weekend gap must
      // stay a gap; a synthesised flat bar is fabricated market data.
      const candles = parseChart(
        chart([1000, 1060, 1120], {
          open: [10, null, 12],
          high: [12, null, 14],
          low: [9, null, 11],
          close: [11, null, 13],
          volume: [100, null, 300],
        }),
      );

      expect(candles).toHaveLength(2);
      expect(candles.map((candle) => candle.close)).toEqual([11, 13]);
      expect(candles.some((candle) => candle.close === 11 && candle.timestamp === 1_060_000)).toBe(
        false,
      );
    });

    it('drops a slot where only some fields are null', () => {
      // A bar with a close but no high is not a bar.
      const candles = parseChart(
        chart([1000], { open: [10], high: [null], low: [9], close: [11], volume: [100] }),
      );
      expect(candles).toHaveLength(0);
    });

    it('keeps a bar whose volume alone is missing', () => {
      // FX and indices have no traded volume at all. Rejecting those would
      // discard every forex and index candle.
      const candles = parseChart(
        chart([1000], { open: [10], high: [12], low: [9], close: [11], volume: [null] }),
      );
      expect(candles).toHaveLength(1);
      expect(candles[0]?.volume).toBeNull();
    });

    it('returns ascending candles regardless of input order', () => {
      const candles = parseChart(
        chart([2000, 1000], {
          open: [20, 10],
          high: [22, 12],
          low: [19, 9],
          close: [21, 11],
          volume: [1, 2],
        }),
      );
      expect(candles.map((candle) => candle.timestamp)).toEqual([1_000_000, 2_000_000]);
    });

    it('treats an empty range as empty, not malformed', () => {
      // A symbol with no bars in the window is a valid answer.
      expect(parseChart({ chart: { result: [{ meta: {} }], error: null } })).toEqual([]);
    });

    it('raises on a response with no result at all', () => {
      expect(() => parseChart({ chart: { result: null, error: null } })).toThrow(ProviderError);
      expect(() => parseChart({ nonsense: true })).toThrow(ProviderError);
    });

    it("surfaces the provider's own error description", () => {
      expect(() =>
        parseChart({
          chart: {
            result: null,
            error: { code: 'Not Found', description: 'symbol may be delisted' },
          },
        }),
      ).toThrow(/delisted/);
    });
  });

  describe('symbol resolution', () => {
    it('refuses a symbol outside the catalogue', async () => {
      // The caller cannot name a provider symbol; only the catalogue can. This
      // is what keeps an arbitrary string out of the outbound URL.
      const provider = createYahooProvider({ fetchImpl: vi.fn() as unknown as HttpFetch });
      await expect(provider.fetchCandles({ symbol: 'HACK=X', timeframe: '1d' })).rejects.toThrow(
        /not a Yahoo Finance instrument/,
      );
    });

    it('refuses a crypto symbol, which another provider serves', () => {
      const provider = createYahooProvider({ fetchImpl: vi.fn() as unknown as HttpFetch });
      return expect(provider.fetchCandles({ symbol: 'BTCUSD', timeframe: '1d' })).rejects.toThrow(
        ProviderError,
      );
    });

    it('maps the domain symbol to the provider symbol in the URL', async () => {
      const fetchImpl = vi.fn(async (_url: string) =>
        json(chart([1000], { open: [1], high: [2], low: [0.5], close: [1.5], volume: [null] })),
      );
      const provider = createYahooProvider({ fetchImpl: fetchImpl as unknown as HttpFetch });

      const result = await provider.fetchCandles({ symbol: 'EURUSD', timeframe: '1d' });

      const url = String(fetchImpl.mock.calls[0]?.[0]);
      expect(url).toContain('EURUSD%3DX');
      // And the result comes back in DOMAIN terms, not provider terms.
      expect(result.symbol).toBe('EURUSD');
      expect(result.meta.providerSymbol).toBe('EURUSD=X');
    });

    it('sends epoch SECONDS for an explicit range', async () => {
      // Milliseconds are accepted and silently return the wrong window, which
      // is the worst available failure mode.
      const fetchImpl = vi.fn(async (_url: string) => json(chart([], {})));
      const provider = createYahooProvider({ fetchImpl: fetchImpl as unknown as HttpFetch });

      await provider.fetchCandles({
        symbol: 'AAPL',
        timeframe: '1d',
        from: 1_700_000_000_000,
        to: 1_700_086_400_000,
      });

      const url = String(fetchImpl.mock.calls[0]?.[0]);
      expect(url).toContain('period1=1700000000');
      expect(url).toContain('period2=1700086400');
    });
  });

  describe('unsupported timeframe', () => {
    it('refuses rather than resampling', async () => {
      // Building a 30m bar from 1m bars produces a candle the venue never
      // published. Refusing is the honest behaviour.
      const provider = createYahooProvider({ fetchImpl: vi.fn() as unknown as HttpFetch });
      await expect(provider.fetchCandles({ symbol: 'AAPL', timeframe: '30m' })).rejects.toThrow(
        /does not serve 30m/,
      );
    });
  });

  describe('error classification', () => {
    const cases: [number, string][] = [
      [404, 'not_found'],
      [429, 'rate_limited'],
      [403, 'authentication'],
      [500, 'server_error'],
      [422, 'unsupported'],
    ];

    for (const [status, kind] of cases) {
      it(`maps HTTP ${status} to ${kind}`, async () => {
        const provider = createYahooProvider({
          fetchImpl: (async () =>
            json({ chart: { error: { description: 'x' } } }, status)) as HttpFetch,
        });
        await expect(
          provider.fetchCandles({ symbol: 'AAPL', timeframe: '1d' }),
        ).rejects.toMatchObject({ kind });
      });
    }

    it('maps a timeout to its own kind, not to a network error', async () => {
      const provider = createYahooProvider({
        fetchImpl: (async () => {
          const error = new Error('timed out');
          error.name = 'TimeoutError';
          throw error;
        }) as HttpFetch,
      });
      await expect(
        provider.fetchCandles({ symbol: 'AAPL', timeframe: '1d' }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('maps unparseable JSON to malformed_response', async () => {
      const provider = createYahooProvider({
        fetchImpl: (async () => new Response('<html>', { status: 200 })) as HttpFetch,
      });
      await expect(
        provider.fetchCandles({ symbol: 'AAPL', timeframe: '1d' }),
      ).rejects.toMatchObject({ kind: 'malformed_response' });
    });

    it('reports ping failure as false rather than throwing', async () => {
      const provider = createYahooProvider({
        fetchImpl: (async () => {
          throw new Error('offline');
        }) as HttpFetch,
      });
      expect(await provider.ping()).toBe(false);
    });
  });

  describe('candle completeness', () => {
    it('marks a still-forming bar incomplete', async () => {
      // The analysis loop must never decide on a partial candle.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const fetchImpl = vi.fn(async (_url: string) =>
        json(
          chart([nowSeconds - 86_400, nowSeconds], {
            open: [10, 11],
            high: [12, 13],
            low: [9, 10],
            close: [11, 12],
            volume: [1, 2],
          }),
        ),
      );
      const provider = createYahooProvider({ fetchImpl: fetchImpl as unknown as HttpFetch });

      const result = await provider.fetchCandles({ symbol: 'AAPL', timeframe: '1d' });
      expect(result.candles[0]?.complete).toBe(true);
      expect(result.candles[1]?.complete).toBe(false);
    });
  });

  describe('listAssets', () => {
    it('offers only the catalogue instruments this provider serves', async () => {
      const provider = createYahooProvider({ fetchImpl: vi.fn() as unknown as HttpFetch });
      const assets = await provider.listAssets();

      expect(assets.length).toBeGreaterThan(0);
      // No crypto: that is another provider's class.
      expect(assets.every((asset) => asset.assetClass !== 'crypto')).toBe(true);
      expect(assets.map((asset) => asset.symbol)).toContain('EURUSD');
      expect(assets.map((asset) => asset.symbol)).toContain('AAPL');
    });
  });
});
