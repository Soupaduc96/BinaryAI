import { runHistoricalIngestion } from '@binaryai/market-data';
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
    const series = await context.persistence.repositories.candles.latest(asset, timeframe, limit);

    if (!series) {
      return {
        series: null,
        reason: `No stored candles for ${asset} ${timeframe}. Run an ingestion first.`,
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
    const { provider, tracker } = context.marketData;
    if (!provider) {
      return reply
        .code(503)
        .send(errorBody('provider_not_configured', NO_PROVIDER, undefined, request.id));
    }

    const parsed = parseBody(ingestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const body = parsed.data;
    if (body.to <= body.from) {
      return reply
        .code(400)
        .send(errorBody('invalid_range', '`to` must be after `from`.', undefined, request.id));
    }
    if (!provider.capabilities.supportedTimeframes.includes(body.timeframe)) {
      return reply
        .code(400)
        .send(
          errorBody(
            'unsupported_timeframe',
            `${provider.capabilities.displayName} does not serve ${body.timeframe} candles. Supported: ${provider.capabilities.supportedTimeframes.join(', ')}.`,
            undefined,
            request.id,
          ),
        );
    }

    const result = await runHistoricalIngestion(
      {
        symbol: body.asset,
        timeframe: body.timeframe,
        from: body.from,
        to: body.to,
        ...(body.maxCandles === undefined ? {} : { maxCandles: body.maxCandles }),
      },
      {
        provider,
        repositories: context.persistence?.repositories ?? null,
        tracker,
      },
    );

    return reply.code(result.status === 'failed' ? 502 : 200).send({ result });
  });
}
