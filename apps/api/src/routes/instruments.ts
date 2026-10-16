import {
  ASSET_CLASS_LABELS,
  CATALOGUE_ASSET_CLASSES,
  findInstrument,
  listInstruments,
  resolveAssetClassState,
  assessFreshness,
  resolveAvailability,
  searchInstruments,
} from '@binaryai/market-data';
import type {
  AssetClassStatus,
  CandleCoverage,
  Instrument,
  InstrumentMarketState,
  InstrumentStatus,
  Timeframe,
} from '@binaryai/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody } from '../lib/http.js';

/**
 * The instrument catalogue.
 *
 * THE SERVER IS AUTHORITATIVE. The browser picks from what this returns; it
 * never constructs an instrument, and it never learns a provider's symbol
 * syntax. That is a security boundary as much as a modelling one — the ingest
 * route used to accept any `asset` string a caller sent.
 *
 * Every response carries availability, because a catalogue without it is a
 * promise the system may not be able to keep. The four capability states are
 * computed per instrument from real evidence: which provider serves its class,
 * whether a database exists, what is actually stored, and which instrument the
 * engine is configured to analyse.
 */

const singleTimeframeSchema = z.enum(['1m', '5m', '15m', '1h', '1d']);

const listQuerySchema = z.object({
  assetClass: z.enum(['crypto', 'forex', 'stock', 'index', 'commodity']).optional(),
  q: z.string().max(64).optional(),
  /**
   * The timeframe the workspace is showing.
   *
   * D4: chart availability is answered for THIS timeframe when one is given.
   * Optional, because a catalogue listing legitimately has no timeframe in hand.
   */
  timeframe: z.enum(['1m', '5m', '15m', '1h', '1d']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});

export function registerInstrumentRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * Coverage for every instrument in one query.
   *
   * Read once per request and shared across all catalogue entries. Asking per
   * instrument would be thirty-six round trips to answer a question one GROUP
   * BY already answers.
   */
  async function coverageBySymbol(): Promise<Map<string, CandleCoverage[]>> {
    const byCandleSymbol = new Map<string, CandleCoverage[]>();
    if (!context.persistence) return byCandleSymbol;
    const rows = await context.persistence.repositories.candles.coverage();
    for (const row of rows) {
      const existing = byCandleSymbol.get(row.assetSymbol);
      if (existing) existing.push(row);
      else byCandleSymbol.set(row.assetSymbol, [row]);
    }
    return byCandleSymbol;
  }

  function describe(
    instrument: Instrument,
    coverage: readonly CandleCoverage[] | undefined,
    timeframe?: Timeframe,
  ): InstrumentStatus {
    const stored = coverage ?? [];
    const storedTimeframes = stored.map((row) => row.timeframe);
    const lastCandleAt = stored.reduce<number | null>(
      (newest, row) => (newest === null || row.lastCandleAt > newest ? row.lastCandleAt : newest),
      null,
    );

    /*
     * R7 — market state for THIS instrument at THIS timeframe.
     *
     * Derived from the coverage row for the requested timeframe, never from the
     * global status. The global one reports whichever instrument the worker
     * polls, so it declared AAPL LIVE beside its own "23h ago". `no_data` and
     * `stale` stay distinct because the fix differs: ingest it, or find out why
     * ingestion stopped.
     */
    const marketState = ((): InstrumentMarketState | undefined => {
      if (timeframe === undefined) return undefined;

      const providerId = context.marketData.router.providerIdForClass(instrument.assetClass);
      const provider = context.marketData.router.forClass(instrument.assetClass);
      if (!provider) {
        return {
          symbol: instrument.symbol,
          timeframe,
          providerId: null,
          lastCandleAt: null,
          ageSeconds: null,
          barsBehind: 0,
          state: 'not_configured',
          detail: `No provider is configured for ${instrument.assetClass}.`,
        };
      }

      const row = stored.find((entry) => entry.timeframe === timeframe);
      if (!row) {
        return {
          symbol: instrument.symbol,
          timeframe,
          providerId,
          lastCandleAt: null,
          ageSeconds: null,
          barsBehind: 0,
          state: 'no_data',
          detail:
            storedTimeframes.length === 0
              ? `No candles are stored for ${instrument.displaySymbol}.`
              : `No ${timeframe} candles are stored for ${instrument.displaySymbol}. Stored: ${storedTimeframes.join(', ')}.`,
        };
      }

      /*
       * Freshness is judged against THIS timeframe's grid, not a fixed
       * seconds threshold — see `assessFreshness`.
       *
       * A 1h instrument cannot have a bar younger than an hour, so the old
       * 300s threshold reported STALE for fifty-five minutes out of every
       * sixty, and a 1d instrument was stale permanently. Both were reporting
       * on perfectly current data.
       */
      const freshness = assessFreshness({
        timeframe,
        lastCandleAt: row.lastCandleAt,
        displaySymbol: instrument.displaySymbol,
      });
      return {
        symbol: instrument.symbol,
        timeframe,
        providerId,
        lastCandleAt: row.lastCandleAt,
        ageSeconds: freshness.ageSeconds,
        barsBehind: freshness.barsBehind,
        state: freshness.state,
        detail: freshness.detail,
      };
    })();

    return {
      instrument,
      availability: resolveAvailability({
        instrument,
        router: context.marketData.router,
        persistenceConfigured: context.persistence !== null,
        storedTimeframes,
        ...(timeframe === undefined ? {} : { timeframe }),
        analysedSymbols: analysedSymbols(),
        analysisEnabled: context.config.workers.analysis.enabled,
      }),
      lastCandleAt,
      storedTimeframes,
      ...(marketState === undefined ? {} : { marketState }),
    };
  }

  /**
   * EVERY instrument the engine analyses, as CANONICAL symbols.
   *
   * R6. This returned ONE symbol — the first configured — while the worker
   * ran the whole set, so every other configured instrument was reported as
   * unanalysed. Read straight off the runtime, which holds the resolved plan,
   * rather than re-deriving identity from a configuration string.
   *
   * Empty when analysis is disabled, which availability renders as
   * "no instrument is configured for analysis".
   */
  function analysedSymbols(): readonly string[] {
    return context.config.workers.analysis.enabled ? context.analysisInstruments : [];
  }

  function assetClasses(): readonly AssetClassStatus[] {
    return CATALOGUE_ASSET_CLASSES.map((assetClass) => {
      const provider = context.marketData.router.forClass(assetClass);
      const { state, detail } = resolveAssetClassState(assetClass, context.marketData.router);
      return {
        assetClass,
        label: ASSET_CLASS_LABELS[assetClass],
        providerId: provider?.capabilities.id ?? null,
        providerName: provider?.capabilities.displayName ?? null,
        state,
        detail,
        instrumentCount: listInstruments().filter((entry) => entry.assetClass === assetClass)
          .length,
      };
    });
  }

  /**
   * The catalogue, with availability, optionally filtered or searched.
   *
   * Instruments whose class has no provider are STILL RETURNED, carrying
   * `not_configured`. Hiding them would answer "does BinaryAI support forex?"
   * with silence, and silence reads as "no" when the truthful answer is
   * "yes, but this deployment has not enabled a data source for it".
   */
  app.get('/v1/instruments', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(
        errorBody(
          'invalid_query',
          'Query parameters failed validation.',
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          request.id,
        ),
      );
    }

    const { assetClass, q, limit, timeframe } = parsed.data;
    const coverage = await coverageBySymbol();

    let matches = q === undefined ? listInstruments() : searchInstruments(q, limit);
    if (assetClass) matches = matches.filter((entry) => entry.assetClass === assetClass);

    return {
      instruments: matches
        .slice(0, limit)
        .map((entry) => describe(entry, coverage.get(entry.symbol), timeframe)),
      assetClasses: assetClasses(),
      total: matches.length,
      analysedSymbols: analysedSymbols(),
    };
  });

  /** One instrument, for a workspace that already knows which it wants. */
  app.get<{ Params: { symbol: string }; Querystring: { timeframe?: string } }>(
    '/v1/instruments/:symbol',
    async (request, reply) => {
      const instrument = findInstrument(request.params.symbol);
      if (!instrument) {
        return reply.code(404).send(
          errorBody(
            'unknown_instrument',
            // Names what to do about it. A bare 404 on a symbol the user
            // reasonably typed is a dead end.
            `${request.params.symbol} is not in BinaryAI's instrument catalogue. GET /v1/instruments lists everything supported.`,
            undefined,
            request.id,
          ),
        );
      }

      const coverage = await coverageBySymbol();
      // Availability is answered for the timeframe the caller is showing, when it
      // names one — the D4 fix reaching the single-instrument path too.
      const timeframe = singleTimeframeSchema.safeParse(request.query.timeframe);
      return {
        instrument: describe(
          instrument,
          coverage.get(instrument.symbol),
          timeframe.success ? timeframe.data : undefined,
        ),
      };
    },
  );

  /**
   * Asset classes and who serves them.
   *
   * Separate from the instrument list because the picker's group headers need
   * it before any instrument is chosen, and because "is forex configured?" is a
   * question about the deployment rather than about any one pair.
   */
  app.get('/v1/instruments/asset-classes', async () => ({
    assetClasses: assetClasses(),
    providers: context.marketData.router.configured().map((provider) => ({
      // Capabilities only — no key, no URL, no credential, same as
      // /v1/market-data/status.
      ...provider.capabilities,
    })),
  }));
}
