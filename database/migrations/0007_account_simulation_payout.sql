-- BinaryAI :: optional per-account simulation payout
--
-- Phase 5 deliberately shipped exposure-only accounting: a win and a loss
-- released exactly the same units, because a binary payout is broker-defined
-- and BinaryAI has no broker (ADR-0013).
--
-- This migration adds the honest way to get a moving balance: an assumption the
-- USER supplies, stored on their own account, versioned, and stamped on every
-- entry it produces. BinaryAI still asserts no payout rate. It answers "what
-- would this look like at the rate YOU specified", which is a different claim
-- and a defensible one.
--
-- Three properties the schema enforces:
--   * OFF by default. An account that never configures one keeps exposure-only
--     accounting and a balance that does not move.
--   * Rates are bounded. A 900% payout is not a simulation, it is a fantasy.
--   * The version is stamped on every ledger entry, so changing the rate later
--     cannot retroactively rewrite what a past settlement was worth.

ALTER TABLE accounts
  -- Off by default. Enabling it is an explicit act by the account owner.
  ADD COLUMN payout_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Profit as a fraction of size on a win. 0.8 = +80%.
  ADD COLUMN payout_win_rate         NUMERIC(6, 4) NOT NULL DEFAULT 0
    CHECK (payout_win_rate >= 0 AND payout_win_rate <= 5),
  -- Fraction of size returned on a loss. Usually 0; some brokers refund a little.
  ADD COLUMN payout_loss_refund_rate NUMERIC(6, 4) NOT NULL DEFAULT 0
    CHECK (payout_loss_refund_rate >= 0 AND payout_loss_refund_rate <= 1),
  ADD COLUMN payout_tie_policy       TEXT NOT NULL DEFAULT 'refund'
    CHECK (payout_tie_policy IN ('refund', 'loss')),
  -- The user's own description of where the rate came from. Carried onto every
  -- figure derived from it so a number is never shown without its assumption.
  ADD COLUMN payout_note             TEXT,
  ADD COLUMN payout_version          INTEGER NOT NULL DEFAULT 1
    CHECK (payout_version >= 1);

-- An enabled payout with a zero win rate is not a simulation, it is a way to
-- lose units on every settlement. Refused outright.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_payout_coherent
    CHECK (payout_enabled = FALSE OR payout_win_rate > 0);

COMMENT ON COLUMN accounts.payout_win_rate IS
  'A USER-SUPPLIED assumption, not a rate BinaryAI asserts. Applies to paper positions only.';

-- ------------------------------------------------- ledger entry reference ----
--
-- Replaces the 0005 constraint so a 'simulated_payout' entry may name the
-- position it settles. The enum value itself was added in 0006; see the note
-- there for why the two cannot be one migration.

ALTER TABLE paper_ledger_entries
  DROP CONSTRAINT paper_ledger_position_reference;

ALTER TABLE paper_ledger_entries
  ADD CONSTRAINT paper_ledger_position_reference CHECK (
    (type IN ('exposure_committed', 'exposure_released', 'simulated_payout')
      AND position_id IS NOT NULL)
    OR (type IN ('initial_allocation', 'adjustment', 'reset') AND position_id IS NULL)
  );

-- ------------------------------------------------------ sign discipline ----
--
-- The 0005 CHECK constrained the direction of every entry type it knew about
-- and refused anything else, so it must be replaced rather than left alone.
--
-- A payout entry is signed BOTH ways by design -- positive on a win, negative
-- on a loss -- so it joins the arm that carries no direction constraint. The
-- fixed-direction types keep theirs: a commit that credited an account, or a
-- release that debited one, would silently corrupt the derived balance.

ALTER TABLE paper_ledger_entries
  DROP CONSTRAINT paper_ledger_sign;

ALTER TABLE paper_ledger_entries
  ADD CONSTRAINT paper_ledger_sign CHECK (
    (type = 'exposure_committed' AND amount < 0)
    OR (type = 'exposure_released' AND amount > 0)
    OR (type IN ('initial_allocation', 'adjustment', 'reset', 'simulated_payout'))
  );

-- At most one payout entry per position, so a retried settlement cannot pay
-- twice. Mirrors the exposure_committed/exposure_released guarantee from 0005;
-- that index already covers this because it keys on (position_id, type).

COMMENT ON TYPE ledger_entry_type IS
  'simulated_payout applies a USER-CONFIGURED assumption. It is never derived from a broker.';
