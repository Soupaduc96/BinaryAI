import { describe, expect, it } from 'vitest';
import { resolveAssetClassState, resolveAvailability } from './availability.js';
import { findInstrument } from './catalogue.js';
import { createProviderRouter, type ProviderAssignment } from './registry.js';

/**
 * The capability ladder.
 *
 * The rule under test is the one the whole phase exists to enforce: HAVING A
 * CHART IS NOT BEING ANALYSED. BinaryAI's engine runs against one configured
 * instrument, and every other instrument can have live validated candles while
 * producing no signal at all. These tests pin that apart so a future refactor
 * cannot quietly make `analysis` follow `marketData`.
 */

const BTC = findInstrument('BTCUSD')!;
const EUR = findInstrument('EURUSD')!;
const AAPL = findInstrument('AAPL')!;

const router = (assignment: ProviderAssignment) => createProviderRouter(assignment);

const CRYPTO_ONLY: ProviderAssignment = { crypto: 'coinbase', equity: 'none' };
const BOTH: ProviderAssignment = { crypto: 'coinbase', equity: 'yahoo' };
const NEITHER: ProviderAssignment = { crypto: 'none', equity: 'none' };

/** A fully working deployment analysing BTC/USD, as the defaults describe. */
const healthy = {
  router: router(BOTH),
  persistenceConfigured: true,
  storedTimeframes: ['1m'] as const,
  analysedSymbols: ['BTCUSD'],
  analysisEnabled: true,
};

describe('instrument availability', () => {
  describe('market data', () => {
    it('is available when a provider serves the class', () => {
      const result = resolveAvailability({ ...healthy, instrument: BTC });
      expect(result.marketData.state).toBe('available');
      expect(result.marketData.detail).toContain('Coinbase');
    });

    it('is not_configured when the class has no provider', () => {
      const result = resolveAvailability({
        ...healthy,
        router: router(CRYPTO_ONLY),
        instrument: EUR,
      });
      expect(result.marketData.state).toBe('not_configured');
      // The distinction the user acts on: implemented, not enabled here.
      expect(result.marketData.detail).toContain('implements this asset class');
    });

    it('separates a rate limit from any other provider failure', () => {
      // Different user response: wait, versus go and investigate.
      const limited = resolveAvailability({
        ...healthy,
        instrument: BTC,
        providerFailure: { kind: 'rate_limited', message: 'too many' },
      });
      expect(limited.marketData.state).toBe('rate_limited');
      expect(limited.marketData.detail).toContain('temporary');

      const broken = resolveAvailability({
        ...healthy,
        instrument: BTC,
        providerFailure: { kind: 'network', message: 'connection refused' },
      });
      expect(broken.marketData.state).toBe('provider_error');
      expect(broken.marketData.detail).toContain('connection refused');
    });
  });

  describe('chart', () => {
    it('is no_data when the provider works but nothing is stored', () => {
      // Distinct from not_configured: the fix is "ingest", not "configure".
      const result = resolveAvailability({ ...healthy, instrument: BTC, storedTimeframes: [] });
      expect(result.chart.state).toBe('no_data');
      expect(result.chart.detail).toContain('No candles have been ingested');
    });

    it('is not_configured without a database', () => {
      const result = resolveAvailability({
        ...healthy,
        instrument: BTC,
        persistenceConfigured: false,
        storedTimeframes: [],
      });
      expect(result.chart.state).toBe('not_configured');
    });

    it('reports the timeframes actually stored', () => {
      const result = resolveAvailability({
        ...healthy,
        instrument: BTC,
        storedTimeframes: ['1m', '1h'],
      });
      expect(result.chart.state).toBe('available');
      expect(result.chart.detail).toContain('1m, 1h');
    });
  });

  describe('analysis is independent of market data', () => {
    it('is NOT available for an instrument with a perfect chart', () => {
      // The core claim. EUR/USD: provider configured, candles stored, chart
      // drawn — and still not analysed, because the engine runs on BTCUSD.
      const result = resolveAvailability({
        ...healthy,
        instrument: EUR,
        storedTimeframes: ['1m', '1h'],
      });

      expect(result.marketData.state).toBe('available');
      expect(result.chart.state).toBe('available');
      expect(result.analysis.state).toBe('not_configured');
      expect(result.analysis.detail).toContain('analyses BTCUSD, which does not include EUR/USD');
    });

    it('is available only for the configured instrument', () => {
      const result = resolveAvailability({ ...healthy, instrument: BTC });
      expect(result.analysis.state).toBe('available');
    });

    it('follows the configured symbol when it changes', () => {
      // Configuring the engine for EUR/USD makes EUR/USD analysed and BTC not.
      // Nothing about the instruments themselves changes.
      const onEur = { ...healthy, analysedSymbols: ['EURUSD'] };
      expect(resolveAvailability({ ...onEur, instrument: EUR }).analysis.state).toBe('available');
      expect(resolveAvailability({ ...onEur, instrument: BTC }).analysis.state).toBe(
        'not_configured',
      );
    });

    it('is not_configured for every instrument when the worker is off', () => {
      const result = resolveAvailability({ ...healthy, instrument: BTC, analysisEnabled: false });
      expect(result.analysis.state).toBe('not_configured');
      expect(result.analysis.detail).toContain('disabled');
    });

    it('is no_data when the configured instrument has no candles to analyse', () => {
      const result = resolveAvailability({ ...healthy, instrument: BTC, storedTimeframes: [] });
      expect(result.analysis.state).toBe('no_data');
    });
  });

  describe('paper trading follows analysis, never market data', () => {
    it('is unavailable for an instrument that produces no signal', () => {
      const result = resolveAvailability({
        ...healthy,
        instrument: AAPL,
        storedTimeframes: ['1d'],
      });
      expect(result.chart.state).toBe('available');
      expect(result.paperTrading.state).toBe('not_configured');
      expect(result.paperTrading.detail).toContain('taken on a signal');
    });

    it('is available for the analysed instrument', () => {
      const result = resolveAvailability({ ...healthy, instrument: BTC });
      expect(result.paperTrading.state).toBe('available');
    });

    it('explains itself by naming the analysis cause', () => {
      // The paper detail carries the analysis detail, so a user reading only
      // the last line still learns why.
      const result = resolveAvailability({ ...healthy, instrument: EUR });
      expect(result.paperTrading.detail).toContain('analyses BTCUSD');
    });
  });

  describe('asset class state', () => {
    it('reports the provider that serves a configured class', () => {
      const result = resolveAssetClassState('forex', router(BOTH));
      expect(result.state).toBe('available');
      expect(result.detail).toContain('Yahoo Finance');
    });

    it('reports not_configured for a class with no provider', () => {
      const result = resolveAssetClassState('forex', router(CRYPTO_ONLY));
      expect(result.state).toBe('not_configured');
      expect(result.detail).toContain('implemented but no data provider');
    });

    it('reports every class unconfigured when nothing is set', () => {
      for (const assetClass of ['crypto', 'forex', 'stock', 'index', 'commodity'] as const) {
        expect(resolveAssetClassState(assetClass, router(NEITHER)).state).toBe('not_configured');
      }
    });
  });

  describe('no cross-instrument leakage', () => {
    it('reports availability for the instrument it was asked about', () => {
      for (const instrument of [BTC, EUR, AAPL]) {
        const result = resolveAvailability({ ...healthy, instrument });
        expect(result.symbol).toBe(instrument.symbol);
      }
    });

    it('never mentions another instrument as if it were this one', () => {
      const result = resolveAvailability({ ...healthy, instrument: AAPL });
      // Naming BTCUSD as the analysed instrument is correct and expected; what
      // must not happen is AAPL inheriting BTC's availability.
      expect(result.analysis.state).not.toBe('available');
      expect(result.paperTrading.state).not.toBe('available');
    });
  });
});

