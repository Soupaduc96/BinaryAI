import type {
  CalibrationQuery,
  CalibrationSample,
  NewSignalOutcome,
  PayoutModel,
  SignalOutcomeRepository,
  StoredSignalOutcome,
} from '@binaryai/types';
import {
  toDataSource,
  toDirection,
  toOutcomeResult,
  toRegime,
  toRiskLevel,
  toTimeframe,
} from '../enums.js';
import { DatabaseError, type Row, type SqlExecutor } from '../executor.js';
import {
  asNumericRecord,
  asRecord,
  fromJson,
  toEpochMs,
  toJsonParam,
  toNullableText,
  toNumber,
  toText,
  toTimestamp,
} from '../mappers.js';
import { resolveSignalRowId } from './ids.js';

/**
 * Signal outcomes -- the ground truth that closes the loop.
 *
 * Recording an outcome is what eventually makes confidence calibration
 * possible. It does NOT make it implemented: confidence stays
 * `uncalibrated_heuristic` until a model is fitted and validated on these rows.
 * See docs/ai-architecture.md.
 *
 * `price_delta` is computed in SQL from the signal's own entry price rather
 * than trusted from the caller, so it cannot disagree with the stored signal.
 */

interface OutcomeRow extends Row {
  signal_id: string;
  settled_at: Date;
  settlement_price: string;
  result: string;
  price_delta: string;
  payout: unknown;
  metadata: unknown;
}

interface CalibrationRow extends Row {
  signal_id: string;
  asset_symbol: string;
  timeframe: string;
  direction: string;
  entry_at: Date;
  expires_at: Date;
  settled_at: Date;
  entry_price: string;
  expiry_price: string;
  result: string;
  price_delta: string;
  payout_assumption: unknown;
  strategy_key: string | null;
  strategy_version: string | null;
  confidence_at_signal: string;
  confidence_calibration: string;
  market_regime: string;
  risk_level: string;
  data_quality_score: string;
  data_source: string;
  market_conditions: unknown;
  result_metadata: unknown;
}

const OUTCOME_COLUMNS =
  'signal_id, settled_at, settlement_price, result, price_delta, payout, metadata';

function toStoredOutcome(row: OutcomeRow, signalKey: string): StoredSignalOutcome {
  const payout = fromJson<PayoutModel | Record<string, never>>(row.payout, {});
  return {
    signalId: signalKey,
    settledAt: toEpochMs(row.settled_at, 'outcome.settled_at'),
    settlementPrice: toNumber(row.settlement_price, 'outcome.settlement_price'),
    result: toOutcomeResult(row.result),
    priceDelta: toNumber(row.price_delta, 'outcome.price_delta'),
    payout: 'winPayoutRate' in payout ? (payout as PayoutModel) : null,
    metadata: asRecord(row.metadata),
  };
}

/** Read-only view used by the signal repository when loading a signal. */
export function createOutcomeReader(executor: SqlExecutor) {
  return {
    async findByRowId(signalRowId: string): Promise<StoredSignalOutcome | null> {
      const result = await executor.query<OutcomeRow & { signal_key: string | null }>(
        `SELECT o.${OUTCOME_COLUMNS.split(', ').join(', o.')}, s.signal_key
         FROM signal_outcomes o
         JOIN signals s ON s.id = o.signal_id
         WHERE o.signal_id = $1`,
        [signalRowId],
      );
      const row = result.rows[0];
      return row ? toStoredOutcome(row, toNullableText(row.signal_key) ?? row.signal_id) : null;
    },
  };
}

export function createSignalOutcomeRepository(executor: SqlExecutor): SignalOutcomeRepository {
  return {
    async record(outcome: NewSignalOutcome): Promise<StoredSignalOutcome> {
      const signalRowId = await resolveSignalRowId(executor, outcome.signalId);

      const result = await executor.query<OutcomeRow>(
        `INSERT INTO signal_outcomes (signal_id, settled_at, settlement_price, result, price_delta, payout, metadata)
         SELECT $1, $2, $3, $4::trade_outcome, $3 - s.price, $5::jsonb, $6::jsonb
         FROM signals s WHERE s.id = $1
         RETURNING ${OUTCOME_COLUMNS}`,
        [
          signalRowId,
          toTimestamp(outcome.settledAt),
          outcome.settlementPrice,
          outcome.result,
          toJsonParam(outcome.payout ?? {}),
          toJsonParam(outcome.metadata ?? {}),
        ],
      );

      const row = result.rows[0];
      if (!row)
        throw new DatabaseError(`outcome insert for signal ${outcome.signalId} wrote no row`);

      // Settling a signal is a state change on the signal itself.
      await executor.query(
        `UPDATE signals SET status = 'settled'::signal_status WHERE id = $1 AND status <> 'settled'`,
        [signalRowId],
      );

      return toStoredOutcome(row, outcome.signalId);
    },

    async findBySignalId(signalId: string): Promise<StoredSignalOutcome | null> {
      const signalRowId = await resolveSignalRowId(executor, signalId);
      return createOutcomeReader(executor).findByRowId(signalRowId);
    },

    async listCalibrationSamples(
      query: CalibrationQuery = {},
    ): Promise<readonly CalibrationSample[]> {
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (query.strategyKey !== undefined) {
        params.push(query.strategyKey);
        conditions.push(`strategy_key = $${params.length}`);
      }
      if (query.assetSymbol !== undefined) {
        params.push(query.assetSymbol);
        conditions.push(`asset_symbol = $${params.length}`);
      }
      if (query.settledAfter !== undefined) {
        params.push(toTimestamp(query.settledAfter));
        conditions.push(`settled_at >= $${params.length}`);
      }

      params.push(query.limit ?? 1000);
      const result = await executor.query<CalibrationRow>(
        `SELECT * FROM signal_calibration_samples
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY settled_at DESC
         LIMIT $${params.length}`,
        params,
      );

      return result.rows.map((row) => ({
        signalId: toText(row.signal_id, 'sample.signal_id'),
        assetSymbol: toText(row.asset_symbol, 'sample.asset_symbol'),
        timeframe: toTimeframe(row.timeframe),
        direction: toDirection(row.direction),
        entryAt: toEpochMs(row.entry_at, 'sample.entry_at'),
        expiresAt: toEpochMs(row.expires_at, 'sample.expires_at'),
        settledAt: toEpochMs(row.settled_at, 'sample.settled_at'),
        entryPrice: toNumber(row.entry_price, 'sample.entry_price'),
        expiryPrice: toNumber(row.expiry_price, 'sample.expiry_price'),
        result: toOutcomeResult(row.result),
        priceDelta: toNumber(row.price_delta, 'sample.price_delta'),
        payoutAssumption: fromJson<PayoutModel | null>(row.payout_assumption, null),
        strategyKey: toNullableText(row.strategy_key),
        strategyVersion: toNullableText(row.strategy_version),
        confidenceAtSignal: toNumber(row.confidence_at_signal, 'sample.confidence'),
        confidenceCalibration: toText(row.confidence_calibration, 'sample.calibration'),
        marketRegime: toRegime(row.market_regime),
        riskLevel: toRiskLevel(row.risk_level),
        dataQualityScore: toNumber(row.data_quality_score, 'sample.data_quality_score'),
        dataSource: toDataSource(row.data_source),
        marketConditions: asNumericRecord(row.market_conditions),
        resultMetadata: asRecord(row.result_metadata),
      }));
    },

    async countSettled(): Promise<number> {
      const result = await executor.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM signal_outcomes',
      );
      return toNumber(result.rows[0]?.total ?? 0, 'outcomes.count');
    },
  };
}
