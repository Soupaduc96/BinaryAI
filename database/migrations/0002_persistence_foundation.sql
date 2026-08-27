-- BinaryAI :: persistence foundation
--
-- Every change here was forced by a concrete problem found while implementing
-- the repository layer against a real PostgreSQL engine. The schema was not
-- redesigned; these are the gaps that only appear once code writes and reads it.
--
--  1. signals.snapshot        -- 0001 stored reasoning and risk, but not the
--                                indicator/confirmation/conflict/confidence
--                                detail, so a signal could not be replayed
--                                exactly as decided. The relational projection
--                                in signal_features stays: it answers questions
--                                ACROSS signals, the snapshot replays ONE.
--  2. signal_features.meta    -- IndicatorSnapshot.interpretation (bullish /
--                                bearish / neutral) had nowhere to live.
--  3. signal_outcomes.payout  -- the payout terms assumed when scoring an
--     signal_outcomes.metadata   outcome, plus settlement provenance. Required
--                                by the calibration data model: a win under an
--                                80% payout is not the same sample as a win
--                                under 70%.
--  4. backtest_runs.run_key   -- the engine's deterministic run id (bt_<hash>)
--                                had no home; re-running an identical backtest
--                                must be recognisable as the same run.
--  5. signal_calibration_samples -- the read model that makes future confidence
--                                calibration possible. Creating the VIEW does
--                                NOT calibrate anything; confidence remains
--                                'uncalibrated_heuristic'. See
--                                docs/ai-architecture.md.

ALTER TABLE signals
  ADD COLUMN snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The engine's own signal id is 'sig_<uuid>' in live analysis and
  -- 'sig_<hash>' in a backtest -- neither is a valid UUID, so it cannot be the
  -- primary key. The row keeps its UUID; the engine id is stored verbatim here
  -- so a signal can be found by the id the API actually returned.
  ADD COLUMN signal_key TEXT;

CREATE UNIQUE INDEX signals_signal_key_idx ON signals (signal_key);

COMMENT ON COLUMN signals.snapshot IS
  'Full domain Signal as decided, for exact replay. signal_features is the queryable projection of the same evidence.';

ALTER TABLE signal_features
  ADD COLUMN meta JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE signal_outcomes
  ADD COLUMN payout   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE backtest_runs
  ADD COLUMN run_key TEXT;

CREATE UNIQUE INDEX backtest_runs_run_key_idx ON backtest_runs (run_key);

-- Supports "how many settled outcomes do we have for this strategy?", the
-- question that gates any future calibration work.
CREATE INDEX signals_data_source_idx ON signals (data_source, decided_at DESC);

-- ----------------------------------------------------- calibration samples --
--
-- One row per SETTLED signal, carrying everything a calibration model would
-- need: what was predicted, under which conditions, and what actually happened.
-- Built as a VIEW so it cannot drift from its sources.
--
-- NOTE: data_source is included deliberately. A sample generated from synthetic
-- candles must never be pooled with live-market samples, and the column makes
-- that filterable rather than a convention someone has to remember.

CREATE VIEW signal_calibration_samples AS
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
  o.metadata                    AS result_metadata
FROM signals s
JOIN signal_outcomes o ON o.signal_id = s.id
LEFT JOIN strategies st ON st.id = s.strategy_id;

COMMENT ON VIEW signal_calibration_samples IS
  'Read model for future confidence calibration. Its existence does not imply calibration is implemented.';
