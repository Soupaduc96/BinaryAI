import type { MarketDataProvider } from '@binaryai/types';
import { createCoinbaseProvider, COINBASE_CAPABILITIES } from './providers/coinbase.js';
import type { HttpFetch } from './provider-error.js';

/**
 * Provider registry.
 *
 * The single place a provider id maps to an implementation. Adding a provider
 * means writing an adapter and adding one line here — no consumer changes,
 * because everything downstream depends on `MarketDataProvider`.
 */

export type ProviderId = 'none' | 'coinbase';

export interface CreateProviderOptions {
  readonly fetchImpl?: HttpFetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Reserved for keyed providers. Coinbase's public endpoints need none. */
  readonly apiKey?: string | undefined;
}

/** Returns null for 'none', which is a valid configuration, not a failure. */
export function createProvider(
  id: ProviderId,
  options: CreateProviderOptions = {},
): MarketDataProvider | null {
  switch (id) {
    case 'none':
      return null;
    case 'coinbase':
      return createCoinbaseProvider({
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
  }
}

/** Capability descriptors for every known provider, for docs and the API. */
export function listAvailableProviders() {
  return [COINBASE_CAPABILITIES];
}
