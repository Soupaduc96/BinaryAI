# ADR-0013 — Paper accounts, exposure-only accounting and account risk enforcement

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Since Phase 1 the risk engine has accepted a `RiskLimits` object and a
`RiskContext`, and since Phase 3 `accounts.risk_limits` has stored per-account
overrides. Nothing ever read them. The limits were configuration that changed
no behaviour, which is worse than having none: an interface showing "max open
positions: 1" implied an enforcement that did not exist.

Phase 5 had to make them real, and in doing so answer four questions that had
been deferred.

## Decision 1 — Account risk is a separate layer from signal risk

`assessRisk` answers "is this analysis sound enough to act on?" — the same
answer for every user, because it is a property of the market data. A new pure
module, `evaluateAccountAction`, answers a different question: "may THIS
account act on it, right now?"

Keeping them apart is what stops the runtime from needing to know about
accounts. One market analysis still produces one system signal; the account
layer runs afterwards, against state the analysis knows nothing about.

The account layer also has a wider outcome vocabulary — `allowed`, `blocked`,
`cooldown`, `limit_reached`, `invalid_policy`, `insufficient_context` — because
"blocked" covers too much. A cooldown clears by itself, a limit clears when a
position settles, and an invalid policy needs an operator. Collapsing them
would leave the interface unable to tell a user what to do next.

## Decision 2 — Exposure-only accounting, and no payout

**A binary option's payout is entirely broker-defined, and BinaryAI has no
broker.** There is no rate from which a directional win could be converted into
a gain. Inventing one — 0.8 is the conventional placeholder, and the unused
`trades` table already had it as a column default — would fabricate the single
most consequential number in the product.

So the ledger tracks **exposure**, not profit:

| Event              | Ledger entry         | Amount     |
| ------------------ | -------------------- | ---------- |
| account created    | `initial_allocation` | +100 units |
| position opened    | `exposure_committed` | −size      |
| position settled   | `exposure_released`  | +size      |
| position cancelled | `exposure_released`  | +size      |

A win and a loss release **exactly the same amount**. The directional outcome is
recorded on the position; it moves no units. `availableUnits` is therefore a
measure of capacity, not of performance, and every payload carries a note
saying so.

This is `accountingModel: 'exposure_only'`. An account with no allocation
reports `'not_configured'` rather than a zero balance, because "not set up" and
"nothing left" are different states.

**Units are not currency.** No symbol, no "balance", no conversion. They exist
so that exposure limits have something to bind on.

## Decision 3 — `paper_positions` is a new table, not a reuse of `trades`

§29 asks for reuse, and this is the one place it was refused. The reason:

`trades` (migration 0001) encodes a payout model — `payout_rate NUMERIC DEFAULT
0.8`, a `pnl` column, and a CHECK requiring `pnl` to be non-null once settled.
Reusing it would mean dropping the default, making `pnl` nullable and loosening
that CHECK: removing the three things that define the table. Its `status` set
(`open`/`settled`/`cancelled`) also cannot express "expired, awaiting a
settlement bar", which is a real state here.

`trades` has never been written to by any code path. It is left in place —
dropping it would not be additive — and carries a `COMMENT` marking it
superseded.

Everything else **is** reused: `accounts` holds the policy (exactly one row per
account, so a separate table would add a join for nothing), `risk_events` is the
audit trail, and `signals` is the analysis a position points at.

## Decision 4 — The account row lock is the concurrency boundary

Position creation runs inside one transaction holding `SELECT … FOR UPDATE` on
the account row. Two concurrent requests for the same account serialize there,
so the second one's open-position count includes the first one's position.
Without the lock both would read the same count and both would be permitted
through a limit of one.

Idempotency is separate and stronger: a unique index on `(account_id,
signal_id, action_key)`. A check-then-insert would leave a window in which two
concurrent requests both pass the check; a constraint cannot be raced.

**Order matters.** The idempotency check runs BEFORE risk evaluation. A retry of
an action that already succeeded must return that position rather than being
refused by the open-position limit which its own earlier success created —
otherwise a user retrying a timed-out request is told they hit their limit when
in fact their action went through.

## Settlement semantics

Paper positions settle in the same worker cycle as signals, under the same rule:
the close of the last exchange bar ending at or before expiry. Never "the latest
price", which would make the result depend on when the worker happened to run.

They are **separate writes**, deliberately:

- `signal_outcomes` is the canonical ANALYSIS observation and is what
  calibration reads. There is exactly one per signal, however many accounts
  acted on it.
- `paper_positions.result` is one account's record of its own action.

Collapsing them would either duplicate one signal's outcome into N calibration
samples (§24), or make an account's history depend on whether anyone else
happened to act on the same signal.

## Policy semantics that had to be chosen explicitly

**Allowlists.** `null` means unset (unrestricted). `[]` means allow none and
fails closed. The two are not interchangeable: an operator who cleared a list
expressed "nothing", and reading that as "everything" would invert the
restriction. New accounts default to `null`, because an account that could act
on nothing would look broken rather than safe.

**The exposure window is a rolling 24 hours**, not a calendar day. A calendar
day needs a timezone, and the user's, the server's and the exchange's all
differ; any choice would silently move when the limit resets, and could be gamed
by acting just before midnight.

**A tie breaks a loss streak** rather than extending it. A tie is not a loss,
and treating it as one would trigger a halt the user did not earn. An unresolved
position affects the streak not at all.

**Caller-supplied limits may only TIGHTEN.** The evaluate endpoint previously
accepted a `riskLimits` object, which meant any user could bypass their own
stored policy by sending different limits with each request — the policy was
advisory in the most literal sense. `tightenLimits` now merges per-field in the
stricter direction only, and `allowLiveExecution` is forced false from any
direction.

## Consequences

**Good**

- Configured limits actually bind, at the backend, on every action.
- Every refusal is auditable: which rule, observed value, limit, window and
  policy version.
- The ledger is append-only and enforced by a database trigger, so an audit
  trail cannot be rewritten by application code or by hand.
- No payout was invented, and no number in the product implies one.

**Bad, and accepted**

- **There is no profit-and-loss figure.** Users accustomed to a paper-trading
  balance that moves will find this surprising. It is the honest position: any
  moving balance would be derived from a payout rate BinaryAI does not have.
- **The account lock serializes position creation per account.** Correct, and
  irrelevant at this scale, but it is a per-account bottleneck by construction.
- **The default allocation of 100 units is arbitrary.** It is a capacity
  denominator, not a claim about anything, but it is still a number chosen
  rather than derived.
- **`rejected` is a position state that the creation path never produces.** A
  blocked action writes a risk event and no row. The state exists so a future
  reversal has somewhere terminal to land rather than overloading `cancelled`.

## Not verified

**True multi-connection concurrency.** PGlite accepts one connection, so two
genuinely simultaneous transactions cannot be run locally. What is verified is
the constraint that makes the guarantee real — the unique index — and the
sequential behaviour of the lock, including full rollback on failure. A real
race needs the `postgres:16` CI job, which has never run because no git remote
is configured. This is stated rather than glossed: the lock is _correct by
construction and by review_, not _proven under contention_.

## Revisit when

- A defensible payout model exists — most likely a user-configured simulation
  rate that is stated on every figure derived from it, and versioned like the
  calibration methodology.
- Multiple accounts per user become a real requirement, at which point account
  selection needs explicit semantics beyond "the default one".
- The API runs as more than one instance, where the per-account lock becomes a
  cross-process concern rather than a per-connection one.
