-- BinaryAI :: initial schema
--
-- Design notes
--  * Demo-only is enforced in the database, not just in application code:
--    accounts and trades carry a CHECK constraint pinning execution_mode to
--    'demo'. Enabling live trading is therefore a deliberate, reviewable
--    migration rather than a config flag someone can flip.
--  * Money and prices use NUMERIC. Never FLOAT: binary settlement compares two
--    prices for equality, and float rounding would silently create ties.
--  * Explainability is first-class: every signal keeps its features, its
--    confidence components and its reasoning, so an old decision can be
--    reconstructed exactly.
--  * Timestamps are TIMESTAMPTZ, always UTC.
--
-- Applied by the migration runner (npm run db:migrate), which owns the
-- transaction and the schema_migrations ledger. Do not add BEGIN/COMMIT here.

-- ---------------------------------------------------------------- enums ----

CREATE TYPE execution_mode   AS ENUM ('demo', 'live');
CREATE TYPE signal_direction AS ENUM ('call', 'put', 'none');
CREATE TYPE market_regime    AS ENUM ('trend_up', 'trend_down', 'range', 'volatile', 'quiet', 'unknown');
CREATE TYPE risk_level       AS ENUM ('low', 'medium', 'high', 'extreme');
CREATE TYPE signal_status    AS ENUM ('candidate', 'accepted', 'rejected', 'expired', 'settled', 'cancelled');
CREATE TYPE recommendation   AS ENUM ('consider', 'wait_for_confirmation', 'skip');
CREATE TYPE trade_outcome    AS ENUM ('win', 'loss', 'tie', 'unresolved');
CREATE TYPE data_source      AS ENUM ('live_provider', 'historical_provider', 'historical_file', 'synthetic', 'unknown');
CREATE TYPE feature_kind     AS ENUM ('indicator', 'confirmation', 'conflict', 'confidence_component');
CREATE TYPE event_level      AS ENUM ('debug', 'info', 'warning', 'error', 'critical');
CREATE TYPE calibration_kind AS ENUM ('uncalibrated_heuristic', 'backtest_calibrated', 'model_calibrated');

-- ------------------------------------------------------- users/accounts ----

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  -- Argon2id/bcrypt digest. A plaintext password must never reach this table.
  password_hash  TEXT NOT NULL,
  display_name   TEXT,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name               TEXT NOT NULL DEFAULT 'Demo account',
  -- Enforced at the storage layer: this build cannot hold a live account.
  mode               execution_mode NOT NULL DEFAULT 'demo' CHECK (mode = 'demo'),
  currency           TEXT NOT NULL DEFAULT 'USD',
  balance            NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  day_start_balance  NUMERIC(20, 8) NOT NULL DEFAULT 0,
  open_exposure      NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (open_exposure >= 0),
  consecutive_losses INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_losses >= 0),
  last_loss_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);

-- --------------------------------------------------------- market data ----

CREATE TABLE market_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  asset_class     TEXT NOT NULL DEFAULT 'unknown',
  price_precision SMALLINT NOT NULL DEFAULT 5 CHECK (price_precision BETWEEN 0 AND 10),
  is_otc          BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per candle. The composite primary key makes ingestion idempotent:
-- re-delivering a candle updates it rather than duplicating history.
CREATE TABLE candles (
  asset_id   UUID NOT NULL REFERENCES market_assets (id) ON DELETE CASCADE,
  timeframe  TEXT NOT NULL,
  opened_at  TIMESTAMPTZ NOT NULL,
  open       NUMERIC(20, 8) NOT NULL CHECK (open > 0),
  high       NUMERIC(20, 8) NOT NULL CHECK (high > 0),
  low        NUMERIC(20, 8) NOT NULL CHECK (low > 0),
  close      NUMERIC(20, 8) NOT NULL CHECK (close > 0),
  volume     NUMERIC(20, 8),
  source     data_source NOT NULL DEFAULT 'unknown',
  complete   BOOLEAN NOT NULL DEFAULT TRUE,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, timeframe, opened_at),
  CONSTRAINT candles_ohlc_consistent CHECK (
    high >= low AND high >= GREATEST(open, close) AND low <= LEAST(open, close)
  )
);
CREATE INDEX candles_recent_idx ON candles (asset_id, timeframe, opened_at DESC);

