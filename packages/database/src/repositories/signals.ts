import type {
  AccessScope,
  PersistedSignal,
  Signal,
  SignalLinks,
  SignalQuery,
  SignalRepository,
  SignalSummary,
  StoredSignalFeature,
  StoredSignalRef,
  ExpiredSignal,
} from '@binaryai/types';
import {
  toDataSource,
  toDirection,
  toFeatureKind,
  toRegime,
  toRiskLevel,
  toSignalStatus,
  toTimeframe,
} from '../enums.js';
import { DatabaseError, type Row, type SqlExecutor } from '../executor.js';
import {
  fromJson,
  toBoolean,
  toEpochMs,
  toJsonParam,
  toNullableNumber,
  toNullableText,
  toNumber,
  toText,
  toTimestamp,
} from '../mappers.js';
import { isUuid } from './ids.js';
import { createOutcomeReader } from './outcomes.js';

/**
 * Signal persistence.
 *
 * Two representations of the same decision are written together:
 *
 *  - `signals.snapshot` — the full domain object, for replaying ONE signal
 *    exactly as it was decided, including fields added to the type later.
 *  - `signal_features` — the relational projection, for asking questions ACROSS
 *    signals ("which conflicts preceded losing signals?"). That query is the
 *    prerequisite for any future confidence calibration, and it is not
 *    answerable against a JSON blob at any reasonable speed.
 *
 * They are written in one transaction, so the projection can never disagree
 * with the snapshot.
 */

interface SignalRow extends Row {
  id: string;
  signal_key: string | null;
  account_id?: string | null;
  asset_symbol: string;
  timeframe: string;
  direction: string;
  status: string;
  confidence: string;
  risk_level: string;
  market_regime: string;
  decided_at: Date;
  expires_at: Date;
  data_source: string;
  snapshot: unknown;
  has_outcome?: boolean;
}

interface FeatureRow extends Row {
  kind: string;
  code: string;
  label: string;
  numeric_value: string | null;
  weight: string | null;
  severity: string | null;
  detail: string | null;
}

interface FeatureInsert {
  readonly kind: StoredSignalFeature['kind'];
  readonly code: string;
  readonly label: string;
  readonly numericValue: number | null;
  readonly weight: number | null;
  readonly severity: string | null;
  readonly detail: string | null;
  readonly meta: Record<string, unknown>;
}

/** Flatten a signal's evidence into rows. Pure, and unit-testable on its own. */
export function toFeatureInserts(signal: Signal): FeatureInsert[] {
  const features: FeatureInsert[] = [];

  for (const indicator of signal.indicators) {
    features.push({
      kind: 'indicator',
      code: indicator.key,
      label: indicator.label,
      numericValue: indicator.value,
      weight: null,
      severity: null,
      detail: indicator.detail ?? null,
      meta: { interpretation: indicator.interpretation },
    });
  }

  for (const confirmation of signal.confirmations) {
    features.push({
      kind: 'confirmation',
      code: confirmation.code,
      label: confirmation.label,
      numericValue: null,
      weight: confirmation.weight,
      severity: null,
      detail: confirmation.detail,
      meta: {},
    });
  }

  for (const conflict of signal.conflicts) {
    features.push({
      kind: 'conflict',
      code: conflict.code,
      label: conflict.label,
      numericValue: null,
      weight: conflict.weight,
      severity: conflict.severity,
      detail: conflict.detail,
      meta: {},
    });
  }

  for (const component of signal.confidence.components) {
    features.push({
      kind: 'confidence_component',
      code: component.key,
      label: component.label,
      numericValue: component.score,
      weight: component.weight,
      severity: null,
      detail: component.detail,
      meta: { contribution: component.contribution },
    });
  }

  return features;
}

function toSummary(row: SignalRow): SignalSummary {
  return {
    id: toText(row.id, 'signal.id'),
    assetSymbol: toText(row.asset_symbol, 'signal.asset_symbol'),
    timeframe: toTimeframe(row.timeframe),
    direction: toDirection(row.direction),
    status: toSignalStatus(row.status),
    confidence: toNumber(row.confidence, 'signal.confidence'),
    riskLevel: toRiskLevel(row.risk_level),
    marketRegime: toRegime(row.market_regime),
    decidedAt: toEpochMs(row.decided_at, 'signal.decided_at'),
    expiresAt: toEpochMs(row.expires_at, 'signal.expires_at'),
    dataSource: toDataSource(row.data_source),
    hasOutcome: toBoolean(row.has_outcome),
  };
}

