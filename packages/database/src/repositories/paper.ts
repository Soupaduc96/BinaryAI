import type {
  AccountActivitySnapshot,
  AccountPaperPosition,
  AccountPaperPositionStatus,
  NewAccountPaperPosition,
  PaperPositionRepository,
  SimulationResult,
  PositionQuery,
  Repositories,
  SignalOutcome,
} from '@binaryai/types';
import { toTimeframe, toDirection, toOutcomeResult } from '../enums.js';
import { DatabaseError, RecordNotFoundError, type Row, type SqlExecutor } from '../executor.js';
import {
  toEpochMs,
  toNullableEpochMs,
  toNullableNumber,
  toNullableText,
  toNumber,
  toText,
  toTimestamp,
} from '../mappers.js';
import { createLedgerRepository } from './ledger.js';

/**
 * Paper positions and the exposure ledger.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **Opening a position and committing its exposure are one write.** A
 *     position without its ledger entry would make the derived balance wrong
 *     and the exposure limit unenforceable, so both happen in one transaction
 *     or neither does.
 *  2. **Idempotency is the database's job.** A duplicate action key violates a
 *     unique index. A check-then-insert would leave a window in which two
 *     concurrent requests both pass the check.
 *  3. **Every read is account-scoped.** There is no method that returns another
 *     account's positions or ledger, so a route cannot leak one by forgetting a
 *     filter.
 */

interface PositionRow extends Row {
  id: string;
  account_id: string;
  signal_id: string;
  signal_key: string | null;
  asset_symbol: string;
  timeframe: string;
  direction: string;
  size: string | number;
  entry_price: string | number;
  opened_at: Date;
  expires_at: Date;
  status: string;
  settled_at: Date | null;
  settlement_price: string | number | null;
  result: string | null;
  data_origin: string | null;
  action_key: string;
  policy_version: number | string;
  created_at: Date;
  updated_at: Date;
}

const POSITION_COLUMNS = `
  p.id, p.account_id, p.signal_id, s.signal_key, p.asset_symbol, p.timeframe, p.direction,
  p.size, p.entry_price, p.opened_at, p.expires_at, p.status, p.settled_at,
  p.settlement_price, p.result, p.data_origin, p.action_key, p.policy_version,
  p.created_at, p.updated_at
`;

function toStatus(value: string): AccountPaperPositionStatus {
  if (
    value === 'open' ||
    value === 'pending_settlement' ||
    value === 'settled' ||
    value === 'cancelled' ||
    value === 'rejected'
  ) {
    return value;
  }
  // The enum constrains this already; failing loudly beats casting an unknown
  // state into the type system and rendering it as something it is not.
  throw new DatabaseError(`Unknown paper position status "${value}"`);
}

function toPosition(row: PositionRow): AccountPaperPosition {
  const direction = toDirection(toText(row.direction, 'position.direction'));
  if (direction === 'none') {
    throw new DatabaseError(`Position ${row.id} has direction 'none', which the CHECK forbids.`);
  }
  return {
    id: toText(row.id, 'position.id'),
    accountId: toText(row.account_id, 'position.account_id'),
    signalId: toText(row.signal_id, 'position.signal_id'),
    signalKey: toNullableText(row.signal_key),
    assetSymbol: toText(row.asset_symbol, 'position.asset_symbol'),
    timeframe: toTimeframe(toText(row.timeframe, 'position.timeframe')),
    direction,
    size: toNumber(row.size, 'position.size'),
    entryPrice: toNumber(row.entry_price, 'position.entry_price'),
    openedAt: toEpochMs(row.opened_at, 'position.opened_at'),
    expiresAt: toEpochMs(row.expires_at, 'position.expires_at'),
    status: toStatus(toText(row.status, 'position.status')),
    settledAt: toNullableEpochMs(row.settled_at),
    settlementPrice: toNullableNumber(row.settlement_price),
    result: row.result === null ? null : toOutcomeResult(row.result),
    dataOrigin: toNullableText(row.data_origin) as AccountPaperPosition['dataOrigin'],
    actionKey: toText(row.action_key, 'position.action_key'),
    policyVersion: toNumber(row.policy_version, 'position.policy_version'),
    createdAt: toEpochMs(row.created_at, 'position.created_at'),
    updatedAt: toEpochMs(row.updated_at, 'position.updated_at'),
  };
}

