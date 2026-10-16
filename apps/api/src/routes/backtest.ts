import { DEFAULT_PAYOUT_MODEL, runBacktest } from '@binaryai/backtest';
import { normalizeCandleSeries, rawCandleSeriesSchema } from '@binaryai/engine';
import { assetFromInstrument, findInstrument } from '@binaryai/market-data';
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
  /**
   * EXPLICIT instrument identity. R8.
   *
   * Optional so existing callers keep working, but when given it is resolved
   * through the catalogue and must AGREE with the series symbol. BinaryAI
   * never infers an instrument from candle data and never borrows the
   * workspace's current selection: a backtest is a claim about a specific
   * market, and a claim about the wrong one is worse than no claim.
   */
  asset: z.string().min(1).max(32).optional(),
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

    /*
     * D8 / R8 — instrument identity for a backtest.
     *
     * This block used to assert a hardcoded BTC-USD identity for every run, so
     * backtesting AAPL recorded a five-decimal crypto pair. Identity now comes
     * from the catalogue, which is the same resolution every other part of the
     * system uses, and the CANONICAL symbol is what gets stored — a run filed
     * under 'btc-usd' could never be joined to signals filed under 'BTCUSD'.
     *
     * A symbol the catalogue does not know is NOT rejected. A backtest over a
     * hand-supplied series is a legitimate thing to do, and unlike
     * /v1/signals/evaluate it produces no tradable signal and no exposure. It
     * is recorded as 'unresolved' EXPLICITLY, which is the honest state:
     * BinaryAI cannot establish what that series was, and inventing an
     * identity for it would be worse than admitting the gap.
     */
    const catalogued = findInstrument(series.asset);

    /*
     * When the caller names the instrument, it must AGREE with the series.
     *
     * The two are compared after resolution, so 'BTC-USD' and 'BTCUSD' are the
     * same claim, while 'AAPL' over a BTC series is a contradiction. BinaryAI
     * refuses rather than picking a winner: silently trusting either one would
     * file a real result under the wrong market, and a mislabelled backtest is
     * worse than no backtest.
     */
    if (body.asset !== undefined) {
      const declared = findInstrument(body.asset);
      const declaredSymbol = declared?.symbol ?? body.asset.toUpperCase();
      const seriesSymbol = catalogued?.symbol ?? series.asset.toUpperCase();
      if (declaredSymbol !== seriesSymbol) {
        return reply
          .code(400)
          .send(
            errorBody(
              'instrument_mismatch',
              `Declared instrument "${body.asset}" does not match the series instrument "${series.asset}".`,
              [
                `declared: ${declaredSymbol} (${declared ? 'in catalogue' : 'not in catalogue'})`,
                `series: ${seriesSymbol} (${catalogued ? 'in catalogue' : 'not in catalogue'})`,
              ],
              request.id,
            ),
          );
      }
    }

    const result = runBacktest({
      asset: catalogued
        ? assetFromInstrument(catalogued)
        : {
            symbol: series.asset,
            displayName: series.asset,
            assetClass: 'unknown',
            pricePrecision: 5,
            isOtc: false,
          },
      instrumentIdentity: catalogued ? 'catalogue' : 'unresolved',
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
