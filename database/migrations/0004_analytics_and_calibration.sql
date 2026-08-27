-- BinaryAI :: analytics, calibration eligibility and outcome provenance
--
-- Phase 4 turns accumulated outcomes into measurement. Nothing here computes a
-- statistic; it makes the underlying facts queryable, scoped and auditable.
--
-- Three problems in the existing read model had to be fixed before any honest
-- analytics were possible:
--
--  1. `signal_calibration_samples` carried no `account_id`, so a per-user query
--     was impossible -- analytics would have had to pool every account's private
--     signals into one number.
--  2. It carried no `status`, so a signal REJECTED by the risk engine looked
--     identical to one that was accepted and then lost. Counting a rejection as
--     a loss would understate accuracy and, worse, would invent a directional
--     claim the engine never made.
--  3. There was no record of WHY a settled signal was unusable, so exclusions
--     would have been silent.
--
-- Nothing existing is dropped or rewritten. Historical outcomes are untouched.

-- ------------------------------------------ extended calibration samples ----
--
-- CREATE OR REPLACE keeps the existing column list and order intact and appends
-- the new ones, so any consumer of the old view continues to work unchanged.

CREATE OR REPLACE VIEW signal_calibration_samples AS
SELECT
  s.id                          AS signal_id,
  s.asset_symbol,
  s.timeframe,
  s.direction,
  s.decided_at                  AS entry_at,
  s.expires_at,
  o.settled_at,
  s.price                       AS entry_price,
  o.settlement_price            AS expiry_price,
  o.result,
  o.price_delta,
  NULLIF(o.payout, '{}'::jsonb) AS payout_assumption,
  st.strategy_key,
  st.version                    AS strategy_version,
  s.confidence                  AS confidence_at_signal,
  s.confidence_calibration,
  s.market_regime,
  s.risk_level,
  s.data_quality_score,
  s.data_source,
  COALESCE(
    (
      SELECT jsonb_object_agg(f.code, f.numeric_value)
      FROM signal_features f
      WHERE f.signal_id = s.id
        AND f.kind = 'indicator'
        AND f.numeric_value IS NOT NULL
    ),
    '{}'::jsonb
  )                             AS market_conditions,
  o.metadata                    AS result_metadata,
  -- ---- appended in 0004 -------------------------------------------------
  -- Ownership. NULL is a system signal from the runtime worker, readable by
  -- every user; a value scopes the row to one account (ADR-0011).
  s.account_id,
  -- Whether the engine actually made a directional claim. A 'rejected' signal
  -- made none, and must never contribute a win or a loss.
  s.status,
  s.recommendation,
  s.expiration_seconds,
  s.execution_mode,
  s.confidence_sample_size,
  -- Provenance of the settlement price itself, distinct from the candle data
  -- origin above. BinaryAI has no broker feed, so this is 'exchange' for
  -- worker-settled rows -- never broker settlement.
  o.metadata ->> 'dataOrigin'   AS settlement_data_origin
FROM signals s
JOIN signal_outcomes o ON o.signal_id = s.id
LEFT JOIN strategies st ON st.id = s.strategy_id;

COMMENT ON VIEW signal_calibration_samples IS
  'Read model for confidence measurement. Its existence does not imply a calibration model exists.';

-- ------------------------------------------------ eligibility read model ----
--
-- One row per SETTLED signal with an explicit verdict attached.
-- `exclusion_reason IS NULL` means eligible; anything else names the rule that
-- rejected it. Keeping excluded rows visible is the point: "400 settled, 37
-- excluded because the strategy row was missing" is auditable, whereas
-- filtering them away silently is not.
--
-- The ORDER of the CASE arms is the eligibility policy, and it is deliberate:
-- the most fundamental disqualification is tested first, so a row is always
-- reported against the first rule it fails rather than an arbitrary one.

