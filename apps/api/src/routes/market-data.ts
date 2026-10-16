import { assetFromInstrument, findInstrument, runHistoricalIngestion } from '@binaryai/market-data';
import { TIMEFRAME_SECONDS, type Timeframe } from '@binaryai/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody, parseBody } from '../lib/http.js';

/**
 * Market-data routes.
 *
 * Security posture:
 *  - No provider credential is ever returned. The status payload reports
 *    capabilities, not configuration.
 *  - The client cannot name a URL. It names a BinaryAI symbol; the adapter maps
 *    it to a provider symbol. There is no path from a request body to an
 *    arbitrary outbound host.
 *  - Every parameter is validated, and ingestion is bounded by an explicit
 *    window and a candle ceiling.
 */

const NO_PROVIDER =
  'No market-data provider is configured. Set MARKET_DATA_PROVIDER=coinbase to enable ingestion.';

const timeframeValues = Object.keys(TIMEFRAME_SECONDS) as [Timeframe, ...Timeframe[]];

const candlesQuerySchema = z.object({
  asset: z.string().min(1).max(32),
  timeframe: z.enum(timeframeValues).default('1m'),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

const ingestSchema = z.object({
  asset: z.string().min(1).max(32),
  timeframe: z.enum(timeframeValues).default('1m'),
  /** Epoch ms. Required: there is no "fetch everything" path. */
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  maxCandles: z.number().int().min(1).max(5000).optional(),
});

export function registerMarketDataRoutes(app: FastifyInstance, context: AppContext): void {
  /** What the dashboard's MARKET DATA indicator reflects. */
  app.get('/v1/market-data/status', async () => {
    const status = await context.marketData.status();
    const ingestion = context.marketData.tracker.snapshot();

    return {
      status,
      provider: context.marketData.provider
        ? {
            // Capabilities only. No key, no URL, no credential.
            ...context.marketData.provider.capabilities,
          }
        : null,
      ingestion: {
        runs: ingestion.runs,
        lastRunId: ingestion.lastRunId,
        lastSuccessAt: ingestion.lastSuccessAt,
        lastFailureAt: ingestion.lastFailureAt,
        lastError: ingestion.lastError,
        candlesStoredTotal: ingestion.candlesStoredTotal,
        candlesRejectedTotal: ingestion.candlesRejectedTotal,
        lastLatencyMs: ingestion.lastLatencyMs,
      },
    };
  });

  /** The instrument universe, as BinaryAI symbols. */
  app.get('/v1/market-data/assets', async (request, reply) => {
    const { provider } = context.marketData;
    if (!provider) return { assets: [], provider: null, reason: NO_PROVIDER };

    try {
      const assets = await provider.listAssets();
      return {
        provider: provider.capabilities.id,
        origin: provider.capabilities.dataOrigin,
        total: assets.length,
        assets: assets.slice(0, 500),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply
        .code(502)
        .send(errorBody('provider_unavailable', message, undefined, request.id));
    }
  });

  /**
   * Stored candles. Reads from the database, never straight from the provider:
   * what the chart shows must be what passed validation and was persisted.
   */
  app.get('/v1/market-data/candles', async (request, reply) => {
    const parsed = candlesQuerySchema.safeParse(request.query);
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

    if (!context.persistence) {
      return {
        series: null,
        reason:
          'No database is configured, so no candles are stored. Set DATABASE_URL and run an ingestion.',
      };
    }

    const { asset, timeframe, limit } = parsed.data;

    /*
     * Resolved through the CATALOGUE, like every other asset-scoped route.
     *
     * Without this, `?asset=BTC-USD` reported "no stored candles" while 593
     * BTCUSD candles sat in the table — a legacy spelling produced an empty
     * chart rather than the instrument's own data.
     *
     * An unknown symbol is refused rather than answered. It previously got a
     * 200 saying "Run an ingestion first", which reads as "this instrument
     * exists and simply has no data yet". For `EURUSD-OTC` that is exactly
     * the claim BinaryAI must never make: OTC is unsupported, and an endpoint
     * implying an OTC instrument is merely un-ingested is inventing one.
     */
    const instrument = findInstrument(asset);
    if (!instrument) {
      return reply
        .code(404)
        .send(
          errorBody(
            'unknown_instrument',
            `No instrument named "${asset}" is in the catalogue.`,
            undefined,
            request.id,
          ),
        );
    }

    /*
     * A timeframe the provider does not serve is a DIFFERENT fact from a
     * timeframe that simply has not been ingested, and the remedy differs:
     * one is "run an ingestion", the other is "this will never arrive".
     * Telling an operator to run an ingestion that cannot succeed is advice
     * that wastes their time and hides the real constraint.
     */
    if (!instrument.supportedTimeframes.includes(timeframe)) {
      return {
        series: null,
        reason:
          `${instrument.displaySymbol} is not served at ${timeframe} by ${instrument.providerId}. ` +
          `Available: ${instrument.supportedTimeframes.join(', ')}.`,
      };
    }

    const series = await context.persistence.repositories.candles.latest(
      instrument.symbol,
      timeframe,
      limit,
    );

    if (!series) {
      return {
        series: null,
        reason: `No stored candles for ${instrument.symbol} ${timeframe}. Run an ingestion first.`,
      };
    }
    return { series, count: series.candles.length };
  });

  /**
   * Triggers a bounded historical backfill.
   *
   * A write operation: it is covered by the API's auth guard when auth is
   * enabled, and it cannot be used to reach an arbitrary host.
   */
  app.post('/v1/market-data/ingest', async (request, reply) => {
    const { tracker, router } = context.marketData;

    const parsed = parseBody(ingestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const body = parsed.data;

    /*
     * Resolve the instrument BEFORE anything else.
     *
     * This route used to take `body.asset` and pass it straight through to the
     * provider and the repository, so whatever string the caller sent became a
     * row in `market_assets`. That is how the same instrument came to be stored
     * as both `BTC-USD` and `BTCUSD`, with its candle history split between
     * them and every per-instrument query quietly wrong.
     *
     * The catalogue is now the gate: an unknown symbol is refused, and a known
     * one is normalised to its canonical form regardless of which spelling the
     * caller used. A caller can no longer name an instrument BinaryAI has not
     * declared, which also removes the last path from a request body to an
     * arbitrary provider symbol.
     */
    const instrument = findInstrument(body.asset);
    if (!instrument) {
      return reply
        .code(404)
        .send(
          errorBody(
            'unknown_instrument',
            `${body.asset} is not in BinaryAI's instrument catalogue. GET /v1/instruments lists everything supported.`,
            undefined,
            request.id,
          ),
        );
    }

    // The provider for THIS instrument's asset class, not the primary one.
    const provider = router.resolve(instrument);
    if (!provider) {
      return reply
        .code(503)
        .send(
          errorBody(
            'provider_not_configured',
            `No market-data provider is configured for ${instrument.assetClass}. ${instrument.displaySymbol} cannot be ingested until one is.`,
            undefined,
            request.id,
          ),
        );
    }

    if (body.to <= body.from) {
      return reply
        .code(400)
        .send(errorBody('invalid_range', '`to` must be after `from`.', undefined, request.id));
    }
    // Checked against the INSTRUMENT's timeframes, which are the provider's
    // narrowed to what it serves for this symbol.
    if (!instrument.supportedTimeframes.includes(body.timeframe)) {
      return reply
        .code(400)
        .send(
          errorBody(
            'unsupported_timeframe',
            `${provider.capabilities.displayName} does not serve ${body.timeframe} candles for ${instrument.displaySymbol}. Supported: ${instrument.supportedTimeframes.join(', ')}.`,
            undefined,
            request.id,
          ),
        );
    }

    const result = await runHistoricalIngestion(
      {
        // Canonical, never the caller's spelling.
        symbol: instrument.symbol,
        timeframe: body.timeframe,
        from: body.from,
        to: body.to,
        ...(body.maxCandles === undefined ? {} : { maxCandles: body.maxCandles }),
      },
      {
        provider,
        repositories: context.persistence?.repositories ?? null,
        tracker,
        asset: assetFromInstrument(instrument),
        // Shared with the ingestion worker: a manual backfill and a background
        // poll on the same provider queue through one allowance (R15).
        ...(router.budgetFor(instrument.assetClass) === null
          ? {}
          : { budget: router.budgetFor(instrument.assetClass)! }),
      },
    );

    return reply.code(result.status === 'failed' ? 502 : 200).send({ result });
  });
}
