import type { NewUser, User, UserRepository, UserRole, UserWithCredentials } from '@binaryai/types';
import { RecordNotFoundError, type Row, type SqlExecutor } from '../executor.js';
import {
  toBoolean,
  toEpochMs,
  toNullableEpochMs,
  toNullableText,
  toNumber,
  toText,
} from '../mappers.js';

/**
 * Users.
 *
 * One rule shapes this whole file: the password digest leaves through exactly
 * ONE method, `findByEmailWithCredentials`, which the login flow alone calls.
 * Every other read projects a column list that omits `password_hash`, so a
 * route cannot serialize a digest even by accident. That is why the SELECT
 * lists are spelled out rather than using `SELECT *`.
 */

interface UserRow extends Row {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

interface CredentialRow extends UserRow {
  password_hash: string;
  failed_logins: number | string;
  locked_until: Date | null;
}

/** Note the absent password_hash. Adding it here would leak it everywhere. */
const SAFE_COLUMNS = `id, email, display_name, role, is_active, created_at, last_login_at`;

function toRole(value: string): UserRole {
  // The database CHECK already restricts this; the guard exists so an
  // unexpected value fails loudly instead of being cast into the type system.
  if (value === 'user' || value === 'admin') return value;
  throw new Error(`Unknown user role "${value}" in the database.`);
}

function toUser(row: UserRow): User {
  return {
    id: toText(row.id, 'user.id'),
    email: toText(row.email, 'user.email'),
    displayName: toNullableText(row.display_name),
    role: toRole(toText(row.role, 'user.role')),
    isActive: toBoolean(row.is_active),
    createdAt: toEpochMs(row.created_at, 'user.created_at'),
    lastLoginAt: toNullableEpochMs(row.last_login_at),
  };
}

function toUserWithCredentials(row: CredentialRow): UserWithCredentials {
  return {
    ...toUser(row),
    passwordHash: toText(row.password_hash, 'user.password_hash'),
    failedLogins: toNumber(row.failed_logins, 'user.failed_logins'),
    lockedUntil: toNullableEpochMs(row.locked_until),
  };
}

export function createUserRepository(executor: SqlExecutor): UserRepository {
  return {
    async create(user: NewUser): Promise<User> {
      const result = await executor.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING ${SAFE_COLUMNS}`,
        [user.email, user.passwordHash, user.displayName ?? null, user.role ?? 'user'],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('user', user.email);
      return toUser(row);
    },

    async findById(id: string): Promise<User | null> {
      const result = await executor.query<UserRow>(
        `SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toUser(row) : null;
    },

    async findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null> {
      const result = await executor.query<CredentialRow>(
        `SELECT ${SAFE_COLUMNS}, password_hash, failed_logins, locked_until
         FROM users WHERE email = $1`,
        [email],
      );
      const row = result.rows[0];
      return row ? toUserWithCredentials(row) : null;
    },

    async list(limit = 50, offset = 0): Promise<readonly User[]> {
      const result = await executor.query<UserRow>(
        `SELECT ${SAFE_COLUMNS} FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map(toUser);
    },

    async count(): Promise<number> {
      const result = await executor.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
      return Number(result.rows[0]?.count ?? 0);
    },

    async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
      await executor.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        userId,
        passwordHash,
      ]);
    },

    async setActive(userId: string, isActive: boolean): Promise<void> {
      await executor.query('UPDATE users SET is_active = $2 WHERE id = $1', [userId, isActive]);
    },

    async recordLoginSuccess(userId: string, at: number): Promise<void> {
      // Clearing the counter here is what makes the lockout forgiving: one
      // correct login wipes a history of typos.
      await executor.query(
        `UPDATE users
            SET last_login_at = to_timestamp($2::double precision / 1000),
                failed_logins = 0,
                locked_until  = NULL
          WHERE id = $1`,
        [userId, at],
      );
    },

    async recordLoginFailure(
      userId: string,
      _at: number,
      lockUntil: number | null,
    ): Promise<number> {
      // Incremented in SQL rather than read-modify-write, so simultaneous
      // guesses cannot each read the same count and overwrite one another.
      const result = await executor.query<{ failed_logins: number | string }>(
        `UPDATE users
            SET failed_logins = failed_logins + 1,
                locked_until  = CASE
                  WHEN $2::double precision IS NULL THEN locked_until
                  ELSE to_timestamp($2::double precision / 1000)
                END
          WHERE id = $1
          RETURNING failed_logins`,
        [userId, lockUntil],
      );
      return Number(result.rows[0]?.failed_logins ?? 0);
    },
  };
}
