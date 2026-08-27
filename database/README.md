# Database

PostgreSQL 16+ (uses `gen_random_uuid()`, built in since PG 13).

## Status

The schema is **applied, executed and covered by tests**. `@binaryai/database`
implements the repository interfaces from `@binaryai/types`, and the API stores
signals, features, outcomes and backtest runs when `DATABASE_URL` is set.

Persistence remains **optional**: with no `DATABASE_URL` the API runs stateless
exactly as it did in Phase 1, and every persistence-backed route returns an
empty result with the reason rather than an error.

### What has actually been verified, and where

| Verified                                                               | On what                                   |
| ---------------------------------------------------------------------- | ----------------------------------------- |
| Migrations apply from empty, are idempotent, roll back on failure      | Real PostgreSQL engine (PGlite, embedded) |
| Every CHECK, foreign key, enum and uniqueness constraint               | Same                                      |
| Repository reads/writes, transactions, calibration view                | Same                                      |
| The same suite against **PostgreSQL 16** over a real pooled connection | GitHub Actions `database` job             |

Local runs use PGlite, which bundles a **different PostgreSQL major version**
than the deployment target, and cannot exercise pooling under concurrency,
networking, TLS or roles. CI is the authoritative check — see
[ADR-0007](../docs/adr/0007-two-engine-database-testing.md). Each test prints
the engine and version it ran on, so a passing local run is never mistaken for
a claim about PG 16.

## Applying migrations

```bash
docker compose up -d                      # PostgreSQL + Redis for development
export DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai
npm run db:migrate                        # apply pending migrations
npm run db:status                         # show applied / pending, apply nothing
```

Node can read `.env` directly:

```bash
node --env-file=.env scripts/db-migrate.mjs
```

### How the runner behaves

- Migrations apply **in filename order, one transaction each**. PostgreSQL has
  transactional DDL, so a failure part-way through `0002` leaves the database
  exactly as `0001` left it.
- The `.sql` files contain **no `BEGIN`/`COMMIT`**. The runner owns the
  transaction; a file that manages its own cannot be rolled back by the runner,
  and a half-applied migration is the worst possible outcome.
- Each applied version is recorded in `schema_migrations` with a **sha256
  checksum** of the file (line endings normalised, so Windows checkouts do not
  report false drift).
- **Editing an applied migration is refused.** Migrations are immutable once
  applied; add a new one instead.

## Migrations

| File                              | Contents                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| `0001_init.sql`                   | The 14 core tables, enum types, indexes and constraints            |
| `0002_persistence_foundation.sql` | Gaps the repository layer exposed, plus the calibration read model |

Everything in `0002` was forced by a concrete problem found while writing code
against the schema, not by a redesign:

- **`signals.snapshot`** — `0001` stored reasoning and risk but not the
  indicator/confirmation/conflict/confidence detail, so a signal could not be
  replayed exactly as decided.
- **`signals.signal_key`** — the engine's own id is `sig_<uuid>` live and
  `sig_<hash>` in a backtest. Neither is a valid UUID, so it cannot be the
  primary key; the row keeps its UUID and the engine id is stored alongside.
- **`signal_features.meta`** — `IndicatorSnapshot.interpretation` had nowhere
  to live.
- **`signal_outcomes.payout` / `.metadata`** — a win under an 80% payout is not
  the same calibration sample as a win under 70%, so the assumed terms must be
  recorded with the outcome.
- **`backtest_runs.run_key`** — the deterministic run id had no home, so an
  identical re-run could not be recognised as the same run.
- **`signal_calibration_samples`** — a VIEW joining signals, outcomes,
  strategies and indicator features. Creating it does **not** calibrate
  anything; confidence stays `uncalibrated_heuristic`.

## Design decisions worth knowing

**Demo-only is a storage-level constraint.** `accounts.mode`,
`trades.execution_mode` and `signals.execution_mode` all carry
`CHECK (... = 'demo')`, and `backtest_runs.result_type` is pinned to
`historical_simulation`. Turning on live trading requires a migration someone
has to write and review — it cannot happen because an environment variable was
set wrong. Tested in `tests/db/schema.test.ts`.

**`NUMERIC`, never `FLOAT`.** Binary settlement compares two prices for
equality to detect a tie. With floating point, `100.1 - 0.1 = 100.00000000000001`
and a tie silently becomes a loss. Money and prices are `NUMERIC(20, 8)`, which
the driver returns as a **string** to avoid precision loss; conversion to
`number` happens explicitly in `packages/database/src/mappers.ts`.

