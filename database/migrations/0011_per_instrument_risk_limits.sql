-- Optional per-instrument risk limits.
--
-- WHY. Account limits are account-wide, and they stay that way — this column
-- cannot raise them. What it adds is the ability to SUBDIVIDE the account
-- ceiling. With several instruments analysed, a single account-wide
-- `max_open_positions = 1` means the first instrument to produce a signal takes
-- the only slot and every other instrument is blocked for as long as it is
-- held. That starvation is not something anybody configured; it is what a
-- single global counter does when the system stops being single-instrument.
--
-- SHAPE. A JSONB object keyed by CANONICAL catalogue symbol:
--
--   {"BTCUSD": {"maxOpenPositions": 2, "maxExposureFraction": 0.5},
--    "ETHUSD": {"maxOpenPositions": 1, "isolateCooldown": true}}
--
-- JSONB rather than a table because these are policy values read as a unit with
-- the rest of the account's policy, never queried across accounts, and always
-- rewritten wholesale. A child table would add a join to every risk evaluation
-- to model something that has no independent identity.
--
-- BACKWARD COMPATIBLE BY DEFAULT. NULL means "no instrument-specific limits",
-- which is precisely the behaviour every existing account has today. No row is
-- rewritten, no default is guessed, and an account that never sets this keeps
-- evaluating exactly as it did before.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS per_instrument_limits JSONB;

-- Must be an object, never an array or a scalar. Without this a client could
-- store `[1,2,3]` and the risk evaluator would read undefined limits for every
-- instrument — failing OPEN, which is the wrong direction for a risk control.
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_per_instrument_limits_object;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_per_instrument_limits_object CHECK (
    per_instrument_limits IS NULL OR jsonb_typeof(per_instrument_limits) = 'object'
  );
