import type { AssetClass, Timeframe } from './market.js';

/**
 * The domain instrument model.
 *
 * BinaryAI's answer to "what am I looking at", independent of who supplies the
 * data. Before this existed, an instrument was a bare string that happened to
 * be whatever a provider called it — which is how the same asset came to be
 * stored twice, once as `BTC-USD` and once as `BTCUSD`, with its history split
 * between them.
 *
 * THE CENTRAL SEPARATION, and the reason this file is in `types` rather than in
 * the market-data package:
 *
 *   DOMAIN INSTRUMENT   BTC/USD   what the user, the engine and the database see
 *   PROVIDER SYMBOL     BTC-USD   what one specific adapter puts in a URL
 *
 * Nothing outside `@binaryai/market-data` may know a provider's symbol syntax.
 * The engine asks for an instrument; the registry picks the provider that can
 * serve its asset class; the adapter is the only layer that renders a provider
 * symbol. Adding an equities provider therefore changes no engine code.
 *
 * WHAT `displaySymbol` IS NOT: it is never parsed. It is presentation derived
 * from `base`/`quote`, so `BTC-USD` and `BTCUSD` can both render as BTC/USD
 * without either string being reinterpreted as structure.
 */

/**
 * The canonical BinaryAI symbol, e.g. `BTCUSD`, `EURUSD`, `AAPL`, `SPX`.
 *
 * A plain string rather than a branded type: it is a database key, a URL
 * parameter and a JSON field, and every one of those boundaries would have to
 * cast the brand away. The catalogue is the guard instead — a symbol is valid
 * because it resolves, not because it type-checks.
 */
export type InstrumentSymbol = string;

/**
 * When an instrument's market is open.
 *
 * Declared statically, because it is a property of the venue rather than of any
 * particular request. Deliberately NOT an open/closed flag: saying "closed"
 * requires an exchange calendar with holidays, half-days and DST, and BinaryAI
 * has none. Claiming a session state it cannot compute would be exactly the
 * kind of confident-and-wrong the rest of this system avoids.
 */
export type TradingSchedule =
  /** Continuous. Crypto. */
  | '24x7'
  /** Continuous Sunday evening to Friday evening, closed weekends. Spot FX. */
  | '24x5'
  /** A venue's session, with holidays. Equities, index and futures. */
  | 'exchange_session'
  | 'unknown';

/** How an instrument's price is quoted, which drives formatting and validation. */
export interface InstrumentQuoting {
  /**
   * The asset being priced. Null where the instrument is not a pair — a share
   * or an index level has no base currency.
   */
  readonly base: string | null;
  /** The currency the price is expressed in. */
  readonly quote: string;
  /** Decimal places for rendering. 2 for equities, 5 for most FX. */
  readonly pricePrecision: number;
  /**
   * Decimal places for position size.
   *
   * Present for completeness of the model. BinaryAI's paper positions are
   * denominated in abstract accounting units, not instrument quantity, so
   * nothing in this build divides by it — see `docs/paper-trading.md`.
   */
  readonly quantityPrecision: number;
  /**
   * Smallest position an instrument would accept, in quantity units, where the
   * venue publishes one. Null means "not published", never "no minimum".
   */
  readonly minimumSize: number | null;
}

/**
 * One instrument in BinaryAI's server-defined catalogue.
 *
 * STATIC by construction: every field here is a property of the instrument, not
 * of the current state of the world. Whether data can be fetched *right now*
 * lives in `InstrumentAvailability`, which is computed per request. Mixing the
 * two is what produces a catalogue that claims an asset class works because
 * somebody wrote an interface for it.
 */
export interface Instrument {
  /** Stable identity. Also the `market_assets.symbol` key. */
  readonly symbol: InstrumentSymbol;
  /** Presentation only, e.g. `BTC/USD`. Never parsed, never a key. */
  readonly displaySymbol: string;
  /** Human name, e.g. `Bitcoin / US Dollar`, `Apple Inc.`, `S&P 500`. */
  readonly name: string;
  readonly assetClass: AssetClass;
  readonly quoting: InstrumentQuoting;
  readonly schedule: TradingSchedule;
  /** The provider that serves this instrument, by registry id. */
  readonly providerId: string;
  /** That provider's own identifier. The ONLY provider-shaped string here. */
  readonly providerSymbol: string;
  /**
   * Timeframes the provider serves natively for this instrument.
   *
   * Never a superset of the provider's own list, and never resampled: a 30m
   * candle built locally from 1m bars is a candle the venue never published.
   */
  readonly supportedTimeframes: readonly Timeframe[];
  /**
   * Broker-synthesised instrument. Kept from `MarketAsset` because the UI is
   * required to label OTC pricing as broker-constructed rather than exchange.
   */
  readonly isOtc: boolean;
}

