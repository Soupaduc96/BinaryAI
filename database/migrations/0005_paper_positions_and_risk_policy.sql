-- BinaryAI :: account risk policy, paper positions and the exposure ledger
--
-- Phase 5 makes account risk limits real. Everything here is additive; no
-- existing table is dropped and no stored row is rewritten.
--
-- WHAT IS REUSED, deliberately:
--   accounts        -- already owns risk_limits (0003), balance and streak state
--   risk_events     -- already the audit table for risk decisions (0001)
--   signals         -- the analysis a position is taken on, never duplicated
--
-- WHY paper_positions IS A NEW TABLE rather than a reuse of `trades`:
--
--   `trades` (0001) encodes a PAYOUT model: `payout_rate NUMERIC DEFAULT 0.8`,
--   a `pnl` column, and a CHECK requiring pnl to be non-null once settled. That
--   0.8 is exactly the invented broker payout Phase 5 must not adopt -- BinaryAI
--   has no broker terms, so there is no defensible rate to convert a
--   directional outcome into money.
--
--   Reusing it would mean dropping the payout default, making pnl nullable, and
--   loosening the settled-fields CHECK -- i.e. removing the three things that
--   define the table. Its `status` set (open/settled/cancelled) also cannot
--   express "expired, awaiting a settlement bar", which is a real state here.
--
--   `trades` has never been written to by any code path. It is left in place
--   (dropping it is not additive) and commented as superseded.

COMMENT ON TABLE trades IS
  'SUPERSEDED by paper_positions (0005) and unused. Retained only because dropping it would not be additive. Its payout_rate/pnl columns assume broker economics BinaryAI does not have.';

-- ------------------------------------------------------- account policy ----
--
-- The policy lives on `accounts` rather than in a new table: it is exactly one
-- row per account, always present, and a separate table would add a join and a
-- nullable relationship for no gain. `risk_limits` (0003) already holds the
-- engine's RiskLimits; these columns add the account-action dimensions.

ALTER TABLE accounts
  -- Incremented on every policy change and stamped on every decision made
  -- under it, so an old risk event stays interpretable after a policy edit.
  ADD COLUMN risk_policy_version  INTEGER NOT NULL DEFAULT 1
    CHECK (risk_policy_version >= 1),
  ADD COLUMN risk_policy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN max_position_size    NUMERIC(20, 8) NOT NULL DEFAULT 10
    CHECK (max_position_size > 0),
  ADD COLUMN max_daily_exposure   NUMERIC(20, 8) NOT NULL DEFAULT 50
    CHECK (max_daily_exposure > 0),
  -- Allowlists. NULL means UNSET (unrestricted); an empty array means ALLOW
  -- NONE and fails closed. The two are different on purpose -- reading a
  -- cleared list as "everything" would invert the operator's intent.
  ADD COLUMN allowed_strategies   TEXT[],
  ADD COLUMN allowed_timeframes   TEXT[],
  ADD COLUMN allowed_assets       TEXT[],
  -- Units allocated to the paper account. NOT money and never presented as a
  -- currency balance; see the accounting note on paper_ledger_entries.
  ADD COLUMN allocated_units      NUMERIC(20, 8) NOT NULL DEFAULT 0
    CHECK (allocated_units >= 0);

-- A single action must never be able to exceed the window ceiling, or the
-- daily limit could never bind and would be decorative.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_position_size_within_daily
    CHECK (max_position_size <= max_daily_exposure);

COMMENT ON COLUMN accounts.allowed_strategies IS
  'NULL = unrestricted. Empty array = allow none (fails closed). Not interchangeable.';
COMMENT ON COLUMN accounts.allocated_units IS
  'Paper accounting units. Not currency, not money held by BinaryAI, not convertible.';

-- ------------------------------------------------------ paper positions ----

CREATE TYPE paper_position_status AS ENUM (
  'open',
  -- Expiry has passed but the settlement bar is not available yet. Distinct
  -- from 'open' because an expired position can no longer change, and distinct
  -- from 'settled' because no result exists.
  'pending_settlement',
  'settled',
  'cancelled',
  -- Terminal, and never produced by the creation path: a blocked risk decision
  -- records a risk_event and creates NO row. Present so a future reversal has a
  -- terminal state rather than overloading 'cancelled'.
  'rejected'
);

