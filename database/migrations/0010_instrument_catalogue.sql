-- Multi-asset instrument metadata, and one symbol normalisation.
--
-- Two things happen here, and they are deliberately in the same transaction.
--
-- 1. `market_assets` gains the metadata a multi-asset catalogue needs. Until
--    now a stored asset knew its symbol, a display name, an asset class and a
--    price precision — enough for one crypto pair and not enough to tell
--    EUR/USD from AAPL, or to know which provider serves either.
--
-- 2. The `BTC-USD` rows are normalised to `BTCUSD`.
--
-- WHY (2) IS NECESSARY, and why it is a normalisation rather than a
-- reinterpretation. `POST /v1/market-data/ingest` used to store whatever
-- `asset` string the caller sent, with no resolution step. The analysis worker
-- was configured with LIVE_ANALYSIS_SYMBOL=BTC-USD, so its candles and signals
-- landed under `BTC-USD`; a later ingest of the same instrument through the
-- provider catalogue would have landed under `BTCUSD`. Same asset, two rows,
-- history split between them, and every per-instrument query silently wrong.
--
-- `BTC-USD` and `BTCUSD` are the same instrument. This renames one spelling to
-- the other across every table that carries it. No row is deleted, no history
-- is discarded, and no value changes meaning — a candle that was Bitcoin before
-- this migration is Bitcoin after it.
--
-- IDEMPOTENT: every statement is guarded, so re-running against an already
-- migrated database is a no-op. Safe on an empty database (nothing matches) and
-- safe on a populated one (the guards prevent a collision with an existing
-- BTCUSD row).

-- ------------------------------------------------------------- metadata ----

-- Presentation, derived from base/quote rather than parsed from `symbol`. This
-- is what lets `BTC-USD` and `BTCUSD` both render as BTC/USD without either
-- string being treated as structure.
ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS display_symbol TEXT;
ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS base_currency  TEXT;
ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS quote_currency TEXT;

-- Which adapter serves this instrument, and what that adapter calls it. The
-- provider symbol is stored for observability and support: when an ingestion
-- fails, the operator needs to know which upstream identifier was requested.
-- Nothing outside the market-data package reads it.
ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS provider_id     TEXT;
ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS provider_symbol TEXT;

-- Quantity precision and minimum size complete the instrument model. BinaryAI's
-- paper positions are denominated in abstract accounting units rather than
-- instrument quantity, so nothing divides by these today; they are stored so
-- the catalogue is complete rather than so a future feature has to migrate.
ALTER TABLE market_assets
  ADD COLUMN IF NOT EXISTS quantity_precision SMALLINT NOT NULL DEFAULT 2
  CHECK (quantity_precision BETWEEN 0 AND 10);
ALTER TABLE market_assets
  ADD COLUMN IF NOT EXISTS minimum_size NUMERIC(20, 8)
  CHECK (minimum_size IS NULL OR minimum_size > 0);

-- When this instrument's market is open. Text with a CHECK rather than an enum:
-- adding a schedule later is then an ALTER rather than an enum migration, and
-- there is no ordering semantics to preserve.
ALTER TABLE market_assets
  ADD COLUMN IF NOT EXISTS trading_schedule TEXT NOT NULL DEFAULT 'unknown'
  CHECK (trading_schedule IN ('24x7', '24x5', 'exchange_session', 'unknown'));

-- Timeframes the provider serves for this instrument. An empty array means
-- "none known", which is different from NULL meaning "never populated".
ALTER TABLE market_assets
  ADD COLUMN IF NOT EXISTS supported_timeframes TEXT[] NOT NULL DEFAULT '{}';

-- True when this row corresponds to an entry in the server-defined catalogue.
-- Rows ingested before the catalogue existed are FALSE until matched, which
-- keeps "we know what this is" separate from "somebody once stored it".
ALTER TABLE market_assets
  ADD COLUMN IF NOT EXISTS in_catalogue BOOLEAN NOT NULL DEFAULT FALSE;