-- ----------------------------------------------------------- strategies ----

-- The registry lives in code (@binaryai/strategies). This table records which
-- versions have been seen, so a signal from an old version stays attributable.
CREATE TABLE strategies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_key  TEXT NOT NULL,
  version       TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  parameters    JSONB NOT NULL DEFAULT '[]'::jsonb,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strategy_key, version)
);

-- -------------------------------------------------------------- signals ----

CREATE TABLE signals (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              UUID REFERENCES accounts (id) ON DELETE SET NULL,
  asset_id                UUID REFERENCES market_assets (id) ON DELETE SET NULL,
  asset_symbol            TEXT NOT NULL,
  timeframe               TEXT NOT NULL,
  strategy_id             UUID REFERENCES strategies (id) ON DELETE SET NULL,
  direction               signal_direction NOT NULL,
  status                  signal_status NOT NULL DEFAULT 'candidate',
  recommendation          recommendation NOT NULL DEFAULT 'skip',
  market_regime           market_regime NOT NULL DEFAULT 'unknown',
  risk_level              risk_level NOT NULL DEFAULT 'medium',
  confidence              NUMERIC(6, 5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- Stored with the score so a number can never be displayed without knowing
  -- whether it means anything.
  confidence_calibration  calibration_kind NOT NULL DEFAULT 'uncalibrated_heuristic',
  confidence_sample_size  INTEGER,
  price                   NUMERIC(20, 8) NOT NULL,
  decided_at              TIMESTAMPTZ NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  expiration_seconds      INTEGER NOT NULL CHECK (expiration_seconds > 0),
  execution_mode          execution_mode NOT NULL DEFAULT 'demo' CHECK (execution_mode = 'demo'),
  data_source             data_source NOT NULL DEFAULT 'unknown',
  data_quality_score      NUMERIC(4, 3) NOT NULL DEFAULT 0 CHECK (data_quality_score BETWEEN 0 AND 1),
  reasoning               JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_assessment         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signals_expiry_after_decision CHECK (expires_at > decided_at)
);
CREATE INDEX signals_asset_time_idx ON signals (asset_symbol, decided_at DESC);
CREATE INDEX signals_status_idx ON signals (status, decided_at DESC);
CREATE INDEX signals_strategy_idx ON signals (strategy_id, decided_at DESC);

-- Indicators, confirmations, conflicts and confidence components in one shape.
-- Keeping them relational (rather than only inside a JSON blob) is what makes
-- "which conditions preceded losing signals?" answerable later.
CREATE TABLE signal_features (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal_id     UUID NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  kind          feature_kind NOT NULL,
  code          TEXT NOT NULL,
  label         TEXT NOT NULL,
  numeric_value NUMERIC(20, 8),
  weight        NUMERIC(6, 5),
  severity      TEXT,
  detail        TEXT
);
CREATE INDEX signal_features_signal_idx ON signal_features (signal_id);
CREATE INDEX signal_features_code_idx ON signal_features (code, kind);

-- Ground truth. Written after expiry; the input to future calibration.
CREATE TABLE signal_outcomes (
  signal_id         UUID PRIMARY KEY REFERENCES signals (id) ON DELETE CASCADE,
  settled_at        TIMESTAMPTZ NOT NULL,
  settlement_price  NUMERIC(20, 8) NOT NULL,
  result            trade_outcome NOT NULL,
  price_delta       NUMERIC(20, 8) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX signal_outcomes_result_idx ON signal_outcomes (result, settled_at DESC);

-- --------------------------------------------------------------- trades ----

CREATE TABLE trades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  signal_id         UUID REFERENCES signals (id) ON DELETE SET NULL,
  asset_symbol      TEXT NOT NULL,
  direction         signal_direction NOT NULL CHECK (direction <> 'none'),
  stake             NUMERIC(20, 8) NOT NULL CHECK (stake > 0),
  entry_price       NUMERIC(20, 8) NOT NULL CHECK (entry_price > 0),
  opened_at         TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  settlement_price  NUMERIC(20, 8),
  settled_at        TIMESTAMPTZ,
  outcome           trade_outcome,
  pnl               NUMERIC(20, 8),
  payout_rate       NUMERIC(6, 4) NOT NULL DEFAULT 0.8,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  -- Paper trading only. A live trade cannot be recorded by this schema.
  execution_mode    execution_mode NOT NULL DEFAULT 'demo' CHECK (execution_mode = 'demo'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trades_settled_fields CHECK (
    (status <> 'settled') OR (settlement_price IS NOT NULL AND outcome IS NOT NULL AND pnl IS NOT NULL)
  )
);
CREATE INDEX trades_account_idx ON trades (account_id, opened_at DESC);
CREATE INDEX trades_signal_idx ON trades (signal_id);

-- ----------------------------------------------------------- backtests ----

CREATE TABLE backtest_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users (id) ON DELETE SET NULL,
  strategy_id    UUID REFERENCES strategies (id) ON DELETE SET NULL,
  strategy_key   TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  -- Pinned: this table stores simulations, never live results.
  result_type    TEXT NOT NULL DEFAULT 'historical_simulation'
                 CHECK (result_type = 'historical_simulation'),
  dataset_label  TEXT NOT NULL,
  dataset_source data_source NOT NULL,
  asset_symbol   TEXT NOT NULL,
  timeframe      TEXT NOT NULL,
  candle_count   INTEGER NOT NULL CHECK (candle_count >= 0),
  range_from     TIMESTAMPTZ,
  range_to       TIMESTAMPTZ,
  config         JSONB NOT NULL,
  warnings       JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX backtest_runs_strategy_idx ON backtest_runs (strategy_key, started_at DESC);

CREATE TABLE backtest_results (
  run_id               UUID PRIMARY KEY REFERENCES backtest_runs (id) ON DELETE CASCADE,
  trades_count         INTEGER NOT NULL DEFAULT 0,
  wins                 INTEGER NOT NULL DEFAULT 0,
  losses               INTEGER NOT NULL DEFAULT 0,
  ties                 INTEGER NOT NULL DEFAULT 0,
  -- NULL, not 0, when no trade resolved: absence of data is not a 0% win rate.
  win_rate             NUMERIC(6, 5),
  net_pnl              NUMERIC(20, 8) NOT NULL DEFAULT 0,
  return_percent       NUMERIC(12, 6) NOT NULL DEFAULT 0,
  max_drawdown         NUMERIC(20, 8) NOT NULL DEFAULT 0,
  max_drawdown_percent NUMERIC(12, 6) NOT NULL DEFAULT 0,
  longest_win_streak   INTEGER NOT NULL DEFAULT 0,
  longest_loss_streak  INTEGER NOT NULL DEFAULT 0,
  profit_factor        NUMERIC(12, 6),
  metrics              JSONB NOT NULL DEFAULT '{}'::jsonb,
  trades               JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- -------------------------------------------------------------- events ----

CREATE TABLE risk_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id     UUID REFERENCES accounts (id) ON DELETE SET NULL,
  signal_id      UUID REFERENCES signals (id) ON DELETE SET NULL,
  code           TEXT NOT NULL,
  severity       TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  message        TEXT NOT NULL,
  execution_mode execution_mode NOT NULL DEFAULT 'demo',
  context        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX risk_events_time_idx ON risk_events (occurred_at DESC);
CREATE INDEX risk_events_code_idx ON risk_events (code, occurred_at DESC);

-- Append-only operational log and audit trail.
CREATE TABLE system_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  level          event_level NOT NULL DEFAULT 'info',
  category       TEXT NOT NULL,
  code           TEXT NOT NULL,
  message        TEXT NOT NULL,
  user_id        UUID REFERENCES users (id) ON DELETE SET NULL,
  execution_mode execution_mode,
  context        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX system_events_time_idx ON system_events (occurred_at DESC);
CREATE INDEX system_events_category_idx ON system_events (category, level, occurred_at DESC);
