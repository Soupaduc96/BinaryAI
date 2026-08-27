import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseError, type Database, type SqlExecutor } from './executor.js';

/**
 * Migration runner.
 *
 * Owns the transaction and the `schema_migrations` ledger, which is why the
 * .sql files contain no BEGIN/COMMIT of their own: a file that manages its own
 * transaction cannot be rolled back by the runner, and a half-applied migration
 * is the worst possible outcome.
 *
 * Each migration runs in its own transaction. PostgreSQL has transactional DDL,
 * so a failure inside 0002 leaves the database exactly as 0001 left it.
 */

export interface MigrationFile {
  /** Filename without extension, e.g. "0001_init". Sorts lexicographically. */
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationRecord {
  readonly version: string;
  readonly appliedAt: number;
  readonly checksum: string | null;
}

export interface MigrationDrift {
  readonly version: string;
  readonly appliedChecksum: string;
  readonly currentChecksum: string;
}

export interface MigrationStatus {
  readonly applied: readonly MigrationRecord[];
  readonly pending: readonly MigrationFile[];
  /** Applied migrations whose file has since changed -- always a mistake. */
  readonly drift: readonly MigrationDrift[];
}

/**
 * Checksums normalise line endings first. Git on Windows checks these files out
 * with CRLF, and a checksum that changes with the platform would report drift
 * on every machine.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim()).digest('hex');
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const sql = await readFile(path.join(directory, filename), 'utf8');
    migrations.push({
      version: filename.replace(/\.sql$/, ''),
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }
  return migrations;
}

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum   TEXT
  )
`;

export async function ensureMigrationsTable(executor: SqlExecutor): Promise<void> {
  await executor.query(CREATE_LEDGER);
  // 0001 originally shipped a ledger without a checksum column; adding it here
  // keeps an existing database upgradeable without a migration of its own.
  await executor.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

export async function readAppliedMigrations(executor: SqlExecutor): Promise<MigrationRecord[]> {
  const result = await executor.query<{
    version: string;
    applied_at: Date;
    checksum: string | null;
  }>('SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.getTime() : Number(row.applied_at),
    checksum: row.checksum,
  }));
}

export async function getMigrationStatus(
  executor: SqlExecutor,
  migrations: readonly MigrationFile[],
): Promise<MigrationStatus> {
  await ensureMigrationsTable(executor);
  const applied = await readAppliedMigrations(executor);
  const appliedByVersion = new Map(applied.map((record) => [record.version, record]));

  const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version));
  const drift: MigrationDrift[] = [];

  for (const migration of migrations) {
    const record = appliedByVersion.get(migration.version);
    if (record?.checksum && record.checksum !== migration.checksum) {
      drift.push({
        version: migration.version,
        appliedChecksum: record.checksum,
        currentChecksum: migration.checksum,
      });
    }
  }

  return { applied, pending, drift };
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export interface RunMigrationsOptions {
  /** Refuse to run when an applied migration's file has changed. Default true. */
  readonly failOnDrift?: boolean;
}

export async function runMigrations(
  database: Database,
  migrations: readonly MigrationFile[],
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const { failOnDrift = true } = options;
  const status = await getMigrationStatus(database, migrations);

  if (failOnDrift && status.drift.length > 0) {
    const detail = status.drift
      .map(
        (item) =>
          `${item.version} (applied ${item.appliedChecksum.slice(0, 12)}, now ${item.currentChecksum.slice(0, 12)})`,
      )
      .join(', ');
    throw new DatabaseError(
      `Applied migrations have been edited: ${detail}. Migrations are immutable once applied; ` +
        'add a new migration instead of changing history.',
    );
  }

  const applied: string[] = [];
  for (const migration of status.pending) {
    await database.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [migration.version, migration.checksum],
      );
    });
    applied.push(migration.version);
  }

  return {
    applied,
    alreadyApplied: status.applied.map((record) => record.version),
  };
}
