# Local development

## Requirements

- **Node.js ≥ 20.9** (developed on 24.15), npm 10+
- Optional: Docker (PostgreSQL + Redis), Python 3.11+ (AI service skeleton)

Neither optional dependency is needed to run, test or build BinaryAI today.

## Setup

```bash
npm install
cp .env.example .env
npm run verify
```

`verify` runs format check → lint → typecheck → tests. If it passes, the
workspace is healthy.

## Running

```bash
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:3000   <- open this one
```

Both on `localhost`, not `127.0.0.1`: they are different hosts for cookie
purposes, and a mismatch leaves the session cookie unreadable by the dashboard.
See [environment.md](environment.md).

Two terminals. The API is `tsx watch`; the dashboard is Next dev with Turbopack.

The dashboard calls the API for system status and the strategy list. With the
API down it renders an "API unreachable" panel — deliberately, rather than
hanging or showing placeholder values.

### First thing worth running

```bash
npm run backtest:demo
```

Runs the full pipeline over a labelled synthetic dataset and prints metrics.
Expect roughly a 52% win rate and a small negative return: the dataset is a
driftless random walk, and a coin flip loses money against an 80% payout. That
is the honest demonstration, and it exercises indicators → strategy →
confidence → risk → settlement → metrics.

```bash
node scripts/run-backtest.mjs --strategy mean-reversion --candles 800 --seed 7
```

## Daily workflow

```bash
npm run test:watch                    # while working
npx vitest run packages/engine        # one package
npm run lint:fix && npm run format    # before committing
npm run verify                        # full gate
```

## Optional: database

The API runs stateless without one. To enable persistence:

```bash
docker compose up -d                      # PostgreSQL 16 + Redis
export DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai
npm run db:migrate                        # apply migrations
npm run db:status                         # applied / pending, applies nothing
```

### Verifying against PostgreSQL 16

`npm test` runs against PGlite, which is real PostgreSQL but is **version 18**
and has **one connection**. Neither limitation is cosmetic: production targets
16, so anything added after 16 passes locally and fails on the server; and row
locking, unique-constraint races and pooling cannot be tested at all on a single
connection.

One command closes both gaps, and it needs **no container runtime**:

```bash
npm run verify:postgres
```

With no `DATABASE_URL` set it starts its own PostgreSQL 16 server from the
official binaries shipped by the `embedded-postgres` dev dependency, on port
55432, in a throwaway cluster it deletes afterwards. `SELECT version()` reports
`PostgreSQL 16.14`; connections go over TCP through the real pool. It is a real
server, not PGlite and not an emulation.

To point it at your own server instead — which is what CI does, against
`postgres:16-alpine`:

```bash
docker compose up -d
DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai_test   npm run verify:postgres
```

`binaryai_test` is a second database created by `database/init/`, so a
verification run cannot truncate the database you are developing against. On a
volume that existed before that was added, create it once:

```bash
docker exec binaryai-postgres createdb -U binaryai binaryai_test
```

Either way the script asserts the server's major version **before** running
anything — a PostgreSQL 14 answering on the port must never be reported
afterwards as a PostgreSQL 16 verification — then migrates from zero, re-runs
the migrator to prove idempotency, and runs the database and integration suites.
Exit 2 means no server was reachable, deliberately distinguished from a test
failure.

Server-backed suites run with `--maxWorkers=1`. Against PGlite each file gets
its own embedded engine and parallelism is free; against one server, eight files
opening pools at once ask for dozens of connections simultaneously, and
PostgreSQL creates a process per connection. The first run of this script died
exactly there. Serialising costs wall-clock time and changes no assertion.

### Multi-instance verification

```bash
npm run verify:distributed
```

Starts PostgreSQL 16, a shared counter, and **two API instances** on separate
ports, then drives real HTTP through both to prove they share one rate-limit
budget, that a session issued by one is honoured by the other, and that a dead
counter fails credential traffic closed while general traffic continues.

