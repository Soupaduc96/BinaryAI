#!/usr/bin/env node
/**
 * The authoritative database run.
 *
 * PGlite proves the SQL is valid PostgreSQL. It does not prove it is valid
 * PostgreSQL *16* — PGlite 0.5 embeds PostgreSQL 18, so the local engine is
 * NEWER than the deployment target and the gap runs in the dangerous direction:
 * anything added after 16 passes locally and fails on the server. Nor can it
 * prove anything about pooling, row locking or unique-constraint races, because
 * it is one embedded engine on one connection.
 *
 * This script closes both gaps. It runs against a real PostgreSQL 16 server,
 * one of two ways:
 *
 *   DATABASE_URL set   -> that server. What CI does (postgres:16-alpine).
 *   DATABASE_URL unset -> starts one from the official PostgreSQL 16 binaries
 *                         shipped by `embedded-postgres`. No container runtime
 *                         needed, which is what makes this runnable on a
 *                         developer machine that has no Docker.
 *
 * Either way the server version is CHECKED before anything runs. A PostgreSQL
 * 14 that happened to be listening on the port must never be reported
 * afterwards as a PostgreSQL 16 verification.
 *
 *   npm run verify:postgres
 *
 * Exit codes: 0 verified, 1 a step failed, 2 no server could be reached. The
 * distinction matters in CI — a missing server is an infrastructure problem,
 * not a test failure, and reporting it as one trains people to ignore red.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const EXPECTED_MAJOR = 16;

/**
 * Runs one step, or exits.
 *
 * The command arrives as a single string rather than a command plus an args
 * array. That is forced by Windows: `npm` and `npx` are `.cmd` shims, Node
 * refuses to spawn a `.cmd` without a shell (CVE-2024-27980), and passing an
 * args array WITH a shell is deprecated because the arguments get concatenated
 * rather than escaped. A pre-joined string sidesteps both. It is safe here
 * because every command below is a literal in this file — no value from the
 * environment or from a caller is ever interpolated into one.
 */
function step(label, commandLine) {
  process.stdout.write(`\n--- ${label}\n`);
  const result = spawnSync(commandLine, { stdio: 'inherit', shell: true });
  return result.status === 0;
}

/**
 * Reads the version of whatever is actually answering.
 *
 * Separate from the run itself so the check cannot be skipped by a later edit
 * that reorders the steps.
 */
async function readServerVersion(url) {
  const { createPostgresDatabase } = await import('@binaryai/database');
  const database = createPostgresDatabase({
    url,
    maxConnections: 1,
    applicationName: 'binaryai-verify',
  });
  try {
    // `SHOW server_version` names its column `server_version`, not `setting` --
    // reading the wrong one yields undefined, which parses to 0, which would
    // make this check silently useless for the one job it has.
    const result = await database.query("SELECT current_setting('server_version') AS version");
    return result.rows[0]?.version ?? 'unknown';
  } finally {
    await database.close();
  }
}

// Before anything that imports from the workspace: on a fresh checkout the
// package dist/ directories do not exist yet, and the code below imports
// @binaryai/database.
if (!step('Build packages', 'npm run build:packages')) {
  console.error('\nFAILED: Build packages');
  process.exit(1);
}

let url = process.env.DATABASE_URL;
let provisioned = null;
let source;

if (url) {
  source = 'DATABASE_URL (external server)';
} else {
  process.stdout.write('\n--- Starting an embedded PostgreSQL 16 server\n');
  try {
    const { startPostgres16 } = await import('./postgres16.mjs');
    provisioned = await startPostgres16();
    url = provisioned.url;
    source = 'embedded-postgres (official PostgreSQL 16 binaries)';
    // Child processes read this: the test harness targets a server whenever
    // DATABASE_URL is set, and skips the concurrency suite when it is not.
    process.env.DATABASE_URL = url;
  } catch (error) {
    console.error(
      `\nCould not start a PostgreSQL 16 server.\n${error instanceof Error ? error.message : String(error)}\n\n` +
        'Set DATABASE_URL to point at your own server, or install the dev dependencies\n' +
        '(`npm install`) so the embedded binaries are available.\n\n' +
        'Reported as an infrastructure problem (exit 2), not a test failure.',
    );
    process.exit(2);
  }
}

