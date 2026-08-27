-- BinaryAI :: sessions, per-user risk limits and signal ownership
--
-- Phase 3 turns a single-tenant system into a multi-user one. The `users` and
-- `accounts` tables already existed from 0001; what was missing was a way to
-- authenticate a user and scope data to them.
--
-- Design notes
--  * Sessions are OPAQUE and server-side. Only a SHA-256 of the token is
--    stored, so a database leak yields no usable sessions -- the same reason
--    passwords are hashed. Revocation is a row update and takes effect on the
--    next request, which a stateless JWT cannot offer.
--  * Signal ownership stays OPTIONAL, matching 0001's intent: the runtime's
--    analysis stream is a shared intelligence product (account_id IS NULL),
--    while a signal a user generates for themselves is owned. Trades, by
--    contrast, were always NOT NULL -- a position must have an owner.
--  * Risk limits move onto the account. Each user gets their own ceilings; the
--    engine defaults still apply to anything unset.

-- ------------------------------------------------------------- sessions ----

CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the raw token. The raw value exists only in the user's cookie
  -- and is never written anywhere on the server.
  token_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set on logout or admin revocation. Kept rather than deleted so the audit
  -- trail survives; expired rows are pruned separately.
  revoked_at   TIMESTAMPTZ,
  user_agent   TEXT,
  ip_address   TEXT,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);
-- Supports the "active sessions" lookup and the expiry sweep.
CREATE INDEX sessions_active_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- users ----

ALTER TABLE users
  ADD COLUMN last_login_at TIMESTAMPTZ,
  -- Counts consecutive failures for throttling. Reset on a successful login.
  ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  ADD COLUMN locked_until  TIMESTAMPTZ;

COMMENT ON COLUMN users.password_hash IS
  'Argon2id digest (OWASP parameters). A plaintext password must never reach this table.';

-- ------------------------------------------------------------- accounts ----

ALTER TABLE accounts
  -- Per-user risk ceilings. Empty object means "use the engine defaults";
  -- every key here can only ever tighten them.
  ADD COLUMN risk_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN is_default  BOOLEAN NOT NULL DEFAULT TRUE;

-- One default account per user, enforced by the database rather than by code.
CREATE UNIQUE INDEX accounts_one_default_per_user
  ON accounts (user_id) WHERE is_default;

-- -------------------------------------------------------------- signals ----

-- Ownership scoping index: "system signals plus mine", the query every
-- authenticated list endpoint runs.
CREATE INDEX signals_owner_idx ON signals (account_id, decided_at DESC);

COMMENT ON COLUMN signals.account_id IS
  'NULL = system signal from the runtime worker, readable by every user. Set = owned by that account and private to it.';
