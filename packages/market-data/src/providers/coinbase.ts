import {
  TIMEFRAME_SECONDS,
  type Candle,
  type CandleRequest,
  type MarketDataProvider,
  type ProviderAsset,
  type ProviderCapabilities,
  type ProviderFetchResult,
  type Timeframe,
} from '@binaryai/types';
import { ProviderError, type HttpFetch } from '../provider-error.js';

/**
 * Coinbase Exchange market-data adapter.
 *
 * Public endpoints only: no credentials, no account, no trading scope. The
 * adapter reads market data and nothing else.
 *
 * WHAT THIS DATA IS: matched trades on the Coinbase Exchange order book.
 * WHAT IT IS NOT: the quote or settlement price a binary-options broker uses.
 * Those are different feeds and can differ in price and timing — which is why
 * `dataOrigin` is 'exchange' and never 'broker'. See docs/market-data.md.
 *
 * The response format has one genuine trap, verified against the live API:
 * candles are `[time, low, high, open, close, volume]` — LOW and HIGH come
 * BEFORE open and close. Assuming the conventional OHLC order silently
 * corrupts every candle, so the mapping below is explicit and tested.
 */

const BASE_URL = 'https://api.exchange.coinbase.com';

/** Granularities the API accepts, in seconds. Verified against the live API. */
const GRANULARITY: Partial<Record<Timeframe, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

const SUPPORTED_TIMEFRAMES = Object.keys(GRANULARITY) as Timeframe[];

export const COINBASE_CAPABILITIES: ProviderCapabilities = {
  id: 'coinbase',
  displayName: 'Coinbase Exchange',
  requiresCredentials: false,
  supportedTimeframes: SUPPORTED_TIMEFRAMES,
  // Verified: the endpoint returns at most 300 candles per request.
  maxCandlesPerRequest: 300,
  supportsHistoricalRange: true,
  // The Exchange websocket feed carries ticker and matches, but no candle
  // channel; candles would have to be aggregated from trades. Not in this phase.
  supportsStreaming: false,
  historicalDepth: 'Multi-year via explicit start/end windows, 300 candles per request.',
  dataOrigin: 'exchange',
  rateLimitPerSecond: 8,
  documentationUrl:
    'https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles',
  limitations: [
    'Cryptocurrency only. No forex, indices or commodities.',
    'Native timeframes are 1m, 5m, 15m, 1h and 1d. 30m and 4h are not served and are never resampled.',
    'No candle websocket channel; near-real-time requires polling.',
    'Public endpoints are best-effort and carry no availability SLA.',
    'Exchange trade data, not binary-options broker quote or settlement pricing.',
  ],
};

