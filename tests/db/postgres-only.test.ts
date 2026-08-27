import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDatabase, type Database } from '@binaryai/database';
import { createTestDatabase, migrate, seedUserAndAccount, type TestDatabase } from './harness.js';

/**
 * Guarantees that only a real PostgreSQL SERVER can establish.
 *
 * Every other database test in this repository runs on PGlite by default, and
 * PGlite is real PostgreSQL — enums, CHECK constraints, foreign keys, NUMERIC,
 * TIMESTAMPTZ and triggers all behave as they do on a server. What it is not is
 * a server: it is one embedded engine with ONE connection. That single fact
 * makes an entire class of guarantee untestable there:
 *
 *   - row locking, because there is no second transaction to block
 *   - unique-constraint races, because there is no concurrency to race
 *   - connection pooling, because there is no pool
 *
 * Those are exactly the guarantees the application leans on hardest — paper
 * action idempotency and settlement-once are enforced by the DATABASE under
 * concurrency, not by application checks. Asserting them on PGlite would
 * produce a passing test that proves nothing about the property it names.
 *
 * So this file SKIPS without DATABASE_URL, and says so out loud rather than
 * silently reporting green. Set DATABASE_URL (see docs/local-development.md, or
 * `docker compose up -d`) to run it.
 */

const url = process.env['DATABASE_URL'];
const onServer = url ? describe : describe.skip;

describe('database test matrix', () => {
  it('states which engine these tests ran against', async () => {
    const test = await createTestDatabase();
    try {
      // Not an assertion about correctness — a record in the test output, so a
      // green run can never be mistaken for a green run on a server.
      // eslint-disable-next-line no-console
      console.log(
        `[db] engine=${test.engine} version=${test.version}` +
          (test.engine === 'pglite-embedded'
            ? ' — concurrency guarantees are SKIPPED. Set DATABASE_URL for the authoritative run.'
            : ''),
      );
      expect(test.engine === 'postgres-server' || test.engine === 'pglite-embedded').toBe(true);
    } finally {
      await test.close();
    }
  });

  it('records that the embedded engine is a DIFFERENT major version from the target', async () => {
    // Worth stating plainly, because it cuts the opposite way from how PGlite
    // is usually described. PGlite 0.5 embeds PostgreSQL 18; production targets
    // 16. So the local suite runs on an engine NEWER than the one deployed, and
    // the direction of that gap is the dangerous one: syntax or behaviour added
    // after 16 passes locally and fails on the server. A green local run is
    // therefore not evidence of 16 compatibility even for single-connection
    // behaviour — only the CI job against postgres:16 is.
    //
    // This test asserts nothing about which version is correct. It exists so
    // the gap is recorded in the output of every run rather than living in a
    // document nobody reads during an incident.
    const test = await createTestDatabase();
    try {
      const result = await test.database.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      const major = Number((result.rows[0]?.version ?? '0').split('.')[0]);
      if (test.engine === 'pglite-embedded' && major !== 16) {
        // eslint-disable-next-line no-console
        console.log(
          `[db] WARNING: embedded engine is PostgreSQL ${major}; production targets 16. ` +
            'Local green does not imply 16 compatibility.',
        );
      }
      expect(Number.isFinite(major)).toBe(true);
    } finally {
      await test.close();
    }
  });
});

onServer('PostgreSQL server — version', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
  });
  afterAll(async () => {
    await test.close();
  });

  it('is PostgreSQL 16, the version this project targets', async () => {
    // A run against 14 or 17 is still useful, but it is not the claim CI makes.
    // Naming the version here means the claim is checked rather than assumed.
    const result = await test.database.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    const major = Number((result.rows[0]?.version ?? '0').split('.')[0]);

    // eslint-disable-next-line no-console
    console.log(`[db] server_version=${result.rows[0]?.version}`);
    expect(major).toBe(16);
  });

  it('reports a server banner, not an embedded one', async () => {
    expect(test.version).toMatch(/PostgreSQL/);
  });
});

