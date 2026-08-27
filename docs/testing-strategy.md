# Testing strategy

850 tests, all passing. Runner: [Vitest](https://vitest.dev) 4.

```bash
npm test              # everything, embedded PostgreSQL for the db suite
npm run test:db       # database suite only
npm run test:watch    # watch mode
npx vitest run packages/indicators

# the same database suite against a real server
DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai npm run test:db
```

## Where the tests are, and why

| Level              | Count | Location                             | Covers                                                           |
| ------------------ | ----- | ------------------------------------ | ---------------------------------------------------------------- |
| Unit — indicators  | 42    | `packages/indicators/src/*.test.ts`  | Numeric correctness, warm-up alignment, edge cases               |
| Unit — engine      | 113   | `packages/engine/src/*.test.ts`      | Validation, confidence, risk, pipeline, settlement, account risk |
| Unit — market data | 76    | `packages/market-data/src/*.test.ts` | Normalization, quality scan, provider parsing                    |
| Unit — auth        | 48    | `packages/auth/src/*.test.ts`        | Hashing, session rules, access scope, lockout                    |
| Unit — backtest    | 30    | `packages/backtest/src/*.test.ts`    | Determinism, settlement, metrics, paper accounts                 |
| Unit — database    | 22    | `packages/database/src/*.test.ts`    | Mappers, enum parsing, pool lifecycle, checksums                 |
| Unit — strategies  | 21    | `packages/strategies/src/*.test.ts`  | Registry, parameters, both strategies                            |
| Unit — config      | 10    | `packages/config/src/env.test.ts`    | Validation, secret redaction                                     |
| Unit — runtime     | 10    | `packages/runtime/src/*.test.ts`     | Scheduler single-flight, abort, failure recovery                 |
| Database           | 126   | `tests/db/`                          | Migrations, constraints, repositories, ownership                 |
| Integration — API  | 117   | `tests/integration/`                 | Routing, auth, scoping, rate limiting, persistence               |
| E2E                | 0     | `tests/e2e/`                         | Scaffolded; Playwright not installed                             |

Weighting follows consequence, not code size: the indicator library is small but
a silent off-by-one there corrupts every downstream decision.

## The three-engine matrix

Counts alone hide the question that matters: **which engine did it run on, and
what can that engine actually prove?** Three tiers, and they are not
interchangeable.

| Tier                      | Command                   | Engine                                      | Proves                                                                                             | Cannot prove                                                                  |
| ------------------------- | ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **1. Pure unit**          | `npm test`                | none                                        | Logic, arithmetic, validation, decision rules                                                      | Anything about storage                                                        |
| **2. PGlite integration** | `npm test`                | PostgreSQL 18, embedded, **one connection** | SQL validity, enums, CHECK constraints, foreign keys, triggers, NUMERIC/TIMESTAMPTZ semantics      | Concurrency, pooling, networking, TLS, roles, **PostgreSQL 16 compatibility** |
| **3. PostgreSQL 16**      | `npm run verify:postgres` | postgres:16, real server                    | Everything in tier 2 _on the deployed version_, plus row locking, unique-constraint races, pooling | Production load, real data volumes                                            |

Two things about tier 2 are easy to get wrong in the optimistic direction:

**PGlite is real PostgreSQL, but it is PostgreSQL 18.** Production targets 16.
The gap runs in the dangerous direction — anything added after 16 passes locally
and fails on the server — so a green local run is **not** evidence of 16
compatibility, even for single-connection behaviour.

**PGlite has exactly one connection.** Row locking, unique-constraint races and
pool behaviour are not merely untested there; they are _untestable_, because
there is no second transaction to block or to race. Those are precisely the
guarantees paper-action idempotency and settle-once depend on.

So the cases that need a server live in `tests/db/postgres-only.test.ts` and
**skip** without `DATABASE_URL`, printing the engine and the reason. They never
pass vacuously. To run tier 3 locally:

```bash
docker compose up -d
DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai_test   npm run verify:postgres
```

That script refuses to run without a server (exit 2, distinguished from a test
failure), asserts the server's major version before running anything, migrates
from zero, re-runs the migrator to prove idempotency, and then runs the database
and integration suites. It is the same command CI runs, so the two cannot drift.

## What gets tested at each level

**Indicators** — exact values where a closed form exists (`sma([1,2,3,4,5], 3)`
is `[null, null, 2, 3, 4]`), and behavioural properties elsewhere: RSI of a
monotonically rising series is 100, ATR of constant bars equals the bar range,
ADX stays in 0–100, Bollinger bands stay symmetric around the SMA.

Warm-up alignment is tested explicitly for every indicator, because "first value
lands at index `2 × period − 1`" is precisely the kind of thing that is wrong
without ever throwing.

**Engine** — that bad data is rejected and reported rather than crashing; that
confidence weights sum to 1 and conflicts lower the score; that all 13 risk
checks fire independently; that the pipeline never yields a recommendation
without a completed risk assessment.

**Backtest** — determinism first: identical inputs produce a byte-identical
result (`toStrictEqual`). Then invariants: no trade is opened that cannot
settle, positions never overlap, the running balance matches cumulative PnL, and
the stated payout model is applied to every trade.

**Database** — a real PostgreSQL engine, never a stand-in. Locally that is
PGlite (PostgreSQL compiled to WebAssembly, embedded in the test process); in CI
the same suite runs against a `postgres:16` service. **Not SQLite**: the
schema's value is in what it refuses — enum types, `CHECK (execution_mode =
'demo')`, `NUMERIC` exactness — and SQLite refuses different things, so a green
SQLite run would prove nothing while looking like proof. Every test reports the
engine and version it ran on ([ADR-0007](adr/0007-two-engine-database-testing.md)).

Isolation is per-test `TRUNCATE ... RESTART IDENTITY CASCADE`; the migration
tests drop and recreate the schema so they apply against a genuinely empty
database. Persistence fixtures use a Signal from the **real decision pipeline**,
not a hand-written stub — a stub would hide mapping bugs in exactly the nested
fields (confidence components, conflicts, data quality) that matter.

**API** — the real Fastify app through `inject()`. No mocks of the engine: the
route, the validation, the strategy registry and the decision pipeline all run.
Only the network is skipped. The suite runs twice over: once with a database
injected, once with none, because "works without persistence" is a contract.

**E2E** — reserved for cross-process workflows: the dashboard reaching the API,
strategies registered in the backend appearing in the UI, and the honesty
labels (demo mode, uncalibrated confidence, empty states) being visible to a
user. It does not re-test engine logic.

## Testing the honesty guarantees

These have tests because they are product requirements, not documentation:

- `calibration` is always `uncalibrated_heuristic` and `sampleSize` always
  `null`.
- Backtest results are always `historical_simulation` and carry the disclaimer.
- Synthetic datasets always produce a warning containing `SYNTHETIC`.
- `describeConfig` never contains a secret value.
- Live execution is blocked at config, risk and guard layers.
- Empty metrics are `null`, never `0`.
- `/v1/assets` and `/v1/signals` return empty results with stated reasons.
- AI capabilities report `rule_based` / `not_implemented`, never `llm`.
- The database refuses live accounts, live trades, live signals and backtests
  claiming to be live performance.
- Stored signals keep `data_source`, so synthetic data cannot be read back as
  live-provider data — including in the calibration read model.
- `/v1/calibration/status` reports `implemented: false` no matter how many
  settled outcomes exist.

## Determinism

Every test is deterministic. Randomness exists in exactly one place —
`createSeededRandom` in `@binaryai/fixtures` — and it is seeded. Clocks and id
generators are injected (`now`, `idFactory`), so backtests and pipeline runs
compare exactly.

A flaky test in this codebase means a real non-determinism bug, not a retry.

## Conventions

- Test names state a behaviour: _"blocks live mode outright"_, not _"test risk 3"_.
- Assertions target behaviour, not implementation, so refactors do not break tests.
- Fixtures are synthetic and labelled; no test depends on a network call.
- When a test and the code disagree, work out which is wrong. During this build
  a "dataset too short" test failed because the _test's_ arithmetic was wrong;
  the fix was the test, and the reasoning went in the commit rather than a
  weakened assertion.

## Gaps

Named rather than hidden:

- **No E2E execution.** Playwright is scaffolded but not installed.
- **PostgreSQL 16 has never actually run.** The CI job and the local script both
  exist and are correct, but the repository has no commits and no remote, so
  nothing has ever triggered the job. Every claim about 16 remains a claim about
  what _would_ be verified.
- **No coverage gate.** Coverage is not measured. A threshold is worth adding
  when the codebase stops changing shape weekly.
- **No property-based testing.** `fast-check` over indicators would be a good
  addition — invariants like monotonicity and bounds are natural properties.
- **No load testing.** Meaningless before a data provider exists.
- **Concurrency tests exist but have never executed.** `tests/db/postgres-only.test.ts`
  races two real connections on paper-action idempotency, settlement-once and
  `SELECT FOR UPDATE`. It skips on PGlite, which is every run so far.
- **Redis has never been reached.** The RESP client is tested against a real TCP
  socket and the store against a deterministic fake, but no test has spoken to a
  Redis server.
