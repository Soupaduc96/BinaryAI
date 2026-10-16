import { CONFIDENCE_SEMANTICS, DEFAULT_EVIDENCE_THRESHOLDS } from '@binaryai/analytics';
import { findInstrument } from '@binaryai/market-data';
import type { AnalyticsDimension, AnalyticsQuery } from '@binaryai/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody } from '../lib/http.js';

/**
 * Analytics routes.
 *
 * Additive: nothing here changes an existing endpoint's shape. Four properties
 * hold across every route in this file.
 *
 *  - **Scope comes from the request, never from a parameter.** There is no
 *    `?accountId=` on any endpoint. A caller cannot ask for another account's
 *    analytics because there is nowhere to express the request.
 *  - **Every query is bounded.** The window defaults to 90 days and is capped
 *    at two years, so no caller can trigger an unbounded historical scan.
 *  - **Nothing is fabricated when empty.** With no data these return zero
 *    counts, null rates and a stated reason — never a plausible-looking figure.
 *  - **Semantics travel with the numbers.** Confidence is described as an
 *    uncalibrated heuristic in every payload that mentions it.
 */

const NO_PERSISTENCE =
  'No database is configured (DATABASE_URL is unset), so no outcomes are stored and there is ' +
  'nothing to measure.';

/** Two years. Generous for a research tool, finite for the query planner. */
const MAX_RANGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Shared query parameters.
 *
 * Enums are validated against the values the system actually supports, so an
 * unrecognised timeframe is a 400 rather than a silently empty result set that
 * looks like "no data".
 */
const baseQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  asset: z.string().min(1).max(32).optional(),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']).optional(),
  strategy: z.string().min(1).max(64).optional(),
  regime: z.enum(['trend_up', 'trend_down', 'range', 'volatile', 'quiet', 'unknown']).optional(),
  direction: z.enum(['call', 'put']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const timeseriesQuerySchema = baseQuerySchema.extend({
  interval: z.enum(['day', 'week', 'month', 'auto']).default('auto'),
});

const dimensionQuerySchema = baseQuerySchema.extend({
  dimension: z.enum(['strategy', 'regime', 'timeframe', 'asset', 'direction']).optional(),
});

type BaseQuery = z.infer<typeof baseQuerySchema>;

/**
 * Resolves the query window.
 *
 * An absent window becomes the last 90 days rather than "everything": the
 * default must be bounded, because the endpoint most likely to be hit without
 * parameters is the dashboard on every page load.
 */
function toAnalyticsQuery(parsed: BaseQuery, now: number): AnalyticsQuery {
  const to = parsed.to ?? now;
  const from = parsed.from ?? to - DEFAULT_RANGE_MS;

  return {
    from,
    to,
    // R5 — resolved through the CATALOGUE, never taken as text. A legacy
    // spelling binds on its canonical instrument. An UNRESOLVABLE symbol never
    // reaches here: readQuery refuses the request, because falling back to the
    // caller's text is exactly how a report gets labelled with a market that
    // does not exist.
    ...(parsed.asset === undefined ? {} : { assetSymbol: findInstrument(parsed.asset)?.symbol }),
    ...(parsed.timeframe === undefined ? {} : { timeframe: parsed.timeframe }),
    ...(parsed.strategy === undefined ? {} : { strategyKey: parsed.strategy }),
    ...(parsed.regime === undefined ? {} : { regime: parsed.regime }),
    ...(parsed.direction === undefined ? {} : { direction: parsed.direction }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  };
}

/** Range validation that a per-field schema cannot express. */
function rangeProblem(query: AnalyticsQuery): string | null {
  const { from, to } = query;
  if (from === undefined || to === undefined) return null;
  if (to < from) return 'The "to" timestamp precedes "from".';
  if (to - from > MAX_RANGE_MS) {
    return `The requested window exceeds the maximum of ${Math.floor(MAX_RANGE_MS / 86_400_000)} days.`;
  }
  return null;
}

/**
 * Parses and validates, or sends the error and returns null.
 *
 * Returning null rather than throwing keeps the handlers linear and makes the
 * "did we already reply?" question unambiguous at every call site.
 */
function readQuery<T extends z.ZodType>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply,
  now: number,
): { parsed: z.infer<T>; query: AnalyticsQuery } | null {
  const result = schema.safeParse(request.query);
  if (!result.success) {
    void reply.code(400).send(
      errorBody(
        'invalid_query',
        'Query parameters failed validation.',
        result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        request.id,
      ),
    );
    return null;
  }

  /*
   * An instrument the catalogue does not know is REFUSED, not echoed.
   *
   * This used to fall back to the caller's text, so
   * `?asset=EURUSD-OTC` returned a 200 whose provenance read
   * `assetSymbol: "EURUSD-OTC", instrumentScope: "instrument"` — a
   * provenance record naming a market BinaryAI does not support, produced by
   * nothing more than typing it into a query string. Every figure in that
   * response was correctly empty, which made the label the only claim in it,
   * and the label was false.
   *
   * 404 matches what positions and the ledger already do for the same input,
   * so one unknown symbol cannot be refused by one endpoint and accepted by
   * another.
   */
  const asked = (result.data as BaseQuery).asset;
  if (asked !== undefined && findInstrument(asked) === null) {
    void reply
      .code(404)
      .send(
        errorBody(
          'unknown_instrument',
          `No instrument named "${asked}" is in the catalogue.`,
          undefined,
          request.id,
        ),
      );
    return null;
  }

  const query = toAnalyticsQuery(result.data as BaseQuery, now);
  const problem = rangeProblem(query);
  if (problem) {
    void reply.code(400).send(errorBody('invalid_range', problem, undefined, request.id));
    return null;
  }
  return { parsed: result.data as z.infer<T>, query };
}

export function registerAnalyticsRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * Guard shared by every analytics route.
   *
   * With no database there is nothing to measure, and saying so with a 503 plus
   * the reason is better than returning zeros that read as measured results.
   */
  function requireAnalytics(reply: FastifyReply): NonNullable<AppContext['analytics']> | null {
    if (context.analytics) return context.analytics;
    void reply
      .code(503)
      .send(errorBody('no_persistence', NO_PERSISTENCE, undefined, reply.request.id));
    return null;
  }

  app.get('/v1/analytics/overview', async (request, reply) => {
    const analytics = requireAnalytics(reply);
    if (!analytics) return reply;
    const input = readQuery(baseQuerySchema, request, reply, Date.now());
    if (!input) return reply;

    const overview = await analytics.overview(request.scope, input.query);
    return reply.send({
      overview,
      evidence: {
        // The configured value, not the default: reporting the default while
        // applying a different one would make the empty-state explanation lie.
        minimumSampleSize: context.config.analytics.minimumSamples,
        thresholds: {
          minimumSamples: context.config.analytics.minimumSamples,
          preliminary: Math.max(
            context.config.analytics.minimumSamples,
            DEFAULT_EVIDENCE_THRESHOLDS.preliminary,
          ),
          developing: Math.max(
            context.config.analytics.minimumSamples,
            DEFAULT_EVIDENCE_THRESHOLDS.developing,
          ),
          established: Math.max(
            context.config.analytics.minimumSamples,
            DEFAULT_EVIDENCE_THRESHOLDS.established,
          ),
        },
      },
      semantics: CONFIDENCE_SEMANTICS,
    });
  });

  /**
   * One route per dimension, all backed by the same aggregation.
   *
   * Separate paths rather than a `?dimension=` switch because they are separate
   * resources with separate cache characteristics, and because a fixed path
   * cannot be coaxed into naming a column.
   */
  const dimensions: ReadonlyArray<{ path: string; dimension: AnalyticsDimension }> = [
    { path: '/v1/analytics/strategies', dimension: 'strategy' },
    { path: '/v1/analytics/regimes', dimension: 'regime' },
    { path: '/v1/analytics/timeframes', dimension: 'timeframe' },
    { path: '/v1/analytics/assets', dimension: 'asset' },
  ];

  for (const { path, dimension } of dimensions) {
    app.get(path, async (request, reply) => {
      const analytics = requireAnalytics(reply);
      if (!analytics) return reply;
      const input = readQuery(dimensionQuerySchema, request, reply, Date.now());
      if (!input) return reply;

      const result = await analytics.byDimension(request.scope, dimension, input.query);
      return reply.send({
        dimension,
        groups: result.groups,
        provenance: result.provenance,
        // Stated on every grouped response, because a table sorted by a column
        // invites exactly this misreading.
        ranking:
          'Ordered by sample count, not by accuracy. A high rate from few observations is not ' +
          'evidence that a group performs better.',
        semantics: CONFIDENCE_SEMANTICS,
      });
    });
  }

  app.get('/v1/analytics/confidence', async (request, reply) => {
    const analytics = requireAnalytics(reply);
    if (!analytics) return reply;
    const input = readQuery(baseQuerySchema, request, reply, Date.now());
    if (!input) return reply;

    const { report, provenance } = await analytics.calibration(request.scope, input.query);
    return reply.send({
      buckets: report.buckets,
      relationship: report.relationship,
      divergence: report.divergence,
      evidence: report.evidence,
      minimumSampleSize: report.minimumSampleSize,
      provenance,
      semantics: report.semantics,
    });
  });

  app.get('/v1/analytics/calibration', async (request, reply) => {
    const analytics = requireAnalytics(reply);
    if (!analytics) return reply;
    const input = readQuery(baseQuerySchema, request, reply, Date.now());
    if (!input) return reply;

    const { report, provenance } = await analytics.calibration(request.scope, input.query);
    return reply.send({ calibration: report, provenance });
  });

  app.get('/v1/analytics/timeseries', async (request, reply) => {
    const analytics = requireAnalytics(reply);
    if (!analytics) return reply;
    const input = readQuery(timeseriesQuerySchema, request, reply, Date.now());
    if (!input) return reply;

    const result = await analytics.timeseries(request.scope, input.parsed.interval, input.query);
    return reply.send({
      interval: result.interval,
      periods: result.periods,
      provenance: result.provenance,
      // Says out loud what the gaps mean, so a reader does not fill them in.
      note:
        'Periods with no settled outcomes are absent, not zero. A continuous line through them ' +
        'would imply observations that do not exist.',
    });
  });
}