/**
 * R6 — the analysed SET.
 *
 * `analysedSymbols` was a single string compared with `!==`, and it produced an
 * outright false statement the moment a second instrument was configured. With
 * ANALYSIS_INSTRUMENTS=BTCUSD,ETHUSD the worker analysed both while this module
 * told every caller "BinaryAI's engine analyses BTCUSD, not ETH/USD. No signal
 * is being produced for this instrument" — about an instrument that was, at
 * that moment, producing signals.
 */
describe('R6 — multiple analysed instruments', () => {
  const ETH = findInstrument('ETHUSD')!;
  const multi = { ...healthy, analysedSymbols: ['BTCUSD', 'ETHUSD'] };

  it('reports EVERY configured instrument as analysed', () => {
    expect(resolveAvailability({ ...multi, instrument: BTC }).analysis.state).toBe('available');
    // The assertion that would have failed before: ETH is configured, so ETH
    // is analysed, and nothing may claim otherwise.
    expect(resolveAvailability({ ...multi, instrument: ETH }).analysis.state).toBe('available');
  });

  it('allows paper trading on every analysed instrument', () => {
    for (const instrument of [BTC, ETH]) {
      expect(resolveAvailability({ ...multi, instrument }).paperTrading.state).toBe('available');
    }
  });

  it('names the WHOLE set when refusing an instrument outside it', () => {
    // A reader must be able to see what IS analysed, not just that this one
    // is not. Naming one of several was the original lie.
    const result = resolveAvailability({ ...multi, instrument: EUR });
    expect(result.analysis.state).toBe('not_configured');
    expect(result.analysis.detail).toContain('BTCUSD, ETHUSD');
    expect(result.analysis.detail).toContain('does not include EUR/USD');
  });

  it('treats an empty set as analysis not configured', () => {
    const none = { ...healthy, analysedSymbols: [] as string[] };
    expect(resolveAvailability({ ...none, instrument: BTC }).analysis.state).toBe('not_configured');
    expect(resolveAvailability({ ...none, instrument: BTC }).analysis.detail).toContain(
      'No instrument is configured',
    );
  });
});
