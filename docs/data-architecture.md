# Data architecture

## The boundary

There is exactly one way market data enters BinaryAI:

```
untrusted payload
   → normalizeCandleSeries()   Zod parse, defaults, sort by timestamp
   → CandleSeries              typed, ordered, structurally valid
   → assessDataQuality()       integrity scan → DataQualityReport
   → analysis / strategies / backtest
```

Nothing downstream may consume a provider payload directly. Because this
boundary exists, `@binaryai/indicators` can throw on non-finite input instead of
defensively returning `NaN` and quietly poisoning a series.

## Provenance travels with the data

`CandleSeries.source` is one of `live_provider`, `historical_provider`,
`historical_file`, `synthetic`, `unknown`, and it is copied onto every `Signal`
and every `BacktestResult`. Synthetic data cannot be laundered into looking
live: the label follows it through the pipeline, into the API response, and into
the UI.

## What quality validation checks

| Code                       | Severity | Meaning                                                |
| -------------------------- | -------- | ------------------------------------------------------ |
| `empty_series`             | error    | No candles                                             |
| `insufficient_history`     | error    | Fewer candles than the strategy requires               |
| `non_monotonic_timestamps` | error    | Time goes backwards                                    |
| `duplicate_timestamp`      | error    | Same bar twice — corrupts every indicator              |
| `invalid_ohlc_range`       | error    | `high < low`, or body outside the range                |
| `non_finite_value`         | error    | `NaN` or `Infinity`                                    |
| `non_positive_price`       | error    | Price ≤ 0                                              |
| `timestamp_gap`            | warning  | Missing bars (weekend, outage, thin market)            |
| `unexpected_interval`      | warning  | Bar spacing does not match the timeframe               |
| `negative_volume`          | warning  | Provider bug                                           |
| `incomplete_last_candle`   | info     | Final bar still forming — decide on the previous close |

Any `error` sets `usable: false`. The score starts at 1.0 and subtracts 0.4 per
error, 0.1 per warning, 0.02 per info, clamped to 0–1.

The report is an **input**, not a gate. The risk engine decides what to do with
it (`minDataQualityScore`, default 0.8), and the score feeds confidence at 10%
weight. Bad data lowers confidence and raises risk rather than vanishing.

## Storage

The [schema](../database/migrations/0001_init.sql) is applied and covered by
tests; [database/README.md](../database/README.md) explains the decisions and
records exactly what has been verified on which engine.

`@binaryai/database` implements the repository interfaces declared in
`@binaryai/types`. Persistence is **optional**: with no `DATABASE_URL` the API
runs stateless as before. When configured, signals, their features, outcomes and
backtest runs are stored on request.

Key choices:

- **`NUMERIC`, never `FLOAT`.** Binary settlement compares prices for equality
  to detect ties; float drift would turn ties into losses.
- **Candles keyed `(asset_id, timeframe, opened_at)`.** Re-delivery updates
  rather than duplicating.
- **`signal_features` is relational**, not only JSON, so questions can be asked
  across signals — the prerequisite for calibration.
- **`NULL` means unknown**, not zero.
- **Provenance survives storage.** `candles.source` and `signals.data_source`
  carry the `data_source` enum, so synthetic data cannot be read back as live.

## Planned ingestion flow (still to build)

```
provider ws/rest
      │
      ▼
ingestion worker ──► normalize ──► quality scan ──► candles table
      │                                                 │
      │                                                 ▼
      └────────────► Redis (latest bars, pub/sub) ──► analysis worker
                                                        │
                                                        ▼
                                              evaluateDecision()
                                                        │
                                                        ▼
                                         signals + signal_features
                                                        │
                                              expiry ──►signal_outcomes
```

The storage half of this now exists — `CandleRepository.upsertSeries` writes
idempotently in batches, and `SystemEventRepository` records ingestion problems.
What is missing is the provider adapter and the worker that drives them.

Two rules already fixed by the current design:

1. The analysis worker calls the **same** `evaluateDecision` the API and the
   backtester call. No parallel implementation.
2. Ingestion writes only validated candles. A payload that fails validation is
   logged to `system_events` and dropped, never partially stored.

## Caching

Redis is configured but unused. Intended: latest bars per asset/timeframe, hot
indicator windows, shared rate-limit counters, pub/sub fan-out to websocket
clients. It must never become a second source of truth for candles — PostgreSQL
holds history, Redis holds a fast copy of the recent tail.

## Retention

Not implemented; the shape of the decision: candles are large and compress well
by timeframe — sub-minute bars need retention limits, hourly and daily bars are
cheap to keep indefinitely. `signals`, `signal_features` and `signal_outcomes`
are small and must be kept: they are the calibration dataset.