/** BinaryAI symbol (BTCUSD) <-> provider symbol (BTC-USD). */
export function toProviderSymbol(symbol: string): string {
  if (symbol.includes('-')) return symbol.toUpperCase();
  const upper = symbol.toUpperCase();
  // Quote currencies Coinbase lists, longest first so USDT wins over USD.
  for (const quote of ['USDT', 'USDC', 'GBP', 'EUR', 'USD', 'BTC', 'ETH']) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, upper.length - quote.length)}-${quote}`;
    }
  }
  return upper;
}

export function toBinaryAiSymbol(providerSymbol: string): string {
  return providerSymbol.replace(/-/g, '').toUpperCase();
}

interface CoinbaseProduct {
  id: string;
  base_currency: string;
  quote_currency: string;
  display_name: string;
  quote_increment: string;
  status: string;
  trading_disabled?: boolean;
}

/** Derives decimal places from Coinbase's quote_increment, e.g. "0.01" -> 2. */
export function precisionFromIncrement(increment: string): number {
  const parsed = Number(increment);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2;
  const decimals = increment.split('.')[1]?.replace(/0+$/, '').length;
  return decimals ?? 0;
}

export function parseProducts(payload: unknown): ProviderAsset[] {
  if (!Array.isArray(payload)) {
    throw new ProviderError('malformed_response', 'Products response was not an array');
  }
  const assets: ProviderAsset[] = [];
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null) continue;
    const product = raw as Partial<CoinbaseProduct>;
    if (typeof product.id !== 'string' || typeof product.quote_currency !== 'string') continue;

    assets.push({
      symbol: toBinaryAiSymbol(product.id),
      providerSymbol: product.id,
      displayName: product.display_name ?? product.id,
      assetClass: 'crypto',
      pricePrecision: precisionFromIncrement(product.quote_increment ?? '0.01'),
      quoteCurrency: product.quote_currency,
      tradable: product.status === 'online' && product.trading_disabled !== true,
    });
  }
  return assets;
}

/**
 * Parse the candle payload.
 *
 * Rows arrive newest-first and are returned ascending, because every consumer
 * downstream (indicators, quality scan, storage) assumes chronological order.
 * A row that is not structurally a candle is rejected, never patched.
 */
export function parseCandles(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) {
    throw new ProviderError('malformed_response', 'Candle response was not an array');
  }

  const candles: Candle[] = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 6) continue;

    // [ time, low, high, open, close, volume ] — NOT conventional OHLC order.
    const [time, low, high, open, close, volume] = row as unknown[];
    const values = [time, low, high, open, close].map(Number);
    if (values.some((value) => !Number.isFinite(value))) continue;

    const [seconds, lowValue, highValue, openValue, closeValue] = values as [
      number,
      number,
      number,
      number,
      number,
    ];
    const volumeValue = Number(volume);

    candles.push({
      timestamp: seconds * 1000,
      open: openValue,
      high: highValue,
      low: lowValue,
      close: closeValue,
      volume: Number.isFinite(volumeValue) ? volumeValue : null,
      complete: true,
    });
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

export interface CoinbaseProviderOptions {
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: HttpFetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createCoinbaseProvider(options: CoinbaseProviderOptions = {}): MarketDataProvider {
  const { fetchImpl = fetch, baseUrl = BASE_URL, timeoutMs = 10_000 } = options;

  async function request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'BinaryAI/0.1 (market-data)' },
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('timeout', `Request to ${path} timed out after ${timeoutMs}ms`);
      }
      throw new ProviderError('network', `Request to ${path} failed`, { cause: error });
    }

    if (response.status === 429) {
      throw new ProviderError('rate_limited', 'Provider rate limit reached', { retryable: true });
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        'authentication',
        `Provider rejected the request (${response.status})`,
      );
    }
    if (response.status === 404) {
      throw new ProviderError('not_found', `Not found: ${path}`);
    }
    if (response.status >= 500) {
      throw new ProviderError('server_error', `Provider error ${response.status}`, {
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new ProviderError('bad_request', `Provider returned ${response.status} for ${path}`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new ProviderError('malformed_response', 'Response was not valid JSON', {
        cause: error,
      });
    }
  }

  return {
    capabilities: COINBASE_CAPABILITIES,

    async listAssets(): Promise<readonly ProviderAsset[]> {
      const payload = await request('/products');
      return parseProducts(payload).filter((asset) => asset.tradable);
    },

    async fetchCandles(candleRequest: CandleRequest): Promise<ProviderFetchResult> {
      const granularity = GRANULARITY[candleRequest.timeframe];
      if (granularity === undefined) {
        // Resampling a 1m series into 30m here would produce candles the
        // provider never published. Refusing is the honest behaviour.
        throw new ProviderError(
          'unsupported',
          `Coinbase does not serve ${candleRequest.timeframe} candles. Supported: ${SUPPORTED_TIMEFRAMES.join(', ')}`,
        );
      }

      const providerSymbol = toProviderSymbol(candleRequest.symbol);
      const params = new URLSearchParams({ granularity: String(granularity) });
      if (candleRequest.from !== undefined) {
        params.set('start', new Date(candleRequest.from).toISOString());
      }
      if (candleRequest.to !== undefined) {
        params.set('end', new Date(candleRequest.to).toISOString());
      }

      const endpoint = `/products/${encodeURIComponent(providerSymbol)}/candles?${params.toString()}`;
      const requestedAt = Date.now();
      const payload = await request(endpoint);
      const receivedAt = Date.now();

      // The newest bar is still forming: its close time has not arrived yet.
      // Marking it complete would let the analysis loop decide on a partial
      // candle, which is the single worst input the engine can be handed.
      const closedBy = Date.now();
      const stepMs = granularity * 1000;
      let candles = parseCandles(payload).map((candle) => ({
        ...candle,
        complete: candle.timestamp + stepMs <= closedBy,
      }));
      if (candleRequest.limit !== undefined && candles.length > candleRequest.limit) {
        candles = candles.slice(-candleRequest.limit);
      }

      return {
        symbol: candleRequest.symbol,
        timeframe: candleRequest.timeframe,
        source: candleRequest.from === undefined ? 'live_provider' : 'historical_provider',
        origin: 'exchange',
        candles,
        meta: {
          providerId: COINBASE_CAPABILITIES.id,
          providerSymbol,
          requestedAt,
          receivedAt,
          latencyMs: receivedAt - requestedAt,
          candlesReturned: candles.length,
          // Path only. A full URL in logs would eventually leak a credential
          // once a keyed provider is added.
          endpoint: `/products/${providerSymbol}/candles`,
        },
      };
    },

    async ping(): Promise<boolean> {
      try {
        await request('/time');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Exported for the ingestion planner, which must respect the request ceiling. */
export function granularitySeconds(timeframe: Timeframe): number | undefined {
  return GRANULARITY[timeframe] ?? (TIMEFRAME_SECONDS[timeframe] as number | undefined);
}
