# Outcome analytics

How BinaryAI measures what actually happened, and what it refuses to claim from
it.

The methodology is argued in full in
[ADR-0012](adr/0012-calibration-methodology.md); the ownership rules that scope
every query are in [ADR-0011](adr/0011-ownership-model.md).

## The rule everything else follows

**A statistic that cannot be computed is `null`, never `0`.**

Zero wins from zero settled signals is not "0% accurate" — it is no evidence,
and collapsing those two is the most misleading thing this layer could do. The
null survives from the SQL aggregate, through `ObservedRate.value`, to the em
dash on screen. No component formats a percentage itself; they all route through
`RateValue`, which renders an absence when there is one.

Every figure also carries its own `sampleSize` and `evidence` level, so a number
can never be read without knowing how much stands behind it.

## Where the work happens

```
  PostgreSQL                @binaryai/analytics            API
  ──────────                ───────────────────            ───
  calibration_eligibility   observedAccuracy()             /v1/analytics/*
  → GROUP BY, FILTER   ──▶  evidenceLevelFor()      ──▶    scope from session
  → counts and sums          buildCalibrationReport()      bounded queries
```

SQL **counts**; it does not compute rates. The derived statistics live in a pure
package with no database, so the honesty rules are unit-testable and cannot
drift between SQL dialects — or be bypassed by a new endpoint.

## Outcome taxonomy

Six states, and the distinctions are not cosmetic. Each one would corrupt
accuracy if folded into `loss`:

| Class        | Meaning                                           | In the denominator? |
| ------------ | ------------------------------------------------- | ------------------- |
| `win`        | settled, direction correct                        | yes                 |
| `loss`       | settled, direction wrong                          | yes                 |
| `tie`        | settled exactly at entry price                    | **no**              |
| `unresolved` | expired, no settlement candle yet — pending       | **no**              |
| `invalid`    | settled, but the source cannot support comparison | **no**              |
| `skipped`    | the engine made no directional claim              | **no**              |

A **rejected** signal is `skipped`. The risk engine declined to act, so there
was no prediction to be right or wrong about. Counting it as a loss would invent
a claim that was never made.

An **unresolved** outcome is pending, not failed. It stays out of both numerator
and denominator until a settlement candle exists.

## Eligibility

`calibration_eligibility` attaches an explicit verdict to every settled signal.
`exclusion_reason IS NULL` means eligible; anything else names the rule that
rejected it — and the row stays visible so exclusions are auditable rather than
silent.

Rules apply in this order, so a row is always reported against the first rule it
fails:

| Reason                   | Condition                                  |
| ------------------------ | ------------------------------------------ |
| `no_direction`           | direction was `none`                       |
| `not_accepted`           | status ≠ `accepted` (rejected, candidate…) |
| `not_settled`            | result is `unresolved`                     |
| `missing_strategy`       | no strategy attribution                    |
| `missing_confidence`     | no confidence recorded                     |
| `missing_market_context` | no regime recorded                         |
| `synthetic_data`         | candles were synthetic                     |
| `unknown_data_origin`    | settlement has no recorded `dataOrigin`    |

Synthetic samples are excluded from live measurement outright: fixture data must
never pool with market observations.

## Confidence bands

Five fixed bands over [0, 1], versioned as `BUCKET_VERSION`:

```
0.00–0.19   0.20–0.39   0.40–0.59   0.60–0.79   0.80–1.00
```

Boundaries were fixed **before any data was examined**, which is what makes them
honest — choosing them afterwards is how a flat relationship becomes a
convincing curve. A boundary value belongs to the higher band (0.20 is in the
second, not the first), and `assignBucket` is the single implementation of that
rule so SQL and TypeScript cannot disagree about where a sample sits.

Every band appears in the output, including empty ones. An absent band would
read as "not measured"; a present band with zero samples reads as "measured,
nothing landed here" — which is what is true.

## What is measured

**Primary — the confidence relationship.** Does observed accuracy rise as
confidence rises? Rank-based, so it needs no probabilistic interpretation:

| Value                  | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `not_established`      | fewer than two bands have sufficient evidence, or accuracy is flat |
| `monotonic_increasing` | accuracy rose across bands                                         |
| `monotonic_decreasing` | accuracy fell — a real finding, not an error                       |
| `non_monotonic`        | accuracy moved both ways                                           |

