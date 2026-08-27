import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checksumOf, getMigrationStatus, runMigrations, DatabaseError } from '@binaryai/database';
import {
  createTestDatabase,
  loadMigrationFiles,
  migrate,
  resetSchema,
  type TestDatabase,
} from './harness.js';

/**
 * Migration runner behaviour, executed against a real PostgreSQL engine.
 * Each test starts from a genuinely empty schema.
 */

let context: TestDatabase;

beforeEach(async () => {
  context ??= await createTestDatabase();
  await resetSchema(context.database);
});

afterAll(async () => {
  await context?.close();
});

describe('migration runner', () => {
  it('reports which engine the suite is running against', () => {
    // Printed so a passing run can never be mistaken for a claim about a
    // different PostgreSQL version than the one that actually ran.
    expect(['postgres-server', 'pglite-embedded']).toContain(context.engine);
    expect(context.version).toMatch(/PostgreSQL/i);
  });

  it('applies every migration from an empty database, in order', async () => {
    const applied = await migrate(context.database);
    const onDisk = (await loadMigrationFiles()).map((file) => file.version);

    // Derived from disk rather than hard-coded. A fixed list has to be edited
    // every time a migration is added, which turns an unrelated change into a
    // failing test and trains people to update the expectation without reading
    // it. What actually matters is that the runner applies ALL of them, in
    // filename order, and that order is lexicographic by design.
    expect(applied).toEqual(onDisk);
    expect(applied).toEqual([...applied].sort());
    expect(applied[0]).toBe('0001_init');
    expect(applied.length).toBeGreaterThanOrEqual(4);
  });

  it('creates the expected tables', async () => {
    await migrate(context.database);
    const result = await context.database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const tables = result.rows.map((row) => row.table_name);

    for (const expected of [
      'users',
      'accounts',
      'market_assets',
      'candles',
      'strategies',
      'signals',
      'signal_features',
      'signal_outcomes',
      'trades',
      'backtest_runs',
      'backtest_results',
      'risk_events',
      'system_events',
      'schema_migrations',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('creates the calibration read model as a view', async () => {
    await migrate(context.database);
    const result = await context.database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`,
    );
    expect(result.rows.map((row) => row.table_name)).toContain('signal_calibration_samples');
  });

  it('creates indexes, including the ones queries depend on', async () => {
    await migrate(context.database);
    const result = await context.database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexes = result.rows.map((row) => row.indexname);
    expect(indexes).toContain('signals_asset_time_idx');
    expect(indexes).toContain('candles_recent_idx');
    expect(indexes).toContain('signals_signal_key_idx');
    expect(indexes.length).toBeGreaterThan(15);
  });

  it('is idempotent: a second run applies nothing', async () => {
    await migrate(context.database);
    const second = await migrate(context.database);
    expect(second).toEqual([]);
  });

  it('records every applied migration in the ledger with a checksum', async () => {
    await migrate(context.database);
    const files = await loadMigrationFiles();
    const status = await getMigrationStatus(context.database, files);

    expect(status.pending).toHaveLength(0);
    expect(status.applied.map((record) => record.version)).toEqual(
      files.map((file) => file.version),
    );
    for (const record of status.applied) {
      expect(record.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(record.appliedAt).toBeGreaterThan(0);
    }
  });

  it('reports pending migrations before they run', async () => {
    const files = await loadMigrationFiles();
    const status = await getMigrationStatus(context.database, files);
    expect(status.pending.map((file) => file.version)).toEqual(files.map((file) => file.version));
    expect(status.applied).toHaveLength(0);
  });

  it('refuses to run when an applied migration file has been edited', async () => {
    await migrate(context.database);
    const files = await loadMigrationFiles();

    const tampered = files.map((file) =>
      file.version === '0001_init'
        ? {
            ...file,
            sql: `${file.sql}\n-- edited after the fact`,
            checksum: checksumOf(`${file.sql}\n-- edited`),
          }
        : file,
    );

    await expect(runMigrations(context.database, tampered)).rejects.toThrow(DatabaseError);
    await expect(runMigrations(context.database, tampered)).rejects.toThrow(
      /immutable once applied/,
    );
  });

  it('rolls a failing migration back entirely', async () => {
    await migrate(context.database);
    const broken = [
      {
        version: '9999_broken',
        filename: '9999_broken.sql',
        sql: `CREATE TABLE should_not_survive (id INT);
              INSERT INTO should_not_survive VALUES (1);
              SELECT * FROM a_table_that_does_not_exist;`,
        checksum: 'x'.repeat(64),
      },
    ];

    await expect(runMigrations(context.database, broken)).rejects.toThrow();

    // PostgreSQL has transactional DDL: the table must not exist.
    const result = await context.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'should_not_survive'`,
    );
    expect(result.rows[0]?.count).toBe('0');

    const files = await loadMigrationFiles();
    const status = await getMigrationStatus(context.database, files);
    expect(status.applied.map((r) => r.version)).not.toContain('9999_broken');
  });

  it('normalises line endings so checksums are stable across platforms', () => {
    expect(checksumOf('SELECT 1;\nSELECT 2;')).toBe(checksumOf('SELECT 1;\r\nSELECT 2;'));
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });
});
