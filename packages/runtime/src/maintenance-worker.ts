import type { Repositories } from '@binaryai/types';

/**
 * Scheduled housekeeping.
 *
 * Expired sessions stop authenticating the moment they expire — `findValid`
 * checks the expiry on every request, so an unswept row grants nothing. What it
 * does do is ACCUMULATE: every sign-in writes a row, and nothing ever removed
 * one. On a long-running instance the sessions table grows without bound, and
 * the rows that remain are exactly the credential material an attacker would
 * want from a database copy.
 *
 * So this is a retention job, not an authorisation control. Saying that plainly
 * matters: if it were load-bearing for security, a failed sweep would be an
 * incident rather than a cleanup that runs again in an hour.
 *
 * Deliberately conservative:
 *
 *  - It deletes only rows already PAST their expiry. A session in use is never
 *    touched, so a sweep cannot sign anybody out.
 *  - It reports what it deleted rather than logging silence, because a job that
 *    quietly does nothing for a month looks identical to one that is working.
 *  - It never throws for an empty sweep. Nothing to delete is the normal case.
 */

export interface MaintenanceDeps {
  readonly repositories: Repositories | null;
  readonly now?: () => number;
}

export interface MaintenanceResult {
  /** Expired session rows removed this cycle. */
  readonly sessionsDeleted: number;
  /** False when no database is configured, so nothing could be swept. */
  readonly ran: boolean;
}

const NOTHING: MaintenanceResult = { sessionsDeleted: 0, ran: false };

/**
 * Removes session rows whose expiry has already passed.
 *
 * The cutoff is `now`, never a padded window: deleting a row that expires in a
 * minute would sign out a user who is still working, to save a row that would
 * have been swept on the next cycle anyway.
 */
export async function runMaintenanceCycle(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const { repositories, now = Date.now } = deps;
  if (!repositories) return NOTHING;

  const sessionsDeleted = await repositories.sessions.deleteExpired(now());
  return { sessionsDeleted, ran: true };
}
