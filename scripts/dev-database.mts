import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/**
 * A throwaway PostgreSQL endpoint for local development and end-to-end checks.
 *
 * PGlite is real PostgreSQL compiled to WebAssembly; this exposes it over a TCP
 * socket so anything speaking the PostgreSQL wire protocol -- including the API's
 * `pg` pool -- can connect with an ordinary postgres:// URL.
 *
 * It is NOT a substitute for a PostgreSQL server. It is single-connection, so it
 * cannot demonstrate pooling, concurrency or isolation between clients, and it
 * holds everything in memory unless a data directory is given. Use it to exercise
 * a flow end-to-end on a machine with no server installed; use the real thing for
 * anything that claims to be verified. See docs/adr/0007-test-database.md.
 *
 *   npx tsx scripts/dev-database.mts [--port 5433] [--dir .tmp/pgdata]
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(flag('port') ?? 5433);
const dataDir = flag('dir');

const db = await PGlite.create(dataDir ? { dataDir } : {});
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

console.log(`PGlite listening on postgres://postgres@127.0.0.1:${port}/postgres`);
console.log(dataDir ? `Persisting to ${dataDir}` : 'In memory: everything is lost on exit.');
console.log('This is a development convenience, not a PostgreSQL server.');

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
