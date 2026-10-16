import type { AssetClass, Instrument, MarketAsset, Timeframe } from '@binaryai/types';

/**
 * BinaryAI's instrument catalogue.
 *
 * SERVER-DEFINED AND AUTHORITATIVE. The browser never invents an instrument; it
 * picks one from this list. That is a security property as much as a product
 * one — `POST /v1/market-data/ingest` used to take whatever `asset` string the
 * caller sent and store it verbatim, which is how the same asset ended up in
 * the database twice under two spellings.
 *
 * CURATED, NOT EXHAUSTIVE. Coinbase alone lists over five hundred products, and
 * offering all of them would be a worse product and a dishonest one: most have
 * no liquidity worth analysing, and a picker with five hundred rows is a picker
 * nobody uses. What is listed here is what BinaryAI is prepared to stand behind.
 *
 * Adding an instrument means adding a row here and nothing else. Adding an
 * asset class means writing a provider adapter and adding rows; no engine,
 * repository or UI code changes, because everything downstream reads
 * `Instrument` rather than provider syntax.
 */

/** Coinbase serves these five natively. Verified against the live API. */
const COINBASE_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

/**
 * Yahoo serves finer intervals than these, but only over short ranges, and it
 * refuses (422) when the window is too long for the interval. These five match
 * the Coinbase set so a timeframe control behaves the same on every instrument.
 */
const YAHOO_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

interface CryptoSpec {
  readonly base: string;
  readonly quote: string;
  readonly name: string;
  readonly pricePrecision: number;
}

/**
 * Coinbase's product id is `BASE-QUOTE`; the canonical BinaryAI symbol is the
 * same without the separator. Both are derived here rather than written out, so
 * a typo cannot put a mismatched pair in the catalogue.
 */
function crypto(spec: CryptoSpec): Instrument {
  return {
    symbol: `${spec.base}${spec.quote}`,
    displaySymbol: `${spec.base}/${spec.quote}`,
    name: spec.name,
    assetClass: 'crypto',
    quoting: {
      base: spec.base,
      quote: spec.quote,
      pricePrecision: spec.pricePrecision,
      quantityPrecision: 8,
      minimumSize: null,
    },
    schedule: '24x7',
    providerId: 'coinbase',
    providerSymbol: `${spec.base}-${spec.quote}`,
    supportedTimeframes: COINBASE_TIMEFRAMES,
    isOtc: false,
  };
}

/** Yahoo quotes spot FX under `EURUSD=X`. Five decimals, three for JPY pairs. */
function forex(base: string, quote: string, name: string): Instrument {
  return {
    symbol: `${base}${quote}`,
    displaySymbol: `${base}/${quote}`,
    name,
    assetClass: 'forex',
    quoting: {
      base,
      quote,
      // JPY pairs are quoted to 3dp; every other major to 5. Using 5 for JPY
      // would render 159.38000, which reads as false precision.
      pricePrecision: quote === 'JPY' ? 3 : 5,
      quantityPrecision: 2,
      minimumSize: null,
    },
    schedule: '24x5',
    providerId: 'yahoo',
    providerSymbol: `${base}${quote}=X`,
    supportedTimeframes: YAHOO_TIMEFRAMES,
    isOtc: false,
  };
}

/** A listed share. The ticker is both the domain symbol and Yahoo's. */
function stock(ticker: string, name: string): Instrument {
  return {
    symbol: ticker,
    displaySymbol: ticker,
    name,
    assetClass: 'stock',
    quoting: {
      base: null,
      quote: 'USD',
      pricePrecision: 2,
      quantityPrecision: 0,
      minimumSize: 1,
    },
    schedule: 'exchange_session',
    providerId: 'yahoo',
    providerSymbol: ticker,
    supportedTimeframes: YAHOO_TIMEFRAMES,
    isOtc: false,
  };
}

/**
 * An index level.
 *
 * `base` is null and `minimumSize` is null because an index is not something
 * one holds — it is a number. Yahoo prefixes them with a caret.
 */
function index(symbol: string, yahooSymbol: string, name: string): Instrument {
  return {
    symbol,
    displaySymbol: symbol,
    name,
    assetClass: 'index',
    quoting: {
      base: null,
      quote: 'USD',
      pricePrecision: 2,
      quantityPrecision: 0,
      minimumSize: null,
    },
    schedule: 'exchange_session',
    providerId: 'yahoo',
    providerSymbol: yahooSymbol,
    supportedTimeframes: YAHOO_TIMEFRAMES,
    isOtc: false,
  };
}