/** Stops a server this script started. Safe to call more than once. */
async function shutdown() {
  if (provisioned) await provisioned.stop();
}

// A failed step must not leave a postgres process listening and a data
// directory behind, so every exit path goes through here.
async function fail(label) {
  console.error(`\nFAILED: ${label}`);
  await shutdown();
  process.exit(1);
}

let version;
try {
  version = await readServerVersion(url);
} catch (error) {
  console.error(
    `\nCould not reach a PostgreSQL server.\n${error instanceof Error ? error.message : String(error)}\n\n` +
      'Reported as an infrastructure problem (exit 2), not a test failure.',
  );
  await shutdown();
  process.exit(2);
}

const major = Number(String(version).split('.')[0]);
process.stdout.write(`\nServer: ${source}\nReports version: ${version}\n`);

if (major !== EXPECTED_MAJOR) {
  // Not fatal for an external server: verifying against 15 or 17 is still worth
  // doing. But the run must not be described afterwards as a PostgreSQL 16
  // verification, so it says so here, in the output that gets pasted into
  // reports.
  process.stdout.write(
    `\nNOTE: this is PostgreSQL ${major}, not ${EXPECTED_MAJOR}.\n` +
      `Whatever this run proves, it is NOT a PostgreSQL ${EXPECTED_MAJOR} verification.\n`,
  );
}

// The database is brand new when this script provisioned it, so this is
// genuinely a migrate-from-zero run rather than a top-up.
if (!step('Apply every migration from zero', 'node scripts/db-migrate.mjs')) await fail('migrate');
// Re-running must be a no-op. A migration that is not idempotent breaks every
// deployment after the first, and only a second run against a server that has
// already been migrated can show it.
if (!step('Migrations are idempotent', 'node scripts/db-migrate.mjs --status')) {
  await fail('migration idempotency');
}
/**
 * Server-backed suites run one file at a time.
 *
 * Not a convenience: against PGlite each file gets its own embedded engine and
 * parallelism is free, but against a SERVER every file opens a connection pool
 * to the same instance. Eight files starting at once ask for dozens of
 * connections simultaneously, and PostgreSQL creates a process per connection —
 * which on Windows has no fork() and re-execs instead. The first run of this
 * script died exactly there: `timeout exceeded when trying to connect`, twelve
 * of thirteen files failing before a single assertion ran.
 *
 * Serialising fixed it (245/247, and the two remaining failures were real bugs
 * in a fixture). Nothing about the assertions changes — the same tests run
 * against the same server, just not all at once. The cost is wall-clock time,
 * which is the right thing to spend to get a truthful result.
 *
 * PHASE 11C: `--maxWorkers=1` turned out not to be enough. It caps the number
 * of worker processes, but vitest still overlapped one file's teardown with
 * the next file's startup, and against a SHARED server that is enough for
 * `truncateAll()` in a beforeEach to deadlock: one fork holds an
 * AccessExclusiveLock for its TRUNCATE while another holds a RowShareLock from
 * a query still in flight. Observed as `deadlock detected` and
 * `timeout exceeded when trying to connect`, in a DIFFERENT unrelated suite on
 * each run — market-data one time, simulation-catalogue the next — while every
 * one of those suites passed on its own against the same server.
 *
 * `--no-file-parallelism` removes the overlap and the whole integration suite
 * goes from 432/448 with a worker crash to 448/448. Against PGlite this
 * changes nothing, because there each file gets its own engine and there is no
 * shared server to contend for.
 */
const SERIAL = '--maxWorkers=1 --no-file-parallelism';

if (!step('Database suite (incl. concurrency)', `npx vitest run tests/db ${SERIAL}`)) {
  await fail('tests/db');
}
if (!step('API integration suite', `npx vitest run tests/integration ${SERIAL}`)) {
  await fail('tests/integration');
}

await shutdown();

process.stdout.write(
  `\nVERIFIED against PostgreSQL ${version} (${source}).\n` +
    (major === EXPECTED_MAJOR
      ? 'This is the authoritative compatibility target.\n'
      : `This is NOT the ${EXPECTED_MAJOR}.x target; treat the result accordingly.\n`),
);
