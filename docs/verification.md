# Verification status

What has actually been run, against what, and what that does and does not prove.

This document exists because "the tests pass" is not one claim — it is several,
and they are not equally strong. A green local run proves the logic is right. It
does not prove the SQL runs on the deployed PostgreSQL version, that two
instances agree, or that anything works against Redis. Those are different
claims needing different evidence, and conflating them is how a project comes to
believe it is production-ready when it is not.

Four statuses are used, and nothing is promoted without evidence:

| Status          | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| **VERIFIED**    | Executed against the real thing. Evidence in this repo.         |
| **IMPLEMENTED** | Code exists and is tested, but not against the real dependency. |
| **UNVERIFIED**  | Neither of the above.                                           |
| **EXTERNAL**    | Blocked on infrastructure this environment cannot provide.      |

## Environments

| Environment    | Available here | What runs on it                                                                             |
| -------------- | -------------- | ------------------------------------------------------------------------------------------- |
| Unit / PGlite  | yes            | `npm test` — 1166 tests. PGlite is real PostgreSQL **18**, embedded, **one connection**.    |
| PostgreSQL 16  | yes            | `npm run verify:postgres` — real 16.14 server over TCP, pooled, from the official binaries. |
| Multi-instance | yes            | `npm run verify:distributed` — two API processes, one database, one shared counter.         |
| Redis          | yes            | `npm run verify:redis` — real Redis **3.0.504**. See the version caveat below.              |
| CI             | **no**         | Repository has no remote. See below.                                                        |

## Matrix

| Capability                       | Local          | PostgreSQL 16 | Redis        | Multi-instance | CI       |
| -------------------------------- | -------------- | ------------- | ------------ | -------------- | -------- |
| Auth (Argon2id, lockout, decoy)  | VERIFIED       | VERIFIED      | n/a          | VERIFIED       | EXTERNAL |
| Sessions (issue, expiry, revoke) | VERIFIED       | VERIFIED      | n/a          | VERIFIED       | EXTERNAL |
| Ownership / account scoping      | VERIFIED       | VERIFIED      | n/a          | VERIFIED       | EXTERNAL |
| Risk enforcement                 | VERIFIED       | VERIFIED      | n/a          | not exercised  | EXTERNAL |
| Paper ledger (append-only)       | VERIFIED       | VERIFIED      | n/a          | not exercised  | EXTERNAL |
| Settlement (settle-once)         | VERIFIED       | VERIFIED      | n/a          | **VERIFIED**   | EXTERNAL |
| Analytics                        | VERIFIED       | VERIFIED      | n/a          | not exercised  | EXTERNAL |
| Rate limiting — logic            | VERIFIED       | n/a           | n/a          | VERIFIED       | EXTERNAL |
| Rate limiting — shared budget    | n/a            | n/a           | **VERIFIED** | **VERIFIED**   | EXTERNAL |
| Rate limiting — RESP client      | VERIFIED       | n/a           | **VERIFIED** | VERIFIED       | EXTERNAL |
| Workers (isolation, lifecycle)   | VERIFIED       | VERIFIED      | n/a          | **VERIFIED**   | EXTERNAL |
| Maintenance / session retention  | VERIFIED       | VERIFIED      | n/a          | **VERIFIED**   | EXTERNAL |
| Concurrency (locks, races)       | **impossible** | VERIFIED      | n/a          | n/a            | EXTERNAL |

"n/a" means the dependency is not involved. "impossible" means the environment
cannot express the test — PGlite has one connection, so there is no second
transaction to race, and the tests **skip** rather than pass vacuously.

## PostgreSQL 16 — VERIFIED

`npm run verify:postgres` starts a real PostgreSQL 16.14 server from the
official binaries shipped by `embedded-postgres`, on TCP, through the real
connection pool. It asserts the major version _before_ running anything, applies
all 9 migrations from an empty database, re-runs the migrator to prove
idempotency, then runs the database and integration suites.

