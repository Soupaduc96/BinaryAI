# The signal model

The canonical internal signal object, defined in
[`packages/types/src/signal.ts`](../packages/types/src/signal.ts). Everything
that produces or consumes a signal — the pipeline, the API, the dashboard, the
database — agrees on this shape.

## Design rules

**A signal carries its own justification.** Confirmations, conflicts, indicator
snapshots, confidence components and reasoning travel with it. A stored signal
can be fully re-explained years later without re-running anything.

**A signal carries its own caveats.** Data source, data-quality report,
execution mode and confidence calibration are fields, not context the UI is
trusted to remember.

**A signal is not an instruction.** The action-shaped field is
`recommendation`, whose values are `consider`, `wait_for_confirmation` and
`skip`. There is no `execute`.

## Fields

| Field            | Type                                       | Notes                                                             |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `id`             | `string`                                   | `sig_<uuid>`; deterministic in backtests via an injected factory  |
| `createdAt`      | `number`                                   | Epoch ms of the decision                                          |
| `asset`          | `string`                                   | Provider-independent symbol                                       |
| `timeframe`      | `Timeframe`                                | One of 12 literals from `TIMEFRAMES`                              |
| `direction`      | `'call' \| 'put' \| 'none'`                | `none` is a real outcome, not an error                            |
| `timestamp`      | `number`                                   | Epoch ms of the candle decided on                                 |
| `price`          | `number`                                   | Close of that candle                                              |
| `expiration`     | `SignalExpiration`                         | `{ seconds, expiresAt }`                                          |
| `confidence`     | `ConfidenceResult`                         | Score **plus** components, calibration, sample size, disclaimer   |
| `riskLevel`      | `'low' \| 'medium' \| 'high' \| 'extreme'` | Derived from conditions, independent of confidence                |
| `marketRegime`   | `MarketRegime`                             | From the engine's classifier, not the strategy's hint             |
| `strategy`       | `StrategyRef`                              | id, **version**, name — old signals stay attributable             |
| `indicators`     | `IndicatorSnapshot[]`                      | Value + interpretation per indicator                              |
| `confirmations`  | `Confirmation[]`                           | Evidence for, weight 0–1                                          |
| `conflicts`      | `Conflict[]`                               | Evidence against, weight 0–1, severity                            |
| `reasoning`      | `SignalReasoning`                          | Summary, supporting, opposing, caveats, **`generatedBy`**         |
| `status`         | `SignalStatus`                             | `candidate`/`accepted`/`rejected`/`expired`/`settled`/`cancelled` |
| `recommendation` | `SignalRecommendation`                     | `consider`/`wait_for_confirmation`/`skip`                         |
| `executionMode`  | `'demo' \| 'live'`                         | Always `demo` in this build                                       |
| `dataSource`     | `MarketDataSource`                         | `synthetic` can never be mistaken for live                        |
| `dataQuality`    | `DataQualityReport`                        | Score, usability, every issue found                               |

## Confidence is a structure, not a number

```ts
interface ConfidenceResult {
  score: number; // 0..1
  components: ConfidenceComponent[]; // key, label, score, weight, contribution, detail
  calibration: ConfidenceCalibration; // 'uncalibrated_heuristic' today
  sampleSize: number | null; // null: nothing backs it
  disclaimer: string;
}
```

Rendering `score` without `calibration` is a product bug. The number is a
weighted opinion about how well-supported a setup is — not a probability. See
[ADR-0003](adr/0003-uncalibrated-confidence.md).

## Confirmations and conflicts

Both carry a `weight` in 0–1 meaning _how strong is this piece of evidence_.
Strategies never convert evidence into a score; the confidence engine does, so
every strategy is measured on one scale.

Conflicts add `severity`:

- `minor` — worth showing, does not change the decision much (×0.5 in scoring)
- `major` — materially degrades the setup (×1.0), raises risk level
- `blocking` — the setup should not be taken (×2.5), fails the risk check outright

## Direction `none`

A strategy declining to act is a first-class result with an `abstainReason`, not
a failure. It produces a signal with `status: 'rejected'`, `recommendation:
'skip'`, confidence 0, and reasoning that says why. Silence with an explanation
beats a marginal signal.

## Lifecycle

```
        strategy abstains ─────────────┐
                                       ▼
candidate ── risk blocked ────────► rejected
     │
     └── risk allows ──► accepted ──► expired ──► settled
                                                   │
                                                   ▼
                                            signal_outcomes
                                     (ground truth for calibration)
```

`signal_outcomes` closes the loop. Once enough settled signals exist, the
heuristic score can be calibrated against reality and `calibration` can change
to `backtest_calibrated` or `model_calibrated` — per signal, which is why the
field is stored per row rather than assumed globally.
