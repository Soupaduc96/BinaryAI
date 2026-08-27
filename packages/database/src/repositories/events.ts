import type {
  EventQuery,
  NewRiskEvent,
  NewSystemEvent,
  RiskEvent,
  RiskEventRepository,
  SystemEvent,
  SystemEventRepository,
} from '@binaryai/types';
import type { Row, SqlExecutor } from '../executor.js';
import {
  asRecord,
  toEpochMs,
  toJsonParam,
  toNullableText,
  toText,
  toTimestamp,
} from '../mappers.js';

/**
 * Operational log and audit trail.
 *
 * Append-only by convention: there is no update or delete here. An audit trail
 * that can be rewritten is not an audit trail.
 */

interface SystemEventRow extends Row {
  id: string;
  occurred_at: Date;
  level: string;
  category: string;
  code: string;
  message: string;
  execution_mode: string | null;
  context: unknown;
}

interface RiskEventRow extends Row {
  id: string;
  occurred_at: Date;
  code: string;
  severity: string;
  message: string;
  execution_mode: string | null;
  context: unknown;
}

function buildEventFilters(query: EventQuery, params: unknown[], hasCategory: boolean): string {
  const conditions: string[] = [];
  if (hasCategory && query.category !== undefined) {
    params.push(query.category);
    conditions.push(`category = $${params.length}`);
  }
  if (query.code !== undefined) {
    params.push(query.code);
    conditions.push(`code = $${params.length}`);
  }
  if (query.since !== undefined) {
    params.push(toTimestamp(query.since));
    conditions.push(`occurred_at >= $${params.length}`);
  }
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

export function createSystemEventRepository(executor: SqlExecutor): SystemEventRepository {
  return {
    async record(event: NewSystemEvent): Promise<void> {
      await executor.query(
        `INSERT INTO system_events (occurred_at, level, category, code, message, execution_mode, context)
         VALUES ($1, $2::event_level, $3, $4, $5, $6::execution_mode, $7::jsonb)`,
        [
          toTimestamp(event.at ?? Date.now()),
          event.level,
          event.category,
          event.code,
          event.message,
          event.executionMode,
          toJsonParam(event.context ?? {}),
        ],
      );
    },

    async list(query: EventQuery = {}): Promise<readonly SystemEvent[]> {
      const params: unknown[] = [];
      const where = buildEventFilters(query, params, true);
      params.push(query.limit ?? 100);

      const result = await executor.query<SystemEventRow>(
        `SELECT id, occurred_at, level, category, code, message, execution_mode, context
         FROM system_events ${where}
         ORDER BY occurred_at DESC LIMIT $${params.length}`,
        params,
      );

      return result.rows.map((row) => ({
        id: toText(row.id, 'event.id'),
        at: toEpochMs(row.occurred_at, 'event.occurred_at'),
        level: row.level as SystemEvent['level'],
        category: row.category as SystemEvent['category'],
        code: toText(row.code, 'event.code'),
        message: toText(row.message, 'event.message'),
        executionMode:
          row.execution_mode === 'demo' ? 'demo' : row.execution_mode === 'live' ? 'live' : null,
        context: asRecord(row.context) as SystemEvent['context'],
      }));
    },
  };
}

export function createRiskEventRepository(executor: SqlExecutor): RiskEventRepository {
  return {
    async record(event: NewRiskEvent): Promise<void> {
      await executor.query(
        `INSERT INTO risk_events (occurred_at, account_id, signal_id, code, severity, message, execution_mode, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7::execution_mode, $8::jsonb)`,
        [
          toTimestamp(event.at ?? Date.now()),
          event.accountId ?? null,
          event.signalId ?? null,
          event.code,
          event.severity,
          event.message,
          event.executionMode,
          toJsonParam(event.context ?? {}),
        ],
      );
    },

    async listForAccount(accountId: string, limit = 100): Promise<readonly RiskEvent[]> {
      // The account id is part of the predicate, not a post-filter. There is
      // deliberately no way to call this without one.
      const result = await executor.query<RiskEventRow>(
        `SELECT id, occurred_at, code, severity, message, execution_mode, context,
                rule_code, policy_version
         FROM risk_events
         WHERE account_id = $1
         ORDER BY occurred_at DESC
         LIMIT $2`,
        [accountId, Math.min(limit, 200)],
      );

      return result.rows.map((row) => ({
        id: toText(row.id, 'risk_event.id'),
        at: toEpochMs(row.occurred_at, 'risk_event.occurred_at'),
        code: row.code as RiskEvent['code'],
        severity: row.severity as RiskEvent['severity'],
        message: toText(row.message, 'risk_event.message'),
        executionMode: toNullableText(row.execution_mode) === 'live' ? 'live' : 'demo',
        context: asRecord(row.context) as RiskEvent['context'],
      }));
    },

    async list(query: EventQuery = {}): Promise<readonly RiskEvent[]> {
      const params: unknown[] = [];
      const where = buildEventFilters(query, params, false);
      params.push(query.limit ?? 100);

      const result = await executor.query<RiskEventRow>(
        `SELECT id, occurred_at, code, severity, message, execution_mode, context
         FROM risk_events ${where}
         ORDER BY occurred_at DESC LIMIT $${params.length}`,
        params,
      );

      return result.rows.map((row) => ({
        id: toText(row.id, 'risk_event.id'),
        at: toEpochMs(row.occurred_at, 'risk_event.occurred_at'),
        code: row.code as RiskEvent['code'],
        severity: row.severity as RiskEvent['severity'],
        message: toText(row.message, 'risk_event.message'),
        executionMode: toNullableText(row.execution_mode) === 'live' ? 'live' : 'demo',
        context: asRecord(row.context) as RiskEvent['context'],
      }));
    },
  };
}
