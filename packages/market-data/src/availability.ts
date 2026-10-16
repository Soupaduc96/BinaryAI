import type {
  AssetClass,
  Capability,
  Instrument,
  InstrumentAvailability,
  Timeframe,
} from '@binaryai/types';
import { ASSET_CLASS_LABELS } from './catalogue.js';
import type { ProviderRouter } from './registry.js';

/**
 * What BinaryAI can actually do with an instrument, right now.
 *
 * This module exists to stop a single question — "is this instrument usable?" —
 * from being answered four different ways in four different components. It is
 * pure: hand it facts, get a verdict. No fetching, no I/O, so the API route
 * gathers evidence and this decides what the evidence means.
 *
 * THE RULE IT ENFORCES, which is the point of the whole phase:
 *
 *   Having a chart is not being analysed.
 *
 * BinaryAI's engine runs against ONE configured instrument. Every other
 * instrument in the catalogue can have live, validated, stored candles and a
 * perfectly good chart while producing no signals at all. A UI that lets the
 * chart imply an opinion is lying by omission, so `analysis` is computed
 * independently of `marketData` and is never inferred from it.
 */

export interface AvailabilityInputs {
  readonly instrument: Instrument;
  /** Router, so the provider for this instrument's class can be resolved. */
  readonly router: ProviderRouter;
  /** True when a database is configured; without one nothing can be stored. */
  readonly persistenceConfigured: boolean;
  /** Timeframes with at least one stored candle for this instrument. */
  readonly storedTimeframes: readonly Timeframe[];
  /**
   * The timeframe the workspace is actually showing.
   *
   * D4. Chart availability used to mean "some timeframe has candles", while the
   * chart rendered at the workspace timeframe. AAPL holds 205 daily candles and
   * no 1m candles, so /analysis?asset=AAPL — the URL the picker produces —
   * displayed CHART: AVAILABLE directly above an empty chart reading
   * "No stored candles for AAPL 1m". Availability now answers the question the
   * user is actually asking: this instrument, AT THIS TIMEFRAME.
   *
   * Omitted where the caller has no timeframe in hand (a catalogue listing, for
   * instance); availability then falls back to the instrument-wide answer and
   * says so.
   */
  readonly timeframe?: Timeframe | undefined;
  /**
   * EVERY instrument the analysis worker is configured to run against, already
   * resolved to canonical symbols. Empty when analysis is disabled.
   *
   * R6. This was a single string compared with `!==`, and it produced an
   * outright false statement the moment a second instrument was configured:
   * with ANALYSIS_INSTRUMENTS=BTCUSD,ETHUSD the worker analysed both while this
   * module told every caller "BinaryAI's engine analyses BTCUSD, not ETH/USD.
   * No signal is being produced for this instrument" — about an instrument
   * that was, at that moment, producing signals.
   *
   * A set cannot make that mistake: membership is the question being asked.
   */
  readonly analysedSymbols: readonly string[];
  /** True when the analysis worker is enabled in configuration. */
  readonly analysisEnabled: boolean;
  /**
   * A provider failure observed for this instrument's class during THIS
   * request. Present only when something actually failed — never speculative.
   */
  readonly providerFailure?: { readonly kind: string; readonly message: string } | undefined;
}

/**
 * Resolves the four capability states.
 *
 * Order matters: each link checks its own precondition rather than trusting the
 * previous verdict, so a bug in one cannot silently promote another.
 */
