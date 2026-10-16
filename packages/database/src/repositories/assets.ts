import type { AssetRepository, MarketAsset, StoredAsset, Timeframe } from '@binaryai/types';
import { toAssetClass } from '../enums.js';
import { RecordNotFoundError, type Row, type SqlExecutor } from '../executor.js';
import { toBoolean, toEpochMs, toNumber, toText } from '../mappers.js';

interface AssetRow extends Row {
  id: string;
  symbol: string;
  display_name: string;
  asset_class: string;
  price_precision: number | string;
  is_otc: boolean;
  is_active: boolean;
  created_at: Date;
  display_symbol: string | null;
  base_currency: string | null;
  quote_currency: string | null;
  provider_id: string | null;
  provider_symbol: string | null;
  quantity_precision: number | string | null;
  minimum_size: number | string | null;
  trading_schedule: string | null;
  supported_timeframes: string[] | null;
  in_catalogue: boolean | null;
}

const COLUMNS = `
  id, symbol, display_name, asset_class, price_precision, is_otc, is_active, created_at,
  display_symbol, base_currency, quote_currency, provider_id, provider_symbol,
  quantity_precision, minimum_size, trading_schedule, supported_timeframes, in_catalogue
`;

const SELECT = `SELECT ${COLUMNS} FROM market_assets`;

const SCHEDULES = ['24x7', '24x5', 'exchange_session', 'unknown'] as const;

function toSchedule(value: unknown): MarketAsset['tradingSchedule'] {
  return SCHEDULES.includes(value as (typeof SCHEDULES)[number])
    ? (value as (typeof SCHEDULES)[number])
    : 'unknown';
}

/**
 * Row to domain.
 *
 * Metadata columns are omitted rather than defaulted when NULL. A row stored
 * before the catalogue existed genuinely does not know its base currency, and
 * `undefined` says that; `'USD'` would be a guess indistinguishable from a fact.
 */
function toStoredAsset(row: AssetRow): StoredAsset {
  return {
    id: toText(row.id, 'asset.id'),
    symbol: toText(row.symbol, 'asset.symbol'),
    displayName: toText(row.display_name, 'asset.display_name'),
    assetClass: toAssetClass(row.asset_class),
    pricePrecision: toNumber(row.price_precision, 'asset.price_precision'),
    isOtc: toBoolean(row.is_otc),
    isActive: toBoolean(row.is_active),
    createdAt: toEpochMs(row.created_at, 'asset.created_at'),
    ...(row.display_symbol === null ? {} : { displaySymbol: row.display_symbol }),
    ...(row.base_currency === null ? {} : { baseCurrency: row.base_currency }),
    ...(row.quote_currency === null ? {} : { quoteCurrency: row.quote_currency }),
    ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
    ...(row.provider_symbol === null ? {} : { providerSymbol: row.provider_symbol }),
    ...(row.quantity_precision === null
      ? {}
      : { quantityPrecision: toNumber(row.quantity_precision, 'asset.quantity_precision') }),
    ...(row.minimum_size === null
      ? {}
      : { minimumSize: toNumber(row.minimum_size, 'asset.minimum_size') }),
    ...(row.trading_schedule === null ? {} : { tradingSchedule: toSchedule(row.trading_schedule) }),
    ...(row.supported_timeframes === null
      ? {}
      : { supportedTimeframes: row.supported_timeframes as readonly Timeframe[] }),
    ...(row.in_catalogue === null ? {} : { inCatalogue: toBoolean(row.in_catalogue) }),
  };
}

export function createAssetRepository(executor: SqlExecutor): AssetRepository {
  return {
    /**
     * Insert or update by symbol.
     *
     * COALESCE on every metadata column, so a caller that knows only a symbol
     * cannot blank out catalogue metadata another caller already established.
     * The ingestion path always supplies full metadata; older call sites that
     * pass a bare `MarketAsset` are then non-destructive rather than needing to
     * be found and updated.
     */
    async upsert(asset: MarketAsset): Promise<StoredAsset> {
      const result = await executor.query<AssetRow>(
        `INSERT INTO market_assets (
           symbol, display_name, asset_class, price_precision, is_otc,
           display_symbol, base_currency, quote_currency, provider_id, provider_symbol,
           quantity_precision, minimum_size, trading_schedule, supported_timeframes, in_catalogue
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 -- Explicit casts: a bare parameter inside COALESCE has no
                 -- inferable type, and PostgreSQL refuses it (42804).
                 COALESCE($11::smallint, 2), $12::numeric,
                 COALESCE($13::text, 'unknown'), COALESCE($14::text[], '{}'),
                 COALESCE($15::boolean, FALSE))
         ON CONFLICT (symbol) DO UPDATE SET
           display_name         = EXCLUDED.display_name,
           asset_class          = EXCLUDED.asset_class,
           price_precision      = EXCLUDED.price_precision,
           is_otc               = EXCLUDED.is_otc,
           display_symbol       = COALESCE(EXCLUDED.display_symbol, market_assets.display_symbol),
           base_currency        = COALESCE(EXCLUDED.base_currency, market_assets.base_currency),
           quote_currency       = COALESCE(EXCLUDED.quote_currency, market_assets.quote_currency),
           provider_id          = COALESCE(EXCLUDED.provider_id, market_assets.provider_id),
           provider_symbol      = COALESCE(EXCLUDED.provider_symbol, market_assets.provider_symbol),
           quantity_precision   = EXCLUDED.quantity_precision,
           minimum_size         = COALESCE(EXCLUDED.minimum_size, market_assets.minimum_size),
           trading_schedule     = EXCLUDED.trading_schedule,
           supported_timeframes = EXCLUDED.supported_timeframes,
           in_catalogue         = market_assets.in_catalogue OR EXCLUDED.in_catalogue
         RETURNING ${COLUMNS}`,
        [
          asset.symbol,
          asset.displayName,
          asset.assetClass,
          asset.pricePrecision,
          asset.isOtc,
          asset.displaySymbol ?? null,
          asset.baseCurrency ?? null,
          asset.quoteCurrency ?? null,
          asset.providerId ?? null,
          asset.providerSymbol ?? null,
          asset.quantityPrecision ?? null,
          asset.minimumSize ?? null,
          asset.tradingSchedule ?? null,
          asset.supportedTimeframes ? [...asset.supportedTimeframes] : null,
          asset.inCatalogue ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('market_asset', asset.symbol);
      return toStoredAsset(row);
    },

    async findBySymbol(symbol: string): Promise<StoredAsset | null> {
      const result = await executor.query<AssetRow>(`${SELECT} WHERE symbol = $1`, [symbol]);
      const row = result.rows[0];
      return row ? toStoredAsset(row) : null;
    },

    async list(): Promise<readonly StoredAsset[]> {
      const result = await executor.query<AssetRow>(`${SELECT} ORDER BY symbol`);
      return result.rows.map(toStoredAsset);
    },
  };
}

/** Resolve a symbol to its row id, used by repositories that key on asset_id. */
export async function resolveAssetId(executor: SqlExecutor, symbol: string): Promise<string> {
  const result = await executor.query<{ id: string }>(
    'SELECT id FROM market_assets WHERE symbol = $1',
    [symbol],
  );
  const row = result.rows[0];
  if (!row) throw new RecordNotFoundError('market_asset', symbol);
  return row.id;
}
