import type { Account } from '@binaryai/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody, parseBody } from '../lib/http.js';
import { ModelSelectionRejected } from '../lib/paper-service.js';
import { requireUser } from '../plugins/auth.js';

/**
 * Account, risk policy, paper positions and ledger.
 *
 * Every route resolves the account through `resolveAccount`, which verifies
 * ownership before anything else runs. Two properties follow from that and are
 * worth stating because they are easy to erode:
 *
 *  - **A foreign account is 404, never 403.** A 403 confirms the id exists and
 *    turns the endpoint into an account-enumeration oracle. "Not available to
 *    you" and "does not exist" are deliberately indistinguishable.
 *  - **`:id` is verified, never trusted.** The path parameter names an account;
 *    the SESSION decides whether it may be touched. `me` resolves to the
 *    caller's default account so a client never has to hold an id at all.
 */

const NO_PERSISTENCE =
  'No database is configured (DATABASE_URL is unset), so accounts do not exist on this instance.';

/** Risk-policy update. `allowLiveExecution` is absent and cannot be sent. */
const policyUpdateSchema = z
  .object({
    limits: z
      .object({
        minConfidence: z.number().min(0).max(1).optional(),
        maxRiskLevel: z.enum(['low', 'medium', 'high', 'extreme']).optional(),
        allowedRegimes: z
          .array(z.enum(['trend_up', 'trend_down', 'range', 'volatile', 'quiet', 'unknown']))
          .max(6)
          .optional(),
        maxOpenPositions: z.number().int().min(0).max(100).optional(),
        maxExposureFraction: z.number().min(0).max(1).optional(),
        maxDailyLossFraction: z.number().min(0).max(1).optional(),
        maxConsecutiveLosses: z.number().int().min(0).max(100).optional(),
        cooldownSecondsAfterLoss: z.number().int().min(0).max(86_400).optional(),
        maxVolatilityAtrPercent: z.number().min(0).max(100).optional(),
        minDataQualityScore: z.number().min(0).max(1).optional(),
      })
      // Strict, like the outer object. `allowLiveExecution` is not a member,
      // so sending it is a visible 400 rather than a silent strip -- a caller
      // must never come away believing it set something it did not.
      .strict()
      .optional(),
    maxPositionSize: z.number().positive().finite().max(1_000_000).optional(),
    maxDailyExposure: z.number().positive().finite().max(10_000_000).optional(),
    // `null` clears the restriction; `[]` blocks everything. Both are
    // expressible on purpose -- see AccountRiskPolicy.
    allowedStrategies: z.array(z.string().min(1).max(64)).max(50).nullable().optional(),
    allowedTimeframes: z
      .array(z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']))
      .max(7)
      .nullable()
      .optional(),
    allowedAssets: z.array(z.string().min(1).max(32)).max(50).nullable().optional(),
  })
  .strict();

/**
 * Selecting a simulation model.
 *
 * The body carries an ID AND NOTHING ELSE. There is deliberately no rate, no
 * tie rule and no refund field: accepting any of them would let the caller
 * define the accounting model, and every figure the account then reported
 * would only be as trustworthy as whatever was last posted here.
 *
 * `.strict()` is what enforces that. A request smuggling a `simulatedReturnRate`
 * alongside the id is rejected outright rather than silently ignored, so a
 * client that believes it set a rate is told plainly that it did not.
 */
const modelSelectionSchema = z
  .object({
    /** Null turns simulation off. */
    modelId: z.string().uuid().nullable(),
  })
  .strict();

const openPositionSchema = z
  .object({
    signalId: z.string().min(1).max(128),
    // `.finite()` rejects NaN and both infinities; `.positive()` rejects zero,
    // negatives and -0. A malformed size must never reach the engine.
    size: z.number().positive().finite().max(1_000_000),
    /**
     * Idempotency key. Supplied by the caller so a retried request is
     * recognisably the same action rather than a second one.
     */
    actionKey: z.string().min(8).max(128),
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum(['open', 'pending_settlement', 'settled', 'cancelled', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function publicAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    name: account.name,
    // Stated on every account payload. This is a simulation object.
    mode: account.mode,
    kind: 'paper',
    currency: account.currency,
    isDefault: account.isDefault,
    createdAt: account.createdAt,
  };
}

export function registerAccountRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * Resolves and authorizes the account named by the path.
   *
   * Returns null and sends the response on failure, so callers read as
   * `if (!account) return reply;`. Ownership is checked here and nowhere else,
   * which is what makes it impossible for a route to forget.
   */
  async function resolveAccount(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Account | null> {
    const user = await requireUser(request, reply);
    if (!user) return null;

    const persistence = context.persistence;
    if (!persistence) {
      void reply.code(503).send(errorBody('no_persistence', NO_PERSISTENCE, undefined, request.id));
      return null;
    }

    const { id } = request.params as { id: string };
    const accounts = persistence.repositories.accounts;

    // 'me' never touches an id at all: the safest request is one that cannot
    // name the wrong account.
    const account =
      id === 'me' ? await accounts.findDefaultForUser(user.id) : await accounts.findById(id);

    // The ownership check and the existence check produce the SAME response.
    // Splitting them would let a caller distinguish "exists but not yours" from
    // "does not exist", which is exactly the enumeration side channel §28 warns
    // about.
    if (!account || account.userId !== user.id) {
      void reply
        .code(404)
        .send(
          errorBody(
            'account_not_found',
            'No such account is available to you.',
            undefined,
            request.id,
          ),
        );
      return null;
    }
    return account;
  }

  function paper(reply: FastifyReply): NonNullable<AppContext['paper']> | null {
    if (context.paper) return context.paper;
    void reply
      .code(503)
      .send(errorBody('no_persistence', NO_PERSISTENCE, undefined, reply.request.id));
    return null;
  }

  // ------------------------------------------------------------- account --

  app.get('/v1/accounts/:id', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const state = await service.state(account);
    return reply.send({ account: publicAccount(account), paper: state });
  });

  // ------------------------------------------------------------- policy --

  app.get('/v1/accounts/:id/risk', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    return reply.send({
      policy: service.policyFor(account),
      enforcement:
        'These limits are evaluated by the backend on every paper action. They are not advisory.',
    });
  });

  app.patch('/v1/accounts/:id/risk', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const parsed = parseBody(policyUpdateSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const updated = await service.updatePolicy(account, parsed.data);
    const policy = service.policyFor(updated);

    // A policy that cannot be evaluated is refused rather than stored: an
    // incoherent policy fails closed at decision time, which would block every
    // action with no obvious cause.
    const problems = context.validatePolicy(policy);
    if (problems.length > 0) {
      return reply
        .code(422)
        .send(
          errorBody(
            'invalid_policy',
            'The resulting policy is not coherent.',
            problems,
            request.id,
          ),
        );
    }
    return reply.send({ policy });
  });

  // ------------------------------------------------- simulation accounting --

  /**
   * The catalogue of models a user may select.
   *
   * Not account-scoped: the catalogue is the same for everyone and contains no
   * user data. It is behind authentication anyway, because an unauthenticated
   * reader has no reason to enumerate it.
   */
  app.get('/v1/simulation/models', async (request, reply) => {
    // A user, not a shared service token: the catalogue is uninteresting to a
    // machine and there is no reason to let one enumerate it.
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const models = await service.listModels();
    return reply.send({
      models,
      disclosure:
        'These are BinaryAI simulation models, not broker terms. Each states its own rules and ' +
        'is versioned so a figure derived from it can always be traced to the arithmetic used.',
    });
  });

  /** The model this account has selected, or none. */
  app.get('/v1/accounts/:id/simulation', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const summary = await service.simulationSummary(account);
    return reply.send({
      simulation: summary,
      separation:
        'Simulated account value. Not exposure, not a broker result, and never used for ' +
        'calibration, which measures observed directional outcomes only.',
    });
  });

  /**
   * Selects a model, or turns simulation off with a null id.
   *
   * PUT rather than PATCH: this replaces the selection outright, and there is
   * no partial state to merge. The account is resolved through the ownership
   * mechanism first, so an id belonging to another user never reaches here.
   */
  app.put('/v1/accounts/:id/simulation', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const parsed = parseBody(modelSelectionSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    try {
      const updated = await service.selectModel(account, parsed.data.modelId);
      return reply.send({ simulation: await service.simulationSummary(updated) });
    } catch (error) {
      if (error instanceof ModelSelectionRejected) {
        return reply
          .code(422)
          .send(
            errorBody(
              'invalid_simulation_model',
              'That simulation model cannot be selected.',
              error.problems,
              request.id,
            ),
          );
      }
      throw error;
    }
  });

  /**
   * One position's simulated result.
   *
   * Returns 404 for a position owned by someone else, identically to one that
   * does not exist. The distinction would otherwise confirm the existence of
   * another user's position.
   */
  app.get('/v1/accounts/:id/positions/:positionId/simulation', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const { positionId } = request.params as { positionId: string };
    const simulation = await service.positionSimulation(positionId, account.id);
    if (!simulation) {
      return reply.code(404).send(errorBody('not_found', 'No such position.', [], request.id));
    }
    return reply.send({ simulation });
  });

  /**
   * Account standing under its selected simulation model.
   *
   * Distinct from /v1/analytics/*, which reports OBSERVED accuracy over signals
   * and applies no model at all. These two must never be read as the same
   * thing: one measures whether the analysis was directionally right, the
   * other says what a stated model computes that to be worth.
   */
  app.get('/v1/accounts/:id/performance', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const simulation = await service.simulationSummary(account);
    return reply.send({
      simulation,
      separation:
        'Simulated account accounting. Not observed accuracy, not a broker result, and never ' +
        'used for calibration.',
    });
  });

  // ----------------------------------------------------------- positions --

  app.get('/v1/accounts/:id/positions', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

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

    const positions = await service.listPositionDetails(account.id, {
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return reply.send({
      positions,
      accounting:
        'Positions are simulated. No order was placed and no payout applies to any outcome.',
    });
  });

  /**
   * Opens a paper position, if the account's risk policy permits it.
   *
   * A refusal is a 422 carrying the full decision, not a bare error: the caller
   * needs to know which rule blocked it, what the observed value was and what
   * the limit is. A retryable refusal (cooldown) carries `retry-after`.
   */
  app.post('/v1/accounts/:id/positions', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const parsed = parseBody(openPositionSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const result = await service.openPosition({
      account,
      signalId: parsed.data.signalId,
      size: parsed.data.size,
      actionKey: parsed.data.actionKey,
    });

    if (!result.ok) {
      const retryAfter = result.decision.retryAfterMs;
      const response = reply.code(result.decision.outcome === 'cooldown' ? 429 : 422);
      if (retryAfter !== null) {
        void response.header('retry-after', String(Math.ceil(retryAfter / 1000)));
      }
      return response.send({
        error: {
          code: result.decision.outcome,
          message: `The action was refused: ${result.decision.outcome}.`,
          requestId: request.id,
        },
        decision: result.decision,
      });
    }

    // 200 rather than 201 for a duplicate: nothing was created, and the caller
    // is being handed the position their earlier identical request produced.
    return reply
      .code(result.duplicate ? 200 : 201)
      .send({ position: result.position, decision: result.decision, duplicate: result.duplicate });
  });

  app.get('/v1/accounts/:id/positions/:positionId', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const { positionId } = request.params as { positionId: string };
    const position = await service.getPosition(positionId, account.id);
    if (!position) {
      return reply
        .code(404)
        .send(errorBody('position_not_found', 'No such position.', undefined, request.id));
    }
    return reply.send({ position });
  });

  app.post('/v1/accounts/:id/positions/:positionId/cancel', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const { positionId } = request.params as { positionId: string };
    const cancelled = await service.cancelPosition(positionId, account.id);
    if (!cancelled) {
      // Covers both "no such position" and "not cancellable". Distinguishing
      // them would disclose the existence of a position the caller may not see.
      return reply
        .code(409)
        .send(
          errorBody(
            'not_cancellable',
            'That position does not exist, or is past expiry and can no longer be cancelled.',
            undefined,
            request.id,
          ),
        );
    }
    return reply.send({ position: cancelled });
  });

  /** Dry run: what would happen, without creating anything. */
  app.post('/v1/accounts/:id/risk/evaluate', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const service = paper(reply);
    if (!service) return reply;

    const parsed = parseBody(
      openPositionSchema.omit({ actionKey: true }).strict(),
      request.body,
      reply,
    );
    if (!parsed.ok) return parsed.sent;

    const decision = await service.evaluate(account, parsed.data.signalId, parsed.data.size);
    return reply.send({ decision });
  });

  // -------------------------------------------------------------- ledger --

  app.get('/v1/accounts/:id/ledger', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const persistence = context.persistence;
    const service = paper(reply);
    if (!service || !persistence) return reply;

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody('invalid_query', 'Query parameters failed validation.', undefined, request.id),
        );
    }

    const [entries, state] = await Promise.all([
      persistence.repositories.ledger.list(account.id, parsed.data.limit, parsed.data.offset),
      service.state(account),
    ]);
    return reply.send({ entries, state, accountingNote: state.accountingNote });
  });

  // --------------------------------------------------------- risk events --

  app.get('/v1/accounts/:id/risk-events', async (request, reply) => {
    const account = await resolveAccount(request, reply);
    if (!account) return reply;
    const persistence = context.persistence;
    if (!persistence) return reply;

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody('invalid_query', 'Query parameters failed validation.', undefined, request.id),
        );
    }

    const events = await persistence.repositories.riskEvents.listForAccount(
      account.id,
      parsed.data.limit,
    );
    return reply.send({ events });
  });
}
