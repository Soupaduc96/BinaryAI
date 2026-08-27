import { Pool, type PoolClient, type PoolConfig } from 'pg';
import {
  toDatabaseError,
  type Database,
  type QueryResult,
  type Row,
  type SqlExecutor,
} from './executor.js';

/**
 * PostgreSQL connection layer.
 *
 * Configuration is passed in, never read from the environment here -- only
 * @binaryai/config touches process.env, and the API maps its `AppConfig` onto
 * `DatabaseConfig`. No credential is ever logged: `describeDatabaseConfig`
 * reports host and database name only.
 */

export interface DatabaseConfig {
  /** postgresql://user:password@host:port/database */
  readonly url: string;
  readonly ssl?: boolean;
  /** Pool ceiling. Keep below the server's max_connections divided by instances. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Server-side cap so one bad query cannot pin a connection forever. */
  readonly statementTimeoutMs?: number;
  /** Shows up in pg_stat_activity, which makes debugging a live server bearable. */
  readonly applicationName?: string;
}

export const DEFAULT_DATABASE_CONFIG = {
  maxConnections: 10,
  connectionTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 15_000,
  applicationName: 'binaryai-api',
} as const;

function toPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    connectionString: config.url,
    max: config.maxConnections ?? DEFAULT_DATABASE_CONFIG.maxConnections,
    connectionTimeoutMillis:
      config.connectionTimeoutMs ?? DEFAULT_DATABASE_CONFIG.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs ?? DEFAULT_DATABASE_CONFIG.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs ?? DEFAULT_DATABASE_CONFIG.statementTimeoutMs,
    application_name: config.applicationName ?? DEFAULT_DATABASE_CONFIG.applicationName,
    ...(config.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

/** Safe-to-log description. Never includes user, password or query strings. */
export function describeDatabaseConfig(config: DatabaseConfig): Record<string, unknown> {
  let host = 'unparseable';
  let database = 'unknown';
  try {
    const parsed = new URL(config.url);
    host = `${parsed.hostname}:${parsed.port || '5432'}`;
    database = parsed.pathname.replace(/^\//, '') || 'unknown';
  } catch {
    // A malformed URL is reported by the connection attempt, not by logging.
  }
  return {
    host,
    database,
    ssl: config.ssl === true,
    maxConnections: config.maxConnections ?? DEFAULT_DATABASE_CONFIG.maxConnections,
    statementTimeoutMs: config.statementTimeoutMs ?? DEFAULT_DATABASE_CONFIG.statementTimeoutMs,
  };
}

class PostgresDatabase implements Database {
  readonly #pool: Pool;
  #closed = false;

  constructor(config: DatabaseConfig) {
    this.#pool = new Pool(toPoolConfig(config));
    // An idle client erroring (server restart, network drop) emits on the pool.
    // Without a listener Node treats it as an unhandled error and exits.
    this.#pool.on('error', () => {
      // Deliberately swallowed: pg discards the broken client and the next
      // checkout gets a fresh one. Surfacing it would need a logger, and this
      // package stays logger-free.
    });
  }

  async query<T extends Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (this.#closed) {
      throw toDatabaseError(new Error('query attempted after the pool was closed'), text);
    }
    try {
      const result = await this.#pool.query(text, [...params]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    } catch (error) {
      throw toDatabaseError(error, text);
    }
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.#pool.connect();
    const executor: SqlExecutor = {
      query: async <R extends Row>(text: string, params: readonly unknown[] = []) => {
        try {
          const result = await client.query(text, [...params]);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
        } catch (error) {
          throw toDatabaseError(error, text);
        }
      },
    };

    try {
      await client.query('BEGIN');
      const value = await work(executor);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already unusable; the original error is what matters.
      }
      throw toDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.query<{ ok: number }>('SELECT 1 AS ok');
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }
}

export function createPostgresDatabase(config: DatabaseConfig): Database {
  if (!config.url || config.url.trim().length === 0) {
    throw toDatabaseError(new Error('DATABASE_URL is empty; cannot create a connection pool'));
  }
  return new PostgresDatabase(config);
}
