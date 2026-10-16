import {
  type Candle,
  type CandleRequest,
  type MarketDataProvider,
  type ProviderAsset,
  type ProviderCapabilities,
  type ProviderFetchResult,
  type Timeframe,
} from '@binaryai/types';
import { ProviderError, type HttpFetch } from '../provider-error.js';
import { instrumentsByClass, findInstrument } from '../catalogue.js';

/**
 * Yahoo Finance chart adapter — forex, equities, indices and commodities.
 *
 * READ THIS BEFORE ENABLING IT IN PRODUCTION.
 *
 * `query1.finance.yahoo.com/v8/finance/chart` is an UNDOCUMENTED endpoint. It
 * has no published contract, no SLA, no versioning promise, and Yahoo's terms
 * do not grant a licence for programmatic access or redistribution. It is
 * reachable and it returns real exchange data, which is why this adapter
 * exists — but it is not a supported integration, and BinaryAI therefore
 * defaults it OFF. An operator must set MARKET_DATA_EQUITY_PROVIDER=yahoo
 * deliberately. See `limitations` below, which the API surfaces to the UI.
 *
 * When a licensed vendor is available, the replacement is one adapter and one
 * line in the registry: nothing outside this file knows that `EURUSD=X` or
 * `^GSPC` or `GC=F` are how anyone spells those instruments.
 *
 * WHAT THIS DATA IS: exchange prices — consolidated equity trades, interbank FX
 * indications, index levels, front-month futures settlements.
 * WHAT IT IS NOT: a binary-options broker's quote or settlement feed. Hence
 * `dataOrigin: 'aggregated'` rather than 'broker'.
 */

const BASE_URL = 'https://query1.finance.yahoo.com';

/**
 * Chart intervals, verified against the live endpoint.
 *
 * Yahoo also serves 2m, 30m and 90m, and BinaryAI's `Timeframe` union contains
 * 2m and 30m — but Coinbase serves neither, and offering a timeframe on FX that
 * silently vanishes on crypto is a worse control than offering five everywhere.
 */
const INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '60m',
  '1d': '1d',
};

const SUPPORTED_TIMEFRAMES = Object.keys(INTERVAL) as Timeframe[];

export const YAHOO_CAPABILITIES: ProviderCapabilities = {
  id: 'yahoo',
  displayName: 'Yahoo Finance',
  requiresCredentials: false,
  supportedTimeframes: SUPPORTED_TIMEFRAMES,
  // No documented ceiling. 1m is capped by RANGE rather than by count: the
  // endpoint returns 422 when the window is too long for the interval, so the
  // planner's windows matter more than this number.
  maxCandlesPerRequest: 1000,
  supportsHistoricalRange: true,
  supportsStreaming: false,
  historicalDepth:
    'Intraday intervals reach back days to weeks; 1d reaches back years. 1m is limited to roughly the last week.',
  dataOrigin: 'aggregated',
  // Conservative. There is no published limit, and the endpoint returns 429
  // without a documented budget, so this is set low deliberately.
  rateLimitPerSecond: 2,
  documentationUrl: 'https://finance.yahoo.com/',
  limitations: [
    'UNDOCUMENTED endpoint. No SLA, no contract, no versioning guarantee; it may change or stop without notice.',
    "Yahoo's terms do not grant a licence for programmatic access or redistribution. Review them before production use.",
    'Equity, index and futures data covers exchange sessions only: expect gaps overnight, at weekends and on holidays.',
    'Commodity instruments are FRONT-MONTH FUTURES, not spot. GC=F is COMEX gold, which is not the same price as spot XAU/USD.',
    'Intraday history is shallow — 1m reaches back about a week, not years.',
    'Exchange and indicative pricing, not binary-options broker quote or settlement pricing.',
  ],
};

/** Yahoo returns nulls inside the OHLC arrays for non-trading slots. */
interface YahooQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

interface YahooResult {
  meta?: { currency?: string; instrumentType?: string; symbol?: string };
  timestamp?: number[];
  indicators?: { quote?: YahooQuote[] };
}

/**
 * Parses one chart result into candles.
 *
 * The trap here is the null slots. Yahoo pads its timestamp array across the
 * whole requested range and writes `null` into the OHLC arrays where no bar
 * exists — overnight, at weekends, on holidays. Carrying the previous close
 * forward would manufacture a flat candle the market never printed, so those
 * slots are DROPPED. A gap in the series is true; a fabricated bar is not.
 */
