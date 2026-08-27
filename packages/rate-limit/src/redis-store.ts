import type { RateLimitHit, RateLimitStore } from './store.js';

/**
 * The shared counter.
 *
 * Written against the four commands it actually needs rather than against a
 * client library, so no Redis package is pulled into the dependency tree for a
 * feature that may not be configured, and so the tests can drive a deterministic
 * fake that exercises the same code path a real server would.
 *
 * ---------------------------------------------------------------------------
 * NOT VERIFIED AGAINST A REAL REDIS SERVER.
 *
 * No Redis is reachable from the development environment this was written in.
 * The command sequence below is the standard fixed-window pattern and the fake
 * in the tests implements INCR/PEXPIRE/PTTL to their documented semantics, but
 * that is a proof about this code, not about a deployment. Until it has run
 * against a real server under real concurrency, "distributed rate limiting" is
 * an implemented capability, not a verified one. See docs/security.md.
 * ---------------------------------------------------------------------------
 */

/** The commands this store issues. Any Redis client can be adapted to it. */
export interface RedisCommands {
  /** Atomically increments and returns the new value. */
  incr(key: string): Promise<number>;
  /** Sets a millisecond TTL. */
  pexpire(key: string, milliseconds: number): Promise<number>;
  /** Remaining TTL in ms; negative when absent or unset. */
  pttl(key: string): Promise<number>;
  ping(): Promise<string>;
  close(): Promise<void>;
}

export interface RedisRateLimitStoreOptions {
  readonly client: RedisCommands;
  /**
   * Namespace prefix. Two applications sharing one Redis must not share
   * counters, and a key collision would silently throttle the wrong traffic.
   */
  readonly prefix?: string;
}

export function createRedisRateLimitStore(options: RedisRateLimitStoreOptions): RateLimitStore {
  const { client, prefix = 'binaryai:rl' } = options;

  return {
    kind: 'redis',
    shared: true,

    async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
      const namespaced = `${prefix}:${key}`;

      // INCR is atomic, so exactly one caller in a window sees 1 and is
      // responsible for setting the expiry.
      const count = await client.incr(namespaced);

      if (count === 1) {
        await client.pexpire(namespaced, windowMs);
        return { count, resetAt: now + windowMs };
      }

      const ttl = await client.pttl(namespaced);
      if (ttl < 0) {
        // The window opener died between INCR and PEXPIRE, leaving a key with
        // no expiry. Without this repair the counter would never reset and the
        // identity would be throttled permanently — a self-inflicted denial of
        // service that would look like an attack in the logs.
        await client.pexpire(namespaced, windowMs);
        return { count, resetAt: now + windowMs };
      }

      return { count, resetAt: now + ttl };
    },

    async healthy(): Promise<boolean> {
      try {
        return (await client.ping()).toUpperCase() === 'PONG';
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
