# Continuous runtime

How BinaryAI runs when it is left running: ingestion, live analysis and expiry
settlement.

```
COINBASE → ingestion worker → normalize → quality scan → PostgreSQL
                                                            ↓
                                              latest CLOSED candles
                                                            ↓
                                                  evaluateDecision()
                                                            ↓
                                              risk engine → recommendation
                                                            ↓
                                                    signals (atomic)
                                                            ↓
                                              settlement worker (on expiry)
                                                            ↓
                                                    signal_outcomes
                                                            ↓
                                              signal_calibration_samples
```

Three independent workers on one lifecycle. They are separate schedulers, not
one pipeline, because they fail and recover independently: a provider outage
stops ingestion but must not stop settling signals that already expired.

## What it is not

It ingests, analyses, records and settles. It does **not** place orders, connect
to a broker, manage money, size positions or retry trades — and there is no code
path in `@binaryai/runtime` that could. Execution remains disabled at the
configuration layer, the risk engine, the execution guard and the database.

## The workers are opt-in

All three default to **off**. Background loops that call an external provider
must be an explicit choice, and development must be able to run the API without
them.

```bash
MARKET_DATA_WORKER_ENABLED=false   MARKET_DATA_POLL_INTERVAL_MS=30000
LIVE_ANALYSIS_ENABLED=false        LIVE_ANALYSIS_INTERVAL_MS=15000
SETTLEMENT_WORKER_ENABLED=false    SETTLEMENT_INTERVAL_MS=30000

LIVE_ANALYSIS_SYMBOL=BTCUSD
LIVE_ANALYSIS_TIMEFRAME=1m
LIVE_ANALYSIS_STRATEGY=trend-momentum
```

A worker that is enabled but cannot function — ingestion without a provider,
analysis without a database — logs why and does not start.

## Scheduler

~100 lines of `setTimeout`, deliberately. The requirement is "run this on an
interval, never concurrently, stop cleanly"; a job framework or message broker
would add operational surface without addressing anything PostgreSQL does not
already guarantee.

Three properties that matter more than they look:

**Single flight.** A tick that fires while the previous run is still going is
skipped and counted, not queued. Queueing would let a slow provider build an
unbounded backlog of stale work.

**Re-armed after completion.** The gap is measured from the _end_ of the
previous run, so a run that overruns its interval cannot cause a pile-up.

**No orphan timers.** `stop()` clears the pending timer, aborts the signal and
awaits the in-flight run, so nothing writes after shutdown and the process can
exit.

## Ingestion

A thin planner around the **existing** bounded ingestion worker — it decides
which window to fetch and delegates. Retries, backoff, rate limiting, quality
validation and idempotent upserts all behave exactly as a manual backfill does.

The window is derived from the newest stored candle, not from memory, so a
restart resumes from the database. Each cycle re-fetches a small overlap
(default 3 bars) to absorb clock drift, provider lag and a missed cycle. That is
safe because upserts are idempotent — and it is how a bar that was still forming
last cycle gets its final values this cycle.

## Candle finalization

**A forming candle never informs a decision.** This is the single most important
rule in the loop.

The provider adapter marks a bar complete only once its close time has passed,
and the analysis loop filters to `complete && timestamp + interval <= now`. The
decision bar is the newest bar that survives that filter.

Without this, the engine would decide on a partial candle whose high, low and
close are all still moving — and the same candle would produce a different
decision each poll.

## Live analysis

Calls **the exact function** the API and the backtester call:
`evaluateDecision` from `@binaryai/engine`. There is no live-specific indicator,
strategy, confidence or risk path. A live decision that differed from a
backtested one on the same input would make every backtest meaningless.

The loop's own job is entirely preconditions:

| Check                  | Behaviour when it fails                                           |
| ---------------------- | ----------------------------------------------------------------- |
| Database configured    | `no_persistence` — a signal that cannot be stored is not produced |
| Candles exist          | `no_candles`                                                      |
| Newest bar closed      | `no_finalized_candle` — waits                                     |
| Enough warm-up history | `insufficient_history`                                            |
| No gaps in the window  | `data_gap` — indicators assume continuity                         |
| Not already analysed   | `already_analyzed`                                                |
| Data passes integrity  | `unusable_data`                                                   |

Only then does the engine decide, and **the engine's decision is final**. There
is no shortcut from "strategy says CALL" to a stored CALL signal: the pipeline
is market → indicators → strategy → regime → confidence → risk →
recommendation → persistence.

## Deduplication

Each analysis event has a deterministic identity:

```
sig_<hash of  asset : timeframe : decisionCandleTs : strategyId@version>
```

Same bar, same strategy version ⇒ same id, forever. That makes deduplication a
property of the data rather than of a cache: a restarted process, a duplicated
tick and a manual re-run all collapse onto the same row.

