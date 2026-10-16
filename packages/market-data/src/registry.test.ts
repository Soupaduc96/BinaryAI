import { describe, expect, it } from 'vitest';
import { createProvider, createProviderRouter, providerCapabilities } from './registry.js';
import { findInstrument } from './catalogue.js';

/**
 * Provider routing.
 *
 * The architectural rule this file defends: BINARYAI'S ENGINE IS NOT COUPLED TO
 * COINBASE. An instrument's asset class chooses its provider, so adding a
 * licensed equities vendor is an adapter plus a registry line, and no engine,
 * repository or UI code changes.
 *
 * The failure this prevents is specific and would be near-invisible: asking a
 * crypto exchange for AAPL. It would 404, get classified as "not found", and
 * read to the user as a missing instrument rather than a misrouted request.
 */

const BTC = findInstrument('BTCUSD')!;
const EUR = findInstrument('EURUSD')!;
const AAPL = findInstrument('AAPL')!;
const SPX = findInstrument('SPX')!;
const GOLD = findInstrument('XAUUSD')!;

describe('provider registry', () => {
  describe('createProvider', () => {
    it('returns null for none, which is a configuration not a failure', () => {
      expect(createProvider('none')).toBeNull();
    });

    it('builds each known adapter', () => {
      expect(createProvider('coinbase')?.capabilities.id).toBe('coinbase');
      expect(createProvider('yahoo')?.capabilities.id).toBe('yahoo');
    });

    it('exposes capabilities without constructing an adapter', () => {
      expect(providerCapabilities('coinbase')?.displayName).toBe('Coinbase Exchange');
      expect(providerCapabilities('none')).toBeNull();
    });
  });

  describe('routing by asset class', () => {
    const router = createProviderRouter({ crypto: 'coinbase', equity: 'yahoo' });

    it('sends crypto to the crypto venue', () => {
      expect(router.resolve(BTC)?.capabilities.id).toBe('coinbase');
    });

    it('sends forex, equities, indices and commodities to the vendor', () => {
      for (const instrument of [EUR, AAPL, SPX, GOLD]) {
        expect(router.resolve(instrument)?.capabilities.id).toBe('yahoo');
      }
    });

    it('never routes an equity to the crypto exchange', () => {
      // The regression this whole module exists to prevent.
      for (const instrument of [EUR, AAPL, SPX, GOLD]) {
        expect(router.resolve(instrument)?.capabilities.id).not.toBe('coinbase');
      }
    });

    it('resolves by symbol as well as by instrument', () => {
      expect(router.resolveSymbol('BTCUSD')?.capabilities.id).toBe('coinbase');
      expect(router.resolveSymbol('AAPL')?.capabilities.id).toBe('yahoo');
    });

    it('resolves a legacy symbol through the catalogue alias', () => {
      expect(router.resolveSymbol('BTC-USD')?.capabilities.id).toBe('coinbase');
    });

    it('returns null for a symbol no catalogue entry claims', () => {
      expect(router.resolveSymbol('NOTREAL')).toBeNull();
    });

    it('shares one adapter instance across classes with the same provider', () => {
      // Two classes pointing at one provider must share a rate budget. Separate
      // instances would each think they had the full allowance.
      expect(router.forClass('forex')).toBe(router.forClass('stock'));
      expect(router.forClass('index')).toBe(router.forClass('commodity'));
    });
  });

  describe('partial configuration', () => {
    const cryptoOnly = createProviderRouter({ crypto: 'coinbase', equity: 'none' });

    it('serves the configured class', () => {
      expect(cryptoOnly.resolve(BTC)).not.toBeNull();
    });

    it('returns null for an unconfigured class rather than falling back', () => {
      // Falling back to the crypto provider would ask Coinbase for EUR/USD.
      for (const instrument of [EUR, AAPL, SPX, GOLD]) {
        expect(cryptoOnly.resolve(instrument)).toBeNull();
      }
    });

    it('reports only genuinely configured providers', () => {
      expect(cryptoOnly.configured().map((p) => p.capabilities.id)).toEqual(['coinbase']);
    });

    it('names the provider id per class even when it is none', () => {
      expect(cryptoOnly.providerIdForClass('crypto')).toBe('coinbase');
      expect(cryptoOnly.providerIdForClass('forex')).toBe('none');
    });
  });

  describe('equity-only configuration', () => {
    const equityOnly = createProviderRouter({ crypto: 'none', equity: 'yahoo' });

    it('serves equities and refuses crypto', () => {
      expect(equityOnly.resolve(AAPL)?.capabilities.id).toBe('yahoo');
      expect(equityOnly.resolve(BTC)).toBeNull();
    });

    it('falls back to the configured provider as primary', () => {
      // `primary` is for callers with no instrument in hand — the status
      // indicator. With no crypto provider it must still find one.
      expect(equityOnly.primary?.capabilities.id).toBe('yahoo');
    });
  });

  describe('no configuration', () => {
    const none = createProviderRouter({ crypto: 'none', equity: 'none' });

    it('resolves nothing and reports nothing configured', () => {
      expect(none.resolve(BTC)).toBeNull();
      expect(none.resolve(AAPL)).toBeNull();
      expect(none.primary).toBeNull();
      expect(none.configured()).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('lists a provider once when it serves several classes', () => {
      const router = createProviderRouter({ crypto: 'yahoo', equity: 'yahoo' });
      expect(router.configured()).toHaveLength(1);
    });
  });
});
