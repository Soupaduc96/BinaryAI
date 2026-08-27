# ADR-0009 — In-process workers with PostgreSQL as the coordination point

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

Phase 2C turned BinaryAI from on-demand analysis into a continuously running
pipeline: poll for candles, analyse each closed bar exactly once, settle signals
when they expire.

That shape — recurring work, exactly-once semantics, crash recovery — is
usually where a queue or job framework is reached for. The candidates were
BullMQ/Redis, a database-backed job table with leasing, an external scheduler,
or plain in-process timers.

## Decision

Three in-process `setTimeout` schedulers, with **PostgreSQL constraints as the
correctness boundary**:

- `signals.signal_key` unique index — the same bar cannot produce two signals.
- `signal_outcomes.signal_id` primary key — a signal cannot be settled twice.
- Candle primary key `(asset_id, timeframe, opened_at)` — re-delivery updates.
- All durable state in tables; workers hold counters only.

No Redis, no broker, no job table, no leasing protocol.

## Rationale

**The hard requirement is exactly-once _effects_, not exactly-once _execution_.**
Every operation here is idempotent by construction: ingestion upserts, analysis
derives a deterministic id from the bar it analysed, settlement is keyed on the
signal. Re-running any of them is harmless. That collapses the problem a queue
exists to solve — a queue would provide at-least-once delivery, which is exactly
what we already tolerate.

**The database is a better coordinator than a queue here.** A job queue would
guard the _application_ path while the database still needed the constraints to
protect against a second process. That is two mechanisms where one suffices, and
the weaker one would be the one everybody reasons about.

**Scale does not justify it.** One symbol on a 1-minute timeframe is one
analysis per minute. Redis plus a worker framework to schedule 1,440 idempotent
operations a day is operational surface bought against no problem.

**Recovery is already free.** Because the ingestion window derives from the
newest stored candle, the analysis key derives from the bar, and settlement
scans for expired-and-unsettled, a crashed process resumes correctly with no
recovery protocol. A job table would need its own crash semantics — orphaned
leases, retry counters, dead-letter handling.

**Single-flight is the only concurrency control needed** within a process, and
it is ten lines.

## Consequences

**Good.** No new infrastructure. Correctness lives in constraints that hold
regardless of how many processes run. Recovery requires no protocol. The whole
runtime is testable in-process against a real PostgreSQL engine, with no broker
to stand up in CI.

**Bad — and real:**

- **Single-instance scheduling.** Two API processes would each poll and each
  analyse. The database prevents duplicate rows, so the result stays correct,
  but the provider gets called twice and the losing writer wastes work. Running
  more than one instance needs advisory locks or a leader election.
- **One symbol and timeframe per process.** Multi-asset means either multiple
  processes or a worker fan-out inside the runtime.
- **Counters reset on restart.** Status shows process-local numbers; durable
  history is in `system_events`.
- **No backpressure or priority.** A slow provider means skipped ticks, which is
  the right behaviour here but would not be for a queue of user-submitted work.

**Untested locally.** True multi-connection races cannot be exercised on the
embedded engine (single connection). The constraint behaviour is tested
sequentially; the concurrent case relies on PostgreSQL semantics and is verified
in CI against a real server — see [ADR-0007](0007-two-engine-database-testing.md).

## Revisit if

More than one instance must run, more than a handful of symbols are analysed
concurrently, work needs prioritisation or backpressure, or scheduling must
survive independently of the API process. The natural next step is PostgreSQL
advisory locks for leader election — still no new infrastructure — and only then
a real queue.
