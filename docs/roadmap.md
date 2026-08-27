# Roadmap

Each phase lists what it delivers and what must be true before it starts.
Phases are sequenced by dependency, not by appeal.

---

## Phase 1 — Foundation ✅ complete

Monorepo, strict TypeScript, shared types, indicator library, strategy system,
decision pipeline (validate → analyse → strategy → confidence → risk), risk
engine, backtester, paper trading, REST API, dashboard shell, database schema,
documentation, 179 tests.

**Deliberately excluded:** market data, persistence, live execution, trained
models, user accounts. (Persistence landed in Phase 2A.)

---

## Phase 2A — Persistence foundation ✅ complete

PostgreSQL schema applied and constraint-tested, migration runner with a
checksummed ledger and transactional rollback, connection pool with graceful
shutdown, repositories for assets, candles, strategies, signals, features,
outcomes, backtests and events, opt-in persistence on the API, the
`signal_calibration_samples` read model, CI with a real PostgreSQL 16 job, and
117 new tests.

Query-layer decision recorded in
[ADR-0006](adr/0006-query-layer-node-postgres.md); testing approach in
[ADR-0007](adr/0007-two-engine-database-testing.md).

**Deliberately excluded:** market data, live execution, trained models,
calibration. Confidence remains `uncalibrated_heuristic`.

---

## Phase 2B — Market data ingestion

_The phase everything else waits on. Without real data the system cannot
produce a signal from anything but a request body._

**Entry criteria:** a chosen data provider with documented rate limits and
historical coverage. Persistence is done.

- Provider adapter mapping payloads to `RawCandleSeries` — behind an interface,
  so a second provider is additive.
- Ingestion worker: normalize → quality scan → `CandleRepository.upsertSeries`.
  Reconnect with backoff; gap detection and backfill.
- Redis for recent bars and shared rate limiting.
- Live analysis loop calling the same `evaluateDecision`, persisting each signal.
- Expiry settlement worker writing `signal_outcomes` automatically — today
  outcomes are recorded through the API by hand.
- Real charts in the dashboard, and asset/timeframe selectors that work.

**Exit criteria:** signals generated from live data are stored with their
features, and outcomes are recorded at expiry.

---

## Phase 2C — Continuous runtime ✅ complete

Polling scheduler around the existing ingestion worker, live analysis calling
the same `evaluateDecision` as the API and the backtester, deterministic
per-candle deduplication, automatic expiry settlement feeding
`signal_calibration_samples`, runtime status endpoints, and an engine guard
against incoherent decision timestamps. All workers are opt-in and default off.

Architecture recorded in [ADR-0009](adr/0009-in-process-workers.md).

**Still excluded:** broker, execution, calibration. Confidence remains
`uncalibrated_heuristic`.

---

## Phase 3 — Users, sessions and per-user scoping

**Entry criteria:** persistence working (done in Phase 2A).

**Done**

- `users` and `accounts` wired up; Argon2id hashing; opaque server-side
  sessions in an httpOnly cookie ([ADR-0010](adr/0010-opaque-server-sessions.md)).
- Per-user authorization and row-level scoping, with `AccessScope` as a required
  parameter rather than a convention ([ADR-0011](adr/0011-ownership-model.md)).
- CSRF protection: `SameSite=Lax` plus an origin check on cookie-authenticated
  writes.
- Login enumeration resistance, per-IP credential throttling and per-account
  lockout.
- Sign-in screen, identity in the command bar, session forwarding through SSR.

**Still open, carried forward**

- Paper accounts, positions and settlement surfaced in the UI (the engine
  already exists).
- Per-user risk limits **enforced** — `accounts.risk_limits` is stored and
  round-trips, but the risk engine still reads global defaults.
- Admin user management: roles are enforced, but no route creates, disables or
  promotes a user.
- Password reset, email verification and MFA — all need an email transport.
- Rate limiting moved to a shared store — delivered in Phase 6C below.
- Scheduled session pruning.

---

## Phase 4 — Outcome intelligence and analytics

**Entry criteria:** settled outcomes accumulating (done in Phase 2C).

**Done**

- Calibration eligibility as an explicit, auditable read model — every settled
  signal carries a verdict, and exclusions are counted rather than dropped.