/**
 * A commodity, priced from its front-month future.
 *
 * Worth being precise about, because the difference is real money to anyone who
 * assumes otherwise: `GC=F` is the COMEX gold FUTURE, not spot XAU/USD. They
 * track each other and are not the same price. The name says "Futures" for
 * exactly that reason.
 */
function commodity(
  symbol: string,
  yahooSymbol: string,
  name: string,
  pricePrecision: number,
): Instrument {
  return {
    symbol,
    displaySymbol: symbol,
    name,
    assetClass: 'commodity',
    quoting: {
      base: null,
      quote: 'USD',
      pricePrecision,
      quantityPrecision: 2,
      minimumSize: null,
    },
    schedule: 'exchange_session',
    providerId: 'yahoo',
    providerSymbol: yahooSymbol,
    supportedTimeframes: YAHOO_TIMEFRAMES,
    isOtc: false,
  };
}

/**
 * The catalogue.
 *
 * Every entry below was resolved against its provider's live API during Phase
 * 10 — the symbol returned candles, and the instrument type the provider
 * reported matched the asset class claimed here. Nothing is listed on the
 * strength of a symbol looking plausible.
 */
export const INSTRUMENT_CATALOGUE: readonly Instrument[] = [
  // ------------------------------------------------------------- crypto --
  crypto({ base: 'BTC', quote: 'USD', name: 'Bitcoin / US Dollar', pricePrecision: 2 }),
  crypto({ base: 'ETH', quote: 'USD', name: 'Ethereum / US Dollar', pricePrecision: 2 }),
  crypto({ base: 'SOL', quote: 'USD', name: 'Solana / US Dollar', pricePrecision: 2 }),
  crypto({ base: 'XRP', quote: 'USD', name: 'XRP / US Dollar', pricePrecision: 4 }),
  crypto({ base: 'ADA', quote: 'USD', name: 'Cardano / US Dollar', pricePrecision: 4 }),
  crypto({ base: 'DOGE', quote: 'USD', name: 'Dogecoin / US Dollar', pricePrecision: 5 }),
  crypto({ base: 'LTC', quote: 'USD', name: 'Litecoin / US Dollar', pricePrecision: 2 }),
  crypto({ base: 'LINK', quote: 'USD', name: 'Chainlink / US Dollar', pricePrecision: 4 }),
  crypto({ base: 'AVAX', quote: 'USD', name: 'Avalanche / US Dollar', pricePrecision: 3 }),
  crypto({ base: 'DOT', quote: 'USD', name: 'Polkadot / US Dollar', pricePrecision: 4 }),

  // -------------------------------------------------------------- forex --
  forex('EUR', 'USD', 'Euro / US Dollar'),
  forex('GBP', 'USD', 'British Pound / US Dollar'),
  forex('USD', 'JPY', 'US Dollar / Japanese Yen'),
  forex('AUD', 'USD', 'Australian Dollar / US Dollar'),
  forex('USD', 'CAD', 'US Dollar / Canadian Dollar'),
  forex('USD', 'CHF', 'US Dollar / Swiss Franc'),
  forex('NZD', 'USD', 'New Zealand Dollar / US Dollar'),
  forex('EUR', 'GBP', 'Euro / British Pound'),

  // ------------------------------------------------------------- stocks --
  stock('AAPL', 'Apple Inc.'),
  stock('MSFT', 'Microsoft Corporation'),
  stock('NVDA', 'NVIDIA Corporation'),
  stock('TSLA', 'Tesla, Inc.'),
  stock('AMZN', 'Amazon.com, Inc.'),
  stock('GOOGL', 'Alphabet Inc. Class A'),
  stock('META', 'Meta Platforms, Inc.'),
  stock('JPM', 'JPMorgan Chase & Co.'),

  // ------------------------------------------------------------ indices --
  index('SPX', '^GSPC', 'S&P 500'),
  index('NDX', '^NDX', 'NASDAQ-100'),
  index('DJI', '^DJI', 'Dow Jones Industrial Average'),
  index('RUT', '^RUT', 'Russell 2000'),
  index('VIX', '^VIX', 'CBOE Volatility Index'),

  // -------------------------------------------------------- commodities --
  commodity('XAUUSD', 'GC=F', 'Gold Futures', 2),
  commodity('XAGUSD', 'SI=F', 'Silver Futures', 3),
  commodity('WTIUSD', 'CL=F', 'Crude Oil WTI Futures', 2),
  commodity('NGUSD', 'NG=F', 'Natural Gas Futures', 3),
  commodity('HGUSD', 'HG=F', 'Copper Futures', 4),
];

