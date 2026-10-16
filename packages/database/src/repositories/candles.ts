import type {
  Candle,
  CandleCoverage,
  CandleRangeQuery,
  CandleRepository,
  CandleSeries,
  Timeframe,
} from '@binaryai/types';
import { toDataSource, toTimeframe } from '../enums.js';
import { type Row, type SqlExecutor } from '../executor.js';
import { toBoolean, toEpochMs, toNullableNumber, toNumber, toTimestamp } from '../mappers.js';
import { resolveAssetId } from './assets.js';

interface CandleRow extends Row {
  opened_at: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  source: string;
  complete: boolean;
  timeframe: string;
}

function toCandle(row: CandleRow): Candle {
  return {
    timestamp: toEpochMs(row.opened_at, 'candle.opened_at'),
    open: toNumber(row.open, 'candle.open'),
    high: toNumber(row.high, 'candle.high'),
    low: toNumber(row.low, 'candle.low'),
    close: toNumber(row.close, 'candle.close'),
    volume: toNullableNumber(row.volume, 'candle.volume'),
    complete: toBoolean(row.complete),
  };
}

const SELECT_COLUMNS = 'opened_at, timeframe, open, high, low, close, volume, source, complete';

/**
 * Candle storage.
 *
 * Writes are idempotent by primary key `(asset_id, timeframe, opened_at)`: a
 * re-delivered bar updates in place. Duplicate bars are the classic way to
 * corrupt an indicator series, so this is a correctness requirement rather than
 * a convenience.
 *
 * `source` is stored exactly as the series declares it. Synthetic candles stay
 * labelled synthetic in the database, which is what stops them from ever being
 * read back as live-provider data.
 */
export function createCandleRepository(executor: SqlExecutor): CandleRepository {
  async function buildSeries(
    assetSymbol: string,
    timeframe: Timeframe,
    rows: CandleRow[],
  ): Promise<CandleSeries | null> {
    if (rows.length === 0) return null;
    const sources = new Set(rows.map((row) => toDataSource(row.source)));
    return {
      asset: assetSymbol,
      timeframe,
      // Mixed provenance is reported honestly rather than picking a winner.
      source: sources.size === 1 ? [...sources][0]! : 'unknown',
      label:
        sources.size > 1 ? `mixed sources: ${[...sources].join(', ')}` : `stored:${assetSymbol}`,
      candles: rows.map(toCandle),
    };
  }

  return {
    async upsertSeries(series: CandleSeries): Promise<number> {
      if (series.candles.length === 0) return 0;
      const assetId = await resolveAssetId(executor, series.asset);

      let written = 0;
      // Batched rather than one statement per candle: a 5k-bar backfill as 5k
      // round trips is unusably slow, and a single statement with 40k
      // parameters exceeds PostgreSQL's 65535 parameter limit.
      const BATCH = 500;
      for (let start = 0; start < series.candles.length; start += BATCH) {
        const batch = series.candles.slice(start, start + BATCH);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const candle of batch) {
          const base = values.length;
          tuples.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
              `$${base + 7}, $${base + 8}, $${base + 9}::data_source, $${base + 10})`,
          );
          values.push(
            assetId,
            series.timeframe,
            toTimestamp(candle.timestamp),
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume,
            series.source,
            candle.complete,
          );
        }

        const result = await executor.query(
          `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close, volume, source, complete)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (asset_id, timeframe, opened_at) DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
             volume = EXCLUDED.volume, source = EXCLUDED.source, complete = EXCLUDED.complete,
             ingested_at = now()`,
          values,
        );
        written += result.rowCount;
      }
      return written;
    },

    async findRange(query: CandleRangeQuery): Promise<CandleSeries | null> {
      const conditions = ['a.symbol = $1', 'c.timeframe = $2'];
      const params: unknown[] = [query.assetSymbol, query.timeframe];

      if (query.from !== undefined) {
        params.push(toTimestamp(query.from));
        conditions.push(`c.opened_at >= $${params.length}`);
      }
      if (query.to !== undefined) {
        params.push(toTimestamp(query.to));
        conditions.push(`c.opened_at <= $${params.length}`);
      }

      let sql = `SELECT ${SELECT_COLUMNS} FROM candles c
                 JOIN market_assets a ON a.id = c.asset_id
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY c.opened_at ASC`;
      if (query.limit !== undefined) {
        params.push(query.limit);
        sql += ` LIMIT $${params.length}`;
      }

      const result = await executor.query<CandleRow>(sql, params);
      return buildSeries(query.assetSymbol, toTimeframe(query.timeframe), result.rows);
    },

    async latest(
      assetSymbol: string,
      timeframe: Timeframe,
      limit: number,
    ): Promise<CandleSeries | null> {
      // Newest N, then re-sorted ascending: indicators require chronological order.
      const result = await executor.query<CandleRow>(
        `SELECT ${SELECT_COLUMNS} FROM (
           SELECT c.* FROM candles c
           JOIN market_assets a ON a.id = c.asset_id
           WHERE a.symbol = $1 AND c.timeframe = $2
           ORDER BY c.opened_at DESC
           LIMIT $3
         ) recent
         ORDER BY opened_at ASC`,
        [assetSymbol, timeframe, limit],
      );
      return buildSeries(assetSymbol, timeframe, result.rows);
    },

    async count(assetSymbol: string, timeframe: Timeframe): Promise<number> {
      const result = await executor.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM candles c
         JOIN market_assets a ON a.id = c.asset_id
         WHERE a.symbol = $1 AND c.timeframe = $2`,
        [assetSymbol, timeframe],
      );
      return toNumber(result.rows[0]?.total ?? 0, 'candles.count');
    },

    /**
     * Stored coverage for every instrument and timeframe at once.
     *
     * One grouped scan rather than a query per instrument. The instrument
     * picker asks "which of these thirty-six catalogue entries do we actually
     * hold candles for" on every render; doing that one symbol at a time would
     * be thirty-six round trips to answer a question the index already knows.
     *
     * `candles_recent_idx` is (asset_id, timeframe, opened_at DESC), so the
     * GROUP BY is served from the index rather than a heap scan.
     */
    async coverage(): Promise<readonly CandleCoverage[]> {
      const result = await executor.query<{
        symbol: string;
        timeframe: string;
        total: string;
        last_at: Date;
      }>(
        `SELECT a.symbol,
                c.timeframe,
                count(*)::text  AS total,
                max(c.opened_at) AS last_at
           FROM candles c
           JOIN market_assets a ON a.id = c.asset_id
          GROUP BY a.symbol, c.timeframe`,
      );

      return result.rows.map((row) => ({
        assetSymbol: row.symbol,
        timeframe: toTimeframe(row.timeframe),
        candles: toNumber(row.total, 'coverage.total'),
        lastCandleAt: toEpochMs(row.last_at, 'coverage.last_at'),
      }));
    },
  };
}