export function parseChart(payload: unknown): Candle[] {
  const body = payload as { chart?: { result?: YahooResult[] | null; error?: unknown } } | null;

  if (body?.chart?.error) {
    const error = body.chart.error as { description?: string; code?: string };
    throw new ProviderError(
      'bad_request',
      error.description ?? error.code ?? 'Provider reported an error',
    );
  }

  const result = body?.chart?.result?.[0];
  if (!result) {
    throw new ProviderError('malformed_response', 'Chart response contained no result');
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  // A valid response for a symbol with no bars in range: not malformed, empty.
  if (!Array.isArray(timestamps) || !quote) return [];

  const candles: Candle[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const seconds = timestamps[index];
    const open = quote.open?.[index];
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const close = quote.close?.[index];

    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) continue;
    if (
      typeof open !== 'number' ||
      typeof high !== 'number' ||
      typeof low !== 'number' ||
      typeof close !== 'number'
    ) {
      continue;
    }
    if (![open, high, low, close].every(Number.isFinite)) continue;

    const volume = quote.volume?.[index];
    candles.push({
      timestamp: seconds * 1000,
      open,
      high,
      low,
      close,
      // Genuinely absent for FX and indices — neither has a traded volume.
      volume: typeof volume === 'number' && Number.isFinite(volume) ? volume : null,
      complete: true,
    });
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

export interface YahooProviderOptions {
  readonly fetchImpl?: HttpFetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createYahooProvider(options: YahooProviderOptions = {}): MarketDataProvider {
  const { fetchImpl = fetch, baseUrl = BASE_URL, timeoutMs = 12_000 } = options;

  async function request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/json',
          // The endpoint returns 403 to an unrecognised agent. This identifies
          // BinaryAI honestly rather than impersonating a browser.
          'user-agent': 'BinaryAI/0.1 (market-data; +https://github.com/Soupaduc96/BinaryAI)',
        },
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
      throw new ProviderError('not_found', 'The provider does not know that symbol');
    }
    // 422 is Yahoo's "that interval is not available for that range" — a
    // distinct, actionable cause, so it must not collapse into bad_request.
    if (response.status === 422) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        'unsupported',
        describe(detail) ?? 'That interval is not available over the requested range',
      );
    }
    if (response.status >= 500) {
      throw new ProviderError('server_error', `Provider error ${response.status}`, {
        retryable: true,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        'bad_request',
        describe(detail) ?? `Provider returned ${response.status}`,
      );
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
    capabilities: YAHOO_CAPABILITIES,

    /**
     * The catalogue entries this provider serves.
     *
     * Unlike Coinbase, there is no products endpoint to enumerate — the chart
     * API answers per symbol. Returning the curated catalogue rather than an
     * invented universe is both the only honest option and the better one: a
     * symbol here is one BinaryAI has actually resolved.
     */
    async listAssets(): Promise<readonly ProviderAsset[]> {
      return (['forex', 'stock', 'index', 'commodity'] as const)
        .flatMap((assetClass) => instrumentsByClass(assetClass))
        .filter((instrument) => instrument.providerId === 'yahoo')
        .map((instrument) => ({
          symbol: instrument.symbol,
          providerSymbol: instrument.providerSymbol,
          displayName: instrument.displaySymbol,
          assetClass: instrument.assetClass,
          pricePrecision: instrument.quoting.pricePrecision,
          quoteCurrency: instrument.quoting.quote,
          tradable: true,
        }));
    },

    async fetchCandles(candleRequest: CandleRequest): Promise<ProviderFetchResult> {
      const interval = INTERVAL[candleRequest.timeframe];
      if (interval === undefined) {
        throw new ProviderError(
          'unsupported',
          `Yahoo Finance does not serve ${candleRequest.timeframe} candles here. Supported: ${SUPPORTED_TIMEFRAMES.join(', ')}`,
        );
      }

      // The catalogue is the ONLY source of a provider symbol. A caller cannot
      // name one, which is what keeps an arbitrary string out of the URL.
      const instrument = findInstrument(candleRequest.symbol);
      if (!instrument || instrument.providerId !== 'yahoo') {
        throw new ProviderError(
          'not_found',
          `${candleRequest.symbol} is not a Yahoo Finance instrument in BinaryAI's catalogue`,
        );
      }
      const providerSymbol = instrument.providerSymbol;

      const params = new URLSearchParams({ interval });
      if (candleRequest.from !== undefined && candleRequest.to !== undefined) {
        // Epoch SECONDS. Milliseconds are accepted and silently return the
        // wrong window, which is the worst possible failure mode.
        params.set('period1', String(Math.floor(candleRequest.from / 1000)));
        params.set('period2', String(Math.ceil(candleRequest.to / 1000)));
      } else {
        params.set('range', defaultRange(candleRequest.timeframe));
      }

      const endpoint = `/v8/finance/chart/${encodeURIComponent(providerSymbol)}?${params.toString()}`;
      const requestedAt = Date.now();
      const payload = await request(endpoint);
      const receivedAt = Date.now();

      const stepMs = stepMsFor(candleRequest.timeframe);
      const closedBy = Date.now();
      let candles = parseChart(payload).map((candle) => ({
        ...candle,
        // Same rule as every other adapter: the forming bar is not complete,
        // and the analysis loop must never decide on a partial candle.
        complete: candle.timestamp + stepMs <= closedBy,
      }));
      if (candleRequest.limit !== undefined && candles.length > candleRequest.limit) {
        candles = candles.slice(-candleRequest.limit);
      }

      return {
        symbol: instrument.symbol,
        timeframe: candleRequest.timeframe,
        source: candleRequest.from === undefined ? 'live_provider' : 'historical_provider',
        origin: 'aggregated',
        candles,
        meta: {
          providerId: YAHOO_CAPABILITIES.id,
          providerSymbol,
          requestedAt,
          receivedAt,
          latencyMs: receivedAt - requestedAt,
          candlesReturned: candles.length,
          endpoint: `/v8/finance/chart/${providerSymbol}`,
        },
      };
    },

    async ping(): Promise<boolean> {
      try {
        // A known-good, always-listed symbol. Cheapest range the API offers.
        await request('/v8/finance/chart/AAPL?interval=1d&range=1d');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Yahoo's own message, when it sent one worth showing. */
function describe(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { chart?: { error?: { description?: string } } };
    return parsed.chart?.error?.description ?? null;
  } catch {
    return null;
  }
}

/** Ranges Yahoo accepts for each interval. 1m over a year is a 422. */
function defaultRange(timeframe: Timeframe): string {
  switch (timeframe) {
    case '1m':
      return '1d';
    case '5m':
    case '15m':
      return '5d';
    case '1h':
      return '1mo';
    default:
      return '1y';
  }
}

function stepMsFor(timeframe: Timeframe): number {
  switch (timeframe) {
    case '1m':
      return 60_000;
    case '5m':
      return 300_000;
    case '15m':
      return 900_000;
    case '1h':
      return 3_600_000;
    default:
      return 86_400_000;
  }
}
