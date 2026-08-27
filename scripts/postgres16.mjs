/**
 * Provisions a real PostgreSQL 16 server, with no container runtime.
 *
 * `embedded-postgres` ships the OFFICIAL PostgreSQL binaries for the platform
 * and runs `postgres.exe` (or `postgres`) as a separate process listening on
 * TCP. It is not an emulation and it is not PGlite: `SELECT version()` reports
 * "PostgreSQL 16.14", connections go over a socket, and the pool, row locking
 * and unique-constraint races all behave as they do in production.
 *
 * What it is NOT: the same *build* as `postgres:16-alpine`. This is the Windows
 * or macOS build of 16.x rather than the musl Linux one CI runs. That
 * difference is small — the same source, the same major version, the same
 * planner and the same constraint semantics — but it is a difference, and CI
 * remains the authoritative run. What this closes is the far larger gap of
 * having never run against PostgreSQL 16 at all.
 *
 * The cluster is created fresh and destroyed afterwards, so every run exercises
 * the migration-from-zero path rather than inheriting a schema.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** Away from 5432 so a developer's own PostgreSQL is never touched. */
export const DEFAULT_PORT = 55432;

const USER = 'binaryai';
const PASSWORD = 'binaryai';
const DATABASE = 'binaryai_verify';

/**
 * Starts a throwaway PostgreSQL 16 server and returns how to reach it.
 *
 * Throws if the binaries turn out not to be 16.x. That check is the entire
 * value of this module: a run against 15 or 17 that got REPORTED as a
 * PostgreSQL 16 verification would be worse than not running at all.
 */
export async function startPostgres16(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = path.resolve(options.dataDir ?? '.tmp/pg16data');

  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  // A leftover cluster from an interrupted run would silently skip the
  // migrate-from-zero path, so the directory is cleared rather than reused.
  await rm(dataDir, { recursive: true, force: true });

  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent: false,
    // The server logs to stderr; keep it out of the test output unless asked.
    onLog: options.verbose ? (message) => process.stderr.write(String(message)) : () => {},
  });

  await server.initialise();
  await server.start();
  await server.createDatabase(DATABASE);

  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`;

  const client = server.getPgClient();
  await client.connect();
  let version;
  try {
    const result = await client.query("SELECT current_setting('server_version') AS version");
    version = result.rows[0]?.version ?? 'unknown';
  } finally {
    await client.end();
  }

  const major = Number(String(version).split('.')[0]);
  if (major !== 16) {
    await server.stop().catch(() => {});
    throw new Error(
      `Embedded server reports PostgreSQL ${version}, not 16.x. ` +
        'Refusing to continue: this run would otherwise be reported as a PostgreSQL 16 ' +
        'verification when it is not one.',
    );
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { url, version, port, stop };
}
