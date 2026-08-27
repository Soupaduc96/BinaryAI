# ADR-0004 — Demo-only execution, enforced at four layers

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The brief requires demo and live trading to be strictly separated and forbids
connecting real-money execution during initialization.

The usual implementation is a boolean: `LIVE_TRADING=false`. The failure mode is
well known — a misconfigured environment, a copied `.env`, a merged branch that
flips a default, and software that was never reviewed for real-money execution
starts placing real orders.

The cost of this failure is unbounded and irreversible. That justifies defence
in depth rather than a flag.

## Decision

Live execution is blocked at four independent layers, each sufficient on its
own:

1. **Configuration.** `loadConfig` refuses `ALLOW_LIVE_EXECUTION=true` and
   `EXECUTION_MODE=live`, aborting boot with an explanation and a pointer here.
   It always returns `{ mode: 'demo', allowLive: false }`.
2. **Risk engine.** The `live_execution_disabled` check fails for live mode,
   blocking the signal regardless of its quality.
3. **Execution guard.** `assertExecutionAllowed()` throws
   `LiveExecutionDisabledError`. The paper-trading path calls it even though it
   is demo-only by type — the guard must be habitual, not conditional.
4. **Database.** `CHECK (execution_mode = 'demo')` on `accounts`, `trades` and
   `signals`.

Additionally, `PaperAccount.mode` is the literal type `'demo'`, so a live
account is **unrepresentable** rather than merely disallowed, and the API does
not accept an execution mode from the caller at all.

## Rationale

**Why not one flag.** A flag is one edit away from being wrong, and nothing
about the system would notice.

**Why the database layer matters most.** The other three live in code that a
developer can change in a minute. A `CHECK` constraint requires a migration —
a file someone writes, reviews and applies deliberately. That converts "enable
live trading" from an accident into a decision with a paper trail.

**Why the type-level constraint.** Making the illegal state unrepresentable
means the compiler participates. There is no runtime path that constructs a live
account, because the type does not permit one.

**Why refuse the config rather than warn.** A warning in a log is not a control.
Refusing to boot is unambiguous and is caught in development, not production.

## Consequences

**Good.** No single mistake enables real-money execution. The blocks are tested.
The refusal message tells an operator exactly why and where to read more.

**Bad.** Someone who genuinely wants live trading must do real work across four
layers. That is the intent, and it should be preceded by the design and review
listed in [risk-management.md](../risk-management.md).

**Neutral.** The API cannot be asked to evaluate in live mode; the request field
is simply not accepted. Tests assert that supplying it changes nothing.

## Revisit if

A live integration is genuinely wanted. That is a project — broker adapter with
idempotent submission, fill reconciliation, a kill switch reachable without a
deploy, server-side per-user limits, an audit trail, migrations relaxing the
constraints, and calibrated confidence — not a config change. It gets its own
ADR superseding this one.
