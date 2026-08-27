import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';

/**
 * Exposure ledger and account isolation, against a real PostgreSQL engine.
 *
 * The ledger is append-only and the balance is derived from it, so these tests
 * assert what the database refuses as much as what it stores.
 */

let context: TestDatabase;
let repositories: Repositories;
let accountId = '';
let otherAccountId = '';
let signalId = '';

/**
 * Anchored to the real clock, not a fixed date.
 *
 * `open()` stamps `opened_at` with the DATABASE's now(), and the schema
 * requires `expires_at > opened_at`. A hard-coded past date would produce a
 * signal that is already expired, which the constraint correctly refuses --
 * so the fixture has to be genuinely in the future. Every assertion below is
 * relative to this value, so the tests stay deterministic.
 */
const NOW = Date.now();
const MINUTE = 60_000;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

afterAll(async () => {
  await context?.close();
});

async function makeAccount(email: string): Promise<string> {
  const user = await context.database.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  const account = await context.database.query<{ id: string }>(
    `INSERT INTO accounts (user_id, allocated_units) VALUES ($1, 100) RETURNING id`,
    [user.rows[0]?.id],
  );
  const id = account.rows[0]?.id ?? '';
  await context.database.query(
    `INSERT INTO paper_ledger_entries (account_id, type, amount, source)
     VALUES ($1, 'initial_allocation', 100, 'test')`,
    [id],
  );
  return id;
}

/** Inserts an accepted, directional, unexpired signal. */
async function makeSignal(expiresInMs = 5 * MINUTE): Promise<string> {
  const strategy = await context.database.query<{ id: string }>(
    `INSERT INTO strategies (strategy_key, version, name, description)
     VALUES ('trend-momentum', '1.0.0', 'T', 't')
     ON CONFLICT DO NOTHING RETURNING id`,
  );
  const strategyId =
    strategy.rows[0]?.id ??
    (
      await context.database.query<{ id: string }>(
        `SELECT id FROM strategies WHERE strategy_key = 'trend-momentum' LIMIT 1`,
      )
    ).rows[0]?.id;

  const result = await context.database.query<{ id: string }>(
    `INSERT INTO signals (asset_symbol, timeframe, strategy_id, direction, status, market_regime,
                          confidence, price, decided_at, expires_at, expiration_seconds, data_source)
     VALUES ('BTC-USD', '5m', $1, 'call', 'accepted', 'trend_up', 0.7, 100,
             to_timestamp($2::double precision / 1000),
             to_timestamp($3::double precision / 1000), 300, 'live_provider')
     RETURNING id`,
    [strategyId, NOW, NOW + expiresInMs],
  );
  return result.rows[0]?.id ?? '';
}

beforeEach(async () => {
  await truncateAll(context.database);
  await context.database.query('TRUNCATE TABLE paper_ledger_entries, paper_positions CASCADE');
  accountId = await makeAccount('a@test.local');
  otherAccountId = await makeAccount('b@test.local');
  signalId = await makeSignal();
});

const open = (over: { size?: number; actionKey?: string; account?: string } = {}) =>
  repositories.positions.open({
    accountId: over.account ?? accountId,
    signalId,
    size: over.size ?? 5,
    actionKey: over.actionKey ?? 'action-1',
    policyVersion: 1,
  });