type TransactionRunner = {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
} | null;

export function createPaperPositionRepository(
  executor: SqlExecutor,
  runner: TransactionRunner,
  buildRepositories: (tx: SqlExecutor) => Repositories,
): PaperPositionRepository {
  const ledger = createLedgerRepository(executor);

  async function readPosition(id: string): Promise<AccountPaperPosition> {
    const result = await executor.query<PositionRow>(
      `SELECT ${POSITION_COLUMNS}
       FROM paper_positions p JOIN signals s ON s.id = p.signal_id
       WHERE p.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new RecordNotFoundError('paper_position', id);
    return toPosition(row);
  }

  return {
    async open(position: NewAccountPaperPosition): Promise<AccountPaperPosition> {
      // Denormalizes asset/timeframe/direction/entry price from the signal in
      // SQL rather than trusting caller-supplied values: a position must
      // describe the analysis it was taken on, not what a request claimed.
      const inserted = await executor.query<{ id: string }>(
        `INSERT INTO paper_positions
           (account_id, signal_id, asset_symbol, timeframe, direction, size,
            entry_price, opened_at, expires_at, status, action_key, policy_version)
         SELECT $1, s.id, s.asset_symbol, s.timeframe, s.direction, $3,
                s.price, now(), s.expires_at, 'open', $4, $5
         FROM signals s
         WHERE s.id = $2
         RETURNING id`,
        [
          position.accountId,
          position.signalId,
          position.size,
          position.actionKey,
          position.policyVersion,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new RecordNotFoundError('signal', position.signalId);

      // Same transaction as the insert. A position whose exposure was never
      // committed would be invisible to the exposure limit.
      await ledger.append({
        accountId: position.accountId,
        type: 'exposure_committed',
        amount: -position.size,
        positionId: id,
        source: 'paper_position_open',
        metadata: { signalId: position.signalId, actionKey: position.actionKey },
      });

      return readPosition(id);
    },

    async findById(id: string, accountId: string): Promise<AccountPaperPosition | null> {
      // Account id is part of the predicate, not checked afterwards: another
      // account's position reads as absent rather than as forbidden, so the
      // response cannot confirm that the id exists.
      const result = await executor.query<PositionRow>(
        `SELECT ${POSITION_COLUMNS}
         FROM paper_positions p JOIN signals s ON s.id = p.signal_id
         WHERE p.id = $1 AND p.account_id = $2`,
        [id, accountId],
      );
      const row = result.rows[0];
      return row ? toPosition(row) : null;
    },

    async list(
      accountId: string,
      query: PositionQuery = {},
    ): Promise<readonly AccountPaperPosition[]> {
      const params: unknown[] = [accountId];
      const conditions = ['p.account_id = $1'];

      if (query.status !== undefined) {
        params.push(query.status);
        conditions.push(`p.status = $${params.length}::paper_position_status`);
      }
      if (query.signalId !== undefined) {
        params.push(query.signalId);
        conditions.push(`p.signal_id = $${params.length}`);
      }
      params.push(Math.min(query.limit ?? 50, 200));
      const limitClause = `LIMIT $${params.length}`;
      params.push(query.offset ?? 0);

      const result = await executor.query<PositionRow>(
        `SELECT ${POSITION_COLUMNS}
         FROM paper_positions p JOIN signals s ON s.id = p.signal_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY p.opened_at DESC
         ${limitClause} OFFSET $${params.length}`,
        params,
      );
      return result.rows.map(toPosition);
    },

    async count(accountId: string, status?: AccountPaperPositionStatus): Promise<number> {
      const params: unknown[] = [accountId];
      let condition = 'account_id = $1';
      if (status !== undefined) {
        params.push(status);
        condition += ` AND status = $${params.length}::paper_position_status`;
      }
      const result = await executor.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM paper_positions WHERE ${condition}`,
        params,
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async activity(
      accountId: string,
      windowFromMs: number,
      now: number,
    ): Promise<AccountActivitySnapshot> {
      const result = await executor.query<{
        open_count: string;
        settled_count: string;
        exposure: string | null;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('open', 'pending_settlement'))       AS open_count,
           COUNT(*) FILTER (WHERE status = 'settled')                             AS settled_count,
           COALESCE(SUM(size) FILTER (
             WHERE opened_at >= $2 AND opened_at <= $3
               AND status <> 'cancelled' AND status <> 'rejected'
           ), 0)                                                                  AS exposure
         FROM paper_positions
         WHERE account_id = $1`,
        [accountId, toTimestamp(windowFromMs), toTimestamp(now)],
      );
      const row = result.rows[0];

      // The loss streak is counted from the most recent settled positions,
      // newest first, stopping at the first non-loss. A tie or an unresolved
      // outcome BREAKS the streak rather than extending it: neither is a loss,
      // and treating them as one would trigger a halt the user did not earn.
      const recent = await executor.query<{ result: string; settled_at: Date }>(
        `SELECT result, settled_at
         FROM paper_positions
         WHERE account_id = $1 AND status = 'settled' AND result IS NOT NULL
         ORDER BY settled_at DESC
         LIMIT 50`,
        [accountId],
      );

      let consecutiveLosses = 0;
      let lastLossAt: number | null = null;
      for (const entry of recent.rows) {
        if (entry.result !== 'loss') break;
        consecutiveLosses += 1;
        if (lastLossAt === null) lastLossAt = new Date(entry.settled_at).getTime();
      }

      return {
        openPositions: Number(row?.open_count ?? 0),
        exposureInWindow: Math.abs(Number(row?.exposure ?? 0)),
        consecutiveLosses,
        lastLossAt,
        settledPositions: Number(row?.settled_count ?? 0),
      };
    },

    async findExpired(before: number, limit = 100): Promise<readonly AccountPaperPosition[]> {
      const result = await executor.query<PositionRow>(
        `SELECT ${POSITION_COLUMNS}
         FROM paper_positions p JOIN signals s ON s.id = p.signal_id
         WHERE p.expires_at <= $1 AND p.status IN ('open', 'pending_settlement')
         ORDER BY p.expires_at ASC
         LIMIT $2`,
        [toTimestamp(before), limit],
      );
      return result.rows.map(toPosition);
    },

    async settle(input: {
      positionId: string;
      settledAt: number;
      settlementPrice: number;
      result: SignalOutcome['result'];
      dataOrigin: string;
      simulation?: SimulationResult;
    }): Promise<AccountPaperPosition> {
      // The status predicate makes this idempotent under a retried worker
      // cycle: a position already settled matches nothing and updates nothing.
      const updated = await executor.query<{ account_id: string; size: string }>(
        `UPDATE paper_positions
            SET status = 'settled',
                settled_at = $2,
                settlement_price = $3,
                result = $4::trade_outcome,
                data_origin = $5,
                updated_at = now()
          WHERE id = $1 AND status IN ('open', 'pending_settlement')
          RETURNING account_id, size`,
        [
          input.positionId,
          toTimestamp(input.settledAt),
          input.settlementPrice,
          input.result,
          input.dataOrigin,
        ],
      );
      const row = updated.rows[0];
      if (!row) {
        // Already settled, or never existed. Return the current state rather
        // than throwing: a racing worker losing this race is not an error.
        return readPosition(input.positionId);
      }

      const simulation = input.simulation;
      // A model that RAN and computed zero (a refunded tie) writes no entry:
      // there is nothing to record and a zero row would clutter the audit
      // trail. The position's own `result` already carries that it tied.
      const simulationApplied = simulation?.applied === true && simulation.delta !== 0;

      // Releasing exposure is the counterpart of committing it, and is
      // UNCONDITIONAL: committing 5 units always returns 5 units, whatever the
      // outcome was. The unique index on (position_id, type) makes a second
      // release impossible even if this ran twice.
      await ledger.append({
        accountId: row.account_id,
        type: 'exposure_released',
        amount: Number(row.size),
        positionId: input.positionId,
        occurredAt: input.settledAt,
        source: 'paper_position_settle',
        metadata: {
          result: input.result,
          dataOrigin: input.dataOrigin,
          note: simulationApplied
            ? 'Exposure released. Any change in simulated value is the separate simulated_return entry.'
            : 'Exposure released. No simulation model applied, so no simulated value changed.',
        },
      });

      // The simulated result, when a model is in force. A SEPARATE entry,
      // deliberately: the exposure release is a fact and the simulated return
      // is arithmetic on a stated premise. Keeping them apart means a reader
      // can always recover what actually happened from what was assumed.
      //
      // The model id and version go in COLUMNS, not just metadata, because a
      // database CHECK requires them -- an unattributable simulated number
      // cannot be written even by a future code path that forgets to try.
      if (simulationApplied && simulation) {
        await ledger.append({
          accountId: row.account_id,
          type: 'simulated_return',
          amount: simulation.delta,
          positionId: input.positionId,
          occurredAt: input.settledAt,
          source: 'simulation_model',
          simulationModelId: simulation.modelId,
          simulationModelVersion: simulation.modelVersion,
          metadata: {
            result: input.result,
            modelKey: simulation.modelKey,
            // Stored verbatim so the entry stays interpretable even if the
            // catalogue row is somehow lost.
            disclosure: simulation.reason,
          },
        });
      }

      return readPosition(input.positionId);
    },

    async markPendingSettlement(positionId: string, at: number): Promise<void> {
      await executor.query(
        `UPDATE paper_positions
            SET status = 'pending_settlement', updated_at = $2
          WHERE id = $1 AND status = 'open'`,
        [positionId, toTimestamp(at)],
      );
    },

    async cancel(
      positionId: string,
      accountId: string,
      at: number,
    ): Promise<AccountPaperPosition | null> {
      // Only an open position may be cancelled. Cancelling one past expiry
      // would erase an outcome that has already happened.
      const updated = await executor.query<{ size: string }>(
        `UPDATE paper_positions
            SET status = 'cancelled', updated_at = $3
          WHERE id = $1 AND account_id = $2 AND status = 'open' AND expires_at > $3
          RETURNING size`,
        [positionId, accountId, toTimestamp(at)],
      );
      const row = updated.rows[0];
      if (!row) return null;

      await ledger.append({
        accountId,
        type: 'exposure_released',
        amount: Number(row.size),
        positionId,
        occurredAt: at,
        source: 'paper_position_cancel',
        metadata: { note: 'Exposure released on cancellation before expiry.' },
      });

      return readPosition(positionId);
    },

    async withAccountLock<T>(
      accountId: string,
      work: (tx: Repositories) => Promise<T>,
    ): Promise<T> {
      const run = async (tx: SqlExecutor): Promise<T> => {
        // SELECT ... FOR UPDATE on the account row. Two concurrent creations
        // for the same account serialize here, so the second one's count
        // includes the first one's position. Without this lock both would read
        // the same count and both would be permitted through a limit of one.
        const locked = await tx.query<{ id: string }>(
          'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
          [accountId],
        );
        if (!locked.rows[0]) throw new RecordNotFoundError('account', accountId);
        return work(buildRepositories(tx));
      };

      // Already inside a transaction: join it rather than opening a second
      // connection, which would deadlock against the lock we just took.
      return runner ? runner.transaction(run) : run(executor);
    },
  };
}