- Outcome taxonomy that refuses to fold a rejected signal, an unresolved
  outcome or a tie into `loss`.
- Bucketed frequency measurement with a versioned methodology
  ([ADR-0012](adr/0012-calibration-methodology.md)).
- Minimum-sample policy: below `ANALYTICS_MIN_SAMPLES` no rate is published,
  and a null rate never renders as zero.
- Evidence levels on every figure.
- Breakdowns by strategy, regime, timeframe, asset and direction; time series
  with real gaps.
- Eight additive analytics endpoints, scoped in SQL, bounded and validated.
- Dashboard: observed outcomes and calibration, separated from simulation.

**Still open, carried forward**

- **A calibration model.** Not implemented and `implemented` stays false. The
  five conditions are listed in ADR-0012; sample volume alone is not one of them.
- Confidence intervals to replace evidence tiers as the uncertainty signal.
- Significance testing on the confidence relationship.
- Persisting `calibration_runs` on a schedule.
- Per-account risk limits enforced by the risk engine.
- Paper accounts and positions surfaced in the UI.
- Rate limiting moved to Redis.

---

## Phase 5 — Per-account risk enforcement and paper positions

**Entry criteria:** users, accounts and sessions (done in Phase 3).

**Done**

- Account risk limits are **actually enforced**. `accounts.risk_limits` was
  stored but never read since Phase 3; it is now the authoritative policy on
  every paper action.
- `evaluateAccountAction`: a pure account-level risk layer, separate from
  signal-level risk, with a six-value outcome vocabulary and per-rule
  observed/limit/window reporting.
- Caller-supplied limits may only TIGHTEN. The analysis endpoint previously
  accepted arbitrary limits, which made the stored policy advisory.
- Paper positions with a full lifecycle, enforced by CHECK constraints.
- Append-only exposure ledger, enforced by a database trigger; the balance is
  derived, never stored.
- Idempotent actions via a unique index, checked before risk evaluation so a
  retry is never refused by the limit its own success created.
- Position creation inside a transaction holding the account row lock.
- Paper settlement in the existing worker, under the existing bar rule, as a
  write separate from the signal outcome.
- Account workspace in the dashboard, labelled simulated throughout.

**Still open, carried forward**

- ~~No profit-and-loss accounting~~ — **closed by Phase 6**, though not the way
  this entry predicted. A _user-configured_ rate was built and then rejected: it
  let the client author the accounting model. Simulation is now a server-defined
  versioned model the user selects. See
  [ADR-0014](adr/0014-simulation-model.md).
- True multi-connection concurrency remains unverified locally (PGlite is
  single-connection); it needs the postgres:16 CI job.
- Multiple accounts per user; account selection semantics.
- Admin reversal/adjustment endpoints (the ledger types exist, nothing writes them).
- A calibration model (Phase 4 carry-over; sample volume is the gate).
- Rate limiting moved to Redis.

---

## Phase 6 — Versioned paper simulation ✅ complete

**Entry criteria:** paper positions and the append-only ledger (Phase 5).

**Done**

- `simulation_models`: a server-defined, versioned catalogue published by
  migration and immutable once published. A trigger refuses edits to a published
  model's arithmetic, because editing one would silently rewrite the meaning of
  every ledger entry stamped with it.
- Every parameter that affects a figure is in the model row and checked by the
  schema. A model missing its tie rule cannot be published.
- `applySimulationModel`: pure and deterministic; the same model version,
  outcome and exposure always produce the same number.
- `simulated_return` ledger entries, stamped with model id **and** version, with
  a CHECK making an unattributable simulated figure impossible to write.
- Idempotent settlement: the unique index on `(position_id, type)` means a retry
  cannot pay twice. Verified live over three cycles.
- Ties stay a third outcome; unresolved positions produce nothing and are
  reported in their own field, never folded into losses.
- Dashboard: a **Paper Simulation** section, exposure separated from simulated
  account value in the account card, and a per-position simulated column.
- A client cannot author the model. The selection endpoint takes an id and
  rejects a body carrying its own rate.

**Superseded during the phase**

- The per-account payout assumption (migration `0007`) let a client `PATCH` its
  own rate. It was replaced before release. The columns remain, documented as
  superseded, so any `simulated_payout` entries stay interpretable; no code path
  reads them, and they are excluded from the model total.

