import type { ProviderErrorKind } from '@binaryai/types';

/**
 * One error type for every provider failure, carrying the classification the
 * ingestion worker needs to decide between retry, back off, and stop.
 *
 * Retryability is a property of the failure, not a guess made at the call site:
 * a timeout or a 503 is worth retrying, a 401 or an unsupported timeframe never
 * is, and retrying them would just burn the rate limit.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(kind);
  }
}

const DEFAULT_RETRYABLE = new Set<ProviderErrorKind>([
  'network',
  'timeout',
  'rate_limited',
  'server_error',
]);

export function isRetryable(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

export function errorKind(error: unknown): ProviderErrorKind {
  return error instanceof ProviderError ? error.kind : 'network';
}

/** The subset of `fetch` the adapters use. Injectable, so tests need no network. */
export type HttpFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;
