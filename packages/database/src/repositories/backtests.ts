import { BACKTEST_DISCLAIMER } from '@binaryai/types';
import type {
  BacktestRepository,
  BacktestResult,
  BacktestRunSummary,
  StoredBacktestRef,
} from '@binaryai/types';
import { toDataSource, toTimeframe } from '../enums.js';
import { isUuid } from './ids.js';
import { DatabaseError, type Row, type SqlExecutor } from '../executor.js';
import {
  fromJson,
  toEpochMs,
  toJsonParam,
  toNullableNumber,
  toNumber,
  toText,
  toTimestamp,
} from '../mappers.js';

/**
 * Backtest persistence.
 *
 * `result_type` is pinned to 'historical_simulation' by a CHECK constraint in
 * the schema, so a simulation cannot be recorded as live performance even by a
 * buggy caller. `dataset_source` is stored as declared -- a run over synthetic
 * candles stays labelled synthetic, which is what keeps it from being quoted
 * later as if it were a market result.
 */

interface RunRow extends Row {
  id: string;
  run_key: string | null;
  strategy_key: string;
  strategy_version: string;
  dataset_label: string;
  dataset_source: string;
  asset_symbol: string;
  timeframe: string;
  candle_count: number | string;
  started_at: Date;
  result_type: string;
  trades_count?: number | string | null;
  win_rate?: string | null;
  net_pnl?: string | null;
}

