import type {
  AccessScope,
  AnalyticsAggregateRow,
  AnalyticsDimension,
  AnalyticsInterval,
  AnalyticsQuery,
  AnalyticsRepository,
  ExclusionReason,
} from '@binaryai/types';
import type { Row, SqlExecutor } from '../executor.js';
import { toTimestamp } from '../mappers.js';

/**
 * Analytics aggregation.
 *
 * Four rules govern every query in this file.
 *
 *  1. **Scope is mandatory.** Every method takes an `AccessScope` and applies it
 *     as a WHERE clause. There is no unscoped path, so an analytics endpoint
 *     cannot accidentally aggregate across accounts — the filter is in the SQL,
 *     not in a route handler or a component.
 *  2. **Only eligible samples are counted.** Rows come from
 *     `calibration_eligibility`, which attaches an explicit verdict to every
 *     settled signal. A rejected signal never becomes a loss.
 *  3. **Every value is a bound parameter.** No identifier, no literal and no
 *     fragment is built from caller input by string concatenation. Dimensions
 *     and intervals map through a lookup of fixed constants, so an unexpected
 *     value throws instead of reaching the database.
 *  4. **Every query is bounded.** A limit is always applied, and the date range
 *     is validated by the caller before it arrives.
 *
 * SQL counts; it does not compute rates. Accuracy, evidence levels and
 * calibration measures are derived in @binaryai/analytics, so the honesty rules
 * live in one testable place rather than being spread across SQL dialects.
 */

/** Hard ceiling on any grouped result, regardless of what a caller asks for. */
const MAX_GROUPS = 200;

/** Hard ceiling on time-series buckets: ~3 years of daily periods. */
const MAX_PERIODS = 1100;

interface AggregateRow extends Row {
  key: string | null;
  version: string | null;
  wins: string | number;
  losses: string | number;
  ties: string | number;
  unresolved: string | number;
  invalid: string | number;
  skipped: string | number;
  total: string | number;
  confidence_sum: string | number | null;
  confidence_count: string | number;
}

/**
 * Column expressions per dimension.
 *
 * A fixed lookup, never caller input interpolated into SQL. An unknown
 * dimension throws rather than producing a query, which makes injection through
 * this path structurally impossible rather than merely unlikely.
 */
const DIMENSION_COLUMNS: Record<AnalyticsDimension, { key: string; version: string }> = {
  strategy: { key: 'e.strategy_key', version: 'e.strategy_version' },
  regime: { key: 'e.market_regime::text', version: 'NULL' },
  timeframe: { key: 'e.timeframe', version: 'NULL' },
  asset: { key: 'e.asset_symbol', version: 'NULL' },
  direction: { key: 'e.direction::text', version: 'NULL' },
};

/** `date_trunc` units, likewise fixed. */
const INTERVAL_UNITS: Record<AnalyticsInterval, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/**
 * The outcome tallies every aggregate shares.
 *
 * `exclusion_reason IS NULL` is the eligibility gate and appears in every
 * counter except `total`. Note what each arm refuses to do: an excluded row
 * contributes to `skipped`, never to `losses`; an `unresolved` result is
 * counted as pending, never as a failure.
 */
const OUTCOME_TALLIES = `
  COUNT(*) FILTER (WHERE e.exclusion_reason IS NULL AND e.result = 'win')  AS wins,
  COUNT(*) FILTER (WHERE e.exclusion_reason IS NULL AND e.result = 'loss') AS losses,
  -- A tie is eligible: it settled, and the price landed exactly on entry. It
  -- carries no directional verdict, so it is counted here and kept out of the
  -- accuracy denominator rather than being folded into either side.
  COUNT(*) FILTER (WHERE e.exclusion_reason IS NULL AND e.result = 'tie')  AS ties,
  -- Counted by RESULT, not by eligibility. The eligibility view marks these
  -- 'not_settled' (correctly -- they cannot calibrate anything), but they are a
  -- meaningful state of their own: awaiting a settlement candle, not failed.
  -- Filtering on exclusion_reason IS NULL here would make this counter
  -- permanently zero and quietly reclassify every pending signal as skipped.
  COUNT(*) FILTER (WHERE e.result = 'unresolved')                          AS unresolved,
  COUNT(*) FILTER (WHERE e.exclusion_reason = 'unknown_data_origin')       AS invalid,
  COUNT(*) FILTER (
    WHERE e.exclusion_reason IS NOT NULL
      AND e.exclusion_reason <> 'unknown_data_origin'
      AND e.result <> 'unresolved'
  )                                                                        AS skipped,
  COUNT(*)                                                                      AS total,
  SUM(e.confidence_at_signal) FILTER (
    WHERE e.exclusion_reason IS NULL AND e.result IN ('win', 'loss')
  )                                                                             AS confidence_sum,
  COUNT(*) FILTER (
    WHERE e.exclusion_reason IS NULL AND e.result IN ('win', 'loss')
  )                                                                             AS confidence_count
`;

