# ADR-0006 — Hand-written SQL over node-postgres; no ORM

- **Status:** Accepted
- **Date:** 2026-08-24
- **Completes:** [ADR-0005](0005-sql-first-persistence.md), which deferred this choice

## Context

ADR-0005 chose plain SQL migrations and deliberately deferred the query layer
until real access patterns existed. Phase 2A produced them: candle range scans
and bulk upserts, a signal written with its feature rows in one transaction, a
join-heavy calibration read model, and filtered signal listings.

Candidates: Prisma, Drizzle, Kysely, or `pg` with hand-written SQL.

## Decision

`pg` (node-postgres) with hand-written parameterised SQL, behind repository
interfaces declared in `@binaryai/types` and implemented in
`@binaryai/database`.

Typing comes from explicit row interfaces plus parsers at the read boundary
(`toNumber`, `toEpochMs`, `toTimeframe`, …), not from generated types.

## Rationale

**The access patterns do not want an ORM.** The two queries that matter most —
the batched candle upsert with `ON CONFLICT`, and the calibration view joining
signals, outcomes, strategies and a `jsonb_object_agg` over features — are
written directly in SQL in a few lines each. Through an ORM they would be raw
escape hatches anyway, which is an ORM's worth of dependency for no benefit.

**Casting is not typing.** An ORM gives generated types; a hand-written layer
gives `unknown` unless something checks. Rather than cast, the read boundary
_parses_: `toDirection('sideways')` throws instead of quietly producing an
invalid signal direction. That is stronger than a generated type, which asserts
the database matches a schema file and is wrong the moment it does not.

**NUMERIC must stay a string until we convert it.** The driver returns
NUMERIC as text to avoid precision loss. Conversion happens explicitly in
`mappers.ts`, where the decision is visible. Several ORMs hide this behind a
configurable type parser, and a silent float coercion in a system that compares
prices for equality to detect a tie would be a real bug.

**Dependency budget** (development rule 14). `pg` is one dependency with no
codegen step, no schema DSL and no migration engine competing with the one we
already have.

**It keeps the domain clean.** Repositories return domain types from
`@binaryai/types`. Nothing outside `@binaryai/database` knows SQL exists, so
this decision can be reversed without touching the engine or the API routes.

## Consequences

**Good.** Full SQL expressiveness. No codegen. Explicit, testable conversion at
the boundary. Repository interfaces are storage-agnostic, so an entirely
different backend could implement them.

**Bad.** SQL and row interfaces are maintained by hand, and they can drift from
the schema — the mitigation is that every repository is covered by tests that
run against a real PostgreSQL engine, so drift fails loudly. No compile-time
check that a column exists; that check is a test, not the compiler.

**Neutral.** Query composition is manual (`buildFilters` assembles `WHERE`
clauses and parameter indices). Fine at this size; a query builder like Kysely
becomes attractive if filters get much richer.

## Revisit if

Hand-written filter composition starts producing bugs, or a use case needs
schema-derived types across many tables. Kysely is the natural next step: it
adds type-safe composition without an ORM's opinions, and it consumes the
existing schema rather than owning it.