export function resolveAvailability(inputs: AvailabilityInputs): InstrumentAvailability {
  const { instrument, router, storedTimeframes, timeframe } = inputs;

  const providerId = router.providerIdForClass(instrument.assetClass);
  const provider = router.forClass(instrument.assetClass);

  // ------------------------------------------------------- market data --
  const marketData: Capability = ((): Capability => {
    if (providerId === 'none' || !provider) {
      return {
        state: 'not_configured',
        detail: `No market-data provider is configured for ${ASSET_CLASS_LABELS[instrument.assetClass].toLowerCase()}. BinaryAI implements this asset class but this deployment has not enabled a provider for it.`,
      };
    }
    if (inputs.providerFailure) {
      // Rate limiting is separated from other failures because the user's
      // response differs: wait, versus investigate.
      if (inputs.providerFailure.kind === 'rate_limited') {
        return {
          state: 'rate_limited',
          detail: `${provider.capabilities.displayName} refused the request for volume. This is temporary; retrying shortly usually succeeds.`,
        };
      }
      return {
        state: 'provider_error',
        detail: `${provider.capabilities.displayName} could not be reached: ${inputs.providerFailure.message}`,
      };
    }
    if (!instrument.supportedTimeframes.length) {
      return {
        state: 'unsupported',
        detail: `${provider.capabilities.displayName} serves no timeframe for ${instrument.displaySymbol}.`,
      };
    }
    return {
      state: 'available',
      detail: `${provider.capabilities.displayName} serves ${instrument.displaySymbol} at ${instrument.supportedTimeframes.join(', ')}.`,
    };
  })();

  // -------------------------------------------------------------- chart --
  const chart: Capability = ((): Capability => {
    if (!inputs.persistenceConfigured) {
      return {
        state: 'not_configured',
        detail:
          'No database is configured, so validated candles are never stored. The chart draws stored bars only, never a provider passthrough.',
      };
    }
    if (marketData.state === 'not_configured') {
      return {
        state: 'not_configured',
        detail: 'Nothing can be ingested for this instrument until its asset class has a provider.',
      };
    }
    if (storedTimeframes.length === 0) {
      return {
        state: 'no_data',
        detail: `No candles have been ingested for ${instrument.displaySymbol} yet. Adding it from the instrument picker backfills a recent window.`,
      };
    }

    /*
     * The timeframe-specific answer — the D4 fix.
     *
     * Naming what IS stored, because that is the actionable part: a user told
     * only "no data" would reasonably conclude the instrument is broken, when
     * in fact one click on a different timeframe draws a full chart.
     */
    if (timeframe !== undefined && !storedTimeframes.includes(timeframe)) {
      return {
        state: 'no_data',
        detail:
          `No ${timeframe} candles are stored for ${instrument.displaySymbol}. ` +
          `Stored: ${storedTimeframes.join(', ')}.`,
      };
    }

    return {
      state: 'available',
      detail:
        timeframe === undefined
          ? `Stored, validated candles for ${storedTimeframes.join(', ')}.`
          : `Stored, validated ${timeframe} candles for ${instrument.displaySymbol}.`,
    };
  })();

  // ----------------------------------------------------------- analysis --
  const analysis: Capability = ((): Capability => {
    if (!inputs.analysisEnabled) {
      return {
        state: 'not_configured',
        detail:
          'The analysis worker is disabled in this deployment, so no instrument is being analysed.',
      };
    }
    if (inputs.analysedSymbols.length === 0) {
      return {
        state: 'not_configured',
        detail: 'No instrument is configured for analysis.',
      };
    }
    if (!inputs.analysedSymbols.includes(instrument.symbol)) {
      // The single most important honest state in the product. It names the
      // WHOLE configured set, so a reader sees what IS analysed rather than
      // being told about one instrument out of several.
      return {
        state: 'not_configured',
        detail:
          `BinaryAI's engine analyses ${inputs.analysedSymbols.join(', ')}, which does not ` +
          `include ${instrument.displaySymbol}. Market data and the chart are real; no signal ` +
          'is being produced for this instrument.',
      };
    }
    if (chart.state !== 'available') {
      return {
        state: 'no_data',
        detail: `${instrument.displaySymbol} is the configured analysis instrument, but there are no stored candles to analyse yet.`,
      };
    }
    return {
      state: 'available',
      detail: `The engine analyses ${instrument.displaySymbol} on each closed candle.`,
    };
  })();

  // ------------------------------------------------------- paper trading --
  const paperTrading: Capability = ((): Capability => {
    if (analysis.state !== 'available') {
      return {
        state: analysis.state === 'no_data' ? 'no_data' : 'not_configured',
        detail: `Paper actions are taken on a signal, and no signal is produced for ${instrument.displaySymbol}. ${analysis.detail}`,
      };
    }
    if (!inputs.persistenceConfigured) {
      return {
        state: 'not_configured',
        detail: 'Paper positions require a database.',
      };
    }
    return {
      state: 'available',
      detail: `Signals for ${instrument.displaySymbol} can be acted on against a paper account.`,
    };
  })();

  return { symbol: instrument.symbol, marketData, chart, analysis, paperTrading };
}

/**
 * The state of a whole asset class, for the picker's group headers.
 *
 * Reports on the PROVIDER, not on any instrument: the question a group header
 * answers is "can BinaryAI get forex data at all", and answering it per
 * instrument would make an unconfigured class look like a list of broken rows.
 */
export function resolveAssetClassState(
  assetClass: AssetClass,
  router: ProviderRouter,
): { state: Capability['state']; detail: string } {
  const provider = router.forClass(assetClass);
  if (!provider) {
    return {
      state: 'not_configured',
      detail: `${ASSET_CLASS_LABELS[assetClass]} is implemented but no data provider is configured for it in this deployment.`,
    };
  }
  return {
    state: 'available',
    detail: `Served by ${provider.capabilities.displayName}.`,
  };
}
