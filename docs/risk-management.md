# Risk management

## Philosophy

**Every rule can only reduce activity.** There is no setting in BinaryAI that
increases stake, loosens a filter automatically, or attempts to recover losses.
Martingale and its relatives are excluded by design: they convert a series of
small losses into one account-ending loss, and they are the most common reason
binary-options accounts go to zero.

**Risk is independent of confidence.** `deriveRiskLevel` looks at conflicts,
volatility, regime, data quality and confidence together. A confident signal in
dangerous conditions is still reported as risky — the two numbers answer
different questions:

- _Confidence:_ how well-supported is this view?
- _Risk:_ how dangerous are the conditions if the view is wrong?

**Blocking comes with reasons.** Every check reports pass/fail with a
human-readable detail. `blockedBy` lists the failed codes. "Blocked" is never
opaque.

**Demo-first is structural, not a default.** See [ADR-0004](adr/0004-demo-only-execution.md).

## The checks

Run on every signal, in `assessRisk`. Any failure blocks.

| Check                        | Default                     | Rationale                                                |
| ---------------------------- | --------------------------- | -------------------------------------------------------- |
| `live_execution_disabled`    | live blocked                | This build cannot trade real money                       |
| `no_direction`               | —                           | Nothing to assess                                        |
| `data_quality_too_low`       | score ≥ 0.8                 | Bad data produces confident nonsense                     |
| `volatility_too_high`        | ATR ≤ 1.5%                  | Short expiries behave erratically in unstable conditions |
| `regime_not_allowed`         | trend_up, trend_down, range | `volatile`/`quiet`/`unknown` excluded by default         |
| `confidence_below_threshold` | ≥ 0.6                       | Floor beneath which a setup is not worth showing         |
| `risk_level_too_high`        | ≤ medium                    | Ceiling on conditions, not on conviction                 |
| `blocking_conflict`          | none present                | A strategy can veto its own setup                        |
| `max_open_positions`         | 1                           | Concurrency multiplies correlated exposure               |
| `exposure_limit`             | 2% of balance               | Total simultaneous risk                                  |
| `daily_loss_limit`           | 5% of day-start balance     | Stops a bad day compounding                              |
| `consecutive_loss_limit`     | 3                           | Streaks often mean conditions changed                    |
| `cooldown_active`            | 300s after a loss           | Removes revenge-trading pressure                         |

Defaults live in `DEFAULT_RISK_LIMITS`. They are conservative on purpose; the
tests assert they stay that way.

## Risk level

```
points = 3×blocking conflicts + 1×major conflicts
       + 2 if volatility extreme, 1 if high
       + 1 if regime volatile or unknown
       + 1 if confidence < 0.5
       + 1 if data quality < 0.9
       + 2 if data unusable

0–1 → low     2–3 → medium     4–5 → high     6+ → extreme
```

## Stake sizing

```
maxStake = balance × maxExposureFraction − openExposure
```

Floored at zero, and it is a **ceiling**. The backtester takes
`min(requested, maxStake, balance)`. Nothing scales stake up after a loss.

## Demo/live separation

Four layers, each sufficient alone:

1. **Configuration** — `loadConfig` refuses `ALLOW_LIVE_EXECUTION=true` and
   `EXECUTION_MODE=live`, aborting boot with an explanation.
2. **Risk engine** — `live_execution_disabled` fails for live mode.
3. **Execution guard** — `assertExecutionAllowed()` throws
   `LiveExecutionDisabledError`.
4. **Database** — `CHECK (execution_mode = 'demo')` on accounts, trades, signals.

The API never accepts an execution mode from the caller. `PaperAccount.mode` is
the literal `'demo'`, so a live account is unrepresentable rather than merely
disallowed.

## What a future live path would require

Not a flag. At minimum: a reviewed broker adapter with idempotent order
submission; reconciliation between intended and actual fills; a kill switch
reachable without a deploy; per-user limits enforced server-side; an audit trail
in `risk_events` for every order; a migration relaxing the CHECK constraints; and
a calibrated confidence model, because sizing decisions built on an uncalibrated
score are guesswork with extra steps.

## Honest position on binary options

Under typical payouts (~80% on a win, −100% on a loss), break-even requires
about a **55.6% win rate**. Randomly correct 50% of the time loses money
steadily — which the demo backtest demonstrates on a driftless random walk:
52.78% win rate, −1.80% return.

BinaryAI does not claim to beat that. Its filters exist to avoid situations
where the odds are visibly worse, not to manufacture an edge.

## Account-level enforcement (Phase 5)

The checks above are SIGNAL-level: they ask whether an analysis is sound enough
to act on, and the answer is the same for every user because it is a property of
the market data.

A second layer, `evaluateAccountAction`, asks a different question: may THIS
account act, right now, given its own policy and its own open positions? It is a
separate pure module so the runtime never needs to know about accounts — one
market analysis still produces one system signal.

Its outcome vocabulary is wider than allow/block, because "blocked" covers too
much: a `cooldown` clears by itself, a `limit_reached` clears when a position
settles, and an `invalid_policy` needs an operator. Every refusal reports the
rule, the observed value, the configured limit, the window and the policy
version — enough to reconstruct the decision later.

Limits are enforced in a transaction holding the account row lock, so they bind
under concurrent requests rather than being advisory. See
[paper-accounts.md](paper-accounts.md) and
[ADR-0013](adr/0013-paper-accounts-and-risk-enforcement.md).

Nothing in this layer can increase activity either: every rule is a ceiling, a
floor or an allowlist.