The shared counter is `scripts/resp-server.mjs` — four RESP commands over TCP,
in its own process. It is **not Redis**, and nothing verified against it may be
described as Redis verification. See [security.md](security.md#rate-limiting).

### Optional: shared rate limiting

Redis is in the compose file but nothing reads it by default. To run with shared
counters:

```bash
export RATE_LIMIT_STORE=redis
export REDIS_URL=redis://localhost:6379
```

The API refuses to start with `RATE_LIMIT_STORE=redis` and no `REDIS_URL`.
Leaving both unset is fine for development: counters live in process, which is
correct for one instance.

To check the Redis path itself:

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run verify:redis        # client, store, limiter
REDIS_URL=redis://127.0.0.1:6379 npm run verify:distributed  # two instances, one budget
```

Both exit 2 rather than 1 when no server answers, so "no Redis here" stays
distinguishable from "Redis behaved wrongly". Without `REDIS_URL`,
`verify:distributed` falls back to a local RESP stand-in that is **not Redis**
and is labelled as such in its output.

Or put `DATABASE_URL` in `.env` and let Node read it:

```bash
node --env-file=.env scripts/db-migrate.mjs
```

Then:

```bash
# store a signal with its evidence
curl -X POST localhost:4000/v1/signals/evaluate -H 'content-type: application/json'   -d '{"strategyId":"trend-momentum","persist":true,"series":{ ... }}'

curl localhost:4000/v1/signals              # stored signals
curl localhost:4000/v1/calibration/status   # how much ground truth exists
```

### Database tests need no database

```bash
npm run test:db
```

They run against PGlite — real PostgreSQL compiled to WebAssembly, embedded in
the test process. No Docker, no server, about two seconds. Set `DATABASE_URL`
to run the identical suite against a real server instead; CI does exactly that
against `postgres:16`, and that run is the authoritative one
([ADR-0007](adr/0007-two-engine-database-testing.md)).

### Running the whole stack without a PostgreSQL server

`scripts/dev-database.mts` exposes PGlite over TCP, so the API's `pg` pool can
connect with an ordinary `postgres://` URL:

```bash
npx tsx scripts/dev-database.mts --port 5433 --dir .tmp/pgdata

DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres \
  node scripts/db-migrate.mjs
```

**Set `DATABASE_MAX_CONNECTIONS=1` when pointing the API at it.** The bridge
serves exactly ONE connection. The pool defaults to 10, and any endpoint issuing
queries concurrently — `/v1/analytics/calibration` runs several under
`Promise.all` — will otherwise open a second connection and get `ECONNRESET`,
which surfaces as a 500 that looks like a bug in the route:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres \
DATABASE_MAX_CONNECTIONS=1 \
  npm run dev:api
```

Two further consequences worth knowing before losing an hour to them:

- **The bridge terminates on a SQL error** and does not recover. Validate
  statements against in-process PGlite first, then run them once against the
  bridge.
- **Nothing else may hold the connection.** A `psql` session or a seeding script
  running alongside the API will starve it. Stop the API before connecting
  directly.

This is a development convenience, not a PostgreSQL server: it demonstrates no
pooling, no concurrency and no isolation between clients
([ADR-0007](adr/0007-two-engine-database-testing.md)).

### Migration rules

- One transaction per migration; PostgreSQL rolls back DDL on failure.
- No `BEGIN`/`COMMIT` inside a migration file — the runner owns the transaction.
- **Never edit an applied migration.** The runner checksums them and refuses.
  Add a new file instead.

## Optional: AI service skeleton

```bash
cd services/ai/reference-python
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Every endpoint returns `501`. It exists to make the contract concrete.

## Repo mechanics

**Build order.** TypeScript project references (`tsc -b tsconfig.build.json`)
build packages in dependency order and incrementally. The API and web build on
top of the compiled packages.

**Tests run against source**, not `dist`. Vitest aliases `@binaryai/*` to
`packages/*/src`, so no build is needed for a test run.

**Adding a repository:** declare the interface in `packages/types/src/persistence.ts`,
implement it in `packages/database/src/repositories/`, add it to the bundle in
`repositories/index.ts`, and cover it in `tests/db/`. Nothing outside
`@binaryai/database` should know SQL exists.

**Adding a package:** create `packages/<name>` with `package.json` and
`tsconfig.json` (copy an existing one), add it to `tsconfig.build.json`
references, add the alias to `vitest.config.ts`, and run `npm install` to link
the workspace.

**Adding a strategy:** implement `Strategy` in `packages/strategies/src`, export
it from `index.ts`, add it to `builtInStrategies`. It appears in the API and the
dashboard automatically. Write tests asserting determinism and that it abstains
when it should.

## Troubleshooting

**`Cannot find module '@binaryai/...'`** — run `npm install` (workspace links),
then `npm run build:packages`.

**`DATABASE_URL is not set`** from `db:migrate` — export it, or use
`node --env-file=.env scripts/db-migrate.mjs`.

**Migration reports drift** — an applied migration file was edited. Restore it
and add a new migration; history is immutable.

**Web build fails on types** — packages must be built first;
`npm run typecheck` does it in order.

**Port already in use** — change `API_PORT` in `.env`, or
`npm run dev:web -- --port 3001`.

**Config error at boot** — the message lists each problem. Note that
`ALLOW_LIVE_EXECUTION=true` and `EXECUTION_MODE=live` are refused on purpose.

## Conventions

- Prettier decides formatting. Do not argue with it; run `npm run format`.
- Run `npm run verify` before committing.
- Keep files under ~400 lines (ESLint warns).
- Public functions get a comment explaining _why_, not _what_.
