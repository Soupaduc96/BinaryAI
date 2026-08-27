-- BinaryAI :: versioned, server-defined paper simulation models
--
-- WHAT THIS REPLACES, AND WHY
--
-- 0007 let an account holder PATCH their own payout rate onto their account.
-- That made the client the author of the accounting model, which is the one
-- thing a simulation whose numbers look like money must never allow: any
-- figure it produced was only as trustworthy as whatever the caller last
-- typed, and two accounts could report incomparable results with no record of
-- why.
--
-- This migration moves the rules into a SERVER-DEFINED CATALOGUE. A user may
-- select among models. A user may not invent one. Every model is immutable
-- once published and identified by (model_key, version), so a simulated figure
-- can always be traced to the exact arithmetic that produced it.
--
-- THE THREE THINGS THIS SCHEMA KEEPS APART
--
--   exchange market data   what the market did          (candles)
--   observed outcome       whether the call was right   (paper_positions.result)
--   simulated return       what a stated model computes (this migration)
--
-- The first two are facts. The third is arithmetic on a premise, and the
-- premise is named on every row that carries one.

-- ------------------------------------------------------------- catalogue ----

CREATE TABLE simulation_models (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identity across versions. 'demo_return' stays 'demo_return' when
  -- its parameters change; the version is what moves.
  model_key     TEXT NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{2,39}$'),
  -- Semver. Text rather than an integer so a parameter change and a rule
  -- change can be told apart by anyone reading a stamped ledger entry.
  version       TEXT NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  -- Every assumption that materially affects a result. Nothing that changes a
  -- number may live only in application code; see the CHECK below.
  parameters    JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'deprecated')),
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A version is published once. Re-publishing (model_key, version) with
  -- different arithmetic would silently reinterpret every entry stamped with
  -- it, which is precisely the failure versioning exists to prevent.
  CONSTRAINT simulation_models_identity UNIQUE (model_key, version),

  -- The parameters a result actually depends on must be present and of the
  -- right shape. A model missing its tie rule would otherwise settle ties by
  -- whatever the application happened to default to -- an assumption hidden in
  -- code, which section 4 forbids.
  CONSTRAINT simulation_models_parameters_complete CHECK (
    parameters ? 'startingUnits'
    AND parameters ? 'simulatedReturnRate'
    AND parameters ? 'lossRule'
    AND parameters ? 'tieRule'
    AND parameters ? 'roundingDecimals'
    AND jsonb_typeof(parameters -> 'startingUnits') = 'number'
    AND jsonb_typeof(parameters -> 'simulatedReturnRate') = 'number'
    AND jsonb_typeof(parameters -> 'roundingDecimals') = 'number'
    AND (parameters ->> 'lossRule') IN ('forfeit_exposure', 'partial_refund')
    AND (parameters ->> 'tieRule') IN ('refund_exposure', 'treat_as_loss')
    AND (parameters ->> 'startingUnits')::numeric >= 0
    -- Bounded for the same reason the superseded model bounded it: a 900%
    -- return is not a simulation of any instrument, it is a way to make the
    -- account screen produce impressive numbers.
    AND (parameters ->> 'simulatedReturnRate')::numeric >= 0
    AND (parameters ->> 'simulatedReturnRate')::numeric <= 5
    AND (parameters ->> 'roundingDecimals')::numeric BETWEEN 0 AND 8
  )
);

CREATE INDEX simulation_models_active_idx
  ON simulation_models (model_key, effective_at DESC)
  WHERE status = 'active';

COMMENT ON TABLE simulation_models IS
  'Server-defined, versioned paper simulation rules. Not broker terms. A client may select a model but may never define one.';
COMMENT ON COLUMN simulation_models.parameters IS
  'Every assumption that materially affects a simulated result. Named simulatedReturnRate, never payout: no counterparty pays anything.';

-- Published models are immutable. Without this, editing a row would rewrite
-- the meaning of every ledger entry already stamped with its version while
-- leaving the entries themselves untouched -- an audit trail that lies without
-- ever being modified.
CREATE OR REPLACE FUNCTION refuse_published_model_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'simulation_models rows are immutable once published (model %, version %)',
        OLD.model_key, OLD.version;
    END IF;
    RETURN OLD;
  END IF;

  -- Status may advance (draft -> active -> deprecated); arithmetic may not change.
  IF OLD.status <> 'draft' AND (
       NEW.parameters IS DISTINCT FROM OLD.parameters
    OR NEW.model_key  IS DISTINCT FROM OLD.model_key
    OR NEW.version    IS DISTINCT FROM OLD.version
  ) THEN
    RAISE EXCEPTION 'the arithmetic of a published simulation model cannot change (model %, version %)',
      OLD.model_key, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER simulation_models_immutable
  BEFORE UPDATE OR DELETE ON simulation_models
  FOR EACH ROW EXECUTE FUNCTION refuse_published_model_mutation();

-- ------------------------------------------------------- account selection ----
--
-- NULL means no simulation. That is the default and it is a real state, not a
-- missing one: an account with no model keeps exposure-only accounting and has
-- no simulated value at all. The dashboard renders that as SIMULATION OFF
-- rather than as a zero, because zero is a number and "none" is not.
--
-- ON DELETE RESTRICT: a model that any account references cannot be removed.

ALTER TABLE accounts
  ADD COLUMN simulation_model_id UUID REFERENCES simulation_models (id) ON DELETE RESTRICT;

CREATE INDEX accounts_simulation_model_idx
  ON accounts (simulation_model_id)
  WHERE simulation_model_id IS NOT NULL;

