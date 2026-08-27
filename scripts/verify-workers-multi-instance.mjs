#!/usr/bin/env node
/**
 * Do two runtime processes corrupt anything, or merely duplicate work?
 *
 * ADR-0015 argues that BinaryAI is safe to run as several instances because
 * every write the workers end in is protected by a database constraint — so a
 * race has one winner and the loser's error is discarded. That argument has
 * been verified as CONSTRAINTS under concurrency (tests/db/postgres-only), but
 * never as WORKERS: no two competing runtime processes had ever been observed.
 *
 * This closes that gap. It starts a real PostgreSQL 16 server, seeds work that
 * both instances will race to perform, starts two API processes with the
 * settlement and maintenance workers enabled on a short interval, lets them
 * tick, and then inspects the DATABASE — not the logs, not the exit codes.
 *
 * The distinction being tested:
 *
 *   CORRECTNESS      exactly one outcome per signal, exactly one release per
 *                    position, expired sessions removed. Must hold.
 *   DUPLICATED WORK  both instances scanning, both attempting, one losing.
 *                    Expected, wasteful, harmless.
 *
 * A failure here would mean ADR-0015 is wrong and leader election is required
 * for correctness rather than efficiency.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 infrastructure missing.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { startPostgres16 } from './postgres16.mjs';

const PORT_A = 4111;
const PORT_B = 4112;
const TICK_MS = 1000;
/**
 * Long enough for both instances to collide repeatedly on settlement AND for
 * at least one maintenance sweep to fire.
 *
 * MAINTENANCE_INTERVAL_MS is floored at 60s by configuration -- deliberately,
 * since retention gains nothing from sweeping more often -- so a shorter
 * observation would report "expired rows remain" and prove nothing about the
 * sweep racing.
 */
const OBSERVE_MS = 70_000;

const checks = [];
let failures = 0;

function check(name, passed, detail = '') {
  checks.push({ name, passed });
  if (!passed) failures += 1;
  process.stdout.write(`${passed ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n--- ${title}\n`);
}

const children = [];

async function stopAll() {
  for (const child of children) if (!child.killed) child.kill();
  await sleep(400);
}