Concurrency cases that only a server can express (`tests/db/postgres-only.test.ts`)
run here and nowhere else:

- `SELECT … FOR UPDATE` blocks a second transaction until the first commits
- two concurrent duplicate paper actions → exactly one row
- eight concurrent retries of one action key → exactly one row
- two different concurrent actions on one account → both commit
- two concurrent settlement releases → exactly one ledger entry
- the derived balance nets to zero after a settlement race
- concurrent mutation of a published simulation model → both refused
- append-only triggers hold from a second connection

**Not** the same build as CI. CI runs `postgres:16-alpine` (musl Linux); this is
the platform's own build of 16.x. Same source, same major version, same planner
and constraint semantics — but a different build, so CI remains authoritative.

## Redis — VERIFIED (against 3.0.504, with a version caveat)

`npm run verify:redis`: **17/17** against a real Redis server, and
`REDIS_URL=… npm run verify:distributed`: **18/18** with two API instances
sharing that Redis as their counter.

Why a separate check when the unit tests already cover the client: those run
against `createFakeRedis`, and the distributed run can use a RESP stand-in.
Both were written by the same hand as the client they exercise, so a shared
misreading of the protocol would pass both. An independent server
implementation is the only thing that rules that out — and it did:

| Verified against real Redis |                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Protocol                    | PING, INCR, PEXPIRE, PTTL — including `-1` for no expiry and `-2` for a missing key                    |
| Pipelining                  | three concurrent INCRs, replies matched to commands in order                                           |
| Window                      | opens once, does **not** slide forward on each hit, and genuinely expires                              |
| Limiter                     | allows to the limit then refuses; reports the store shared, available, zero failures                   |
| Two instances               | one combined budget of 10 — A served 6, B served 4 then refused                                        |
| Counter outage              | credential traffic 503 `rate_limiter_unavailable`; general traffic served; readiness 503; liveness 200 |

### The version caveat, stated plainly

The server is **Redis 3.0.504**, Microsoft's archived Windows port — the only
genuine Redis obtainable on this machine (see the ruled-out list below). It is
real Redis, and the four commands this client sends have had stable semantics
since Redis 2.6, so the protocol evidence is sound.

It is **not** the Redis a deployment would run. Unverified therefore: anything
introduced after 3.0, `protected-mode`, ACLs (Redis 6+), TLS (Redis 6+),
cluster redirection, failover, and modern eviction behaviour. `docker-compose.yml`
defines `redis:7-alpine`; running `verify:redis` and `verify:distributed`
against that is what would close the remaining gap, and both scripts take
`REDIS_URL` for exactly that reason.

### Avenues checked before installing anything

| Avenue                                                        | Result                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `redis-server` on PATH                                        | not installed                                                                                          |
| Docker / Podman                                               | not installed                                                                                          |
| WSL                                                           | `wsl.exe` present but **WSL is not installed**; installing needs admin and a reboot                    |
| `redis-memory-server` (npm)                                   | compiles from source on Linux/macOS; on Windows delegates to **Memurai**, separate commercial software |
| `redis-server` (npm)                                          | only _starts and stops_ a binary you already have — ships none                                         |
| `redis-windows`, `@redis/redis-server`, `valkey-server` (npm) | do not exist                                                                                           |
| `winget install Redis.Redis`                                  | **worked** — Redis 3.0.504, installed with the operator's explicit approval                            |

## Multi-instance — VERIFIED

`npm run verify:distributed`: 18/18 checks. Two API processes on separate ports,
one PostgreSQL 16, one shared counter.

- **One budget, not two.** Budget of 10: instance A served 6, instance B served
  4 then refused. A caller that has spent the budget stays refused when its next
  request lands on the other process.
- A session issued by A is accepted by B; logout on A invalidates it on B.
- Counter unreachable → credential traffic 503 `rate_limiter_unavailable`
  (fails closed), general traffic still served (fails open), readiness reports
  the counter unavailable, liveness stays 200.

### Workers across two instances — VERIFIED

