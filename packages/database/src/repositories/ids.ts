import { RecordNotFoundError, type SqlExecutor } from '../executor.js';

/**
 * Id resolution shared by the signal and outcome repositories.
 *
 * A signal has two identities: the UUID primary key the database assigns, and
 * the engine's own id (`sig_<uuid>` live, `sig_<hash>` in a backtest) stored in
 * `signal_key`. Callers hold whichever one the API handed them, so lookups
 * accept both. Lives in its own module to keep signals.ts and outcomes.ts from
 * importing each other.
 */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function resolveSignalRowId(executor: SqlExecutor, id: string): Promise<string> {
  if (isUuid(id)) {
    const byId = await executor.query<{ id: string }>('SELECT id FROM signals WHERE id = $1', [id]);
    const row = byId.rows[0];
    if (row) return row.id;
  }
  const byKey = await executor.query<{ id: string }>(
    'SELECT id FROM signals WHERE signal_key = $1',
    [id],
  );
  const row = byKey.rows[0];
  if (!row) throw new RecordNotFoundError('signal', id);
  return row.id;
}