async function waitForApi(port, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

// ------------------------------------------------------------------ setup --

section('Starting PostgreSQL 16');
let postgres;
try {
  postgres = await startPostgres16({ dataDir: '.tmp/pg16workers', port: 55441 });
} catch (error) {
  console.error(`Could not start PostgreSQL 16: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
process.stdout.write(`  PostgreSQL ${postgres.version} on ${postgres.port}\n`);

section('Applying migrations');
await new Promise((resolve, reject) => {
  const migrate = spawn(process.execPath, ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: postgres.url },
    stdio: 'ignore',
  });
  migrate.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
});
process.stdout.write('  applied from zero\n');

const { createPostgresDatabase } = await import('@binaryai/database');
const db = createPostgresDatabase({
  url: postgres.url,
  maxConnections: 4,
  applicationName: 'binaryai-worker-verify',
});

/**
 * Seeds work that BOTH instances will find and try to perform.
 *
 * The shapes matter: a signal past expiry with a finalized candle covering it
 * is settleable, and an expired session row is sweepable. Anything less and
 * the workers would find nothing and the test would pass vacuously.
 */
section('Seeding contested work');

const minute = 60_000;
const now = Date.now();
/**
 * Everything is aligned to an exact minute boundary.
 *
 * The settlement worker finds its bar by FLOORING the expiry to the timeframe
 * and asking for exactly that `opened_at`. Candles seeded at `now - k*60s` are
 * offset by however many seconds past the minute the run started, so the lookup
 * matches nothing and every position lands in `pending_settlement` — which is
 * the worker being correct about missing data, not a bug. Aligning the seed is
 * what makes the work genuinely settleable.
 */
const alignedNow = Math.floor(now / minute) * minute;
// Bars well in the past, so every candle involved is finalized rather than
// still forming — the settlement worker refuses to settle on a forming bar.
const decidedAt = alignedNow - 30 * minute;
const expiresAt = alignedNow - 20 * minute;

const asset = await db.query(
  `INSERT INTO market_assets (symbol, display_name, asset_class, price_precision, is_otc)
   VALUES ('SYNTH', 'SYNTH test instrument', 'unknown', 5, false)
   ON CONFLICT (symbol) DO UPDATE SET display_name = EXCLUDED.display_name
   RETURNING id`,
);
const assetId = asset.rows[0].id;

// One candle per minute across the window, so the settling bar exists and is
// finalized. Prices rise, so a `call` settles as a win — the direction is not
// the point, having a determinate answer is.
for (let i = 0; i <= 35; i += 1) {
  const at = new Date(alignedNow - (35 - i) * minute).toISOString();
  const price = 100 + i;
  await db.query(
    `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close, volume, source, complete)
     VALUES ($1, '1m', $2, $3, $4, $5, $6, 10, 'synthetic', true)
     ON CONFLICT (asset_id, timeframe, opened_at) DO NOTHING`,
    [assetId, at, price, price + 1, price - 1, price],
  );
}

const SIGNALS = 5;
const signalIds = [];
for (let i = 0; i < SIGNALS; i += 1) {
  const row = await db.query(
    `INSERT INTO signals
       (signal_key, asset_symbol, timeframe, direction, status, recommendation,
        confidence, price, decided_at, expires_at, expiration_seconds, data_source)
     VALUES ($1, 'SYNTH', '1m', 'call', 'accepted', 'consider',
             0.6, 100, $2, $3, 600, 'synthetic')
     RETURNING id`,
    [`multi-${i}-${now}`, new Date(decidedAt).toISOString(), new Date(expiresAt).toISOString()],
  );
  signalIds.push(row.rows[0].id);
}

const user = await db.query(
  `INSERT INTO users (email, password_hash) VALUES ($1, 'argon2id$placeholder') RETURNING id`,
  [`workers-${now}@test.local`],
);
const account = await db.query(
  `INSERT INTO accounts (user_id, balance, day_start_balance) VALUES ($1, 1000, 1000) RETURNING id`,
  [user.rows[0].id],
);
const accountId = account.rows[0].id;

const positionIds = [];
for (const [index, signalId] of signalIds.entries()) {
  const row = await db.query(
    `INSERT INTO paper_positions
       (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
        size, entry_price, opened_at, expires_at, status, policy_version)
     VALUES ($1, $2, $3, 'SYNTH', '1m', 'call', 5, 100, $4, $5, 'open', 1)
     RETURNING id`,
    [
      accountId,
      signalId,
      `multi-action-${index}`,
      new Date(decidedAt).toISOString(),
      new Date(expiresAt).toISOString(),
    ],
  );
  positionIds.push(row.rows[0].id);
  await db.query(
    `INSERT INTO paper_ledger_entries (account_id, type, amount, position_id, source)
     VALUES ($1, 'exposure_committed', -5, $2, 'seed')`,
    [accountId, row.rows[0].id],
  );
}

// Expired sessions for the maintenance worker to race over. `created_at` is
// backdated too: the schema requires expires_at > created_at.
const EXPIRED_SESSIONS = 6;
for (let i = 0; i < EXPIRED_SESSIONS; i += 1) {
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, now() - interval '2 hours', now() - interval '1 hour')`,
    [user.rows[0].id, `expired-hash-${i}-${now}`],
  );
}
// One live session, which must survive: a sweep that signs people out is the
// failure this whole worker was written to avoid.
await db.query(
  `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
   VALUES ($1, $2, now(), now() + interval '2 hours')`,
  [user.rows[0].id, `live-hash-${now}`],
);

process.stdout.write(
  `  ${SIGNALS} expired signals, ${SIGNALS} open positions, ${EXPIRED_SESSIONS} expired sessions, 1 live session\n`,
);

// -------------------------------------------------------------- instances --

const workerEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'error',
  API_HOST: '127.0.0.1',
  API_CORS_ORIGINS: 'http://localhost:3000',
  AUTH_ENABLED: 'false',
  DATABASE_URL: postgres.url,
  DATABASE_MAX_CONNECTIONS: '5',
  // Both workers on, both ticking fast, so the two instances genuinely overlap.
  SETTLEMENT_WORKER_ENABLED: 'true',
  SETTLEMENT_INTERVAL_MS: String(TICK_MS),
  MAINTENANCE_WORKER_ENABLED: 'true',
  MAINTENANCE_INTERVAL_MS: '60000',
  LIVE_ANALYSIS_ENABLED: 'false',
  MARKET_DATA_WORKER_ENABLED: 'false',
};