export function createBacktestRepository(
  executor: SqlExecutor,
  runner: { transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> } | null,
): BacktestRepository {
  async function insert(
    tx: SqlExecutor,
    result: BacktestResult,
    userId: string | null,
  ): Promise<StoredBacktestRef> {
    const run = await tx.query<{ id: string }>(
      `INSERT INTO backtest_runs (
         user_id, strategy_id, strategy_key, strategy_version, result_type,
         run_key, dataset_label, dataset_source, asset_symbol, timeframe,
         candle_count, range_from, range_to, config, warnings, started_at, finished_at
       ) VALUES (
         $1,
         (SELECT id FROM strategies WHERE strategy_key = $2 AND version = $3),
         $2, $3, $4, $5, $6, $7::data_source, $8, $9, $10, $11, $12,
         $13::jsonb, $14::jsonb, $15, $16
       )
       ON CONFLICT (run_key) DO UPDATE SET finished_at = EXCLUDED.finished_at
       RETURNING id`,
      [
        userId,
        result.strategy.id,
        result.strategy.version,
        result.resultType,
        result.runId,
        result.dataset.label,
        result.dataset.source,
        result.dataset.asset,
        result.dataset.timeframe,
        result.dataset.candleCount,
        result.dataset.from === null ? null : toTimestamp(result.dataset.from),
        result.dataset.to === null ? null : toTimestamp(result.dataset.to),
        toJsonParam(result.config),
        toJsonParam(result.warnings),
        toTimestamp(result.startedAt),
        toTimestamp(result.finishedAt),
      ],
    );

    const row = run.rows[0];
    if (!row) throw new DatabaseError(`backtest run ${result.runId} wrote no row`);

    const { metrics } = result;
    await tx.query(
      `INSERT INTO backtest_results (
         run_id, trades_count, wins, losses, ties, win_rate, net_pnl, return_percent,
         max_drawdown, max_drawdown_percent, longest_win_streak, longest_loss_streak,
         profit_factor, metrics, trades
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET
         trades_count = EXCLUDED.trades_count, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
         ties = EXCLUDED.ties, win_rate = EXCLUDED.win_rate, net_pnl = EXCLUDED.net_pnl,
         return_percent = EXCLUDED.return_percent, max_drawdown = EXCLUDED.max_drawdown,
         max_drawdown_percent = EXCLUDED.max_drawdown_percent,
         longest_win_streak = EXCLUDED.longest_win_streak,
         longest_loss_streak = EXCLUDED.longest_loss_streak,
         profit_factor = EXCLUDED.profit_factor, metrics = EXCLUDED.metrics, trades = EXCLUDED.trades`,
      [
        row.id,
        metrics.trades,
        metrics.wins,
        metrics.losses,
        metrics.ties,
        // NULL, not 0: "no resolved trades" is not a 0% win rate.
        metrics.winRate,
        metrics.netPnl,
        metrics.returnPercent,
        metrics.maxDrawdown,
        metrics.maxDrawdownPercent,
        metrics.longestWinStreak,
        metrics.longestLossStreak,
        metrics.profitFactor,
        toJsonParam(metrics),
        toJsonParam(result.trades),
      ],
    );

    return { id: row.id, runKey: result.runId, storedAt: Date.now() };
  }

  return {
    async save(result: BacktestResult, options = {}): Promise<StoredBacktestRef> {
      const userId = options.userId ?? null;
      return runner
        ? runner.transaction((tx) => insert(tx, result, userId))
        : insert(executor, result, userId);
    },

    async findById(id: string): Promise<BacktestResult | null> {
      const result = await executor.query<{
        config: unknown;
        warnings: unknown;
        metrics: unknown;
        trades: unknown;
        run_key: string | null;
        strategy_key: string;
        strategy_version: string;
        result_type: string;
        dataset_label: string;
        dataset_source: string;
        asset_symbol: string;
        timeframe: string;
        candle_count: number | string;
        range_from: Date | null;
        range_to: Date | null;
        started_at: Date;
        finished_at: Date;
        strategy_name: string | null;
      }>(
        `SELECT r.config, r.warnings, r.run_key, r.strategy_key, r.strategy_version, r.result_type,
                r.dataset_label, r.dataset_source, r.asset_symbol, r.timeframe, r.candle_count,
                r.range_from, r.range_to, r.started_at, r.finished_at,
                res.metrics, res.trades, s.name AS strategy_name
         FROM backtest_runs r
         JOIN backtest_results res ON res.run_id = r.id
         LEFT JOIN strategies s ON s.id = r.strategy_id
         WHERE ${isUuid(id) ? 'r.id = $1::uuid' : 'r.run_key = $1'}`,
        [id],
      );

      const row = result.rows[0];
      if (!row) return null;

      return {
        resultType: 'historical_simulation',
        runId: row.run_key ?? id,
        startedAt: toEpochMs(row.started_at, 'backtest.started_at'),
        finishedAt: toEpochMs(row.finished_at, 'backtest.finished_at'),
        strategy: {
          id: toText(row.strategy_key, 'backtest.strategy_key'),
          version: toText(row.strategy_version, 'backtest.strategy_version'),
          name: row.strategy_name ?? row.strategy_key,
        },
        config: fromJson(row.config, {}) as BacktestResult['config'],
        dataset: {
          asset: toText(row.asset_symbol, 'backtest.asset_symbol'),
          timeframe: toTimeframe(row.timeframe),
          source: toDataSource(row.dataset_source),
          candleCount: toNumber(row.candle_count, 'backtest.candle_count'),
          from: row.range_from === null ? null : toEpochMs(row.range_from),
          to: row.range_to === null ? null : toEpochMs(row.range_to),
          label: toText(row.dataset_label, 'backtest.dataset_label'),
        },
        metrics: fromJson(row.metrics, {}) as BacktestResult['metrics'],
        trades: fromJson(row.trades, []) as BacktestResult['trades'],
        warnings: fromJson<string[]>(row.warnings, []),
        // Re-attached from the domain constant rather than stored per row.
        disclaimer: BACKTEST_DISCLAIMER,
      };
    },

    async list(limit = 25): Promise<readonly BacktestRunSummary[]> {
      const result = await executor.query<RunRow>(
        `SELECT r.id, r.run_key, r.strategy_key, r.strategy_version, r.dataset_label,
                r.dataset_source, r.asset_symbol, r.timeframe, r.candle_count, r.started_at,
                r.result_type, res.trades_count, res.win_rate, res.net_pnl
         FROM backtest_runs r
         LEFT JOIN backtest_results res ON res.run_id = r.id
         ORDER BY r.started_at DESC
         LIMIT $1`,
        [limit],
      );

      return result.rows.map((row) => ({
        id: toText(row.id, 'backtest.id'),
        runKey: row.run_key ?? row.id,
        strategyKey: toText(row.strategy_key, 'backtest.strategy_key'),
        strategyVersion: toText(row.strategy_version, 'backtest.strategy_version'),
        datasetLabel: toText(row.dataset_label, 'backtest.dataset_label'),
        datasetSource: toDataSource(row.dataset_source),
        assetSymbol: toText(row.asset_symbol, 'backtest.asset_symbol'),
        timeframe: toTimeframe(row.timeframe),
        candleCount: toNumber(row.candle_count, 'backtest.candle_count'),
        trades: toNumber(row.trades_count ?? 0, 'backtest.trades_count'),
        winRate: toNullableNumber(row.win_rate, 'backtest.win_rate'),
        netPnl: toNumber(row.net_pnl ?? 0, 'backtest.net_pnl'),
        startedAt: toEpochMs(row.started_at, 'backtest.started_at'),
        resultType: toText(row.result_type, 'backtest.result_type'),
      }));
    },
  };
}