CREATE VIEW calibration_eligibility AS
SELECT
  c.signal_id,
  c.account_id,
  c.asset_symbol,
  c.timeframe,
  c.direction,
  c.strategy_key,
  c.strategy_version,
  c.market_regime,
  c.confidence_at_signal,
  c.confidence_calibration,
  c.data_source,
  c.settlement_data_origin,
  c.result,
  c.status,
  c.entry_at,
  c.settled_at,
  CASE
    -- No directional claim was made, so there is nothing to be right about.
    WHEN c.direction = 'none'                THEN 'no_direction'
    -- Risk rejected it, or it never advanced past candidate. The engine
    -- declined to act; counting it would invent a prediction.
    WHEN c.status <> 'accepted'              THEN 'not_accepted'
    -- Expired with no settlement candle. Pending, not failed.
    WHEN c.result = 'unresolved'             THEN 'not_settled'
    WHEN c.strategy_key IS NULL              THEN 'missing_strategy'
    WHEN c.confidence_at_signal IS NULL      THEN 'missing_confidence'
    WHEN c.market_regime IS NULL             THEN 'missing_market_context'
    -- Synthetic candles must never pool with live-market observations.
    WHEN c.data_source = 'synthetic'         THEN 'synthetic_data'
    WHEN c.settlement_data_origin IS NULL    THEN 'unknown_data_origin'
    ELSE NULL
  END AS exclusion_reason
FROM signal_calibration_samples c;

COMMENT ON VIEW calibration_eligibility IS
  'Every settled signal with an explicit eligibility verdict. NULL exclusion_reason means eligible.';

-- ----------------------------------------------------------- indexes ----
--
-- Analytics aggregates group by strategy, regime, timeframe, asset and time,
-- always filtered by ownership. These support that access pattern; without them
-- every dashboard load is a sequential scan of the signals table.

-- The dominant analytics predicate: owner + settled time window.
CREATE INDEX signals_analytics_idx
  ON signals (account_id, decided_at DESC)
  WHERE status = 'accepted' AND direction <> 'none';

-- Time-series bucketing and the recency split both order by settlement time.
CREATE INDEX signal_outcomes_settled_at_idx ON signal_outcomes (settled_at DESC);

-- Grouping by regime and by timeframe over accepted directional signals.
CREATE INDEX signals_regime_idx ON signals (market_regime, decided_at DESC)
  WHERE status = 'accepted' AND direction <> 'none';
CREATE INDEX signals_timeframe_idx ON signals (timeframe, decided_at DESC)
  WHERE status = 'accepted' AND direction <> 'none';

-- ------------------------------------------------- methodology registry ----
--
-- Records which methodology produced a published result, so changing the method
-- later cannot silently rewrite how an old figure should be read. Rows are
-- append-only by convention; nothing updates them.

CREATE TABLE calibration_runs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method                     TEXT NOT NULL,
  method_version             TEXT NOT NULL,
  sample_definition_version  TEXT NOT NULL,
  bucket_version             TEXT NOT NULL,
  confidence_source          TEXT NOT NULL,
  -- FALSE until a validated calibration MODEL exists. Accumulating samples is
  -- a prerequisite for calibration, never evidence of it.
  model_implemented          BOOLEAN NOT NULL DEFAULT FALSE,
  eligible_samples           INTEGER NOT NULL CHECK (eligible_samples >= 0),
  settled_samples            INTEGER NOT NULL CHECK (settled_samples >= 0),
  excluded_samples           INTEGER NOT NULL CHECK (excluded_samples >= 0),
  evidence_level             TEXT NOT NULL,
  -- Full report as generated, so an old result stays reproducible verbatim
  -- even after the methodology moves on.
  report                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_id                 UUID REFERENCES accounts (id) ON DELETE CASCADE,
  generated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calibration_runs_generated_idx ON calibration_runs (generated_at DESC);
CREATE INDEX calibration_runs_account_idx ON calibration_runs (account_id, generated_at DESC);

COMMENT ON TABLE calibration_runs IS
  'Append-only record of published calibration measurements and the methodology that produced each.';
COMMENT ON COLUMN calibration_runs.model_implemented IS
  'TRUE only when a validated calibration model exists. Sample volume alone never sets this.';
