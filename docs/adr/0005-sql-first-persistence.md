# ADR-0005 — Plain SQL migrations; ORM choice deferred

- **Status:** Accepted
- **Date:** 2026-08-24
- **Completed by:** [ADR-0006](0006-query-layer-node-postgres.md), which chose the query layer this record deferred

## Context

Phase 1 needs a data model: users, accounts, assets, candles, strategies,
signals, features, outcomes, trades, backtests, risk and system events. It does
not need database _access_ — the API is stateless and takes candles in the
request body.

Options for how to express the schema:

1. Prisma — schema DSL, generated client, migration engine.
2. Drizzle — TypeScript schema, generated SQL, typed queries.
3. Plain SQL migrations, ORM decision deferred.

## Decision

Option 3. `database/migrations/*.sql`, applied with `psql`. No query layer is
chosen yet.

## Rationale

**The schema is the artefact this phase needs**, and SQL expresses it more
precisely than any DSL. The constraints that matter here are database
constraints: `CHECK (execution_mode = 'demo')`, OHLC consistency, positive
prices, settled-trade completeness. Some are awkward or impossible to express in
an ORM schema DSL, and they are the parts most worth having.

**Choosing a query layer before writing a query is premature.** The right choice
depends on access patterns that do not exist yet — candle range scans, feature
aggregation across signals, time-series windows. Prisma and Drizzle differ
meaningfully on exactly those, and the honest answer today is that we do not
know which fits.

**It keeps a dependency out of the tree** until it earns its place (rule 14),
and it keeps the engine pure: nothing in `@binaryai/engine` knows storage
exists, so this decision cannot leak into the domain logic.

**Plain SQL is also the escape hatch.** Whatever tool is chosen later can adopt
an existing schema; the reverse — extracting a schema from a tool that generated
it — is harder.

## Consequences

**Good.** Full expressive power for constraints, indexes and types. No ORM
semantics to learn or fight. The schema is readable by anyone who knows SQL, and
reviewable as a design document.

**Bad.** No typed query layer yet, so Phase 2 must either add one or hand-write
mapping code. No automatic migration generation — migrations are written by
hand. `CREATE TYPE` is not idempotent, so re-running `0001_init.sql` fails
loudly rather than being a no-op (acceptable, and better than half-applying).

**Unverified at the time of writing.** The schema had not been executed against
a live PostgreSQL when this record was made. That has since happened: Phase 2A
applied it to a real PostgreSQL engine and added tests for its constraints. See
[ADR-0007](0007-two-engine-database-testing.md) for how, and what is still only
proven in CI.

## Revisit if

Phase 2 starts. At that point the access patterns are known, and the choice
between Drizzle (thin, SQL-shaped, good for time-series work), Prisma (richer
tooling, more opinionated) or a query builder like Kysely can be made on
evidence. Whatever is chosen adopts this schema rather than replacing it.