COMMENT ON COLUMN accounts.simulation_model_id IS
  'Selected server-defined model. NULL means simulation is off, which is distinct from a simulated value of zero.';

-- The superseded per-account assumption columns from 0007. Left in place
-- rather than dropped, the same treatment 0005 gave the legacy `trades` table:
-- dropping them would destroy the only record of what produced any existing
-- simulated_payout entry. No code reads them after this migration.
COMMENT ON COLUMN accounts.payout_enabled IS
  'SUPERSEDED by accounts.simulation_model_id (0009). Retained so historical simulated_payout entries stay interpretable. Not read by any code path.';
COMMENT ON COLUMN accounts.payout_win_rate IS
  'SUPERSEDED by simulation_models.parameters (0009). A client-supplied rate is no longer accepted. Not read by any code path.';

-- --------------------------------------------------------- ledger stamping ----

ALTER TABLE paper_ledger_entries
  ADD COLUMN simulation_model_id      UUID REFERENCES simulation_models (id) ON DELETE RESTRICT,
  -- Denormalised on purpose. The FK identifies the row; this records the
  -- version string as it stood when the entry was written, so the audit trail
  -- survives even a catastrophic mistake in the catalogue.
  ADD COLUMN simulation_model_version TEXT;

-- A simulated return MUST name the model that produced it. This is the
-- constraint that makes section 19 enforceable rather than aspirational:
-- there is no way to write an unattributable simulated number.
ALTER TABLE paper_ledger_entries
  ADD CONSTRAINT paper_ledger_simulation_attribution CHECK (
    (type = 'simulated_return'
      AND simulation_model_id IS NOT NULL
      AND simulation_model_version IS NOT NULL)
    OR
    -- Every other type carries no model. 'simulated_payout' is included here:
    -- those entries predate the catalogue and are attributed by the
    -- payout_version in their own metadata, which is preserved as written.
    (type <> 'simulated_return'
      AND simulation_model_id IS NULL
      AND simulation_model_version IS NULL)
  );

-- ------------------------------------------------------ constraint updates ----
--
-- Both CHECKs enumerate every entry type and refuse anything unlisted, so each
-- must be replaced rather than left alone.

ALTER TABLE paper_ledger_entries
  DROP CONSTRAINT paper_ledger_position_reference;

ALTER TABLE paper_ledger_entries
  ADD CONSTRAINT paper_ledger_position_reference CHECK (
    (type IN ('exposure_committed', 'exposure_released', 'simulated_payout', 'simulated_return')
      AND position_id IS NOT NULL)
    OR (type IN ('initial_allocation', 'adjustment', 'reset') AND position_id IS NULL)
  );

ALTER TABLE paper_ledger_entries
  DROP CONSTRAINT paper_ledger_sign;

-- A simulated return is signed both ways by design -- positive on a win,
-- negative on a loss -- so it joins the arm carrying no direction constraint.
-- The fixed-direction types keep theirs: a commit that credited an account
-- would silently corrupt the derived exposure.
ALTER TABLE paper_ledger_entries
  ADD CONSTRAINT paper_ledger_sign CHECK (
    (type = 'exposure_committed' AND amount < 0)
    OR (type = 'exposure_released' AND amount > 0)
    OR (type IN ('initial_allocation', 'adjustment', 'reset', 'simulated_payout', 'simulated_return'))
  );

-- Idempotency. The unique index from 0005 keys on (position_id, type), so a
-- position can carry at most one simulated_return no matter how many times
-- settlement is retried. Stated here because it is the guarantee section 8
-- asks the database to make, and it is easy to assume it was added rather
-- than inherited.

-- ------------------------------------------------------------ seed models ----
--
-- Seeded here rather than in the application so that a fresh database and a
-- migrated one offer the identical catalogue, and so the parameters are
-- reviewable in version control alongside the constraints that bound them.
--
-- The rate is a DEMONSTRATION PARAMETER of a named model. It is not a claim
-- about any broker, and the model name and description are written so that a
-- figure derived from it cannot be quoted without that context.

INSERT INTO simulation_models (model_key, version, name, description, parameters, status)
VALUES
  (
    'demo_return',
    '1.0.0',
    'BinaryAI Demo Return',
    'Illustrative fixed-return model. On a correct call it returns a stated fraction of the exposure; an incorrect call forfeits it; an exact tie returns the exposure. The rate is a simulation parameter chosen for demonstration and is not quoted by any broker.',
    jsonb_build_object(
      'startingUnits',       1000,
      'simulatedReturnRate', 0.8,
      'lossRule',            'forfeit_exposure',
      'lossRefundRate',      0,
      'tieRule',             'refund_exposure',
      'roundingDecimals',    8,
      'settlementRule',      'close_of_last_bar_ending_at_or_before_expiry'
    ),
    'active'
  ),
  (
    'conservative_return',
    '1.0.0',
    'Conservative Return',
    'A lower stated return with a partial refund on an incorrect call. Provided so that a simulated figure can be compared across assumptions rather than read as a single authoritative number.',
    jsonb_build_object(
      'startingUnits',       1000,
      'simulatedReturnRate', 0.65,
      'lossRule',            'partial_refund',
      'lossRefundRate',      0.1,
      'tieRule',             'refund_exposure',
      'roundingDecimals',    8,
      'settlementRule',      'close_of_last_bar_ending_at_or_before_expiry'
    ),
    'active'
  );

COMMENT ON TYPE ledger_entry_type IS
  'simulated_return is computed by a named, versioned simulation_models row. simulated_payout is its superseded predecessor and is retained only as history.';