function toFeature(row: FeatureRow): StoredSignalFeature {
  return {
    kind: toFeatureKind(row.kind),
    code: toText(row.code, 'feature.code'),
    label: toText(row.label, 'feature.label'),
    numericValue: toNullableNumber(row.numeric_value, 'feature.numeric_value'),
    weight: toNullableNumber(row.weight, 'feature.weight'),
    severity: toNullableText(row.severity),
    detail: toNullableText(row.detail),
  };
}

/**
 * Row-level counterpart of {@link scopeCondition}, for single-record fetches.
 * The two must agree: if this says yes where the SQL filter says no, a record
 * becomes reachable by id that never appears in a list.
 */
function visibleUnder(scope: AccessScope | undefined, ownerAccountId: string | null): boolean {
  if (scope === undefined || scope.kind === 'all') return true;
  if (scope.kind === 'system') return ownerAccountId === null;
  if (ownerAccountId === null) return scope.includeSystem;
  return ownerAccountId === scope.accountId;
}

/**
 * Translates an {@link AccessScope} into a WHERE fragment.
 *
 * Returns null only for `all`, which is the one scope that legitimately adds
 * no filter. Every other case produces a real condition, so a caller cannot end
 * up unscoped by passing something the switch forgot to handle.
 */
function scopeCondition(scope: AccessScope | undefined, params: unknown[]): string | null {
  if (scope === undefined || scope.kind === 'all') return null;
  if (scope.kind === 'system') return 's.account_id IS NULL';
  params.push(scope.accountId);
  return scope.includeSystem
    ? `(s.account_id = $${params.length} OR s.account_id IS NULL)`
    : `s.account_id = $${params.length}`;
}

