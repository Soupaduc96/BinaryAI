import { isUniqueViolation, RecordNotFoundError } from '@binaryai/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody, parseBody } from '../lib/http.js';

/**
 * Stored-signal routes.
 *
 * Every one of these needs a database. With none configured they return an
 * empty result and the reason, matching the Phase 1 behaviour exactly -- the
 * contract did not change, it just has data behind it now.
 */

// Two independent reasons this list is empty, and both matter: nothing is
// stored, AND nothing is generated automatically. Saying only one of them
// would imply the other is handled.
const NO_PERSISTENCE_REASON =
  'No database is configured (DATABASE_URL is unset), so signals are not stored. ' +
  'BinaryAI also does not generate signals without real market data, and no provider is ' +
  'integrated. POST candles to /v1/signals/evaluate to run the pipeline.';

const outcomeSchema = z.object({
  settlementPrice: z.number().positive().finite(),
  result: z.enum(['win', 'loss', 'tie', 'unresolved']),
  settledAt: z.number().int().nonnegative().optional(),
  payout: z
    .object({
      winPayoutRate: z.number().min(0).max(10),
      lossRefundRate: z.number().min(0).max(1).default(0),
      tiePolicy: z.enum(['refund', 'loss']).default('refund'),
      note: z.string().max(200).default('Caller-supplied payout assumption.'),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listQuerySchema = z.object({
  asset: z.string().min(1).max(32).optional(),
  strategy: z.string().min(1).max(64).optional(),
  direction: z.enum(['call', 'put', 'none']).optional(),
  status: z
    .enum(['candidate', 'accepted', 'rejected', 'expired', 'settled', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerSignalRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/v1/signals', async (request, reply) => {
    const { persistence } = context;
    if (!persistence) {
      return { signals: [], total: 0, reason: NO_PERSISTENCE_REASON };
    }

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

    const query = {
      // Ownership filter for this caller: the shared analysis stream plus
      // anything their own account owns, and nothing belonging to anyone else.
      // Both list() and count() take it, so the total never describes rows the
      // caller cannot see.
      scope: request.scope,
      ...(parsed.data.asset === undefined ? {} : { assetSymbol: parsed.data.asset }),
      ...(parsed.data.strategy === undefined ? {} : { strategyKey: parsed.data.strategy }),
      ...(parsed.data.direction === undefined ? {} : { direction: parsed.data.direction }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    };

    const [signals, total] = await Promise.all([
      persistence.repositories.signals.list(query),
      persistence.repositories.signals.count(query),
    ]);

    return { signals, total };
  });

  app.get('/v1/signals/:id', async (request, reply) => {
    const { persistence } = context;
    if (!persistence) {
      return reply
        .code(404)
        .send(errorBody('persistence_disabled', NO_PERSISTENCE_REASON, undefined, request.id));
    }

    const { id } = request.params as { id: string };
    // A signal owned by someone else reads as absent rather than forbidden:
    // a 403 would confirm the id exists, which is itself a disclosure.
    const persisted = await persistence.repositories.signals.findById(id, request.scope);
    if (!persisted) {
      return reply
        .code(404)
        .send(
          errorBody('signal_not_found', `Signal "${id}" is not stored.`, undefined, request.id),
        );
    }

    return persisted;
  });

  /**
   * Records what actually happened at expiry. This is the data that makes
   * future confidence calibration possible -- and only possible: nothing here
   * calibrates anything today.
   */
  app.post('/v1/signals/:id/outcome', async (request, reply) => {
    const { persistence } = context;
    if (!persistence) {
      return reply
        .code(503)
        .send(errorBody('persistence_disabled', NO_PERSISTENCE_REASON, undefined, request.id));
    }

    const parsed = parseBody(outcomeSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const { id } = request.params as { id: string };
    const body = parsed.data;

    // Checked before the write: without this, a caller could record an outcome
    // against another account's signal, corrupting a dataset they cannot read.
    if ((await persistence.repositories.signals.findById(id, request.scope)) === null) {
      return reply
        .code(404)
        .send(
          errorBody('signal_not_found', `Signal "${id}" is not stored.`, undefined, request.id),
        );
    }

    try {
      const outcome = await persistence.repositories.outcomes.record({
        signalId: id,
        settledAt: body.settledAt ?? Date.now(),
        settlementPrice: body.settlementPrice,
        result: body.result,
        ...(body.payout === undefined ? {} : { payout: body.payout }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      });
      return reply.code(201).send({ outcome });
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        return reply
          .code(404)
          .send(
            errorBody('signal_not_found', `Signal "${id}" is not stored.`, undefined, request.id),
          );
      }
      if (isUniqueViolation(error)) {
        return reply
          .code(409)
          .send(
            errorBody(
              'outcome_exists',
              `Signal "${id}" already has a recorded outcome. Outcomes are immutable.`,
              undefined,
              request.id,
            ),
          );
      }
      throw error;
    }
  });

  /**
   * How much ground truth exists, and an unambiguous statement that confidence
   * is still uncalibrated. Reported so the number cannot be quietly assumed to
   * mean something it does not.
   */
  /**
   * Calibration status.
   *
   * Extended in Phase 4, never reshaped: every field the previous version
   * returned is still present with the same meaning, so existing clients keep
   * working. The new fields describe the measurement now available.
   *
   * `implemented` stays FALSE. It answers "does a validated calibration model
   * exist?", and accumulating samples is a prerequisite for building one rather
   * than evidence that one has been built. No sample count flips this flag.
   */
  app.get('/v1/calibration/status', async (request) => {
    const { persistence } = context;
    const settledOutcomes = persistence
      ? await persistence.repositories.outcomes.countSettled()
      : 0;

    // Measured under the CALLER's scope: a user must not learn the size of
    // another account's sample set from a status endpoint.
    const measurement = context.analytics
      ? await context.analytics.calibration(request.scope)
      : null;

    return {
      // ---- unchanged contract ----
      calibration: 'uncalibrated_heuristic',
      implemented: false,
      settledOutcomes,
      persistenceConfigured: persistence !== null,
      reason:
        'Confidence scores are rule-based heuristics. Calibration requires a large sample of ' +
        'settled outcomes and a walk-forward-validated model; neither exists yet. Collecting ' +
        'outcomes is the purpose of this endpoint, not evidence that calibration has happened.',

      // ---- added in Phase 4 ----
      method: measurement?.report.methodology.method ?? null,
      version: measurement?.report.methodology.version ?? null,
      methodology: measurement?.report.methodology ?? null,
      eligibleSamples: measurement?.report.eligibleSamples ?? 0,
      settledSamples: measurement?.report.settledSamples ?? 0,
      excludedSamples: measurement?.report.excludedSamples ?? 0,
      exclusions: measurement?.report.exclusions ?? {},
      evidenceLevel: measurement?.report.evidence ?? 'insufficient',
      minimumSampleSize:
        measurement?.report.minimumSampleSize ?? context.config.analytics.minimumSamples,
      relationship: measurement?.report.relationship ?? 'not_established',
      lastUpdated: measurement?.report.generatedAt ?? null,
      limitations: measurement?.report.limitations ?? [
        'No database is configured, so no outcomes have been observed.',
      ],
    };
  });
}