CREATE TABLE paper_positions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The analysis acted on. ON DELETE RESTRICT, not SET NULL: a position whose
  -- source signal vanished could never be explained or re-settled.
  signal_id         UUID NOT NULL REFERENCES signals (id) ON DELETE RESTRICT,
  asset_symbol      TEXT NOT NULL,
  timeframe         TEXT NOT NULL,
  direction         signal_direction NOT NULL CHECK (direction <> 'none'),
  -- Accounting units committed. There is no payout, so this is exposure, not a
  -- stake against a return.
  size              NUMERIC(20, 8) NOT NULL CHECK (size > 0),
  entry_price       NUMERIC(20, 8) NOT NULL CHECK (entry_price > 0),
  opened_at         TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            paper_position_status NOT NULL DEFAULT 'open',
  settled_at        TIMESTAMPTZ,
  settlement_price  NUMERIC(20, 8) CHECK (settlement_price IS NULL OR settlement_price > 0),
  result            trade_outcome,
  -- Provenance of the settlement price. 'exchange' for worker settlement;
  -- never 'broker', because there is no broker feed.
  data_origin       TEXT,
  -- Caller-supplied idempotency key. See the unique index below.
  action_key        TEXT NOT NULL,
  policy_version    INTEGER NOT NULL CHECK (policy_version >= 1),
  -- Paper only. The same four-layer boundary every other table carries.
  execution_mode    execution_mode NOT NULL DEFAULT 'demo' CHECK (execution_mode = 'demo'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT paper_positions_expiry_after_open CHECK (expires_at > opened_at),
  -- A settled position must carry the evidence of its settlement. Without this
  -- a row could claim 'settled' with no price, no time and no result.
  CONSTRAINT paper_positions_settled_complete CHECK (
    status <> 'settled'
    OR (settled_at IS NOT NULL AND settlement_price IS NOT NULL AND result IS NOT NULL)
  ),
  -- The converse: an unsettled position must not carry a result. This is what
  -- stops an open position from being displayed as a loss.
  CONSTRAINT paper_positions_unsettled_clean CHECK (
    status = 'settled' OR (settled_at IS NULL AND settlement_price IS NULL AND result IS NULL)
  )
);

-- Idempotency, enforced by the DATABASE rather than by a check-then-insert.
-- Two concurrent requests carrying the same action key cannot both succeed:
-- one commits, the other violates this index. Application-level checking would
-- leave a window in which both pass.
CREATE UNIQUE INDEX paper_positions_action_key
  ON paper_positions (account_id, signal_id, action_key);

CREATE INDEX paper_positions_account_idx ON paper_positions (account_id, opened_at DESC);
CREATE INDEX paper_positions_signal_idx ON paper_positions (signal_id);
-- Supports the open-position count and the exposure window, the two reads on
-- the hot path of every position creation.
CREATE INDEX paper_positions_active_idx
  ON paper_positions (account_id, opened_at DESC)
  WHERE status IN ('open', 'pending_settlement');
-- Supports the settlement worker's scan for expired-but-unsettled positions.
CREATE INDEX paper_positions_settlement_idx
  ON paper_positions (expires_at)
  WHERE status IN ('open', 'pending_settlement');

COMMENT ON TABLE paper_positions IS
  'Simulated account actions. Not orders, never transmitted anywhere, and carrying no payout or P&L.';

-- -------------------------------------------------------------- ledger ----

CREATE TYPE ledger_entry_type AS ENUM (
  'initial_allocation',
  'exposure_committed',
  'exposure_released',
  'adjustment',
  'reset'
);

-- Append-only. Available units are DERIVED by summing entries rather than being
-- a mutable column, so a balance can always be reconstructed and audited. There
-- is deliberately no 'win' or 'loss' entry type: a directional outcome moves no
-- units without a payout model, and BinaryAI has none.
CREATE TABLE paper_ledger_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  type          ledger_entry_type NOT NULL,
  -- Signed. Committing exposure is negative, releasing it positive.
  amount        NUMERIC(20, 8) NOT NULL CHECK (amount = amount),
  position_id   UUID REFERENCES paper_positions (id) ON DELETE RESTRICT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Entries that account for a position must name it; allocations must not.
  CONSTRAINT paper_ledger_position_reference CHECK (
    (type IN ('exposure_committed', 'exposure_released') AND position_id IS NOT NULL)
    OR (type IN ('initial_allocation', 'adjustment', 'reset') AND position_id IS NULL)
  ),
  -- Sign discipline, so a commit can never accidentally credit an account.
  CONSTRAINT paper_ledger_sign CHECK (
    (type = 'exposure_committed' AND amount < 0)
    OR (type = 'exposure_released' AND amount > 0)
    OR (type IN ('initial_allocation', 'adjustment', 'reset'))
  )
);

-- One commit and at most one release per position. This is what makes the
-- derived balance idempotent under a retried settlement.
CREATE UNIQUE INDEX paper_ledger_position_entry
  ON paper_ledger_entries (position_id, type)
  WHERE position_id IS NOT NULL;

CREATE INDEX paper_ledger_account_idx ON paper_ledger_entries (account_id, occurred_at DESC);

COMMENT ON TABLE paper_ledger_entries IS
  'Append-only exposure accounting. Units are not currency. No profit or loss is recorded because no payout model exists.';

-- Append-only enforced in the database, not merely by convention: an UPDATE or
-- DELETE against a ledger row is refused outright, so an audit trail cannot be
-- quietly rewritten by application code or by hand.
CREATE OR REPLACE FUNCTION refuse_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'paper_ledger_entries is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paper_ledger_no_update
  BEFORE UPDATE ON paper_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_ledger_mutation();

CREATE TRIGGER paper_ledger_no_delete
  BEFORE DELETE ON paper_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_ledger_mutation();

-- ---------------------------------------------------------- risk events ----
--
-- risk_events (0001) is reused as-is. These columns make a blocked account
-- action reconstructable: which rule, under which policy version.

ALTER TABLE risk_events
  ADD COLUMN rule_code      TEXT,
  ADD COLUMN policy_version INTEGER,
  ADD COLUMN position_id    UUID REFERENCES paper_positions (id) ON DELETE SET NULL;

CREATE INDEX risk_events_account_idx ON risk_events (account_id, occurred_at DESC);