-- Listing the picker by class is the hot read; symbol lookup is already unique.
CREATE INDEX IF NOT EXISTS market_assets_class_idx
  ON market_assets (asset_class, symbol);

-- --------------------------------------------------- symbol normalisation ----

DO $$
DECLARE
  legacy_id UUID;
  target_id UUID;
BEGIN
  SELECT id INTO legacy_id FROM market_assets WHERE symbol = 'BTC-USD';
  IF legacy_id IS NULL THEN
    RETURN; -- Nothing to normalise. Fresh database, or already migrated.
  END IF;

  SELECT id INTO target_id FROM market_assets WHERE symbol = 'BTCUSD';
  IF target_id IS NOT NULL THEN
    -- Both spellings exist. Merging two candle histories means choosing which
    -- bar wins where they overlap, and that is a data decision this migration
    -- has no basis to make silently. Refusing is the honest outcome: an
    -- operator resolves it deliberately.
    RAISE EXCEPTION
      'Both BTC-USD and BTCUSD exist in market_assets. Merge them manually before migrating; this migration will not choose which candle history survives.';
  END IF;

  -- Referencing tables carry the SYMBOL as text (candles reference asset_id and
  -- so need no change). Each is updated explicitly; a missed table would leave
  -- signals pointing at a symbol no asset row has.
  UPDATE market_assets  SET symbol       = 'BTCUSD' WHERE id = legacy_id;
  UPDATE signals        SET asset_symbol = 'BTCUSD' WHERE asset_symbol = 'BTC-USD';
  UPDATE trades         SET asset_symbol = 'BTCUSD' WHERE asset_symbol = 'BTC-USD';
  UPDATE backtest_runs  SET asset_symbol = 'BTCUSD' WHERE asset_symbol = 'BTC-USD';
  UPDATE paper_positions SET asset_symbol = 'BTCUSD' WHERE asset_symbol = 'BTC-USD';

  -- paper_ledger_entries carries no symbol: it reaches an instrument through
  -- position_id. That is why the append-only ledger needs no rewrite here, and
  -- why its immutability trigger is not touched.
END $$;

-- ---------------------------------------------------- catalogue backfill ----

-- Metadata for the instruments that already exist. Written here rather than
-- left to the application so a database migrated offline is immediately
-- coherent. The application re-asserts these values on every ingest, so the
-- catalogue in code stays authoritative; this is a floor, not a fork.
UPDATE market_assets SET
  display_symbol       = COALESCE(display_symbol, 'BTC/USD'),
  base_currency        = COALESCE(base_currency, 'BTC'),
  quote_currency       = COALESCE(quote_currency, 'USD'),
  display_name         = 'Bitcoin / US Dollar',
  provider_id          = COALESCE(provider_id, 'coinbase'),
  provider_symbol      = COALESCE(provider_symbol, 'BTC-USD'),
  asset_class          = 'crypto',
  price_precision      = 2,
  quantity_precision   = 8,
  trading_schedule     = '24x7',
  supported_timeframes = ARRAY['1m', '5m', '15m', '1h', '1d'],
  in_catalogue         = TRUE
WHERE symbol = 'BTCUSD';

UPDATE market_assets SET
  display_symbol       = COALESCE(display_symbol, 'ETH/USDT'),
  base_currency        = COALESCE(base_currency, 'ETH'),
  quote_currency       = COALESCE(quote_currency, 'USDT'),
  provider_id          = COALESCE(provider_id, 'coinbase'),
  provider_symbol      = COALESCE(provider_symbol, 'ETH-USDT'),
  asset_class          = 'crypto',
  trading_schedule     = '24x7',
  supported_timeframes = ARRAY['1m', '5m', '15m', '1h', '1d']
WHERE symbol = 'ETHUSDT';

-- Anything else stored before the catalogue existed keeps its data and is
-- marked as outside the catalogue, rather than being guessed at.
UPDATE market_assets
   SET display_symbol = COALESCE(display_symbol, symbol),
       quote_currency = COALESCE(quote_currency, 'USD')
 WHERE display_symbol IS NULL OR quote_currency IS NULL;
