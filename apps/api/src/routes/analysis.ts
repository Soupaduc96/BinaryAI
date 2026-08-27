import {
  analyzeMarket,
  evaluateDecision,
  normalizeCandleSeries,
  rawCandleSeriesSchema,
  tightenLimits,
} from '@binaryai/engine';
import type { MarketAsset, RiskLimits } from '@binaryai/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { persistSignal } from '../lib/persistence.js';
import { errorBody, parseBody } from '../lib/http.js';

/**
 * Analysis and signal evaluation.
 *
 * Both endpoints are stateless and require the caller to supply the candles.
 * That is deliberate for this phase: BinaryAI has no market-data provider, and
 * inventing one would produce exactly the fake intelligence the brief forbids.
 */

const assetSchema = z.object({
  symbol: z.string().min(1).max(32),
  displayName: z.string().min(1).max(64).optional(),
  assetClass: z
    .enum(['forex', 'crypto', 'commodity', 'index', 'stock', 'otc', 'unknown'])
    .default('unknown'),
  pricePrecision: z.number().int().min(0).max(10).default(5),
  isOtc: z.boolean().default(false),
});

const analysisRequestSchema = z.object({
  series: rawCandleSeriesSchema,
  asset: assetSchema.optional(),
});

const evaluateRequestSchema = analysisRequestSchema.extend({
  strategyId: z.string().min(1).max(64),
  parameters: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
  // Opt-in, default off: evaluating a signal is a read-only operation unless
  // the caller explicitly asks for it to be recorded.
  persist: z.boolean().default(false),
  riskLimits: z
    .object({
      minConfidence: z.number().min(0).max(1).optional(),
      maxVolatilityAtrPercent: z.number().min(0).max(100).optional(),
      minDataQualityScore: z.number().min(0).max(1).optional(),
      maxConsecutiveLosses: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
});

function toAsset(
  input: z.infer<typeof assetSchema> | undefined,
  fallbackSymbol: string,
): MarketAsset {
  return {
    symbol: input?.symbol ?? fallbackSymbol,
    displayName: input?.displayName ?? input?.symbol ?? fallbackSymbol,
    assetClass: input?.assetClass ?? 'unknown',
    pricePrecision: input?.pricePrecision ?? 5,
    isOtc: input?.isOtc ?? false,
  };
}

interface PersistenceOutcome {
  readonly stored: boolean;
  readonly id?: string;
  readonly featureCount?: number;
  readonly reason?: string;
  /** Who the stored signal belongs to. Absent when nothing was stored. */
  readonly owner?: 'system' | 'account';
}

/**
 * Persists only when asked AND when a database exists. A caller that asks for
 * persistence without one gets `stored: false` and the reason -- never a
 * silent success that loses the signal.
 */
async function storeIfRequested(
  context: AppContext,
  requested: boolean,
  signal: Parameters<typeof persistSignal>[1],
  deps: {
    strategy: Parameters<typeof persistSignal>[2];
    asset: Parameters<typeof persistSignal>[3];
    /** Null for an unauthenticated caller: the signal is then system-owned. */
    ownerAccountId: string | null;
  },
): Promise<PersistenceOutcome> {
  if (!requested) return { stored: false, reason: 'Not requested (set "persist": true to store).' };
  if (!context.persistence) {
    return { stored: false, reason: 'No database configured (DATABASE_URL is unset).' };
  }

  const result = await persistSignal(
    context.persistence,
    signal,
    deps.strategy,
    deps.asset,
    deps.ownerAccountId,
  );
  return {
    stored: true,
    id: result.stored.id,
    featureCount: result.stored.featureCount,
    owner: deps.ownerAccountId === null ? 'system' : 'account',
  };
}

/**
 * The caller's account policy, or null when there is no account to read.
 *
 * Read fresh per request rather than cached on the session: a policy edited in
 * one tab must bind on the next action in another.
 */
async function accountPolicyLimits(
  context: AppContext,
  accountId: string,
): Promise<RiskLimits | null> {
  const account = await context.persistence?.repositories.accounts.findById(accountId);
  if (!account || !context.paper) return null;
  return context.paper.policyFor(account).limits;
}

export function registerAnalysisRoutes(app: FastifyInstance, context: AppContext): void {
  app.post('/v1/analysis', (request, reply) => {
    const parsed = parseBody(analysisRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const normalized = normalizeCandleSeries(parsed.data.series);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_series',
            'Candle series failed validation.',
            normalized.error,
            request.id,
          ),
        );
    }

    return { analysis: analyzeMarket(normalized.value) };
  });

  app.post('/v1/signals/evaluate', async (request, reply) => {
    const parsed = parseBody(evaluateRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const { strategyId, parameters, riskLimits } = parsed.data;
    if (!context.registry.has(strategyId)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'strategy_not_found',
            `Strategy "${strategyId}" is not registered.`,
            undefined,
            request.id,
          ),
        );
    }

    const normalized = normalizeCandleSeries(parsed.data.series);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_series',
            'Candle series failed validation.',
            normalized.error,
            request.id,
          ),
        );
    }

    const series = normalized.value;
    // The ACCOUNT's stored policy is authoritative. A caller-supplied override
    // may only tighten it -- otherwise any user could bypass their own limits
    // by sending looser ones with each request, and the stored policy would be
    // decorative. An unauthenticated caller has no account, so its overrides
    // apply to the engine defaults as before.
    const accountLimits =
      request.principal.kind === 'user' && request.principal.accountId && context.paper
        ? await accountPolicyLimits(context, request.principal.accountId)
        : null;
    const effectiveLimits =
      accountLimits === null ? riskLimits : tightenLimits(accountLimits, riskLimits);

    const decision = evaluateDecision({
      asset: toAsset(parsed.data.asset, series.asset),
      series,
      strategy: context.registry.get(strategyId),
      ...(parameters === undefined ? {} : { parameters }),
      // Demo is the only mode this build supports; it is not caller-selectable.
      executionMode: 'demo',
      ...(effectiveLimits === undefined ? {} : { riskLimits: effectiveLimits }),
    });

    const persistence = await storeIfRequested(context, parsed.data.persist, decision.signal, {
      strategy: context.registry.get(strategyId),
      asset: toAsset(parsed.data.asset, series.asset),
      // A signal a user asked for belongs to that user. An unauthenticated
      // caller (auth disabled, or a machine token) produces a system signal,
      // which is exactly what the runtime worker writes.
      ownerAccountId: request.principal.kind === 'user' ? request.principal.accountId : null,
    });

    return {
      signal: decision.signal,
      risk: decision.risk,
      analysis: decision.analysis,
      persistence,
    };
  });

  /**
   * Explanation is derived from a fresh evaluation rather than from a signal
   * posted by the client. A client-supplied "signal" could be forged, and an
   * explanation of a forged signal would be a fabricated rationale.
   */
  app.post('/v1/signals/explain', async (request, reply) => {
    const parsed = parseBody(evaluateRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const { strategyId, parameters } = parsed.data;
    if (!context.registry.has(strategyId)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'strategy_not_found',
            `Strategy "${strategyId}" is not registered.`,
            undefined,
            request.id,
          ),
        );
    }

    const normalized = normalizeCandleSeries(parsed.data.series);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_series',
            'Candle series failed validation.',
            normalized.error,
            request.id,
          ),
        );
    }

    const series = normalized.value;
    const decision = evaluateDecision({
      asset: toAsset(parsed.data.asset, series.asset),
      series,
      strategy: context.registry.get(strategyId),
      ...(parameters === undefined ? {} : { parameters }),
      executionMode: 'demo',
    });

    // The provider reports what produced the text; the route makes no claim.
    const explanation = await context.aiProvider.explain({
      signal: decision.signal,
      analysis: decision.analysis,
    });

    return { signal: decision.signal, explanation };
  });
}
