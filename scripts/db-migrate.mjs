#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   npm run db:migrate          apply pending migrations
 *   npm run db:status           show what is applied and what is pending
 *
 * DATABASE_URL must be set. Node reads .env for you:
 *   node --env-file=.env scripts/db-migrate.mjs
 *
 * Migrations are applied one transaction each, in filename order, and recorded
 * in schema_migrations with a checksum. Editing an applied migration is
 * refused -- add a new one instead.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getMigrationStatus,
  loadMigrations,
  createPostgresDatabase,
  describeDatabaseConfig,
} from '@binaryai/database';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    'DATABASE_URL is not set.\n\n' +
      '  Local PostgreSQL:  docker compose up -d\n' +
      '  Then:              DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai npm run db:migrate\n' +
      '  Or:                node --env-file=.env scripts/db-migrate.mjs\n',
  );
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../database/migrations',
);

const database = createPostgresDatabase({ url, applicationName: 'binaryai-migrate' });

try {
  if (!(await database.ping())) {
    console.error('Could not reach the database at', describeDatabaseConfig({ url }).host);
    process.exit(1);
  }

  const migrations = await loadMigrations(migrationsDir);
  const status = await getMigrationStatus(database, migrations);

  console.log('');
  console.log('BinaryAI :: database migrations');
  console.log('='.repeat(60));
  console.log(
    `  target      ${describeDatabaseConfig({ url }).host}/${describeDatabaseConfig({ url }).database}`,
  );
  console.log(`  migrations  ${migrations.length} on disk`);
  console.log(`  applied     ${status.applied.length}`);
  console.log(`  pending     ${status.pending.length}`);
  console.log('-'.repeat(60));

  for (const record of status.applied) {
    console.log(`  [applied] ${record.version}  ${new Date(record.appliedAt).toISOString()}`);
  }
  for (const file of status.pending) {
    console.log(`  [pending] ${file.version}`);
  }

  if (status.drift.length > 0) {
    console.log('-'.repeat(60));
    for (const drift of status.drift) {
      console.error(`  [DRIFT]   ${drift.version} has been edited since it was applied`);
    }
    console.error('\n  Migrations are immutable once applied. Add a new migration instead.\n');
    process.exit(1);
  }

  if (statusOnly) {
    console.log('');
    process.exit(0);
  }

  if (status.pending.length === 0) {
    console.log('\n  Nothing to apply.\n');
    process.exit(0);
  }

  // Imported lazily so `--status` cannot apply anything by accident.
  const { runMigrations } = await import('@binaryai/database');
  const result = await runMigrations(database, migrations);

  console.log('-'.repeat(60));
  for (const version of result.applied) console.log(`  [ok]      applied ${version}`);
  console.log(`\n  ${result.applied.length} migration(s) applied.\n`);
} catch (error) {
  console.error('\nMigration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
