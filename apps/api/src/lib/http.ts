import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/** Uniform error envelope. Clients parse one shape, never a stack trace. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly string[];
    readonly requestId?: string;
  };
}

export function errorBody(
  code: string,
  message: string,
  issues?: readonly string[],
  requestId?: string,
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      ...(issues === undefined ? {} : { issues }),
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/**
 * Parse an untrusted body against a schema.
 * Returns the reply on failure so handlers can `return failed` and stop.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  reply: FastifyReply,
): { ok: true; data: z.output<T> } | { ok: false; sent: FastifyReply } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };

  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return {
    ok: false,
    sent: reply
      .code(400)
      .send(
        errorBody('invalid_request', 'Request body failed validation.', issues, reply.request.id),
      ),
  };
}
