import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../lib/context.js';
import { errorBody } from '../lib/http.js';

/**
 * Strategy discovery. The UI builds its strategy list and parameter forms from
 * this response, so registering a new strategy module makes it appear in the
 * dashboard with no frontend change.
 */
export function registerStrategyRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/v1/strategies', () => ({
    strategies: context.registry.list().map((strategy) => ({
      ...strategy.meta,
      parameters: strategy.parameters,
    })),
  }));

  app.get('/v1/strategies/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    if (!context.registry.has(id)) {
      return reply
        .code(404)
        .send(
          errorBody(
            'strategy_not_found',
            `Strategy "${id}" is not registered.`,
            undefined,
            request.id,
          ),
        );
    }
    const strategy = context.registry.get(id);
    return { ...strategy.meta, parameters: strategy.parameters };
  });
}