const BY_SYMBOL = new Map(INSTRUMENT_CATALOGUE.map((entry) => [entry.symbol, entry]));

/**
 * Legacy spellings that predate the catalogue.
 *
 * `BTC-USD` was written straight from the ingest request body before symbols
 * were resolved, so stored candles, signals and paper positions carry it.
 * Migration 0010 normalises the stored rows; this map keeps a bookmarked URL
 * or an in-flight request working rather than 404ing on a symbol that was valid
 * yesterday. Additive and small on purpose — it is a compatibility shim, not a
 * second naming scheme.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'BTC-USD': 'BTCUSD',
  'ETH-USD': 'ETHUSD',
  'SOL-USD': 'SOLUSD',
  'EUR/USD': 'EURUSD',
  'BTC/USD': 'BTCUSD',
};

/** The full catalogue, ordered as declared. */
export function listInstruments(): readonly Instrument[] {
  return INSTRUMENT_CATALOGUE;
}

/**
 * The persisted projection of an instrument.
 *
 * One function, so the catalogue is the single origin of what lands in
 * `market_assets`. Both the ingest route and the runtime write asset rows, and
 * before this existed each described an asset inline — which is how both came
 * to hardcode `assetClass: 'crypto'` independently.
 */
export function assetFromInstrument(instrument: Instrument): MarketAsset {
  return {
    symbol: instrument.symbol,
    displayName: instrument.name,
    assetClass: instrument.assetClass,
    pricePrecision: instrument.quoting.pricePrecision,
    isOtc: instrument.isOtc,
    displaySymbol: instrument.displaySymbol,
    baseCurrency: instrument.quoting.base,
    quoteCurrency: instrument.quoting.quote,
    providerId: instrument.providerId,
    providerSymbol: instrument.providerSymbol,
    quantityPrecision: instrument.quoting.quantityPrecision,
    minimumSize: instrument.quoting.minimumSize,
    tradingSchedule: instrument.schedule,
    supportedTimeframes: instrument.supportedTimeframes,
    inCatalogue: true,
  };
}

/** Resolves a symbol, tolerating a known legacy spelling. Null when unknown. */
export function findInstrument(symbol: string): Instrument | null {
  const direct = BY_SYMBOL.get(symbol);
  if (direct) return direct;
  const aliased = ALIASES[symbol];
  return aliased ? (BY_SYMBOL.get(aliased) ?? null) : null;
}

export function instrumentsByClass(assetClass: AssetClass): readonly Instrument[] {
  return INSTRUMENT_CATALOGUE.filter((entry) => entry.assetClass === assetClass);
}

/** Asset classes the catalogue actually contains, in presentation order. */
export const CATALOGUE_ASSET_CLASSES: readonly AssetClass[] = [
  'crypto',
  'forex',
  'stock',
  'index',
  'commodity',
];

export const ASSET_CLASS_LABELS: Readonly<Record<AssetClass, string>> = {
  crypto: 'Crypto',
  forex: 'Forex',
  stock: 'Stocks',
  index: 'Indices',
  commodity: 'Commodities',
  otc: 'OTC',
  unknown: 'Other',
};

/**
 * Free-text search over the catalogue.
 *
 * Matches symbol, display symbol, name and the two currency codes, so "EUR"
 * finds EUR/USD and EUR/GBP, "GOLD" finds nothing but "XAU" and "Gold" both
 * find gold. Ranked so an exact symbol hit is never buried under a name that
 * happens to contain the same letters.
 */
export function searchInstruments(query: string, limit = 50): readonly Instrument[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return INSTRUMENT_CATALOGUE.slice(0, limit);

  const scored: { instrument: Instrument; score: number }[] = [];
  for (const instrument of INSTRUMENT_CATALOGUE) {
    const symbol = instrument.symbol.toLowerCase();
    const display = instrument.displaySymbol.toLowerCase();
    const name = instrument.name.toLowerCase();
    const base = instrument.quoting.base?.toLowerCase() ?? '';
    const quote = instrument.quoting.quote.toLowerCase();

    let score = -1;
    if (symbol === needle || display === needle) score = 0;
    else if (symbol.startsWith(needle) || display.startsWith(needle)) score = 1;
    else if (base === needle || quote === needle) score = 2;
    else if (name.startsWith(needle)) score = 3;
    else if (symbol.includes(needle) || name.includes(needle)) score = 4;

    if (score >= 0) scored.push({ instrument, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.instrument.symbol.localeCompare(b.instrument.symbol))
    .slice(0, limit)
    .map((entry) => entry.instrument);
}