function buildFilters(query: SignalQuery, params: unknown[]): string {
  const conditions: string[] = [];
  // Ownership first, so it is impossible to read this function and miss it.
  // An omitted scope means UNSCOPED and is reserved for internal callers such
  // as the settlement worker; every request-facing path supplies one.
  const ownership = scopeCondition(query.scope, params);
  if (ownership !== null) conditions.push(ownership);
  if (query.assetSymbol !== undefined) {
    params.push(query.assetSymbol);
    conditions.push(`s.asset_symbol = $${params.length}`);
  }
  if (query.status !== undefined) {
    params.push(query.status);
    conditions.push(`s.status = $${params.length}::signal_status`);
  }
  if (query.direction !== undefined) {
    params.push(query.direction);
    conditions.push(`s.direction = $${params.length}::signal_direction`);
  }
  if (query.strategyKey !== undefined) {
    params.push(query.strategyKey);
    conditions.push(
      `s.strategy_id IN (SELECT id FROM strategies WHERE strategy_key = $${params.length})`,
    );
  }
  if (query.decidedAfter !== undefined) {
    params.push(toTimestamp(query.decidedAfter));
    conditions.push(`s.decided_at >= $${params.length}`);
  }
  if (query.decidedBefore !== undefined) {
    params.push(toTimestamp(query.decidedBefore));
    conditions.push(`s.decided_at <= $${params.length}`);
  }
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

export interface SignalRepositoryDeps {
  readonly executor: SqlExecutor;
  /** Present when the repository may open its own transaction. */
  readonly runner: { transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> } | null;
}

export function createSignalRepository(deps: SignalRepositoryDeps): SignalRepository {
  const { executor, runner } = deps;

  async function insert(
    tx: SqlExecutor,
    signal: Signal,
    links: SignalLinks,
  ): Promise<StoredSignalRef> {
    const inserted = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO signals (
         signal_key, account_id, asset_id, asset_symbol, timeframe, strategy_id,
         direction, status, recommendation, market_regime, risk_level,
         confidence, confidence_calibration, confidence_sample_size,
         price, decided_at, expires_at, expiration_seconds,
         execution_mode, data_source, data_quality_score,
         reasoning, risk_assessment, snapshot
       ) VALUES (
         $1, $2,
         (SELECT id FROM market_assets WHERE symbol = $3),
         $3, $4, $5,
         $6::signal_direction, $7::signal_status, $8::recommendation,
         $9::market_regime, $10::risk_level,
         $11, $12::calibration_kind, $13,
         $14, $15, $16, $17,
         $18::execution_mode, $19::data_source, $20,
         $21::jsonb, $22::jsonb, $23::jsonb
       )
       RETURNING id, created_at`,
      [
        signal.id,
        links.accountId ?? null,
        signal.asset,
        signal.timeframe,
        links.strategyRowId ?? null,
        signal.direction,
        signal.status,
        signal.recommendation,
        signal.marketRegime,
        signal.riskLevel,
        signal.confidence.score,
        signal.confidence.calibration,
        signal.confidence.sampleSize,
        signal.price,
        toTimestamp(signal.timestamp),
        toTimestamp(signal.expiration.expiresAt),
        signal.expiration.seconds,
        signal.executionMode,
        signal.dataSource,
        signal.dataQuality.score,
        toJsonParam(signal.reasoning),
        toJsonParam({ dataQualityIssues: signal.dataQuality.issues }),
        toJsonParam(signal),
      ],
    );

    const row = inserted.rows[0];
    if (!row) throw new DatabaseError('signal insert returned no row');

    const features = toFeatureInserts(signal);
    if (features.length > 0) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const feature of features) {
        const base = values.length;
        tuples.push(
          `($${base + 1}, $${base + 2}::feature_kind, $${base + 3}, $${base + 4}, ` +
            `$${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb)`,
        );
        values.push(
          row.id,
          feature.kind,
          feature.code,
          feature.label,
          feature.numericValue,
          feature.weight,
          feature.severity,
          feature.detail,
          toJsonParam(feature.meta),
        );
      }
      await tx.query(
        `INSERT INTO signal_features (signal_id, kind, code, label, numeric_value, weight, severity, detail, meta)
         VALUES ${tuples.join(', ')}`,
        values,
      );
    }

    return {
      id: row.id,
      storedAt: toEpochMs(row.created_at, 'signal.created_at'),
      featureCount: features.length,
    };
  }

  return {
    async save(signal: Signal, links: SignalLinks = {}): Promise<StoredSignalRef> {
      return runner
        ? runner.transaction((tx) => insert(tx, signal, links))
        : insert(executor, signal, links);
    },

    async findById(id: string, scope?: AccessScope): Promise<PersistedSignal | null> {
      // Accepts the stored row id or the engine's signal key (sig_...).
      const lookup = isUuid(id)
        ? { sql: 'WHERE id = $1', params: [id] }
        : { sql: 'WHERE signal_key = $1', params: [id] };

      const result = await executor.query<SignalRow>(
        `SELECT id, signal_key, account_id, asset_symbol, timeframe, direction, status, confidence,
                risk_level, market_regime, decided_at, expires_at, data_source, snapshot
         FROM signals ${lookup.sql}`,
        lookup.params,
      );
      const row = result.rows[0];
      if (!row) return null;

      // Ownership check on a single-record fetch. Without it, a valid id from
      // another account returns that account's data -- the textbook IDOR bug
      // that a WHERE clause on list() alone does not prevent.
      //
      // A denied read returns null, exactly as a missing row does. Returning
      // 403 here would confirm that the id exists, which is itself a leak.
      if (!visibleUnder(scope, row.account_id ?? null)) return null;

      const snapshot = fromJson<Partial<Signal>>(row.snapshot, {});
      if (typeof snapshot.id !== 'string') {
        throw new DatabaseError(
          `signal ${row.id} has no replayable snapshot; it predates the snapshot column`,
        );
      }

      const features = await executor.query<FeatureRow>(
        `SELECT kind, code, label, numeric_value, weight, severity, detail
         FROM signal_features WHERE signal_id = $1 ORDER BY id`,
        [row.id],
      );

      const outcome = await createOutcomeReader(executor).findByRowId(row.id);

      return {
        signal: snapshot as Signal,
        features: features.rows.map(toFeature),
        outcome,
      };
    },

    async list(query: SignalQuery = {}): Promise<readonly SignalSummary[]> {
      const params: unknown[] = [];
      const where = buildFilters(query, params);

      params.push(query.limit ?? 50);
      const limitClause = `LIMIT $${params.length}`;
      params.push(query.offset ?? 0);
      const offsetClause = `OFFSET $${params.length}`;

      const result = await executor.query<SignalRow>(
        `SELECT s.id, s.signal_key, s.asset_symbol, s.timeframe, s.direction, s.status,
                s.confidence, s.risk_level, s.market_regime, s.decided_at, s.expires_at,
                s.data_source, '{}'::jsonb AS snapshot,
                EXISTS (SELECT 1 FROM signal_outcomes o WHERE o.signal_id = s.id) AS has_outcome
         FROM signals s
         ${where}
         ORDER BY s.decided_at DESC
         ${limitClause} ${offsetClause}`,
        params,
      );
      return result.rows.map(toSummary);
    },

    async findExpiredUnsettled(before: number, limit = 100): Promise<readonly ExpiredSignal[]> {
      // Directional signals only: a 'none' signal predicted nothing, so there is
      // no outcome to settle. NOT EXISTS rather than a LEFT JOIN so a signal
      // settled by a racing worker disappears from this scan immediately.
      const result = await executor.query<{
        id: string;
        signal_key: string | null;
        asset_symbol: string;
        timeframe: string;
        direction: string;
        price: string;
        decided_at: Date;
        expires_at: Date;
      }>(
        /*
         * R17 — FAIR ACROSS INSTRUMENTS.
         *
         * A plain `ORDER BY expires_at ASC LIMIT 100` is oldest-first across
         * every instrument, which is fair only while one instrument exists. A
         * 1m instrument produces sixty signals an hour and a 1d instrument
         * produces one; the 1m backlog fills every batch and the daily
         * instrument waits behind it, for as long as the backlog lasts.
         *
         * The window function interleaves them instead: each instrument's
         * pending signals are numbered oldest-first, and the batch is ordered
         * by that rank BEFORE expiry. So the batch takes the oldest signal from
         * every instrument, then the second oldest from every instrument, and
         * so on — round-robin, in one query, with no per-instrument round trip
         * and nothing to keep in memory between cycles.
         *
         * Instruments with nothing pending cost nothing: they contribute no
         * rows, so the batch simply fills from those that do. Oldest-first
         * ordering WITHIN an instrument is preserved exactly.
         */
        `WITH pending AS (
           SELECT s.id, s.signal_key, s.asset_symbol, s.timeframe, s.direction, s.price,
                  s.decided_at, s.expires_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.asset_symbol ORDER BY s.expires_at ASC, s.id
                  ) AS instrument_rank
           FROM signals s
           WHERE s.expires_at <= $1
             AND s.direction <> 'none'
             AND NOT EXISTS (SELECT 1 FROM signal_outcomes o WHERE o.signal_id = s.id)
         )
         SELECT id, signal_key, asset_symbol, timeframe, direction, price,
                decided_at, expires_at
         FROM pending
         ORDER BY instrument_rank ASC, expires_at ASC, id
         LIMIT $2`,
        [toTimestamp(before), limit],
      );

      return result.rows.map((row) => ({
        id: toText(row.id, 'signal.id'),
        signalKey: toNullableText(row.signal_key) ?? toText(row.id, 'signal.id'),
        assetSymbol: toText(row.asset_symbol, 'signal.asset_symbol'),
        timeframe: toTimeframe(row.timeframe),
        direction: toDirection(row.direction) as ExpiredSignal['direction'],
        entryPrice: toNumber(row.price, 'signal.price'),
        decidedAt: toEpochMs(row.decided_at, 'signal.decided_at'),
        expiresAt: toEpochMs(row.expires_at, 'signal.expires_at'),
      }));
    },

    async count(query: SignalQuery = {}): Promise<number> {
      const params: unknown[] = [];
      const where = buildFilters(query, params);
      const result = await executor.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM signals s ${where}`,
        params,
      );
      return toNumber(result.rows[0]?.total ?? 0, 'signals.count');
    },
  };
}
