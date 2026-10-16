import type {
  AssetClass,
  Instrument,
  MarketDataProvider,
  ProviderCapabilities,
} from '@binaryai/types';
import { createCoinbaseProvider, COINBASE_CAPABILITIES } from './providers/coinbase.js';
import { createYahooProvider, YAHOO_CAPABILITIES } from './providers/yahoo.js';
import type { HttpFetch } from './provider-error.js';
import { findInstrument } from './catalogue.js';
import { createRateBudget, type RateBudget } from './rate-budget.js';

/**
 * Provider registry.
 *
 * Previously this mapped one id to one implementation, because BinaryAI served
 * one asset class. Multi-asset changes the shape of the problem: an instrument
 * does not choose its provider, its ASSET CLASS does. Crypto goes to a crypto
 * venue; equities cannot.
 *
 * So the registry is now a router. `resolve(instrument)` answers "who serves
 * this?" and every caller downstream — the ingestion worker, the API routes,
 * the runtime — asks that instead of holding a provider directly. The engine
 * never learns a provider's name, which is the whole point: adding a licensed
 * equities vendor means writing an adapter and changing the line that builds
 * the map, and nothing else.
 *
 * A class with no configured provider resolves to null. That is a first-class
 * state, not an error — it is what the UI renders as "Not configured".
 */

export type ProviderId = 'none' | 'coinbase' | 'yahoo';

export interface CreateProviderOptions {
  readonly fetchImpl?: HttpFetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Reserved for keyed providers. Neither current adapter needs one. */
  readonly apiKey?: string | undefined;
}

/** Returns null for 'none', which is a valid configuration, not a failure. */
export function createProvider(
  id: ProviderId,
  options: CreateProviderOptions = {},
): MarketDataProvider | null {
  const shared = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  switch (id) {
    case 'none':
      return null;
    case 'coinbase':
      return createCoinbaseProvider(shared);
    case 'yahoo':
      return createYahooProvider(shared);
  }
}

/**
 * Which provider serves which asset class.
 *
 * Two settings rather than five: a crypto venue and a multi-asset vendor is how
 * the market actually divides, and one knob per class would be four ways to
 * misconfigure the same thing. When a class gains a dedicated provider this
 * becomes its own entry; the type below already allows it.
 */
export interface ProviderAssignment {
  /** Serves `crypto`. */
  readonly crypto: ProviderId;
  /** Serves `forex`, `stock`, `index` and `commodity`. */
  readonly equity: ProviderId;
}

export interface ProviderRouter {
  /** The provider for one instrument, or null when its class has none. */
  resolve(instrument: Instrument): MarketDataProvider | null;
  /** The provider for a symbol, resolved through the catalogue. */
  resolveSymbol(symbol: string): MarketDataProvider | null;
  forClass(assetClass: AssetClass): MarketDataProvider | null;
  providerIdForClass(assetClass: AssetClass): ProviderId;
  /** Every distinct configured provider, for status and health reporting. */
  configured(): readonly MarketDataProvider[];
  /**
   * The request budget SHARED by everything routed to this provider.
   *
   * R15. One budget per provider instance, so eight instruments polling Yahoo
   * queue through one allowance instead of each keeping its own. Null when the
   * class has no provider.
   */
  budgetFor(assetClass: AssetClass): RateBudget | null;
  /**
   * The provider used where no instrument is in hand — the market-data status
   * indicator, and the ingestion worker's default. Crypto when configured,
   * otherwise whichever single provider is.
   */
  readonly primary: MarketDataProvider | null;
}

const EQUITY_CLASSES: readonly AssetClass[] = ['forex', 'stock', 'index', 'commodity'];

export function createProviderRouter(
  assignment: ProviderAssignment,
  options: CreateProviderOptions = {},
): ProviderRouter {
  // Built once. Two classes pointing at the same provider id share one
  // instance, so a per-provider rate budget stays meaningful.
  const instances = new Map<ProviderId, MarketDataProvider | null>();
  // One budget per provider INSTANCE, created alongside it and shared by every
  // asset class routed there.
  const budgets = new Map<ProviderId, RateBudget | null>();
  const instanceFor = (id: ProviderId): MarketDataProvider | null => {
    if (!instances.has(id)) {
      const built = createProvider(id, options);
      instances.set(id, built);
      budgets.set(id, built ? createRateBudget(built.capabilities.rateLimitPerSecond) : null);
    }
    return instances.get(id) ?? null;
  };

  const providerIdForClass = (assetClass: AssetClass): ProviderId =>
    assetClass === 'crypto'
      ? assignment.crypto
      : EQUITY_CLASSES.includes(assetClass)
        ? assignment.equity
        : 'none';

  const forClass = (assetClass: AssetClass): MarketDataProvider | null =>
    instanceFor(providerIdForClass(assetClass));

  const crypto = instanceFor(assignment.crypto);
  const equity = instanceFor(assignment.equity);

  return {
    providerIdForClass,
    forClass,
    budgetFor: (assetClass) => {
      instanceFor(providerIdForClass(assetClass));
      return budgets.get(providerIdForClass(assetClass)) ?? null;
    },
    resolve: (instrument) => forClass(instrument.assetClass),
    resolveSymbol: (symbol) => {
      const instrument = findInstrument(symbol);
      return instrument ? forClass(instrument.assetClass) : null;
    },
    configured: () => {
      const seen = new Map<string, MarketDataProvider>();
      for (const provider of [crypto, equity]) {
        if (provider) seen.set(provider.capabilities.id, provider);
      }
      return [...seen.values()];
    },
    primary: crypto ?? equity,
  };
}

/**
 * A router that answers with ONE provider for every asset class.
 *
 * For callers that hold a provider directly rather than a configuration: tests
 * injecting a stub, and any embedding that constructs its own adapter. Without
 * this, such a caller's provider would be reachable through
 * `context.marketData.provider` but not through the router — so the status
 * endpoint would see it and the ingest route would not, which is exactly the
 * kind of split that produces a 503 nobody can explain.
 *
 * `null` is a legitimate argument: it means "no provider for anything", which
 * is how a deployment with ingestion switched off is modelled.
 */
export function createFixedRouter(provider: MarketDataProvider | null): ProviderRouter {
  const fixedBudget = provider ? createRateBudget(provider.capabilities.rateLimitPerSecond) : null;
  return {
    resolve: () => provider,
    resolveSymbol: () => provider,
    forClass: () => provider,
    providerIdForClass: () => (provider ? (provider.capabilities.id as ProviderId) : 'none'),
    configured: () => (provider ? [provider] : []),
    // One budget for the single injected provider, so an override behaves like
    // the real router rather than skipping throttling entirely.
    budgetFor: () => fixedBudget,
    primary: provider,
  };
}

/** Capability descriptors for every known provider, for docs and the API. */
export function listAvailableProviders(): readonly ProviderCapabilities[] {
  return [COINBASE_CAPABILITIES, YAHOO_CAPABILITIES];
}

export function providerCapabilities(id: ProviderId): ProviderCapabilities | null {
  switch (id) {
    case 'coinbase':
      return COINBASE_CAPABILITIES;
    case 'yahoo':
      return YAHOO_CAPABILITIES;
    case 'none':
      return null;
  }
}