The application checks first, but the **unique index on `signals.signal_key` is
the actual guarantee** when two workers interleave. Application guards are an
optimisation; the constraint is the protection.

## What gets persisted

Every evaluation is stored with its **true status**. A risk-blocked candidate is
written as `rejected` / `skip` — an audit record, never a tradable signal. This
is deliberate:

- it is what makes deduplication survive a restart,
- it records what the engine actually concluded, and
- it lets a later analysis ask which rejected setups would have won.

The signal and its features are written in one transaction, so a partially
persisted decision is impossible.

## Settlement

Finds signals past expiry with no recorded outcome, locates the candle that
determines the result, and writes it.

**The settlement bar** is the last bar whose close falls at or before expiry:

```
start = floor((expiresAt − interval) / interval) × interval
```

Deterministic and reproducible. Using the bar that merely _contains_ expiry
would settle on a close that happens after the option expired; using "the latest
price" would make the result depend on when the worker happened to run.

Two rules it will not bend:

**No guessing.** If the settlement candle is missing or still forming, the
signal stays unresolved with a stated reason and a later cycle retries once
ingestion backfills it. Substituting another price silently changes what was
measured.

**No payout economics.** The outcome records _directional correctness only_.
BinaryAI has no broker terms, so attaching a payout would fabricate profit from
a directional result. `payout` is `null` on every live outcome, and no ROI or
profit curve is derived from these outcomes anywhere.

Non-directional (`none`) signals are never scanned: they predicted nothing, so
there is nothing to settle.

## Data-origin semantics

Outcomes are settled from **exchange** candles and are stamped
`dataOrigin: 'exchange'` with the note _"Directional outcome from exchange data.
Not a broker settlement result."_

A binary-options broker quotes and settles on its own feed, which can differ in
price and timing. Until such a feed is integrated, an outcome here describes
what the market did — not what a broker would have paid.

## Calibration

Settled outcomes flow into `signal_calibration_samples` automatically. That is
the entire point of the settlement worker: building the labelled dataset a
future calibration model needs.

**Accumulating samples is not calibration.** `/v1/calibration/status` reports
`implemented: false` no matter how many samples exist, and every signal keeps
`calibration: 'uncalibrated_heuristic'`. That does not change until a model is
fitted and validated walk-forward — see [ai-architecture.md](ai-architecture.md).

## Failure handling

| Failure                   | Behaviour                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Provider unreachable      | Market data `DISCONNECTED`; stored data is not refreshed and is not presented as current |
| Data stale                | Market data `STALE` with the age                                                         |
| Insufficient candles      | Analysis skips with `insufficient_history`                                               |
| Gap detected              | Analysis blocked with `data_gap`                                                         |
| Database unavailable      | No analysis: a signal that cannot be persisted is not produced                           |
| Settlement candle missing | Outcome left unresolved with a reason; retried later                                     |
| Worker throws             | Counted, surfaced in status, loop continues — a worker never takes the process down      |

## Crash recovery

The database is the durable source of truth; the workers hold counters only.

After a restart: ingested candles remain; already-analysed candles are not
re-analysed, because the deterministic key already exists; existing signals
remain; and expired unsettled signals are rediscovered by a database query, not
from memory.

## Startup and shutdown

On start: configuration is validated, persistence is created and pinged, the
provider is resolved, workers are constructed always and started only when
enabled.

On shutdown (SIGINT/SIGTERM): **stop scheduling first**, then close the HTTP
server so in-flight requests finish, then drain the connection pool. The reverse
order can abort a worker query mid-transaction.

## Observability

Structured events for ingestion (completed/failed/skipped), analysis
(signal created / no signal / skipped / blocked), and settlement
(completed/failed). Routine states are deliberately quiet: "waiting for the
current bar to close" and "already analysed" are the normal condition between
candles and would bury the events that matter if logged every tick.

Durable history goes to `system_events`.

## API

| Endpoint                    | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `GET /v1/runtime/status`    | All three workers                         |
| `GET /v1/analysis/status`   | Analysis worker plus what it requires     |
| `GET /v1/settlement/status` | Settlement worker plus explicit semantics |
| `GET /v1/signals/latest`    | Most recent evaluations                   |

Worker rows also appear in `GET /v1/system/status`, so the dashboard's System
strip shows them without any UI change.

Status is keyed on what workers _did_. An enabled worker that has not completed
a cycle reports `degraded`, never `ok`.

## Limitations

- Single instance. Two processes against one database are protected by
  constraints, but the schedulers do not coordinate.
- One symbol and timeframe per process.
- Polling, not streaming — the provider has no candle websocket channel.
- Counters are in-memory and reset on restart; durable history is in
  `system_events`.