**Still open, carried forward**

- PostgreSQL 16 CI has still never run — no commits, no remote.
- A calibration model (Phase 4 carry-over; sample volume is the gate).
- Fees, slippage and spread are not modelled, so a simulated figure is
  optimistic relative to any real analogue.
- Admin reversal/adjustment endpoints.
- Rate limiting moved to Redis.

---

## Phase 6B — Production readiness ✅ partial

**Done**

- **Scheduled session retention.** A maintenance worker sweeps expired session
  rows (hourly by default, on by default since it needs only a database). It
  deletes strictly by expiry using `now` as the cutoff, so a sweep can never
  sign anybody out — verified against a real engine, not only against a stub.
- Runtime status reports the sweep, and distinguishes "never run" (`null`) from
  "ran and removed nothing" (`0`).
- **CI trigger fixed.** The workflow watched `main` while the repository sits on
  `master`, so a push would never have triggered it — which is part of why the
  PostgreSQL 16 job has never executed.

---

## Phase 6C — Infrastructure hardening ✅ partial

**Done**

- **Shared rate limiting.** `@binaryai/rate-limit`: a `RateLimitStore`
  interface with an in-process and a Redis implementation, five traffic classes
  (`auth_attempt`, `api_request`, `analytics`, `ingestion`,
  `paper_action`), and identity keys derived from the session rather than from
  any credential. Credential traffic fails **closed** when the counter is
  unreachable; everything else fails open and reports degraded. See
  [ADR-0016](adr/0016-shared-rate-limiting.md).
- **Configuration fails closed at boot.** Production refuses
  `RATE_LIMIT_STORE=memory` without an explicit `RATE_LIMIT_ALLOW_IN_MEMORY=true`,
  and `redis` without `REDIS_URL`. A multi-instance deployment can no longer
  silently enforce a limit nobody chose.
- **A four-command Redis client**, written against `node:net` rather than
  pulling in a client library for a security-relevant path. Its RESP handling is
  tested against a real TCP socket.
- **Liveness and readiness separated.** `/health/live` consults nothing, so an
  external outage cannot get a healthy instance restarted. `/health/ready`
  returns 503 when a configured database or a configured _shared_ limiter is
  unreachable — and deliberately ignores market data, which degrades gracefully.
- **System status made truthful.** The `cache` component, which reported "ok"
  whenever `REDIS_URL` was merely _set_, is replaced by `rate_limiter`, keyed
  on the limiter's real state. A `maintenance` component was added.
- **A real defect fixed:** `/v1/system/status` returned **500** when the
  database was unreachable — the one endpoint an operator consults during an
  outage. Both the runtime's pending-settlement count and the market-data
  status now degrade to "unknown" instead of propagating.
- **The auth audit trail.** `login_succeeded`, `login_failed`,
  `login_blocked`, `account_locked`, `session_revoked`,
  `sessions_revoked_all`, `password_changed`, `password_change_failed` —
  with tests asserting no password, digest or token ever appears in one.
- **The PostgreSQL 16 path.** `npm run verify:postgres` asserts the server
  version before running anything, migrates from zero, proves idempotency, then
  runs the database and integration suites. CI runs the same command, so the two
  cannot drift. `tests/db/postgres-only.test.ts` holds the race and locking
  cases and **skips** without a server rather than passing vacuously.
- **A structural ownership guard.** `tests/integration/ownership-audit.test.ts`
  reads the API source and fails if any route ever reads an account id from a
  query string or body. Verified to catch a real violation, not merely to pass.
- **Multi-instance guarantees classified** in
  [ADR-0015](adr/0015-multi-instance-guarantees.md): what the database enforces,
  what merely duplicates work, and what is unsafe without shared state.

**Still open**

- **PostgreSQL 16 CI has still never run.** The workflow is correct, the script
  is correct, and `postgres:16-alpine` is defined — but the repository has **no
  commits and no remote**, so nothing has ever triggered it. This remains the
  single largest outstanding verification gap, and it is external: it needs a
  remote, not more code.
- **Redis has never been reached.** The client, the store and the fail-closed
  policy are implemented and tested — the client against a real TCP socket, the
  store against a deterministic fake. No Redis server was reachable from this
  environment, so distributed behaviour under real concurrency, failover and
  cluster redirection are **unverified**. Implemented ≠ verified.
