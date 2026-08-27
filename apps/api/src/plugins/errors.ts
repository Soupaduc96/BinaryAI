import { LiveExecutionDisabledError } from '@binaryai/engine';
import { StrategyNotFoundError, StrategyParameterError } from '@binaryai/strategies';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../lib/context.js';
import { errorBody } from '../lib/http.js';

/**
 * One place that turns thrown errors into responses.
 *
 * Known domain errors map to precise status codes. Anything unrecognised is a
 * 500 that logs the detail server-side and returns only a request id -- an
 * internal message could leak schema or path information.
 */
export function registerErrorHandling(app: FastifyInstance, context: AppContext): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(
        errorBody(
          'not_found',
          `No route for ${request.method} ${request.url}.`,
          undefined,
          request.id,
        ),
      );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StrategyNotFoundError) {
      void reply
        .code(404)
        .send(errorBody('strategy_not_found', error.message, undefined, request.id));
      return;
    }
    if (error instanceof StrategyParameterError) {
      void reply
        .code(400)
        .send(errorBody('invalid_parameters', error.message, undefined, request.id));
      return;
    }
    if (error instanceof LiveExecutionDisabledError) {
      void reply
        .code(403)
        .send(errorBody('live_execution_disabled', error.message, undefined, request.id));
      return;
    }
    const statusCode = statusCodeOf(error);
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      void reply
        .code(statusCode)
        .send(errorBody('bad_request', messageOf(error), undefined, request.id));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    const message =
      context.config.nodeEnv === 'production'
        ? 'Internal server error.'
        : `Internal server error: ${messageOf(error)}`;
    void reply.code(500).send(errorBody('internal_error', message, undefined, request.id));
  });
}

/** Fastify types the handler's error as `unknown`; narrow it without casting to any. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error as { statusCode: unknown };
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