onServer('PostgreSQL server — concurrency', () => {
  let test: TestDatabase;
  /** A genuinely separate client, so two transactions can overlap. */
  let second: Database;
  let accountId: string;

  beforeAll(async () => {
    test = await createTestDatabase();
    await migrate(test.database);
    second = createPostgresDatabase({
      url: url as string,
      maxConnections: 2,
      applicationName: 'binaryai-tests-2',
    });
    ({ accountId } = await seedUserAndAccount(test.database));
  });

  afterAll(async () => {
    await second.close();
    await test.close();
  });

  it('makes SELECT FOR UPDATE block a second transaction until the first commits', async () => {
    // The property the settlement worker depends on: a row it has claimed
    // cannot be claimed by another worker mid-cycle. Untestable on one
    // connection, because there is no second transaction to be blocked.
    const order: string[] = [];

    const holder = test.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      order.push('first-locked');
      await new Promise((resolve) => setTimeout(resolve, 250));
      order.push('first-commits');
    });

    // Started after the lock is taken, so it must wait.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiter = second.transaction(async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      order.push('second-acquired');
    });

    await Promise.all([holder, waiter]);

    expect(order).toEqual(['first-locked', 'first-commits', 'second-acquired']);
  });

  it('lets exactly one of two concurrent duplicate paper actions commit', async () => {
    // Idempotency is enforced by a unique index rather than a check-then-insert,
    // precisely so this race has one winner. Only a real server can run the
    // race at all.
    const signalId = await seedSignal(test.database);
    const insert = (database: Database) =>
      database
        .query(
          `INSERT INTO paper_positions
             (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
              size, entry_price, opened_at, expires_at, status, policy_version)
           VALUES ($1, $2, 'race-key', 'SYNTH', '1m', 'call', 5, 100,
                   now(), now() + interval '1 minute', 'open', 1)`,
          [accountId, signalId],
        )
        .then(
          () => 'committed' as const,
          () => 'refused' as const,
        );

    const outcomes = await Promise.all([insert(test.database), insert(second)]);

    expect(outcomes.filter((outcome) => outcome === 'committed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(1);

    // The response codes are not the guarantee — the stored state is. A test
    // that only counted outcomes would still pass if both inserts had somehow
    // landed and one connection merely reported an error afterwards.
    const stored = await test.database.query<{ n: string }>(
      `SELECT count(*) AS n FROM paper_positions
        WHERE account_id = $1 AND signal_id = $2 AND action_key = 'race-key'`,
      [accountId, signalId],
    );
    expect(Number(stored.rows[0]?.n)).toBe(1);
  });

  it('survives a wider race: eight concurrent retries still yield one position', async () => {
    // Two connections prove the index is consulted. Eight prove it holds under
    // the shape a retry storm actually takes — a client retrying an action key
    // several times while an earlier attempt is still in flight.
    const signalId = await seedSignal(test.database);
    const attempt = (database: Database) =>
      database
        .query(
          `INSERT INTO paper_positions
             (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
              size, entry_price, opened_at, expires_at, status, policy_version)
           VALUES ($1, $2, 'storm-key', 'SYNTH', '1m', 'call', 5, 100,
                   now(), now() + interval '1 minute', 'open', 1)`,
          [accountId, signalId],
        )
        .then(
          () => 'committed' as const,
          () => 'refused' as const,
        );

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        attempt(index % 2 === 0 ? test.database : second),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'committed')).toHaveLength(1);
    const stored = await test.database.query<{ n: string }>(
      `SELECT count(*) AS n FROM paper_positions
        WHERE account_id = $1 AND action_key = 'storm-key'`,
      [accountId],
    );
    expect(Number(stored.rows[0]?.n)).toBe(1);
  });

  it('does not block two DIFFERENT concurrent actions on the same account', async () => {
    // The mirror of the test above, and the reason it matters: a uniqueness
    // rule that accidentally serialised or rejected unrelated actions would
    // look "safe" while quietly losing legitimate ones.
    const signalId = await seedSignal(test.database);
    const insert = (database: Database, key: string) =>
      database
        .query(
          `INSERT INTO paper_positions
             (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
              size, entry_price, opened_at, expires_at, status, policy_version)
           VALUES ($1, $2, $3, 'SYNTH', '1m', 'call', 5, 100,
                   now(), now() + interval '1 minute', 'open', 1)`,
          [accountId, signalId, key],
        )
        .then(
          () => 'committed' as const,
          () => 'refused' as const,
        );

    const outcomes = await Promise.all([
      insert(test.database, 'distinct-a'),
      insert(second, 'distinct-b'),
    ]);

    expect(outcomes).toEqual(['committed', 'committed']);
    const stored = await test.database.query<{ n: string }>(
      `SELECT count(*) AS n FROM paper_positions
        WHERE account_id = $1 AND action_key IN ('distinct-a', 'distinct-b')`,
      [accountId],
    );
    expect(Number(stored.rows[0]?.n)).toBe(2);
  });

  it('lets exactly one of two concurrent settlement releases be recorded', async () => {
    // Settlement retries are expected; two of them crediting the same position
    // would inflate the account. The partial unique index is what prevents it,
    // and this is the only place that claim is actually exercised.
    const signalId = await seedSignal(test.database);
    const position = await test.database.query<{ id: string }>(
      `INSERT INTO paper_positions
         (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
          size, entry_price, opened_at, expires_at, status, policy_version)
       VALUES ($1, $2, 'settle-race', 'SYNTH', '1m', 'call', 5, 100,
               now(), now() + interval '1 minute', 'open', 1)
       RETURNING id`,
      [accountId, signalId],
    );
    const positionId = position.rows[0]?.id;

    const release = (database: Database) =>
      database
        .query(
          `INSERT INTO paper_ledger_entries (account_id, type, amount, position_id, source)
           VALUES ($1, 'exposure_released', 5, $2, 'test')`,
          [accountId, positionId],
        )
        .then(
          () => 'committed' as const,
          () => 'refused' as const,
        );

    const outcomes = await Promise.all([release(test.database), release(second)]);

    expect(outcomes.filter((outcome) => outcome === 'committed')).toHaveLength(1);
    const count = await test.database.query<{ n: string }>(
      `SELECT count(*) AS n FROM paper_ledger_entries
        WHERE position_id = $1 AND type = 'exposure_released'`,
      [positionId],
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('leaves the derived balance correct after a settlement race', async () => {
    // The point of settle-once is not that one INSERT failed — it is that the
    // account is not credited twice. The balance is DERIVED by summing entries,
    // so summing them is the only assertion that actually checks the money.
    const signalId = await seedSignal(test.database);
    const position = await test.database.query<{ id: string }>(
      `INSERT INTO paper_positions
         (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
          size, entry_price, opened_at, expires_at, status, policy_version)
       VALUES ($1, $2, 'balance-race', 'SYNTH', '1m', 'call', 5, 100,
               now(), now() + interval '1 minute', 'open', 1)
       RETURNING id`,
      [accountId, signalId],
    );
    const positionId = position.rows[0]?.id;

    await test.database.query(
      `INSERT INTO paper_ledger_entries (account_id, type, amount, position_id, source)
       VALUES ($1, 'exposure_committed', -5, $2, 'test')`,
      [accountId, positionId],
    );

    const release = (database: Database) =>
      database
        .query(
          `INSERT INTO paper_ledger_entries (account_id, type, amount, position_id, source)
           VALUES ($1, 'exposure_released', 5, $2, 'test')`,
          [accountId, positionId],
        )
        .catch(() => undefined);

    await Promise.all([release(test.database), release(second), release(test.database)]);

    const net = await test.database.query<{ total: string }>(
      `SELECT coalesce(sum(amount), 0) AS total FROM paper_ledger_entries
        WHERE position_id = $1`,
      [positionId],
    );
    // -5 committed + 5 released exactly once. A second release would show +5.
    expect(Number(net.rows[0]?.total)).toBe(0);
  });

  it('refuses concurrent mutation of a published simulation model', async () => {
    // Immutability is enforced by a trigger, and a trigger is per-statement —
    // so two connections attempting it at once must both be refused, not one.
    const model = await test.database.query<{ id: string }>(
      `SELECT id FROM simulation_models WHERE status = 'active' LIMIT 1`,
    );
    const modelId = model.rows[0]?.id;
    expect(modelId).toBeDefined();

    const mutate = (database: Database) =>
      database
        .query(
          `UPDATE simulation_models
              SET parameters = jsonb_set(parameters, '{simulatedReturnRate}', '4.0')
            WHERE id = $1`,
          [modelId],
        )
        .then(
          () => 'changed' as const,
          () => 'refused' as const,
        );

    const outcomes = await Promise.all([mutate(test.database), mutate(second)]);

    expect(outcomes).toEqual(['refused', 'refused']);
  });

  it('refuses to mutate a ledger entry from a second connection too', async () => {
    // The append-only trigger is not connection-scoped, but a rule that only
    // ever ran on one connection would be an untested assumption.
    const inserted = await test.database.query<{ id: string }>(
      `INSERT INTO paper_ledger_entries (account_id, type, amount, source)
       VALUES ($1, 'adjustment', 1, 'test') RETURNING id`,
      [accountId],
    );

    await expect(
      second.query('UPDATE paper_ledger_entries SET amount = 999 WHERE id = $1', [
        inserted.rows[0]?.id,
      ]),
    ).rejects.toThrow();
  });

  it('serves concurrent reads from a pool without deadlocking', async () => {
    // PGlite has no pool. This is the smoke test for the one the API actually
    // runs behind, exercised through the same Database interface.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => test.database.query<{ ok: number }>('SELECT 1 AS ok')),
    );
    expect(results.every((result) => result.rows[0]?.ok === 1)).toBe(true);
  });
});

/** A minimal signal row, enough to satisfy the paper_positions foreign key. */
async function seedSignal(database: Database): Promise<string> {
  const key = `race-${Math.random().toString(16).slice(2)}`;
  const result = await database.query<{ id: string }>(
    `INSERT INTO signals
       (signal_key, asset_symbol, timeframe, direction, status, recommendation,
        confidence, price, decided_at, expires_at, expiration_seconds)
     VALUES ($1, 'SYNTH', '1m', 'call', 'accepted', 'consider',
             0.5, 100, now(), now() + interval '1 minute', 60)
     RETURNING id`,
    [key],
  );
  return result.rows[0]?.id ?? '';
}
