import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';

/**
 * Paper position lifecycle, against a real PostgreSQL engine.
 *
 * Opening, idempotency, settlement and state transitions -- and what the
 * DATABASE refuses in each case. Companion to paper-ledger.test.ts.
 *
 * ON CONCURRENCY: PGlite accepts ONE connection, so two genuinely simultaneous
 * transactions cannot be run here. What IS verified is the constraint that
 * makes the guarantee real -- the unique index -- and the sequential behaviour
 * of the lock. A true multi-connection race remains unverified locally and
 * would need the postgres:16 CI job. See ADR-0007.
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

describe('opening a position', () => {
  it('records the action and commits its exposure in one write', async () => {
    const position = await open();

    expect(position.status).toBe('open');
    expect(position.size).toBe(5);
    // Denormalized from the signal, not from the request: a position must
    // describe the analysis it was taken on.
    expect(position.assetSymbol).toBe('BTC-USD');
    expect(position.direction).toBe('call');
    expect(position.entryPrice).toBe(100);

    // The ledger entry is the other half of the same write.
    expect(await repositories.ledger.committed(accountId)).toBe(5);
    expect(await repositories.ledger.balance(accountId)).toBe(95);
  });

  it('carries no result while it is open', async () => {
    const position = await open();

    // The CHECK constraint enforces this. An open position displayed with a
    // result would read as a settled loss.
    expect(position.result).toBeNull();
    expect(position.settledAt).toBeNull();
    expect(position.settlementPrice).toBeNull();
  });

  it('refuses a non-positive size at the database level', async () => {
    await expect(open({ size: 0 })).rejects.toThrow();
    await expect(open({ size: -5 })).rejects.toThrow();
  });

  it('refuses a position whose signal does not exist', async () => {
    await expect(
      repositories.positions.open({
        accountId,
        signalId: '00000000-0000-0000-0000-000000000000',
        size: 5,
        actionKey: 'x-action-key',
        policyVersion: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('idempotency', () => {
  it('refuses a duplicate action key at the database level', async () => {
    await open({ actionKey: 'same-key' });

    // The unique index is the authority. A check-then-insert would leave a
    // window in which two concurrent requests both pass the check.
    await expect(open({ actionKey: 'same-key' })).rejects.toThrow(/duplicate|unique/i);
  });

  it('permits a different action key on the same signal', async () => {
    await open({ actionKey: 'key-one' });
    const second = await open({ actionKey: 'key-two' });
    expect(second.id).toBeTruthy();
  });

  it('scopes the key to the account, so two accounts may use the same one', async () => {
    await open({ actionKey: 'shared-key' });
    const other = await open({ actionKey: 'shared-key', account: otherAccountId });
    expect(other.accountId).toBe(otherAccountId);
  });

  it('leaves no orphan ledger entry when the insert is refused', async () => {
    await open({ actionKey: 'same-key' });
    await expect(open({ actionKey: 'same-key' })).rejects.toThrow();

    // One position, one commit. A duplicate that wrote a ledger entry before
    // failing would silently reduce available units.
    expect(await repositories.ledger.committed(accountId)).toBe(5);
  });
});

describe('settlement', () => {
  it('records the outcome and releases exactly what was committed', async () => {
    const position = await open({ size: 8 });
    const settled = await repositories.positions.settle({
      positionId: position.id,
      settledAt: NOW + 10 * MINUTE,
      settlementPrice: 101,
      result: 'win',
      dataOrigin: 'exchange',
    });

    expect(settled.status).toBe('settled');
    expect(settled.result).toBe('win');
    expect(settled.settlementPrice).toBe(101);

    // The release equals the commit. A win does not add units, because there
    // is no payout model from which a gain could be derived.
    expect(await repositories.ledger.committed(accountId)).toBe(0);
    expect(await repositories.ledger.balance(accountId)).toBe(100);
  });

  it('releases the same amount whether the outcome was a win or a loss', async () => {
    const winner = await open({ size: 5, actionKey: 'k1' });
    const loser = await open({ size: 5, actionKey: 'k2' });

    await repositories.positions.settle({
      positionId: winner.id,
      settledAt: NOW,
      settlementPrice: 101,
      result: 'win',
      dataOrigin: 'exchange',
    });
    await repositories.positions.settle({
      positionId: loser.id,
      settledAt: NOW,
      settlementPrice: 99,
      result: 'loss',
      dataOrigin: 'exchange',
    });

    // The defining property of exposure-only accounting.
    expect(await repositories.ledger.balance(accountId)).toBe(100);
  });

  it('is idempotent under a retried worker cycle', async () => {
    const position = await open();
    const first = await repositories.positions.settle({
      positionId: position.id,
      settledAt: NOW,
      settlementPrice: 101,
      result: 'win',
      dataOrigin: 'exchange',
    });
    const second = await repositories.positions.settle({
      positionId: position.id,
      settledAt: NOW,
      settlementPrice: 999,
      result: 'loss',
      dataOrigin: 'exchange',
    });

    // The second call must not overwrite the recorded outcome, nor release
    // exposure twice.
    expect(second.result).toBe('win');
    expect(second.settlementPrice).toBe(first.settlementPrice);
    expect(await repositories.ledger.balance(accountId)).toBe(100);
  });

  it('refuses a second release for the same position', async () => {
    const position = await open();
    await repositories.ledger.append({
      accountId,
      type: 'exposure_released',
      amount: 5,
      positionId: position.id,
      source: 't',
    });

    // The unique index on (position_id, type) is what makes the derived
    // balance safe under retries.
    await expect(
      repositories.ledger.append({
        accountId,
        type: 'exposure_released',
        amount: 5,
        positionId: position.id,
        source: 't',
      }),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('marks an expired position as pending settlement rather than settling it', async () => {
    const position = await open();
    await repositories.positions.markPendingSettlement(position.id, NOW + MINUTE);

    const reread = await repositories.positions.findById(position.id, accountId);
    // Pending is not a loss and not a result.
    expect(reread?.status).toBe('pending_settlement');
    expect(reread?.result).toBeNull();
  });
});

describe('state transitions', () => {
  it('refuses a settled row that lacks its settlement evidence', async () => {
    const position = await open();
    await expect(
      context.database.query(`UPDATE paper_positions SET status = 'settled' WHERE id = $1`, [
        position.id,
      ]),
    ).rejects.toThrow();
  });

  it('refuses a result on an unsettled position', async () => {
    const position = await open();
    await expect(
      context.database.query(`UPDATE paper_positions SET result = 'loss' WHERE id = $1`, [
        position.id,
      ]),
    ).rejects.toThrow();
  });

  it('cancels an open position and releases its exposure', async () => {
    const position = await open({ size: 7 });
    const cancelled = await repositories.positions.cancel(position.id, accountId, NOW + MINUTE);

    expect(cancelled?.status).toBe('cancelled');
    expect(await repositories.ledger.balance(accountId)).toBe(100);
  });

  it('refuses to cancel a position past expiry', async () => {
    const position = await open();
    // Cancelling after expiry would erase an outcome that already happened.
    const result = await repositories.positions.cancel(position.id, accountId, NOW + 10 * MINUTE);
    expect(result).toBeNull();
  });

  it('refuses to cancel another account’s position', async () => {
    const position = await open();
    expect(
      await repositories.positions.cancel(position.id, otherAccountId, NOW + MINUTE),
    ).toBeNull();
  });

  it('refuses to cancel an already-settled position', async () => {
    const position = await open();
    await repositories.positions.settle({
      positionId: position.id,
      settledAt: NOW,
      settlementPrice: 101,
      result: 'win',
      dataOrigin: 'exchange',
    });
    expect(await repositories.positions.cancel(position.id, accountId, NOW + MINUTE)).toBeNull();
  });
});

describe('concurrency', () => {
  it('serializes work under the account lock', async () => {
    // PGlite is single-connection, so this proves the lock path runs and
    // commits -- NOT that two simultaneous transactions are ordered. The real
    // guarantee under concurrency is the unique index, tested above; a genuine
    // multi-connection race needs the postgres:16 CI job.
    const result = await repositories.positions.withAccountLock(accountId, async (tx) => {
      const before = await tx.positions.count(accountId, 'open');
      await tx.positions.open({
        accountId,
        signalId,
        size: 5,
        actionKey: 'locked-action',
        policyVersion: 1,
      });
      const after = await tx.positions.count(accountId, 'open');
      return { before, after };
    });

    expect(result.before).toBe(0);
    expect(result.after).toBe(1);
    expect(await repositories.positions.count(accountId, 'open')).toBe(1);
  });

  it('rolls the whole action back when the work throws', async () => {
    await expect(
      repositories.positions.withAccountLock(accountId, async (tx) => {
        await tx.positions.open({
          accountId,
          signalId,
          size: 5,
          actionKey: 'doomed',
          policyVersion: 1,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Neither the position nor its ledger entry may survive.
    expect(await repositories.positions.count(accountId)).toBe(0);
    expect(await repositories.ledger.committed(accountId)).toBe(0);
  });

  it('refuses a lock on an account that does not exist', async () => {
    await expect(
      repositories.positions.withAccountLock('00000000-0000-0000-0000-000000000000', async () => 1),
    ).rejects.toThrow();
  });
});