**Nullable metrics mean "unknown".** `backtest_results.win_rate` is `NULL` when
no trade resolved, not `0`. A zero win rate and no data are different facts.

**Explainability is relational _and_ replayable.** `signal_features` stores
every indicator, confirmation, conflict and confidence component as a row;
`signals.snapshot` stores the whole decision as JSON. The rows answer questions
across many signals — "which conflicts preceded losing signals?" — which is the
query that must work before calibration is possible at all. The snapshot
replays one signal exactly. They are written in the same transaction, so they
cannot disagree.

**Candles are idempotent on ingest.** `PRIMARY KEY (asset_id, timeframe, opened_at)`
means a re-delivered bar updates rather than duplicating. Duplicate bars are the
classic way to corrupt an indicator series.

**Provenance survives storage.** `candles.source` and `signals.data_source`
carry the `data_source` enum, so a signal analysed from synthetic candles is
stored as synthetic and can never be read back as live-provider data. The
calibration view exposes it too, because pooling synthetic samples with market
samples would quietly corrupt any model fitted on them.

**Ground truth is separate.** `signal_outcomes` is written after expiry and is
the only source of truth about what happened. `signals.confidence_calibration`
is stored per row, so once some signals are calibrated and others are not, the
distinction survives.

## Entity map

```
users ──< accounts ──< trades >── signals >── strategies
                                    │
                                    ├──< signal_features
                                    └─── signal_outcomes
                                              │
                                     signal_calibration_samples  (view)

market_assets ──< candles
strategies ──< backtest_runs ─── backtest_results
risk_events, system_events   (operational log / audit trail)
```

## Testing

```bash
npm run test:db                    # embedded PostgreSQL, no setup needed
DATABASE_URL=... npm run test:db   # the same suite against a real server
```

See [docs/testing-strategy.md](../docs/testing-strategy.md).

## Analytics read models (0004)

Two views and one table support outcome measurement. Nothing here duplicates
signal data; the views project it.

**`signal_calibration_samples`** — extended, not replaced. `CREATE OR REPLACE`
appended `account_id`, `status`, `recommendation`, `expiration_seconds`,
`execution_mode`, `confidence_sample_size` and `settlement_data_origin`, so
every existing consumer keeps working. The first two were the blocking gaps:
without `account_id` analytics could not be scoped per user, and without
`status` a signal the risk engine REJECTED was indistinguishable from one that
was accepted and lost.

**`calibration_eligibility`** — one row per settled signal with an explicit
verdict. `exclusion_reason IS NULL` means eligible; anything else names the rule
that rejected it. Excluded rows stay visible on purpose: "260 eligible, 3
excluded" is auditable, "260 samples" is not. The CASE arm order is the policy,
so a row is always reported against the first rule it fails.

**`calibration_runs`** — append-only record of a published measurement and the
methodology that produced it. `model_implemented` is FALSE and no sample count
sets it; see [ADR-0012](../docs/adr/0012-calibration-methodology.md). Nothing
writes to this table on a schedule yet.

Four partial indexes support the aggregation access pattern (owner + settled
window, grouped by regime or timeframe), all restricted to
`status = 'accepted' AND direction <> 'none'` — the only rows analytics counts.

Historical outcomes are never rewritten. No migration mutates a stored result to
improve a statistic.

## Paper positions and the ledger (0005)

**`paper_positions`** — a user's recorded action on a signal. Not an order:
there is no order id, no payout rate and no P&L column, because BinaryAI has no
broker terms from which a payout could be derived. Two CHECK constraints keep
the states honest: a `settled` row must carry its settlement evidence, and an
unsettled row must carry none of it — which is what stops an open position from
ever displaying as a loss.

A unique index on `(account_id, signal_id, action_key)` is the idempotency
authority. A check-then-insert would leave a window in which two concurrent
requests both pass.

**`paper_ledger_entries`** — append-only exposure accounting, enforced by a
trigger that refuses UPDATE and DELETE outright. The balance is DERIVED by
summing entries rather than stored, so it can always be reconstructed and
explained line by line. There is deliberately no `win` or `loss` entry type:
settling releases exactly what opening committed, whatever the outcome.

**`accounts`** gained the account-action policy (position size, window
exposure, allowlists, allocation) rather than a new table — it is exactly one
row per account, so a separate table would add a join for nothing.

**`trades`** (0001) is SUPERSEDED and carries a COMMENT saying so. It encodes a
payout model (`payout_rate DEFAULT 0.8`, a non-null `pnl` when settled) that
Phase 5 must not adopt. It has never been written to; dropping it would not be
additive, so it is left in place.