`npm run verify:workers`: 9/9 checks. Two runtime processes, one PostgreSQL 16,
both with settlement and maintenance enabled, racing over the same seeded work
for 70 seconds. The verdict comes from the DATABASE, not from logs or exit
codes.

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Settlement cycles run | **69 on each instance**, over the same 5 signals           |
| Signals settled       | 5/5, **no signal received two outcomes**                   |
| Positions released    | 5, **each exactly once**                                   |
| Derived balance       | nets to **0** — duplicate work did not inflate the account |
| Sessions              | all 6 expired rows swept; **the live session survived**    |
| Worker failures       | 0 on both instances                                        |

This is what turns ADR-0015 from an argument into a result: two instances
duplicate work and corrupt nothing, so leader election remains an efficiency
question rather than a correctness one.

The script refuses to pass vacuously — its first check is that work was
actually performed. That guard fired on the first run (0/5 settled, everything
else trivially "passing") and revealed the seed was at fault: candles were
offset from the minute boundary the settlement worker floors to, so no settling
bar was found and every position correctly landed in `pending_settlement`.

Still not exercised multi-instance: risk enforcement and ingestion.

## CI — EXTERNAL

The workflow is correct, triggers on `push` to `main`/`master` and on every pull
request, and defines a real `postgres:16-alpine` service running the same
`npm run verify:postgres` command used locally.

**It has never executed.** The repository has no configured Git remote, so
nothing has ever triggered it. This requires someone with the account to create
a repository and add the remote; it cannot be done from inside this environment,
and inventing a URL would be worse than the gap:

```bash
git remote add origin <REAL_REPOSITORY_URL>
git push -u origin master
```

### What HAS been done about it

CI cannot be run, but its steps can — and were, against a clean clone of the
committed tree rather than against a developer's working directory, because
only a fresh checkout shows what CI actually gets:

| CI step                                           | Simulated locally                        | Result                                            |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `npm ci`                                          | clean clone, no `node_modules`           | exit 0 — lockfile is complete and installable     |
| `npm run format:check`                            | same clone                               | exit 0 (**after** the `.gitattributes` fix below) |
| `npm run lint`                                    | same clone                               | exit 0                                            |
| `npm run typecheck`                               | same clone                               | exit 0                                            |
| `npm test`                                        | same clone                               | 1166 passed, 11 skipped, 66 files                 |
| `npm run build`                                   | same clone                               | exit 0                                            |
| `npm run verify:postgres` with `DATABASE_URL` set | real PostgreSQL 16 as a stand-in service | see below                                         |

The workflow file was also checked structurally: every `run:` command resolves
to a script that exists, the push trigger includes `master` (the actual default
branch), `pull_request` is present, actions are pinned to `@v4`, and the
lockfile contains the **linux-x64** `embedded-postgres` binaries CI will need —
without which `npm ci` on `ubuntu-latest` would fail at the first step.

**One real CI-adjacent defect was found this way.** `.gitattributes` was
missing, so `core.autocrlf=true` (the Windows default) checked out CRLF while
Prettier is configured `endOfLine: "lf"` — the first `npm run verify` after a
clone failed on 350 files nobody had edited. Linux CI was never affected, but
every Windows contributor would have been. Fixed by `* text=auto eol=lf`, and
confirmed by re-cloning with `autocrlf=true` and watching `format:check` pass.

None of this is a substitute for the job running. It is the difference between
"the workflow looks right" and "every command in it has been executed against
the committed tree".

## Intentionally unimplemented

- **Calibration.** Reported as `implemented: false`. Confidence remains
  `uncalibrated_heuristic`; see [ADR-0012](adr/0012-calibration-methodology.md).
- **Broker integration, order execution, real-money trading.** Not on the
  roadmap; see [ADR-0004](adr/0004-demo-only-execution.md).
- **Worker leader election.** Duplicated work is inefficiency, not incorrectness;
  see [ADR-0015](adr/0015-multi-instance-guarantees.md).