- **Workers are uncoordinated across instances.** Duplicated work, not
  incorrect work — every write they end in is protected by a database
  constraint. Leader election is deliberately not built; see ADR-0015.
- Calibration model remains unimplemented, by intent.

---

## Phase 6D — Infrastructure verification ✅ mostly

The phase that turned claims into evidence. See
[verification.md](verification.md) for the full matrix.

**Verified against real infrastructure**

- **PostgreSQL 16 — VERIFIED.** `embedded-postgres` ships the official
  PostgreSQL binaries, so a real 16.14 server now starts from npm alone, with no
  container runtime. `npm run verify:postgres` asserts the version first,
  migrates from zero, proves idempotency, and runs both suites: **251 database
  tests and 308 integration tests, all passing on a real server over TCP through
  the real pool.** The 7 concurrency tests that had been written but never
  executed — row locking, unique-constraint races, settle-once — now run.
- **Multi-instance — VERIFIED.** `npm run verify:distributed`: **18/18**. Two
  API processes, one database, one shared counter. With a budget of 10, A served
  6 and B served 4 then refused — **one combined budget, not two.** A session
  issued by A is accepted by B; logout on A invalidates it on B. A dead counter
  fails credential traffic closed (503) and general traffic open, with readiness
  degraded and liveness still 200.
- **The initial commit exists.** The repository had 366 files staged and zero
  commits for its entire life until now.

**Two real bugs caught by running against a server, invisible on PGlite**

- `tests/integration/audit-log.test.ts` dropped `system_events` and "restored"
  it with `migrate()` — which applies only PENDING migrations, so the ledger
  still listed 0001 as applied and the table was never recreated. Each PGlite
  file has its own database, so the damage was invisible; against one shared
  server it failed 13 unrelated tests in a later file. Now renamed and restored
  in a `finally`.
- Server-backed suites needed `--maxWorkers=1`. Eight files opening pools at
  once exhausted connection setup on a server that creates a process per
  connection; twelve of thirteen files failed before an assertion ran.

**Still open — all external**

- **Redis — EXTERNAL.** No test has ever spoken to a Redis server. Redis has no
  supported native Windows build; `redis-memory-server` delegates to Memurai
  (separate commercial software) there. Set `REDIS_URL` on Linux or macOS, or
  `docker compose up -d`, and the same verification runs unchanged. The RESP
  client and the shared-budget behaviour are verified; Redis-the-product is not.
- **CI — EXTERNAL.** The workflow is correct and runs the same command as local
  verification, but the repository has **no remote**, so it has never executed.
  Creating one needs account access that does not exist in this environment.
- **Workers multi-instance — UNVERIFIED.** Their duplication safety rests on
  database constraints, which the PostgreSQL 16 run does verify under
  concurrency — but two competing runtime processes were not observed.
- Calibration remains unimplemented, by intent.

---

## Phase 7 — The AI layer, for real

**Entry criteria:** the labelled dataset from Phases 2–4.

- Trained regime classifier replacing the thresholds (same return type).
- Anomaly detection on market conditions — feeds risk, not entries.
- LLM explanations under the constraints in
  [ai-architecture.md](ai-architecture.md).
- Signal ranking once concurrent candidates exist.

Each capability flips its `AiCapabilityStatus.implementation` when — and only
when — something real is behind it.

---

## Phase 8 — Production hardening

- CI: add `npm audit` and dependency review (lint/typecheck/test/build and the
  PostgreSQL 16 job landed in Phase 2A).
- Containers, migrations in the deploy pipeline, health-check wiring.
- Structured metrics and tracing; alerting on ingestion gaps and error rates.
- Backups and restore drills.
- E2E suite running in CI.
- Load testing against realistic ingestion rates.

---

## Explicitly not planned

**Live execution** is not on this roadmap. It would need its own design, its own
review, and at minimum: a reviewed broker adapter with idempotent submission,
fill reconciliation, a kill switch reachable without a deploy, server-side
per-user limits, a full audit trail, migrations relaxing the demo-only
constraints, and calibrated confidence. It is a separate project, not a
milestone.

**Social/copy trading, signal marketplaces, referral schemes.** Out of scope and
against the product's stated purpose.

**Guaranteed-return claims of any kind.** Not a feature.
