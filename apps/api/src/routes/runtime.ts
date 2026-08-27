import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../lib/context.js';

/**
 * Runtime status routes.
 *
 * Every field comes from what the workers actually did. A worker that is
 * configured but has never completed a cycle reports exactly that — there is no
 * path here that turns configuration into a healthy-looking status.
 */
export function registerRuntimeRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/v1/analysis/status', async () => {
    const runtime = await context.runtime.status();
    return {
      analysis: runtime.analysis,
      // Restated here because a green worker with no data is still not analysing.
      requires: {
        persistence: context.persistence !== null,
        marketDataProvider: context.marketData.provider !== null,
      },
    };
  });

  app.get('/v1/settlement/status', async () => {
    const runtime = await context.runtime.status();
    return {
      settlement: runtime.settlement,
      /**
       * Settlement records DIRECTIONAL correctness from exchange candles. It is
       * not a broker settlement result and carries no payout economics.
       */
      semantics: {
        dataOrigin: context.marketData.provider?.capabilities.dataOrigin ?? null,
        rule: 'close of the last bar ending at or before expiry',
        payoutApplied: false,
        note: 'Directional outcome only. BinaryAI has no broker terms, so no profit is derived.',
      },
    };
  });

  app.get('/v1/runtime/status', async () => ({ runtime: await context.runtime.status() }));

  /** The most recent evaluations, newest first. */
  app.get('/v1/signals/latest', async (request) => {
    if (!context.persistence) {
      return {
        signals: [],
        reason: 'No database is configured, so no evaluations are stored.',
      };
    }
    const signals = await context.persistence.repositories.signals.list({
      scope: request.scope,
      limit: 10,
    });
    return { signals };
  });
}
