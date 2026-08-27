import type { AppConfig } from '@binaryai/config';
import {
  createMemoryRateLimitStore,
  createRedisClient,
  createRedisRateLimitStore,
  type RateLimitStore,
} from '@binaryai/rate-limit';

/**
 * Chooses the counter a deployment will use.
 *
 * Configuration has already refused the incoherent combinations at boot —
 * `redis` with no REDIS_URL, and `memory` in production without an explicit
 * opt-in — so this function does not re-litigate them. It builds what was
 * asked for, and returns a line describing the choice so the boot log records
 * which guarantee this instance is actually running under.
 */
export function createRateLimitStoreFromConfig(config: AppConfig): {
  readonly store: RateLimitStore;
  readonly description: string;
} {
  const { store, allowInMemory } = config.server.rateLimit;

  if (store === 'redis' && config.redis.url) {
    return {
      store: createRedisRateLimitStore({ client: createRedisClient({ url: config.redis.url }) }),
      // No URL in the message: it can carry a password.
      description: 'Rate limits are counted in Redis and shared across instances.',
    };
  }

  return {
    store: createMemoryRateLimitStore(),
    description: allowInMemory
      ? 'Rate limits are counted PER PROCESS by explicit opt-in (RATE_LIMIT_ALLOW_IN_MEMORY). ' +
        'Every additional instance multiplies the effective limit.'
      : 'Rate limits are counted per process. Correct for a single instance only.',
  };
}
