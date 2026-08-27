import type { RedisCommands } from './redis-store.js';

/**
 * A deterministic stand-in for Redis.
 *
 * It exists because the alternative — testing the Redis store with a mock that
 * returns whatever the test wants — proves only that the code calls functions.
 * This implements INCR, PEXPIRE and PTTL to their documented semantics against
 * a clock the test controls, so the store's actual reasoning is exercised: that
 * exactly one caller opens a window, that a key with no TTL gets repaired, and
 * that a window genuinely ends.
 *
 * What it CANNOT prove, and no test in this repository claims: network
 * behaviour, real atomicity across real connections, failover, cluster
 * redirection, or that a production Redis is configured correctly.
 */

export interface FakeRedis extends RedisCommands {
  /** Fails every subsequent command with `message`, simulating an outage. */
  breakWith(message: string): void;
  /** Restores normal operation. */
  heal(): void;
  /** Number of live keys. */
  size(): number;
  readonly closed: boolean;
}

interface Entry {
  value: number;
  /** Epoch ms, or null for a key with no expiry set. */
  expiresAt: number | null;
}

export function createFakeRedis(now: () => number = Date.now): FakeRedis {
  const store = new Map<string, Entry>();
  let failure: string | null = null;
  let closed = false;

  const guard = (): void => {
    if (failure !== null) throw new Error(failure);
  };

  const read = (key: string): Entry | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && now() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    async incr(key: string): Promise<number> {
      guard();
      const entry = read(key);
      if (!entry) {
        store.set(key, { value: 1, expiresAt: null });
        return 1;
      }
      entry.value += 1;
      return entry.value;
    },

    async pexpire(key: string, milliseconds: number): Promise<number> {
      guard();
      const entry = read(key);
      if (!entry) return 0;
      entry.expiresAt = now() + milliseconds;
      return 1;
    },

    async pttl(key: string): Promise<number> {
      guard();
      const entry = read(key);
      // Redis returns -2 for a missing key and -1 for a key with no expiry.
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return entry.expiresAt - now();
    },

    async ping(): Promise<string> {
      guard();
      return 'PONG';
    },

    async close(): Promise<void> {
      closed = true;
      store.clear();
    },

    breakWith(message: string): void {
      failure = message;
    },

    heal(): void {
      failure = null;
    },

    size(): number {
      return store.size;
    },

    get closed(): boolean {
      return closed;
    },
  };
}
