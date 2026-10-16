import type { LedgerEntry, LedgerRepository, NewLedgerEntry } from '@binaryai/types';
import { RecordNotFoundError, type Row, type SqlExecutor } from '../executor.js';
import {
  fromJson,
  toEpochMs,
  toJsonParam,
  toNumber,
  toNullableText,
  toText,
  toTimestamp,
} from '../mappers.js';

/**
 * The paper exposure ledger.
 *
 * Append-only, and enforced as such by a database trigger rather than by
 * convention -- an UPDATE or DELETE here is refused outright, so an audit trail
 * cannot be quietly rewritten by application code or by hand.
 *
 * The balance is DERIVED by summing entries, never stored. A stored balance can
 * drift from the entries that produced it, and when it does there is no way to
 * tell which one is wrong.
 *
 * There is deliberately no 'win' or 'loss' entry type. Releasing exposure is a
 * fact -- committing 5 units returns 5 units, whatever happened -- and a
 * directional outcome moves nothing on its own. Any change in simulated value
 * is a SEPARATE 'simulated_return' entry that names the versioned model which
 * computed it, so a reader can always recover what occurred from what was
 * assumed. A simulated entry without that attribution is refused by the
 * database, not merely discouraged here.
 */

interface LedgerRow extends Row {
  id: string;
  account_id: string;
  type: string;
  amount: string | number;
  position_id: string | null;
  occurred_at: Date;
  source: string;
  metadata: unknown;
  simulation_model_id: string | null;
  simulation_model_version: string | null;
}

const LEDGER_COLUMNS = `id, account_id, type, amount, position_id, occurred_at, source,
                        metadata, simulation_model_id, simulation_model_version`;

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: toText(row.id, 'ledger.id'),
    accountId: toText(row.account_id, 'ledger.account_id'),
    type: toText(row.type, 'ledger.type') as LedgerEntry['type'],
    amount: toNumber(row.amount, 'ledger.amount'),
    positionId: toNullableText(row.position_id),
    occurredAt: toEpochMs(row.occurred_at, 'ledger.occurred_at'),
    source: toText(row.source, 'ledger.source'),
    metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
    simulationModelId: toNullableText(row.simulation_model_id),
    simulationModelVersion: toNullableText(row.simulation_model_version),
  };
}

