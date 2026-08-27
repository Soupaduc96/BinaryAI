# ADR-0015: What is and is not safe across multiple instances

**Status:** Accepted
**Date:** 2026-08-27
**Supersedes:** the "rate limiting is per-instance" gap in ADR-0009 and
`docs/security.md`

## Context

BinaryAI has been built and verified as a single process. Running two is a
deployment decision that can be taken without touching the code, and most of the
system is already safe under it — but not all of it, and the parts that are not
fail _quietly_. A duplicated worker cycle wastes work. A duplicated rate-limit
counter silently doubles a limit nobody chose.

The dangerous case is the one where nothing looks wrong. So this ADR classifies
every shared-state concern explicitly, and says which mechanism enforces it.

## Decision

Classify each concern as **enforced by the database**, **merely inefficient**, or
**unsafe without coordination** — and refuse to describe anything as coordinated
that is not.

### Enforced by the database — safe under any number of instances

These hold because a constraint in PostgreSQL holds them, not because the
application checks. Two instances racing produce one winner and one error.

| Concern                            | Mechanism                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| One account per user default       | `accounts_one_default_per_user` unique index                                       |
| Unique user email                  | `users_email_key` unique index on `lower(email)`                                   |
| Unique session token               | `sessions_token_hash_key` unique index                                             |
| Paper action idempotency           | `paper_positions_action_key` unique index on `(account_id, signal_id, action_key)` |
| One settlement credit per position | `paper_ledger_position_entry` partial unique index on `(position_id, type)`        |
| Ledger append-only                 | `paper_ledger_no_update` / `paper_ledger_no_delete` triggers                       |
| Simulation model immutability      | `simulation_models_immutable` trigger                                              |
| Signal deduplication               | `signals_signal_key_idx` unique index                                              |
| Risk limits                        | evaluated inside a transaction holding the account row via `SELECT … FOR UPDATE`   |

Two instances settling the same position concurrently is therefore **correct**:
one commits, the other's insert is refused, and the account is credited once.
This is the property `tests/db/postgres-only.test.ts` exercises — and can only
exercise against a real server, since PGlite has one connection.

### Merely inefficient — safe, wasteful

Duplicated work that costs cycles and provider quota but cannot corrupt state,
because the write it ends in is one of the constrained ones above.

- **Ingestion.** Two instances polling the same symbol fetch the same candles
  twice. The upsert is idempotent; the cost is the provider's rate budget.
- **Analysis.** Two instances analysing the same closed candle produce the same
  `signal_key`; the second insert is refused by the unique index.
- **Settlement scans.** Both instances scan for expired positions. Both attempt
  the same credit; one succeeds.
- **Session retention.** Both sweep expired rows. `DELETE` of an already-deleted
  row removes nothing. The worst outcome is two `DELETE` statements.

None of this is coordinated, and this ADR does not claim it is. A leader
election would remove the waste; it has not been built, and pretending otherwise
would be worse than the waste.

### Unsafe without shared state

- **Rate limiting.** The in-process store counts per process. With N instances
  the effective limit is N times what was configured. This is the one case where
  the failure is silent and security-relevant, so it is handled by configuration
  refusing to boot rather than by documentation: production requires
  `RATE_LIMIT_STORE=redis`, or an explicit `RATE_LIMIT_ALLOW_IN_MEMORY=true`
  from an operator who has decided a single instance is what they are running.

  The Redis-backed store makes this safe **in design**. It has not run against a
  real Redis server, so this ADR does not claim it is safe **in practice**. See
  `docs/security.md`.

- **Runtime status counters.** `ticks`, `failures`, `signalsCreated` and
  `sessionsDeleted` are per process and are lost on restart. They are
  observability, never correctness — but a fleet-wide figure cannot be read off
  one instance, and `/v1/system/status` describes one instance by design.

## Consequences

**A second instance can be added today** for HTTP serving, provided
`RATE_LIMIT_STORE=redis` is configured. Nothing else needs to change for
correctness.

**Workers will duplicate work.** For the current interval sizes this is
acceptable; at higher instance counts the provider quota becomes the binding
constraint, and that is when leader election earns its complexity.

**Nothing here is verified under real multi-instance load.** Every claim above
is either a database constraint that can be pointed at, or an explicit statement
that a thing is uncoordinated. No claim rests on a test of two live instances,
because no such test has been run.

## Alternatives considered

**Advisory locks for worker leadership.** `pg_try_advisory_lock` would make one
instance the worker and the rest passive, removing the duplication. Rejected for
now: it adds a failure mode (a held lock after an ungraceful shutdown, released
only when the session ends) to solve a problem that is currently wasted work
rather than incorrectness. Worth revisiting when ingestion is the cost driver.

**A dedicated worker process.** Cleaner separation, and the natural end state.
Rejected as premature: it changes deployment topology for a system that is not
yet deployed anywhere.