// ------------------------------------------------------------ availability --

/**
 * Why a capability is or is not usable, right now.
 *
 * Five states rather than a boolean, because "unavailable" collapses causes the
 * user needs to tell apart. The brief case: an operator who sees NOT_CONFIGURED
 * should go set an environment variable; one who sees PROVIDER_ERROR should go
 * look at the provider. A shared "Unavailable" sends both to the wrong place.
 */
export type CapabilityState =
  /** Works, and was reached. */
  | 'available'
  /** BinaryAI implements it; this deployment has not enabled it. */
  | 'not_configured'
  /** Configured, but this instrument or parameter is outside what it serves. */
  | 'unsupported'
  /** Configured and supported, but nothing has been stored yet. */
  | 'no_data'
  /** Configured, but the provider failed when asked. */
  | 'provider_error'
  /** Configured, but the provider refused for volume. Retrying may work. */
  | 'rate_limited';

export interface Capability {
  readonly state: CapabilityState;
  /** One sentence naming the cause. Shown verbatim; never a generic string. */
  readonly detail: string;
}

/**
 * What BinaryAI can actually do with one instrument at this moment.
 *
 * The distinction this type exists to enforce, and the reason it has four
 * fields instead of one: HAVING MARKET DATA IS NOT BEING ANALYSED. The engine
 * runs against one configured instrument. Every other instrument can have a
 * complete, live, validated chart and still produce no signals — and the UI has
 * to say so rather than implying that a drawn chart means an opinion exists.
 *
 * The chain is strict, and each link is a precondition for the next:
 *
 *   marketData  provider configured and serving this instrument
 *   chart       validated candles are stored for it
 *   analysis    the engine is configured to analyse THIS instrument
 *   paperTrading  analysis produced a signal that can be acted on
 *
 * Nothing downgrades a later link to make an earlier one look better, and
 * nothing upgrades one because another succeeded.
 */
export interface InstrumentAvailability {
  readonly symbol: InstrumentSymbol;
  readonly marketData: Capability;
  readonly chart: Capability;
  readonly analysis: Capability;
  readonly paperTrading: Capability;
}

/** An instrument together with what can currently be done with it. */
export interface InstrumentStatus {
  readonly instrument: Instrument;
  readonly availability: InstrumentAvailability;
  /** Newest stored candle, epoch ms, or null when nothing is stored. */
  readonly lastCandleAt: number | null;
  /** Timeframes with at least one stored candle. Drives the chart's controls. */
  readonly storedTimeframes: readonly Timeframe[];
  /**
   * Market state for THIS instrument at THIS timeframe.
   *
   * R7. `MarketDataStatus` describes the whole deployment: one state, one
   * `lastCandleAt`, dominated by whichever instrument the worker polls. That
   * made AAPL read LIVE beside "last update 23h ago" — two facts on one strip
   * contradicting each other. Present only when the caller named a timeframe;
   * a catalogue listing has no timeframe and therefore no per-timeframe state.
   */
  readonly marketState?: InstrumentMarketState;
}

/** Freshness of one instrument at one timeframe, derived from stored candles. */
export interface InstrumentMarketState {
  readonly symbol: InstrumentSymbol;
  readonly timeframe: Timeframe;
  /** Registry id of the provider serving this instrument's class, or null. */
  readonly providerId: string | null;
  readonly lastCandleAt: number | null;
  readonly ageSeconds: number | null;
  /**
   * Complete bars missing between the newest stored bar and the one that should
   * be open now. Zero when current.
   *
   * THIS, not `ageSeconds`, is what `state` is derived from. Age alone is
   * meaningless across timeframes: an hourly instrument cannot have a bar
   * younger than an hour, so comparing its age to a fixed threshold reported
   * STALE for fifty-five minutes out of every sixty, on perfectly current data.
   */
  readonly barsBehind: number;
  /**
   * NEVER inferred from another instrument. `no_data` and `stale` are
   * deliberately distinct: one has never been ingested, the other was ingested
   * and has since gone cold, and the operator's response differs.
   */
  readonly state: 'live' | 'stale' | 'no_data' | 'not_configured';
  readonly detail: string;
}

/**
 * An asset class as a whole, so the picker can show a truthful group header.
 *
 * A class is `available` only when its provider is configured AND at least one
 * instrument is genuinely reachable through it. A class whose adapter exists
 * but whose provider is off reports `not_configured`, which is what renders as
 * "Not configured" beside FOREX rather than an empty list that reads as a bug.
 */
export interface AssetClassStatus {
  readonly assetClass: AssetClass;
  readonly label: string;
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly state: CapabilityState;
  readonly detail: string;
  readonly instrumentCount: number;
}