function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toAggregate(row: AggregateRow, fallbackKey = 'unknown'): AnalyticsAggregateRow {
  return {
    key: row.key ?? fallbackKey,
    version: row.version,
    wins: toCount(row.wins),
    losses: toCount(row.losses),
    ties: toCount(row.ties),
    unresolved: toCount(row.unresolved),
    invalid: toCount(row.invalid),
    skipped: toCount(row.skipped),
    total: toCount(row.total),
    confidenceSum: toCount(row.confidence_sum),
    confidenceCount: toCount(row.confidence_count),
  };
}

/**
 * Ownership filter, as a bound-parameter WHERE fragment.
 *
 * Mirrors `scopeCondition` in the signals repository. The two must agree: if
 * analytics were broader than the signal list, a user could infer the existence
 * and performance of another account's signals from an aggregate without ever
 * being able to read one — a count is a disclosure just as a row is.
 */
function scopeCondition(scope: AccessScope, params: unknown[]): string {
  if (scope.kind === 'all') return 'TRUE';
  if (scope.kind === 'system') return 'e.account_id IS NULL';
  params.push(scope.accountId);
  return scope.includeSystem
    ? `(e.account_id = $${params.length} OR e.account_id IS NULL)`
    : `e.account_id = $${params.length}`;
}

/** Optional filters, all parameterized. */
function queryConditions(query: AnalyticsQuery, params: unknown[]): string[] {
  const conditions: string[] = [];

  if (query.from !== undefined) {
    params.push(toTimestamp(query.from));
    conditions.push(`e.settled_at >= $${params.length}`);
  }
  if (query.to !== undefined) {
    params.push(toTimestamp(query.to));
    conditions.push(`e.settled_at <= $${params.length}`);
  }
  if (query.assetSymbol !== undefined) {
    params.push(query.assetSymbol);
    conditions.push(`e.asset_symbol = $${params.length}`);
  }
  if (query.timeframe !== undefined) {
    params.push(query.timeframe);
    conditions.push(`e.timeframe = $${params.length}`);
  }
  if (query.strategyKey !== undefined) {
    params.push(query.strategyKey);
    conditions.push(`e.strategy_key = $${params.length}`);
  }
  if (query.regime !== undefined) {
    params.push(query.regime);
    conditions.push(`e.market_regime = $${params.length}::market_regime`);
  }
  if (query.direction !== undefined) {
    params.push(query.direction);
    conditions.push(`e.direction = $${params.length}::signal_direction`);
  }
  return conditions;
}

function whereClause(scope: AccessScope, query: AnalyticsQuery, params: unknown[]): string {
  const conditions = [scopeCondition(scope, params), ...queryConditions(query, params)];
  return `WHERE ${conditions.join(' AND ')}`;
}

