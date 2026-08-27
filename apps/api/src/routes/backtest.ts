import { DEFAULT_PAYOUT_MODEL, runBacktest } from '@binaryai/backtest';
import { normalizeCandleSeries, rawCandleSeriesSchema } from '@binaryai/engine';
import type { BacktestConfig } from '@binaryai/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { errorBody, parseBody } from '../lib/http.js';

/**
 * Backtesting.
 *
 * The caller supplies the dataset, and the response repeats the dataset
 * descriptor, the payout assumptions and the disclaimer, so a result can never
 * be shown without the context that makes it meaningful.
 */

const backtestRequestSchema = z.object({
  series: rawCandleSeriesSchema,
  strategyId: z.string().min(1).max(64),
  parameters: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
  expirationSeconds: z.number().int().min(5).max(86_400).default(180),
  startingBalance: z.number().positive().max(1_000_000_000).default(1000),
  warmupBars: z.number().int().min(0).max(5000).default(50),
  minConfidence: z.number().min(0).max(1).default(0.6),
  persist: z.boolean().default(false),
  stake: z
    .object({
      kind: z.enum(['fixed', 'fraction_of_balance']),
      value: z.number().positive(),
    })
    .default({ kind: 'fixed', value: 10 }),
  payout: z
    .object({
      winPayoutRate: z.number().min(0).max(10),
      lossRefundRate: z.number().min(0).max(1).default(0),
      tiePolicy: z.enum(['refund', 'loss']).default('refund'),
      note: z.string().max(200).default('Caller-supplied payout assumption.'),
    })
    .optional(),
});

export function registerBacktestRoutes(app: FastifyInstance, context: AppContext): void {
  app.post('/v1/backtest/run', async (request, reply) => {
    const parsed = parseBody(backtestRequestSchema, request.body, reply);
    if (!parsed.ok) return parsed.sent;

    const body = parsed.data;
    if (!context.registry.has(body.strategyId)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'strategy_not_found',
            `Strategy "${body.strategyId}" is not registered.`,
            undefined,
            request.id,
          ),
        );
    }

    const normalized = normalizeCandleSeries(body.series);
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
    const strategy = context.registry.get(body.strategyId);

    const config: BacktestConfig = {
      strategyId: body.strategyId,
      parameters: body.parameters ?? {},
      expirationSeconds: body.expirationSeconds,
      payout: body.payout ?? DEFAULT_PAYOUT_MODEL,
      stake: body.stake,
      startingBalance: body.startingBalance,
      warmupBars: body.warmupBars,
      minConfidence: body.minConfidence,
    };

    const result = runBacktest({
      asset: {
        symbol: series.asset,
        displayName: series.asset,
        assetClass: 'unknown',
        pricePrecision: 5,
        isOtc: false,
      },
      series,
      strategy,
      config,
    });

    let persistence: { stored: boolean; id?: string; reason?: string };
    if (!body.persist) {
      persistence = { stored: false, reason: 'Not requested (set "persist": true to store).' };
    } else if (!context.persistence) {
      persistence = { stored: false, reason: 'No database configured (DATABASE_URL is unset).' };
    } else {
      const ref = await context.persistence.repositories.backtests.save(result);
      persistence = { stored: true, id: ref.id };
    }

    return { result, persistence };
  });

  app.get('/v1/backtest/runs', async () => {
    if (!context.persistence) {
      return {
        runs: [],
        reason: 'No database configured (DATABASE_URL is unset), so backtest runs are not stored.',
      };
    }
    return { runs: await context.persistence.repositories.backtests.list() };
  });
}
