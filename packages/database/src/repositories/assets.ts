import type { AssetRepository, MarketAsset, StoredAsset } from '@binaryai/types';
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
}

const SELECT = `
  SELECT id, symbol, display_name, asset_class, price_precision, is_otc, is_active, created_at
  FROM market_assets
`;

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
  };
}

export function createAssetRepository(executor: SqlExecutor): AssetRepository {
  return {
    async upsert(asset: MarketAsset): Promise<StoredAsset> {
      const result = await executor.query<AssetRow>(
        `INSERT INTO market_assets (symbol, display_name, asset_class, price_precision, is_otc)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (symbol) DO UPDATE SET
           display_name    = EXCLUDED.display_name,
           asset_class     = EXCLUDED.asset_class,
           price_precision = EXCLUDED.price_precision,
           is_otc          = EXCLUDED.is_otc
         RETURNING id, symbol, display_name, asset_class, price_precision, is_otc, is_active, created_at`,
        [asset.symbol, asset.displayName, asset.assetClass, asset.pricePrecision, asset.isOtc],
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