describe('ledger integrity', () => {
  it('is append-only: UPDATE is refused by the database', async () => {
    const entry = await repositories.ledger.append({
      accountId,
      type: 'adjustment',
      amount: 1,
      source: 'test',
    });
    await expect(
      context.database.query('UPDATE paper_ledger_entries SET amount = 999 WHERE id = $1', [
        entry.id,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it('is append-only: DELETE is refused by the database', async () => {
    const entry = await repositories.ledger.append({
      accountId,
      type: 'adjustment',
      amount: 1,
      source: 'test',
    });
    await expect(
      context.database.query('DELETE FROM paper_ledger_entries WHERE id = $1', [entry.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('enforces sign discipline per entry type', async () => {
    const position = await open();
    // A commit that credited the account would silently inflate available units.
    await expect(
      repositories.ledger.append({
        accountId,
        type: 'exposure_committed',
        amount: 5,
        positionId: position.id,
        source: 't',
      }),
    ).rejects.toThrow();
  });

  it('requires a position reference on exposure entries', async () => {
    await expect(
      repositories.ledger.append({
        accountId,
        type: 'exposure_committed',
        amount: -5,
        source: 't',
      }),
    ).rejects.toThrow();
  });

  it('forbids a position reference on an allocation', async () => {
    const position = await open();
    await expect(
      repositories.ledger.append({
        accountId,
        type: 'initial_allocation',
        amount: 10,
        positionId: position.id,
        source: 't',
      }),
    ).rejects.toThrow();
  });

  it('derives the balance deterministically from its entries', async () => {
    await open({ size: 5, actionKey: 'k1' });
    await open({ size: 10, actionKey: 'k2' });

    // 100 allocated − 15 committed.
    expect(await repositories.ledger.balance(accountId)).toBe(85);
    expect(await repositories.ledger.committed(accountId)).toBe(15);
  });
});

describe('account isolation', () => {
  it('never returns another account’s position by id', async () => {
    const position = await open();

    // Reads as absent rather than forbidden, so the response cannot confirm
    // that the id exists.
    expect(await repositories.positions.findById(position.id, otherAccountId)).toBeNull();
    expect(await repositories.positions.findById(position.id, accountId)).not.toBeNull();
  });

  it('never lists another account’s positions', async () => {
    await open();
    expect(await repositories.positions.list(otherAccountId)).toEqual([]);
    expect((await repositories.positions.list(accountId)).length).toBe(1);
  });

  it('never leaks another account’s ledger', async () => {
    await open();
    expect(await repositories.ledger.list(otherAccountId)).toHaveLength(1); // its own allocation
    expect(await repositories.ledger.balance(otherAccountId)).toBe(100);
  });

  it('counts activity per account', async () => {
    await open();
    const mine = await repositories.positions.activity(accountId, NOW - 86_400_000, NOW + MINUTE);
    const theirs = await repositories.positions.activity(
      otherAccountId,
      NOW - 86_400_000,
      NOW + MINUTE,
    );

    expect(mine.openPositions).toBe(1);
    expect(theirs.openPositions).toBe(0);
    expect(theirs.exposureInWindow).toBe(0);
  });
});

describe('activity snapshot', () => {
  it('counts a loss streak from the newest settled positions', async () => {
    for (let i = 0; i < 3; i += 1) {
      const position = await open({ actionKey: `loss-${i}` });
      await repositories.positions.settle({
        positionId: position.id,
        settledAt: NOW + i * MINUTE,
        settlementPrice: 99,
        result: 'loss',
        dataOrigin: 'exchange',
      });
    }

    const activity = await repositories.positions.activity(
      accountId,
      NOW - 86_400_000,
      NOW + 999 * MINUTE,
    );
    expect(activity.consecutiveLosses).toBe(3);
    expect(activity.lastLossAt).toBe(NOW + 2 * MINUTE);
  });

  it('breaks the streak on a win', async () => {
    const loser = await open({ actionKey: 'l1' });
    await repositories.positions.settle({
      positionId: loser.id,
      settledAt: NOW,
      settlementPrice: 99,
      result: 'loss',
      dataOrigin: 'exchange',
    });
    const winner = await open({ actionKey: 'w1' });
    await repositories.positions.settle({
      positionId: winner.id,
      settledAt: NOW + MINUTE,
      settlementPrice: 101,
      result: 'win',
      dataOrigin: 'exchange',
    });

    const activity = await repositories.positions.activity(
      accountId,
      NOW - 86_400_000,
      NOW + 99 * MINUTE,
    );
    expect(activity.consecutiveLosses).toBe(0);
  });

  it('breaks the streak on a tie rather than extending it', async () => {
    const loser = await open({ actionKey: 'l1' });
    await repositories.positions.settle({
      positionId: loser.id,
      settledAt: NOW,
      settlementPrice: 99,
      result: 'loss',
      dataOrigin: 'exchange',
    });
    const tie = await open({ actionKey: 't1' });
    await repositories.positions.settle({
      positionId: tie.id,
      settledAt: NOW + MINUTE,
      settlementPrice: 100,
      result: 'tie',
      dataOrigin: 'exchange',
    });

    // A tie is not a loss. Extending the streak would trigger a halt the user
    // did not earn.
    const activity = await repositories.positions.activity(
      accountId,
      NOW - 86_400_000,
      NOW + 99 * MINUTE,
    );
    expect(activity.consecutiveLosses).toBe(0);
  });

  it('excludes cancelled positions from the exposure window', async () => {
    const position = await open({ size: 20 });
    await repositories.positions.cancel(position.id, accountId, NOW + MINUTE);

    const activity = await repositories.positions.activity(
      accountId,
      NOW - 86_400_000,
      NOW + 99 * MINUTE,
    );
    expect(activity.exposureInWindow).toBe(0);
  });
});