export function createAnalyticsRepository(executor: SqlExecutor): AnalyticsRepository {
  return {
    async totals(scope, query = {}): Promise<AnalyticsAggregateRow> {
      const params: unknown[] = [];
      const where = whereClause(scope, query, params);
      const result = await executor.query<AggregateRow>(
        `SELECT NULL::text AS key, NULL::text AS version, ${OUTCOME_TALLIES}
         FROM calibration_eligibility e
         ${where}`,
        params,
      );
      const row = result.rows[0];
      // An aggregate over no rows still returns one row of zeros, which is the
      // correct representation of "measured, nothing there".
      return row
        ? toAggregate(row, 'total')
        : {
            key: 'total',
            version: null,
            wins: 0,
            losses: 0,
            ties: 0,
            unresolved: 0,
            invalid: 0,
            skipped: 0,
            total: 0,
            confidenceSum: 0,
            confidenceCount: 0,
          };
    },

    async byDimension(scope, dimension, query = {}): Promise<readonly AnalyticsAggregateRow[]> {
      const columns = DIMENSION_COLUMNS[dimension];
      if (!columns) throw new Error(`Unsupported analytics dimension: ${String(dimension)}`);

      const params: unknown[] = [];
      const where = whereClause(scope, query, params);
      params.push(Math.min(query.limit ?? MAX_GROUPS, MAX_GROUPS));

      const result = await executor.query<AggregateRow>(
        `SELECT ${columns.key} AS key, ${columns.version} AS version, ${OUTCOME_TALLIES}
         FROM calibration_eligibility e
         ${where}
         GROUP BY ${columns.key}${columns.version === 'NULL' ? '' : `, ${columns.version}`}
         ORDER BY total DESC
         LIMIT $${params.length}`,
        params,
      );
      // A NULL group key means the dimension is genuinely absent (a signal with
      // no strategy row, say). Labelled rather than dropped, so the count still
      // reconciles against the total.
      return result.rows.map((row) => toAggregate(row, 'unknown'));
    },

    async byConfidenceBucket(
      scope,
      boundaries,
      query = {},
    ): Promise<readonly AnalyticsAggregateRow[]> {
      // Bucket ids and bounds come from @binaryai/analytics constants, never
      // from a request, but they are still bound as parameters rather than
      // inlined: a constant that becomes configurable later must not silently
      // become an injection point.
      const params: unknown[] = [];
      const where = whereClause(scope, query, params);

      const cases = boundaries.map((bucket) => {
        params.push(bucket.id, bucket.lower, bucket.upperExclusive);
        const idParam = params.length - 2;
        const lowerParam = params.length - 1;
        const upperParam = params.length;
        return `WHEN e.confidence_at_signal >= $${lowerParam} AND e.confidence_at_signal < $${upperParam} THEN $${idParam}::text`;
      });

      const result = await executor.query<AggregateRow>(
        `SELECT CASE ${cases.join(' ')} ELSE 'out_of_range' END AS key,
                NULL::text AS version,
                ${OUTCOME_TALLIES}
         FROM calibration_eligibility e
         ${where}
         GROUP BY 1
         ORDER BY 1`,
        params,
      );
      return result.rows.map((row) => toAggregate(row, 'out_of_range'));
    },

    async byPeriod(scope, interval, query = {}): Promise<readonly AnalyticsAggregateRow[]> {
      const unit = INTERVAL_UNITS[interval];
      if (!unit) throw new Error(`Unsupported analytics interval: ${String(interval)}`);

      const params: unknown[] = [];
      const where = whereClause(scope, query, params);
      params.push(MAX_PERIODS);

      const result = await executor.query<AggregateRow>(
        // Epoch ms as text so the key type matches every other aggregate. The
        // unit is a fixed constant chosen by the lookup above, never caller input.
        `SELECT (EXTRACT(EPOCH FROM date_trunc('${unit}', e.settled_at)) * 1000)::bigint::text AS key,
                NULL::text AS version,
                ${OUTCOME_TALLIES}
         FROM calibration_eligibility e
         ${where}
         GROUP BY 1
         ORDER BY 1 DESC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => toAggregate(row, '0'));
    },

    async exclusions(
      scope,
      query = {},
    ): Promise<Readonly<Partial<Record<ExclusionReason, number>>>> {
      const params: unknown[] = [];
      const where = whereClause(scope, query, params);
      const result = await executor.query<{ reason: string | null; count: string | number }>(
        `SELECT e.exclusion_reason AS reason, COUNT(*) AS count
         FROM calibration_eligibility e
         ${where}
           AND e.exclusion_reason IS NOT NULL
         GROUP BY 1`,
        params,
      );

      const tally: Partial<Record<ExclusionReason, number>> = {};
      for (const row of result.rows) {
        if (row.reason === null) continue;
        tally[row.reason as ExclusionReason] = toCount(row.count);
      }
      return tally;
    },

    async settledRange(scope, query = {}): Promise<{ first: number | null; last: number | null }> {
      const params: unknown[] = [];
      const where = whereClause(scope, query, params);
      const result = await executor.query<{ first_at: Date | null; last_at: Date | null }>(
        `SELECT MIN(e.settled_at) AS first_at, MAX(e.settled_at) AS last_at
         FROM calibration_eligibility e
         ${where}
           AND e.exclusion_reason IS NULL`,
        params,
      );
      const row = result.rows[0];
      return {
        first: row?.first_at ? new Date(row.first_at).getTime() : null,
        last: row?.last_at ? new Date(row.last_at).getTime() : null,
      };
    },

    async pendingSettlement(scope): Promise<number> {
      // Counted from `signals`, not from the eligibility view: a signal awaiting
      // settlement has no outcome row yet, so it is absent from that view by
      // construction. The scope predicate is rewritten against `s` accordingly.
      const params: unknown[] = [];
      const condition =
        scope.kind === 'all'
          ? 'TRUE'
          : scope.kind === 'system'
            ? 's.account_id IS NULL'
            : (() => {
                params.push(scope.accountId);
                return scope.includeSystem
                  ? `(s.account_id = $${params.length} OR s.account_id IS NULL)`
                  : `s.account_id = $${params.length}`;
              })();

      const result = await executor.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count
         FROM signals s
         WHERE ${condition}
           AND s.direction <> 'none'
           AND s.status = 'accepted'
           AND NOT EXISTS (SELECT 1 FROM signal_outcomes o WHERE o.signal_id = s.id)`,
        params,
      );
      return toCount(result.rows[0]?.count);
    },

    async dataOrigins(scope, query = {}): Promise<readonly string[]> {
      const params: unknown[] = [];
      const where = whereClause(scope, query, params);
      const result = await executor.query<{ data_source: string }>(
        `SELECT DISTINCT e.data_source::text AS data_source
         FROM calibration_eligibility e
         ${where}
         ORDER BY 1`,
        params,
      );
      return result.rows.map((row) => row.data_source);
    },
  };
}
