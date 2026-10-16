-- 0012 — R8: record whether a backtest run's instrument was ESTABLISHED.
--
-- `asset_symbol` alone cannot answer "is this a real market or the caller's
-- label?", and a run over a hand-supplied series is legitimate but must not be
-- presentable as though its instrument were known.
--
-- Existing rows are left NULL and read back as 'unresolved'. Their symbols were
-- stored as free text before this column existed, so resolving them through
-- today's catalogue would assert an identity that was never established at run
-- time. NULL is the honest record of "not captured", and the read path says so.
ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS instrument_identity TEXT;

ALTER TABLE backtest_runs
  DROP CONSTRAINT IF EXISTS backtest_runs_instrument_identity_known;

ALTER TABLE backtest_runs
  ADD CONSTRAINT backtest_runs_instrument_identity_known CHECK (
    instrument_identity IS NULL OR instrument_identity IN ('catalogue', 'unresolved')
  );
