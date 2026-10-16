import { describe, expect, it } from 'vitest';
import {
  ASSET_CLASS_LABELS,
  CATALOGUE_ASSET_CLASSES,
  INSTRUMENT_CATALOGUE,
  assetFromInstrument,
  findInstrument,
  instrumentsByClass,
  listInstruments,
  searchInstruments,
} from './catalogue.js';

/**
 * The catalogue is the system's definition of what an instrument IS, so these
 * tests are mostly about internal coherence rather than behaviour: a row whose
 * provider symbol disagrees with its domain symbol is a bug that no amount of
 * downstream care can recover from.
 *
 * What is deliberately NOT tested here: whether a symbol resolves against a
 * live provider. That is `scripts/verify-catalogue.mjs`, run against the real
 * APIs. Asserting it in the unit suite would make the build fail when Coinbase
 * has an outage, which teaches people to ignore a red build.
 */

describe('instrument catalogue', () => {
  describe('identity', () => {
    it('gives every instrument a unique symbol', () => {
      const symbols = INSTRUMENT_CATALOGUE.map((entry) => entry.symbol);
      expect(new Set(symbols).size).toBe(symbols.length);
    });

    it('resolves a symbol to exactly the instrument that declares it', () => {
      for (const entry of INSTRUMENT_CATALOGUE) {
        expect(findInstrument(entry.symbol)).toBe(entry);
      }
    });

    it('rejects an unknown symbol rather than guessing', () => {
      // The failure mode this prevents: a typo becoming a new asset row.
      expect(findInstrument('NOTREAL')).toBeNull();
      expect(findInstrument('')).toBeNull();
      expect(findInstrument('BTC')).toBeNull();
    });

    it('is case-sensitive, because a symbol is an identifier not a search', () => {
      expect(findInstrument('btcusd')).toBeNull();
      expect(findInstrument('BTCUSD')).not.toBeNull();
    });

    it('resolves the legacy BTC-USD spelling to the canonical instrument', () => {
      // Bookmarked URLs and in-flight requests from before migration 0010.
      const legacy = findInstrument('BTC-USD');
      expect(legacy?.symbol).toBe('BTCUSD');
      expect(legacy).toBe(findInstrument('BTCUSD'));
    });
  });

  describe('asset class', () => {
    it('places every instrument in a class the picker renders', () => {
      for (const entry of INSTRUMENT_CATALOGUE) {
        expect(CATALOGUE_ASSET_CLASSES).toContain(entry.assetClass);
        expect(ASSET_CLASS_LABELS[entry.assetClass]).toBeTruthy();
      }
    });

    it('covers all five target classes', () => {
      for (const assetClass of CATALOGUE_ASSET_CLASSES) {
        expect(instrumentsByClass(assetClass).length).toBeGreaterThan(0);
      }
    });

    it('filters by class without leaking another class in', () => {
      for (const assetClass of CATALOGUE_ASSET_CLASSES) {
        for (const entry of instrumentsByClass(assetClass)) {
          expect(entry.assetClass).toBe(assetClass);
        }
      }
    });
  });

  describe('provider symbol mapping', () => {
    it('routes crypto to the crypto venue and everything else to the vendor', () => {
      // The architectural rule: an asset class picks a provider. A crypto
      // exchange must never be named as the source for an equity.
      for (const entry of INSTRUMENT_CATALOGUE) {
        expect(entry.providerId).toBe(entry.assetClass === 'crypto' ? 'coinbase' : 'yahoo');
      }
    });

    it('derives the Coinbase product id from base and quote', () => {
      expect(findInstrument('BTCUSD')?.providerSymbol).toBe('BTC-USD');
      expect(findInstrument('DOGEUSD')?.providerSymbol).toBe('DOGE-USD');
    });

    it('uses provider-specific syntax for each non-crypto class', () => {
      expect(findInstrument('EURUSD')?.providerSymbol).toBe('EURUSD=X');
      expect(findInstrument('SPX')?.providerSymbol).toBe('^GSPC');
      expect(findInstrument('XAUUSD')?.providerSymbol).toBe('GC=F');
      // An equity's ticker happens to equal its provider symbol. Asserted so a
      // future change that mangles it is caught rather than assumed harmless.
      expect(findInstrument('AAPL')?.providerSymbol).toBe('AAPL');
    });

    it('never leaks provider syntax into the domain symbol', () => {
      // `=X`, `^` and `=F` are provider spellings. A domain symbol carrying one
      // means the separation has been broken somewhere.
      for (const entry of INSTRUMENT_CATALOGUE) {
        expect(entry.symbol).not.toMatch(/[=^]/);
      }
    });

    it('gives a pair a display symbol built from its currencies', () => {
      expect(findInstrument('EURUSD')?.displaySymbol).toBe('EUR/USD');
      expect(findInstrument('BTCUSD')?.displaySymbol).toBe('BTC/USD');
      // Not a pair: no slash, because there is no base to put before one.
      expect(findInstrument('AAPL')?.displaySymbol).toBe('AAPL');
      expect(findInstrument('AAPL')?.quoting.base).toBeNull();
    });
  });

  describe('quoting', () => {
    it('quotes JPY pairs to three places and other majors to five', () => {
      // 159.38000 would be false precision; 1.17 would lose a real pip.
      expect(findInstrument('USDJPY')?.quoting.pricePrecision).toBe(3);
      expect(findInstrument('EURUSD')?.quoting.pricePrecision).toBe(5);
    });

    it('names the currency a price is actually expressed in', () => {
      expect(findInstrument('USDJPY')?.quoting.quote).toBe('JPY');
      expect(findInstrument('EURGBP')?.quoting.quote).toBe('GBP');
      expect(findInstrument('USDCAD')?.quoting.quote).toBe('CAD');
    });

    it('gives every instrument a usable precision', () => {
      for (const entry of INSTRUMENT_CATALOGUE) {
        expect(entry.quoting.pricePrecision).toBeGreaterThanOrEqual(0);
        expect(entry.quoting.pricePrecision).toBeLessThanOrEqual(10);
        expect(entry.quoting.quote).toMatch(/^[A-Z]{3,4}$/);
      }
    });
  });

  describe('supported timeframes', () => {
    it('declares at least one timeframe for every instrument', () => {
      for (const entry of INSTRUMENT_CATALOGUE) {
        expect(entry.supportedTimeframes.length).toBeGreaterThan(0);
      }
    });

    it('never offers a timeframe outside the shared set', () => {
      // Offering 30m on FX and not on crypto would make the timeframe control
      // behave differently per instrument for no reason the user can see.
      const allowed = new Set(['1m', '5m', '15m', '1h', '1d']);
      for (const entry of INSTRUMENT_CATALOGUE) {
        for (const timeframe of entry.supportedTimeframes) {
          expect(allowed.has(timeframe)).toBe(true);
        }
      }
    });
  });

  describe('trading schedule', () => {
    it('marks crypto continuous and equities session-bound', () => {
      expect(findInstrument('BTCUSD')?.schedule).toBe('24x7');
      expect(findInstrument('EURUSD')?.schedule).toBe('24x5');
      expect(findInstrument('AAPL')?.schedule).toBe('exchange_session');
      expect(findInstrument('SPX')?.schedule).toBe('exchange_session');
    });
  });

  describe('search', () => {
    it('ranks an exact symbol above a name that merely contains it', () => {
      const results = searchInstruments('BTC');
      expect(results[0]?.symbol).toBe('BTCUSD');
    });

    it('finds every pair involving a currency', () => {
      const results = searchInstruments('EUR');
      const symbols = results.map((entry) => entry.symbol);
      expect(symbols).toContain('EURUSD');
      expect(symbols).toContain('EURGBP');
    });

    it('matches on name as well as symbol', () => {
      expect(searchInstruments('Gold').map((e) => e.symbol)).toContain('XAUUSD');
      expect(searchInstruments('Apple').map((e) => e.symbol)).toContain('AAPL');
      expect(searchInstruments('Nasdaq').map((e) => e.symbol)).toContain('NDX');
    });

    it('is case-insensitive and tolerates surrounding space', () => {
      expect(searchInstruments('  nvda  ').map((e) => e.symbol)).toContain('NVDA');
    });

    it('returns nothing for a query that matches nothing', () => {
      // Not "everything", which is what a naive filter does on no match.
      expect(searchInstruments('zzzzz')).toHaveLength(0);
    });

    it('returns the whole catalogue for an empty query', () => {
      expect(searchInstruments('', 200)).toHaveLength(INSTRUMENT_CATALOGUE.length);
    });

    it('respects the limit', () => {
      expect(searchInstruments('USD', 3)).toHaveLength(3);
    });
  });

  describe('persisted projection', () => {
    it('carries the full instrument into the asset row', () => {
      const instrument = findInstrument('EURUSD')!;
      const asset = assetFromInstrument(instrument);

      expect(asset).toMatchObject({
        symbol: 'EURUSD',
        displaySymbol: 'EUR/USD',
        assetClass: 'forex',
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        providerId: 'yahoo',
        providerSymbol: 'EURUSD=X',
        pricePrecision: 5,
        inCatalogue: true,
      });
    });

    it('never labels a non-crypto instrument as crypto', () => {
      // The specific regression: both the ingest path and the runtime used to
      // hardcode 'crypto' for whatever they were handed.
      for (const entry of listInstruments()) {
        const asset = assetFromInstrument(entry);
        expect(asset.assetClass).toBe(entry.assetClass);
        if (entry.assetClass !== 'crypto') expect(asset.assetClass).not.toBe('crypto');
      }
    });
  });
});
