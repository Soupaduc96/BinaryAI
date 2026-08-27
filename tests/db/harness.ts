import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  createPersistenceLayer,
  createPostgresDatabase,
  loadMigrations,
  runMigrations,
  toDatabaseError,
  type Database,
  type QueryResult,
  type Row,
  type SqlExecutor,
} from '@binaryai/database';
import { defaultTestAsset, syntheticUptrend } from '@binaryai/fixtures';
import { evaluateDecision } from '@binaryai/engine';
import { trendMomentumStrategy } from '@binaryai/strategies';
import type { PersistenceLayer, Signal } from '@binaryai/types';

/**
 * Test database harness.
 *
 * The same suite runs against two engines:
 *
 *  - **PGlite** by default — real PostgreSQL compiled to WebAssembly, embedded
 *    in the test process. Enums, CHECK constraints, foreign keys, NUMERIC and
 *    TIMESTAMPTZ all behave as they do on a server, which is exactly why it is
 *    used instead of SQLite. What it CANNOT prove: pooling under concurrency,
 *    networking, TLS, roles, or multi-client isolation.
 *  - **A real server** when DATABASE_URL is set — which is what CI does, on
 *    postgres:16. That run is the authoritative one.
 *
 * Every test therefore states which engine it ran on, and no claim of "verified
 * on PostgreSQL 16" is made from a local run alone.
 */

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../database/migrations',
);

export type TestEngine = 'postgres-server' | 'pglite-embedded';

export interface TestDatabase {
  readonly database: Database;
  readonly persistence: PersistenceLayer;
  readonly engine: TestEngine;
  /** Human-readable engine banner, e.g. "PostgreSQL 16.4". */
  readonly version: string;
  close(): Promise<void>;
}

/** Adapts PGlite to the same `Database` interface the pg pool implements. */
function adaptPglite(client: PGlite): Database {
  const run = async <T extends Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> => {
    try {
      // PGlite's query() takes exactly one statement; exec() takes a script.
      // Migrations arrive as scripts with no parameters, so route on that.
      if (params.length === 0) {
        const results = await client.exec(text);
        const last = results.at(-1);
        const rows = (last?.rows ?? []) as T[];
        return { rows, rowCount: last?.affectedRows ?? rows.length };
      }
      const result = await client.query(text, [...params]);
      const rows = (result.rows ?? []) as T[];
      return { rows, rowCount: result.affectedRows ?? rows.length };
    } catch (error) {
      throw toDatabaseError(error, text);
    }
  };

  const executor: SqlExecutor = { query: run };

  return {
    query: run,
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await run('BEGIN', []);
      try {
        const value = await work(executor);
        await run('COMMIT', []);
        return value;
      } catch (error) {
        await run('ROLLBACK', []).catch(() => undefined);
        throw error;
      }
    },
    async ping(): Promise<boolean> {
      const result = await run<{ ok: number }>('SELECT 1 AS ok', []);
      return result.rows[0]?.ok === 1;
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env['DATABASE_URL'];

  if (url) {
    const database = createPostgresDatabase({
      url,
      maxConnections: 4,
      applicationName: 'binaryai-tests',
    });
    const version = await readVersion(database);
    return {
      database,
      persistence: createPersistenceLayer(database),
      engine: 'postgres-server',
      version,
      close: () => database.close(),
    };
  }

  const client = new PGlite();
  const database = adaptPglite(client);
  const version = await readVersion(database);
  return {
    database,
    persistence: createPersistenceLayer(database),
    engine: 'pglite-embedded',
    version,
    close: () => database.close(),
  };
}

async function readVersion(database: Database): Promise<string> {
  const result = await database.query<{ version: string }>('SELECT version() AS version');
  const banner = result.rows[0]?.version ?? 'unknown';
  return banner.split(' on ')[0] ?? banner;
}

export async function migrate(database: Database): Promise<string[]> {
  const migrations = await loadMigrations(migrationsDirectory);
  const result = await runMigrations(database, migrations);
  return [...result.applied];
}

export async function loadMigrationFiles() {
  return loadMigrations(migrationsDirectory);
}

/**
 * Drops everything, including types and the migration ledger. Used only by the
 * migration tests, which need a genuinely empty database to apply against.
 */
export async function resetSchema(database: Database): Promise<void> {
  await database.query('DROP SCHEMA IF EXISTS public CASCADE');
  await database.query('CREATE SCHEMA public');
}

/**
 * Wipes every table between tests. RESTART IDENTITY resets the signal_features
 * sequence so ids are comparable across tests; CASCADE handles the FK order.
 */
export async function truncateAll(database: Database): Promise<void> {
  await database.query(`
    TRUNCATE TABLE
      signal_features, signal_outcomes, signals, trades,
      backtest_results, backtest_runs, candles, market_assets,
      strategies, sessions, accounts, users, risk_events, system_events
    RESTART IDENTITY CASCADE
  `);
}

// --------------------------------------------------------------- fixtures --

/**
 * A genuine Signal from the real decision pipeline, not a hand-written stub.
 * Persistence tests should exercise the object the engine actually produces --
 * a fake would hide mapping bugs in exactly the fields that matter.
 */
export function buildRealSignal(overrides: Partial<Signal> = {}): Signal {
  const decision = evaluateDecision({
    asset: defaultTestAsset,
    series: syntheticUptrend(300),
    strategy: trendMomentumStrategy,
    // No explicit `now`: it defaults to the last candle's timestamp. Passing an
    // unrelated one produces a signal whose expiry precedes its decision bar --
    // which the schema's signals_expiry_after_decision CHECK rejects outright.
    idFactory: () => 'sig_11111111-1111-1111-1111-111111111111',
  });
  return { ...decision.signal, ...overrides };
}

export function buildRealDecision() {
  return evaluateDecision({
    asset: defaultTestAsset,
    series: syntheticUptrend(300),
    strategy: trendMomentumStrategy,
    idFactory: () => 'sig_22222222-2222-2222-2222-222222222222',
  });
}

export async function seedAsset(persistence: PersistenceLayer, symbol = 'SYNTH'): Promise<string> {
  const stored = await persistence.repositories.assets.upsert({
    symbol,
    displayName: `${symbol} test instrument`,
    assetClass: 'unknown',
    pricePrecision: 5,
    isOtc: false,
  });
  return stored.id;
}

export async function seedUserAndAccount(
  database: Database,
): Promise<{ userId: string; accountId: string }> {
  const user = await database.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [`user-${Math.random().toString(16).slice(2)}@test.local`, 'argon2id$placeholder'],
  );
  const userId = user.rows[0]?.id ?? '';
  const account = await database.query<{ id: string }>(
    `INSERT INTO accounts (user_id, balance, day_start_balance) VALUES ($1, 1000, 1000) RETURNING id`,
    [userId],
  );
  return { userId, accountId: account.rows[0]?.id ?? '' };
}
