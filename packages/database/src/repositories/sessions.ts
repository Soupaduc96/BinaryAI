import type { NewSession, Session, SessionRepository } from '@binaryai/types';
import { RecordNotFoundError, type Row, type SqlExecutor } from '../executor.js';
import { toEpochMs, toNullableEpochMs, toNullableText, toText, toTimestamp } from '../mappers.js';

/**
 * Sessions.
 *
 * Lookups are by token DIGEST, never by a raw token: the raw value exists only
 * in the user's cookie. `token_hash` carries a unique index, so this is a
 * single index probe regardless of how many sessions exist.
 *
 * Revocation sets a timestamp rather than deleting the row, which keeps the
 * audit trail intact -- "when did this session end, and was it a logout or an
 * expiry?" is a question worth being able to answer. `deleteExpired` reclaims
 * the space later.
 */

interface SessionRow extends Row {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  user_agent: string | null;
  ip_address: string | null;
}

const COLUMNS = `id, user_id, created_at, expires_at, last_seen_at, revoked_at, user_agent, ip_address`;

function toSession(row: SessionRow): Session {
  return {
    id: toText(row.id, 'session.id'),
    userId: toText(row.user_id, 'session.user_id'),
    createdAt: toEpochMs(row.created_at, 'session.created_at'),
    expiresAt: toEpochMs(row.expires_at, 'session.expires_at'),
    lastSeenAt: toEpochMs(row.last_seen_at, 'session.last_seen_at'),
    revokedAt: toNullableEpochMs(row.revoked_at),
    userAgent: toNullableText(row.user_agent),
    ipAddress: toNullableText(row.ip_address),
  };
}

/** A user agent is attacker-controlled; store a bounded prefix, never a novel. */
const MAX_USER_AGENT = 400;

export function createSessionRepository(executor: SqlExecutor): SessionRepository {
  return {
    async create(session: NewSession): Promise<Session> {
      const result = await executor.query<SessionRow>(
        `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [
          session.userId,
          session.tokenHash,
          toTimestamp(session.expiresAt),
          session.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
          session.ipAddress ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('session', session.userId);
      return toSession(row);
    },

    async findByTokenHash(tokenHash: string): Promise<Session | null> {
      // Returns expired and revoked rows too. The caller decides what that
      // means -- see resolveSession() in @binaryai/auth -- so that "expired"
      // and "never existed" stay distinguishable.
      const result = await executor.query<SessionRow>(
        `SELECT ${COLUMNS} FROM sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? toSession(row) : null;
    },

    async touch(sessionId: string, at: number): Promise<void> {
      await executor.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [
        sessionId,
        toTimestamp(at),
      ]);
    },

    async revoke(sessionId: string, at: number): Promise<void> {
      // `revoked_at IS NULL` keeps the ORIGINAL revocation time: logging out
      // twice must not rewrite when the session actually ended.
      await executor.query(
        'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
        [sessionId, toTimestamp(at)],
      );
    },

    async revokeAllForUser(userId: string, at: number): Promise<number> {
      const result = await executor.query(
        'UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
        [userId, toTimestamp(at)],
      );
      return result.rowCount;
    },

    async listActiveForUser(userId: string, at: number): Promise<readonly Session[]> {
      const result = await executor.query<SessionRow>(
        `SELECT ${COLUMNS} FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
          ORDER BY last_seen_at DESC`,
        [userId, toTimestamp(at)],
      );
      return result.rows.map(toSession);
    },

    async deleteExpired(before: number): Promise<number> {
      const result = await executor.query('DELETE FROM sessions WHERE expires_at < $1', [
        toTimestamp(before),
      ]);
      return result.rowCount;
    },
  };
}
