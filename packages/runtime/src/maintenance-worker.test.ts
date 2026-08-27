import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '@binaryai/types';
import { runMaintenanceCycle } from './maintenance-worker.js';

/**
 * The session sweep.
 *
 * The property that matters is NOT that rows disappear — it is that the sweep
 * can never sign anybody out. It deletes strictly by expiry, using the current
 * time as the cutoff, and a bug that padded that cutoff forward would revoke
 * live sessions on a schedule. That is what these tests pin.
 */

function repositoriesWith(deleteExpired: (before: number) => Promise<number>): Repositories {
  return { sessions: { deleteExpired } } as unknown as Repositories;
}

describe('runMaintenanceCycle', () => {
  it('sweeps expired sessions and reports the count', async () => {
    const result = await runMaintenanceCycle({
      repositories: repositoriesWith(async () => 7),
      now: () => 1_000,
    });

    expect(result).toEqual({ sessionsDeleted: 7, ran: true });
  });

  it('uses the current time as the cutoff, never a padded window', async () => {
    // A cutoff in the FUTURE would delete sessions that have not expired yet,
    // signing out users who are still working. The cutoff must be exactly now.
    const deleteExpired = vi.fn(async (_before: number) => 0);
    const now = 1_700_000_000_000;

    await runMaintenanceCycle({ repositories: repositoriesWith(deleteExpired), now: () => now });

    expect(deleteExpired).toHaveBeenCalledWith(now);
    expect(deleteExpired.mock.calls[0]?.[0]).not.toBeGreaterThan(now);
  });

  it('treats an empty sweep as success, not as a failure', async () => {
    // Nothing to delete is the normal case on a healthy instance.
    const result = await runMaintenanceCycle({
      repositories: repositoriesWith(async () => 0),
      now: () => 1_000,
    });

    expect(result.ran).toBe(true);
    expect(result.sessionsDeleted).toBe(0);
  });

  it('reports that it did not run when no database is configured', async () => {
    // `ran: false` is distinct from a sweep that deleted nothing: one means
    // there was nothing to sweep, the other that no sweep was possible.
    const result = await runMaintenanceCycle({ repositories: null });

    expect(result.ran).toBe(false);
    expect(result.sessionsDeleted).toBe(0);
  });

  it('propagates a repository failure rather than reporting a clean sweep', async () => {
    // A swallowed error would let a permanently failing job look healthy.
    await expect(
      runMaintenanceCycle({
        repositories: repositoriesWith(async () => {
          throw new Error('connection lost');
        }),
        now: () => 1_000,
      }),
    ).rejects.toThrow('connection lost');
  });

  it('sweeps only sessions, leaving every other record alone', async () => {
    // Retention for auth material is not licence to prune anything else.
    const touched: string[] = [];
    const repositories = new Proxy(
      { sessions: { deleteExpired: async () => 1 } },
      {
        get(target, key: string) {
          touched.push(key);
          return (target as Record<string, unknown>)[key];
        },
      },
    ) as unknown as Repositories;

    await runMaintenanceCycle({ repositories, now: () => 1_000 });

    expect(touched).toEqual(['sessions']);
  });
});