**Secondary — `divergence`.** Sample-weighted mean gap between a band's mean
confidence and its observed accuracy. Structurally this is Expected Calibration
Error. It is **not** named a calibration error, because that name asserts the
score is a probability estimate. Read it as: _if_ one insisted on reading the
heuristic as a probability, it would be off by about this much.

## Evidence levels

| Level          | Samples | 95% interval (≈) |
| -------------- | ------- | ---------------- |
| `insufficient` | < 30    | no rate reported |
| `preliminary`  | ≥ 30    | ±18 pts          |
| `developing`   | ≥ 100   | ±10 pts          |
| `established`  | ≥ 500   | ±4.5 pts         |

`ANALYTICS_MIN_SAMPLES` (default 30) is the gate below which no rate is
published at all. Lowering it does not create evidence — it only lowers the bar
for publishing a figure.

## Endpoints

All scoped to the caller's session. There is **no `?accountId=` parameter** on
any of them: scope comes from the principal, so a caller cannot express a
request for someone else's data.

| Path                        | Returns                                          |
| --------------------------- | ------------------------------------------------ |
| `/v1/analytics/overview`    | totals, observed accuracy, pending settlement    |
| `/v1/analytics/strategies`  | per strategy + version                           |
| `/v1/analytics/regimes`     | per market regime                                |
| `/v1/analytics/timeframes`  | per timeframe (only those with data)             |
| `/v1/analytics/assets`      | per instrument (only those with data)            |
| `/v1/analytics/confidence`  | bands, relationship, divergence                  |
| `/v1/analytics/calibration` | the full report incl. exclusions and limitations |
| `/v1/analytics/timeseries`  | day / week / month buckets, gaps preserved       |

Every query is bounded: the window defaults to 90 days and is capped at two
years, groups at 200 rows, time-series buckets at 1,100.

Grouped results are ordered by **sample count, never by accuracy**. Ranking by
accuracy would put a strategy with 3 wins from 3 above one with 2,800 from 4,000
— arithmetically correct and completely misleading.

## Terminology

| Use                    | Never                                 |
| ---------------------- | ------------------------------------- |
| observed accuracy      | win rate as a prediction              |
| settled outcomes       | trades                                |
| confidence band        | probability bucket                    |
| confidence divergence  | calibration error                     |
| historical observation | expected return, profit, guaranteed … |

"Observed accuracy was higher in `trend_up`" is a statement about co-occurrence.
It is not a claim that the regime caused it.

## Backtests are not observed outcomes

They live in separate tables, never write to `signals`, and are pinned with
`result_type = 'historical_simulation'` by a CHECK constraint. The dashboard
puts them under their own heading for the same reason. A simulated result must
never read as a measured one.

## Scoping

Analytics respect `AccessScope` exactly as signal reads do, enforced in SQL:

- **system signals** (`account_id IS NULL`) — the shared analysis stream, read
  by every authenticated user.
- **account-owned signals** — private, including their counts. A count is a
  disclosure just as a row is, so exclusion tallies and sample sizes are scoped
  too.
- The shared **machine token** resolves to the system scope only. It
  authenticates a process with no owner and must never resolve to a user's data.

## Running it locally

```bash
npm run dev:db                                    # PGlite over TCP, dev only
DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm run db:migrate

DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres \
DATABASE_MAX_CONNECTIONS=1 AUTH_ENABLED=true AUTH_COOKIE_SECURE=false \
npm run dev:api
```

`DATABASE_MAX_CONNECTIONS=1` is required against `dev:db`: the PGlite socket
bridge accepts one connection, and the dashboard's parallel fetches otherwise
produce `ECONNRESET`. That is a limit of the development convenience, not of the
API.

## What is not implemented

- **No calibration model.** `implemented` is false and no sample count changes
  that. See ADR-0012 for the five conditions that would.
- **No confidence intervals.** Evidence tiers are a cruder proxy.
- **No significance testing.** A rising sequence is reported as rising, with no
  claim it is distinguishable from noise.
- **No recency weighting.** Recent and full-history figures are reported side by
  side rather than blended; weighting is a modelling decision that would need
  its own methodology version.
- **No caching.** PostgreSQL aggregation over indexed columns is sufficient at
  current volumes; adding Redis would be appearance, not need.
- **`calibration_runs` is written by nothing yet.** The table exists so a
  published measurement can be pinned to its methodology; nothing persists a run
  on a schedule.
