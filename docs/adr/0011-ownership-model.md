# ADR-0011 — Shared analysis stream, private account data

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

Phase 3 had to answer one question before any code could be written: **who owns
a signal?**

The existing schema and the existing documentation disagreed.

- `database/migrations/0001_init.sql` made `signals.account_id` **nullable**
  with `ON DELETE SET NULL`, while `trades.account_id` is **NOT NULL**. That
  encodes signals as optionally-owned and trades as always-owned.
- `docs/security.md` described the Phase 3 goal as "row-level scoping so one
  user cannot read another's **signals**", which reads as signals being private
  per user.

Getting this wrong would have wasted the phase, so it is recorded here
explicitly rather than settled by whichever file was read first.

Three models were possible:

1. **Fully per-user signals.** Every user's analysis is private; the runtime
   worker runs per user.
2. **Fully shared signals.** One analysis stream, no ownership at all.
3. **Hybrid.** System signals are shared; user-generated signals are private.

## Decision

**Hybrid**, which is what the nullable column already described:

| `signals.account_id` | Meaning                                              | Who can read it          |
| -------------------- | ---------------------------------------------------- | ------------------------ |
| `NULL`               | System signal from the runtime analysis worker       | every authenticated user |
| set                  | Generated for one account via `/v1/signals/evaluate` | that account only        |

Trades, balances, risk events and per-account risk limits are **always** owned
and never shared. `trades.account_id` stays `NOT NULL`.

Scope is a value — `AccessScope` in `@binaryai/types` — not a convention. Every
ownership-sensitive query takes one, so failing to filter is a type error rather
than a silent leak. `scopeForPrincipal` derives it from the request's principal.

An admin gets their **own** scope by default. Elevation to `allScope()` is
explicit at the call site, so a broad read is visible in the code rather than
being an invisible property of who happens to be logged in.

## Rationale

**The analysis is identical, so duplicating it would be pure waste.** The
runtime worker analyses public exchange candles with a deterministic pipeline.
Running it per user would produce N byte-identical signals from the same bars,
multiplying storage and compute while changing no output value. Worse, the
deterministic signal key (`asset:timeframe:candleTs:strategy@version`) is what
makes analysis idempotent — per-user duplication would require making ownership
part of that identity, weakening the exactly-once guarantee from ADR-0009 for no
benefit.

**Account data is genuinely private and genuinely differs.** Balance, exposure,
consecutive losses and risk limits vary per user, and the risk engine's answer
depends on them. That is real per-user state and it is scoped strictly.

**The schema was right.** `signals.account_id` being nullable while
`trades.account_id` is not was a deliberate Phase 1 distinction. Reading it as
an oversight and forcing signals to be owned would have discarded a correct
design decision.

**`docs/security.md` was the sentence that was wrong**, and it has been
corrected rather than left to contradict the schema. Its intent — that one user
must not read another's data — is fully honoured; "signals" was simply the wrong
noun for the shared stream.

## Consequences

**Good**

- One analysis worker, one stream, no duplicated compute or storage.
- The scoping filter is a single clause: `account_id IS NULL OR account_id = ?`.
- Signals a user generates themselves stay private, so experimenting with
  parameters does not publish results to everyone.
- A denied single-record read returns **404, not 403** — a 403 would confirm the
  id exists, which is itself a disclosure.

**Bad, and accepted**

- **The shared stream is visible to every authenticated user.** On a multi-tenant
  deployment where instruments themselves are confidential, this model is wrong
  and the runtime worker would need to become per-account.
- **Two ownership states to keep in mind.** Every new query over `signals` must
  decide which it wants; the `AccessScope` parameter is what forces that choice
  to be made rather than defaulted.
- **`ON DELETE SET NULL` means deleting an account promotes its private signals
  to the shared stream.** That is the pre-existing schema behaviour and it is
  currently wrong for privacy: a deleted user's signals should be deleted, not
  published. Recorded below rather than silently changed, because altering the
  FK is a migration with data consequences.

## Not done

- **Account deletion.** There is no endpoint to delete a user or account, so the
  `ON DELETE SET NULL` promotion above is not yet reachable. It must be resolved
  before one is added — most likely by changing the constraint to `CASCADE` for
  owned signals.
- **Sharing controls.** A user cannot publish one of their signals to the shared
  stream or share it with a specific user. Nothing in the model prevents adding
  it later.
- **Per-account risk limits are stored but not yet enforced.** `accounts.risk_limits`
  round-trips through the repository; the risk engine still reads the global
  defaults. Wiring it in is a Phase 4 item, and until then the column is
  inert — it is not silently half-applied.

## Revisit when

- BinaryAI is deployed multi-tenant with confidential instrument lists, which
  makes the shared stream unacceptable.
- Users need to analyse instruments nobody else ingests, which would make
  per-user analysis meaningful rather than duplicative.
- Account deletion is implemented, which forces the `ON DELETE` question.