export function createLedgerRepository(executor: SqlExecutor): LedgerRepository {
  return {
    async append(entry: NewLedgerEntry): Promise<LedgerEntry> {
      const result = await executor.query<LedgerRow>(
        `INSERT INTO paper_ledger_entries
           (account_id, type, amount, position_id, occurred_at, source, metadata,
            simulation_model_id, simulation_model_version)
         VALUES ($1, $2::ledger_entry_type, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING ${LEDGER_COLUMNS}`,
        [
          entry.accountId,
          entry.type,
          entry.amount,
          entry.positionId ?? null,
          toTimestamp(entry.occurredAt ?? Date.now()),
          entry.source,
          toJsonParam(entry.metadata ?? {}),
          entry.simulationModelId ?? null,
          entry.simulationModelVersion ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('paper_ledger_entry', entry.accountId);
      return toLedgerEntry(row);
    },

    async list(
      accountId: string,
      limit = 50,
      offset = 0,
      assetSymbol?: string,
    ): Promise<readonly LedgerEntry[]> {
      /*
       * R10 — instrument scope reaches the ledger THROUGH THE POSITION.
       *
       * A ledger entry has no symbol of its own, and giving it one would
       * duplicate a fact that already lives on the position it accounts for —
       * two places to disagree. The EXISTS below is therefore the identity
       * relationship, not a text match.
       *
       * A consequence worth stating: allocations, adjustments and resets carry
       * no `position_id`, so an instrument-scoped query correctly excludes
       * them. They are account-wide facts and belong to no instrument.
       */
      const params: unknown[] = [accountId];
      const conditions = ['l.account_id = $1'];

      if (assetSymbol !== undefined) {
        params.push(assetSymbol);
        conditions.push(
          `EXISTS (SELECT 1 FROM paper_positions p
                    WHERE p.id = l.position_id AND p.asset_symbol = $${params.length})`,
        );
      }

      params.push(limit);
      const limitClause = `LIMIT $${params.length}`;
      params.push(offset);

      const result = await executor.query<LedgerRow>(
        `SELECT ${LEDGER_COLUMNS}
         FROM paper_ledger_entries l
         WHERE ${conditions.join(' AND ')}
         ORDER BY l.occurred_at DESC, l.id
         ${limitClause} OFFSET $${params.length}`,
        params,
      );
      return result.rows.map(toLedgerEntry);
    },

    async balance(accountId: string): Promise<number> {
      // Derived, never stored. A stored balance can drift from its entries;
      // a summed one cannot, and it can always be explained line by line.
      const result = await executor.query<{ total: string | null }>(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM paper_ledger_entries WHERE account_id = $1',
        [accountId],
      );
      return Number(result.rows[0]?.total ?? 0);
    },

    async committed(accountId: string): Promise<number> {
      // Commits are negative and releases positive, so an unreleased commit
      // leaves a negative sum. Returned as a positive magnitude.
      const result = await executor.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM paper_ledger_entries
         WHERE account_id = $1 AND type IN ('exposure_committed', 'exposure_released')`,
        [accountId],
      );
      return Math.abs(Number(result.rows[0]?.total ?? 0));
    },

    /**
     * Net simulated units for an account, in occurrence order.
     *
     * Only 'simulated_return' entries. Allocation and exposure are excluded
     * because they are facts about capacity, not the result of a model.
     *
     * The superseded 'simulated_payout' type is excluded too. Those entries
     * were produced by the client-supplied rate this phase replaced, and
     * summing them together with model-attributed entries would total two
     * different accounting regimes into one number that belongs to neither.
     * They remain readable through list().
     */
    async simulatedDeltas(accountId: string): Promise<readonly number[]> {
      const result = await executor.query<{ amount: string | number }>(
        `SELECT amount
         FROM paper_ledger_entries
         WHERE account_id = $1 AND type = 'simulated_return'
         ORDER BY occurred_at ASC, id ASC`,
        [accountId],
      );
      // Returned in a fixed order so floating-point association cannot make
      // the same history total differently on two reads.
      return result.rows.map((row) => toNumber(row.amount, 'ledger.amount'));
    },

    async simulationForPosition(positionId: string, accountId: string) {
      // Both ids are in the WHERE clause. Filtering by account after fetching
      // would leak existence through timing and through any future error path.
      const result = await executor.query<LedgerRow>(
        `SELECT ${LEDGER_COLUMNS}
         FROM paper_ledger_entries
         WHERE position_id = $1 AND account_id = $2 AND type = 'simulated_return'`,
        [positionId, accountId],
      );
      const row = result.rows[0];
      return row ? toLedgerEntry(row) : null;
    },

    async simulatedOutcomeCounts(accountId: string): Promise<{
      wins: number;
      losses: number;
      ties: number;
      positions: number;
    }> {
      // Counted from the POSITION's observed result, joined through the entry,
      // so a simulated tally can never disagree with what actually settled.
      const result = await executor.query<{
        wins: string;
        losses: string;
        ties: string;
        positions: string;
      }>(
        `SELECT COUNT(*) FILTER (WHERE p.result = 'win')  AS wins,
                COUNT(*) FILTER (WHERE p.result = 'loss') AS losses,
                COUNT(*) FILTER (WHERE p.result = 'tie')  AS ties,
                COUNT(*)                                  AS positions
         FROM paper_ledger_entries e
         JOIN paper_positions p ON p.id = e.position_id
         WHERE e.account_id = $1 AND e.type = 'simulated_return'`,
        [accountId],
      );
      const row = result.rows[0];
      return {
        wins: Number(row?.wins ?? 0),
        losses: Number(row?.losses ?? 0),
        ties: Number(row?.ties ?? 0),
        positions: Number(row?.positions ?? 0),
      };
    },
  };
}
