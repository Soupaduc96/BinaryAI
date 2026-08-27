# ADR-0007 — Database tests run on an embedded engine locally and a real server in CI

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Phase 2A needed the schema and the repository layer executed against
PostgreSQL, not merely reviewed. The development machine has no PostgreSQL, no
Docker, no Podman and no WSL, and installing system software was out of scope.

That left a real question: how do database tests run at all?

Options considered:

1. **Skip database tests locally**, run them only in CI.
2. **Substitute SQLite**, which installs as an npm package.
3. **PGlite** — actual PostgreSQL compiled to WebAssembly, embedded in the test
   process, distributed on npm.
4. **Require Docker** for anyone touching the database layer.

## Decision

Option 3 as the default, with a real server whenever `DATABASE_URL` is set.

`tests/db/harness.ts` picks the engine: a `pg` pool when `DATABASE_URL` exists,
PGlite otherwise. The suite is identical either way. CI runs it twice — once
embedded in the `verify` job, once against a `postgres:16` service in the
`database` job.

## Rationale

**Against skipping locally.** A test suite that only runs in CI does not get
run, and the repository layer would have been written blind. In practice this
decision found bugs immediately: a `text = uuid` operator error, an unsafe
property access in the adapter, and a signal whose expiry preceded its decision
bar — all caught locally in seconds.

**Against SQLite, emphatically.** The schema's value is in what it refuses:
`CHECK (execution_mode = 'demo')`, enum types, `NUMERIC(20,8)` exactness, OHLC
consistency constraints. SQLite has different type affinity, different
constraint behaviour and no native enums, so a green SQLite suite would prove
nothing about the database we actually deploy — while _looking_ like proof.
That is worse than no test.

**For PGlite.** It is PostgreSQL, not an imitation: the same parser, planner and
executor built to WASM. Everything the schema relies on behaves identically, and
it starts in about a second with no installation.

**Against requiring Docker.** It would make the database layer untouchable on
this machine, and it raises the cost of contributing for no correctness gain
over PGlite in the common case.

**Why CI is still authoritative.** PGlite cannot exercise what makes a server a
server: connection pooling under concurrency, network failures, TLS, roles and
permissions, or multi-client transaction isolation. It also bundles a different
PostgreSQL major version than the deployment target. So CI runs the same suite
against `postgres:16` over a real socket through the real pool, and that run is
the one that counts.

## Consequences

**Good.** Database tests run everywhere, in seconds, with no setup. Local
failures are real failures. CI proves the target version.

**Bad.** Two engines mean two possible behaviours; a bug present only on the
server appears only in CI. The version gap is real — local runs use PGlite's
bundled PostgreSQL (18.x at time of writing), the target is 16. Anything
version-sensitive must be confirmed by the CI job.

**Mitigation.** Every database test reports the engine and version it ran on,
and the docs never claim "verified on PostgreSQL 16" on the strength of a local
run. That distinction is stated in the test output, in `database/README.md` and
in the Phase 2A report.

## Revisit if

PGlite drifts from server behaviour in a way that costs debugging time, or the
project gains a CI-independent environment where a real server is always
available.

## Amendment (2026-08-27): the third engine

The "revisit if" condition above has been met. `embedded-postgres` ships the
**official PostgreSQL binaries** per platform, so a real PostgreSQL 16 server can
be started from `npm` alone — no container runtime, no service to install. The
matrix is now three tiers rather than two:

| Tier              | Command                   | Engine                                  | Available  |
| ----------------- | ------------------------- | --------------------------------------- | ---------- |
| Unit              | `npm test`                | none                                    | always     |
| PGlite            | `npm test`                | PostgreSQL 18, embedded, one connection | always     |
| **PostgreSQL 16** | `npm run verify:postgres` | **real 16.14 server, TCP, pooled**      | **always** |

This does not retire the CI job. What CI runs is `postgres:16-alpine` — the musl
Linux build — while the local server is the platform's own build of 16.x. Same
source, same major version, same planner, same constraint semantics; a different
build. CI remains authoritative.

What it retires is the far larger gap: the claim "PostgreSQL 16 compatibility is
unverified" was true for every phase of this project until now, purely because
running a server required infrastructure the developer did not have. That excuse
is gone, and the concurrency tests in `tests/db/postgres-only.test.ts` — which
had been written but never executed — now run on demand.

One operational note discovered on first use: server-backed suites must run with
`--maxWorkers=1`. Against PGlite each file gets its own engine and parallelism
is free; against one server, eight files opening pools simultaneously exhaust
connection setup, and PostgreSQL creates a process per connection. Twelve of
thirteen files failed before a single assertion ran. Serialising changes no
assertion and costs only wall-clock time.