section('Starting two runtime instances on one database');
for (const [label, port] of [
  ['A', PORT_A],
  ['B', PORT_B],
]) {
  const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
    env: { ...workerEnv, API_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  children.push(child);
  void label;
}

if (!(await waitForApi(PORT_A)) || !(await waitForApi(PORT_B))) {
  console.error('An instance did not come up.');
  await stopAll();
  await db.close();
  await postgres.stop();
  process.exit(2);
}
process.stdout.write(`  instance A on ${PORT_A}, instance B on ${PORT_B}\n`);

process.stdout.write(`  observing for ${OBSERVE_MS / 1000}s while both settle...\n`);
await sleep(OBSERVE_MS);

// ---------------------------------------------------------------- verdict --

try {
  section('CORRECTNESS — the database is the witness');

  const outcomes = await db.query(
    `SELECT signal_id, count(*)::int AS n FROM signal_outcomes GROUP BY signal_id`,
  );
  const settledSignals = outcomes.rows.length;
  const duplicatedOutcomes = outcomes.rows.filter((r) => r.n > 1);
  check(
    'work was actually performed (otherwise this test proves nothing)',
    settledSignals > 0,
    `${settledSignals}/${SIGNALS} signals settled`,
  );
  check(
    'no signal received two outcomes',
    duplicatedOutcomes.length === 0,
    `${duplicatedOutcomes.length} duplicated`,
  );

  const releases = await db.query(
    `SELECT position_id, count(*)::int AS n FROM paper_ledger_entries
      WHERE type = 'exposure_released' GROUP BY position_id`,
  );
  check(
    'no position was released twice',
    releases.rows.every((r) => r.n === 1),
    `${releases.rows.length} position(s) released`,
  );

  // The ledger is the account's money. Committed -5 and released +5 per
  // settled position must net to zero; a duplicate release would show +5.
  const net = await db.query(
    `SELECT coalesce(sum(amount), 0)::float AS total FROM paper_ledger_entries
      WHERE account_id = $1 AND position_id IN (
        SELECT position_id FROM paper_ledger_entries WHERE type = 'exposure_released'
      )`,
    [accountId],
  );
  check(
    'the derived balance is not inflated by duplicate work',
    Math.abs(Number(net.rows[0].total)) < 1e-9,
    `net ${net.rows[0].total} across settled positions`,
  );

  const positions = await db.query(
    `SELECT status, count(*)::int AS n FROM paper_positions
      WHERE account_id = $1 GROUP BY status`,
    [accountId],
  );
  check(
    'settled positions carry a coherent status',
    positions.rows.every((r) => ['settled', 'open', 'pending_settlement'].includes(r.status)),
    positions.rows.map((r) => `${r.status}=${r.n}`).join(' '),
  );

  section('CORRECTNESS — maintenance');
  const sessions = await db.query(
    `SELECT count(*) FILTER (WHERE expires_at <= now())::int AS expired,
            count(*) FILTER (WHERE expires_at > now())::int AS live
       FROM sessions`,
  );
  check(
    'the live session survived both instances sweeping',
    sessions.rows[0].live === 1,
    `${sessions.rows[0].live} live session(s) remain`,
  );
  check(
    'every expired session row was swept, exactly once, by two racing sweepers',
    sessions.rows[0].expired === 0,
    `${sessions.rows[0].expired} expired row(s) remain of ${EXPIRED_SESSIONS}`,
  );

  section('DUPLICATED WORK — expected, and harmless');
  const statusA = await (await fetch(`http://127.0.0.1:${PORT_A}/v1/runtime/status`)).json();
  const statusB = await (await fetch(`http://127.0.0.1:${PORT_B}/v1/runtime/status`)).json();
  const ticksA = statusA?.runtime?.settlement?.ticks ?? 0;
  const ticksB = statusB?.runtime?.settlement?.ticks ?? 0;
  check(
    'both instances really did run settlement cycles',
    ticksA > 0 && ticksB > 0,
    `A ticked ${ticksA}, B ticked ${ticksB} — both scanned the same work`,
  );
  check(
    'neither instance recorded a worker failure',
    (statusA?.runtime?.settlement?.failures ?? 0) === 0 &&
      (statusB?.runtime?.settlement?.failures ?? 0) === 0,
    `A ${statusA?.runtime?.settlement?.failures ?? '?'} / B ${statusB?.runtime?.settlement?.failures ?? '?'} failures`,
  );
} finally {
  await stopAll();
  await db.close();
  await postgres.stop();
}

process.stdout.write(`\n${checks.length - failures}/${checks.length} checks passed\n`);
process.stdout.write(
  failures === 0
    ? 'Two instances duplicate work and corrupt nothing. ADR-0015 holds.\n'
    : 'A correctness check failed: ADR-0015 needs revisiting.\n',
);
process.exit(failures === 0 ? 0 : 1);
