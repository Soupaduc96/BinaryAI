# Product vision

## What BinaryAI is

An analysis and decision-support platform for binary-options markets. It reads
market data, analyses it, forms a candidate view, scores how well-supported that
view is, checks it against risk limits, and explains the whole chain.

The user is a person deciding whether to act. BinaryAI's job is to make that
decision better informed — not to make it for them.

## What BinaryAI is not

- **Not an autotrader.** It does not place orders. No broker integration exists,
  and four independent layers block real-money execution.
- **Not a prediction engine.** It does not forecast prices. It measures
  conditions and states how much they support a direction.
- **Not a profit claim.** No output asserts an edge. Backtests are labelled
  simulations; confidence scores are labelled uncalibrated.
- **Not a casino.** No countdown pressure, no streak celebration, no "signal of
  the day". The interface is an instrument panel.

## The difference that matters

A typical signal tool outputs:

> **CALL — 87%**

Which invites one question — _why?_ — and answers none of it. The 87% has no
defined meaning: it is not a win rate, not a probability, not a measurement.

BinaryAI outputs the reasoning as the product:

> **CALL** on EURUSD 1m · Trend Momentum v1.0.0
> Confidence **0.74** _(heuristic, uncalibrated — not a win probability)_
> Regime: uptrend (clarity 0.81) · Trend strength: ADX 31.2 · Momentum: RSI 58.4
> Volatility: ATR 0.28% (normal) · Data quality: 1.00 (no issues)
> **Confirmations (4):** EMA alignment · Trend strength · Momentum · +DI dominance
> **Conflicts (1):** Momentum exhaustion (minor) — RSI stretched, pullback plausible
> Risk: **medium** · 12 of 12 checks passed · Max stake 20.00
> **Recommendation: wait for confirmation**

Every line is traceable to a number the engine computed and can be inspected
through the API.

## Principles

**Explainability is the feature.** If a decision cannot be explained, it should
not be shown. Every confidence component carries its own score, weight and a
sentence.

**Honesty over impressiveness.** A rule-based classifier is called rule-based.
An uncalibrated score is labelled uncalibrated. An unconfigured integration says
"not configured" instead of showing a plausible number. It is always better to
show nothing than to show something invented.

**Risk is a first-class subsystem, not a setting.** Risk checks run on every
signal and can only ever reduce activity. There is no auto-recovery, no
martingale, no "aggressive mode".

**Demo before live.** The system was built demo-only on purpose. Live execution
is a future decision requiring deliberate work at four layers, not a flag.

**Modularity over cleverness.** Strategies, indicators, data providers and AI
implementations are pluggable behind interfaces. Adding one should not require
touching anything else.

## Who this is for

Someone technical enough to want the reasoning, who treats a signal as an input
to their own judgement rather than an instruction — and who is fully aware that
binary options carry negative expected value under typical payout structures.

BinaryAI is more useful as an instrument for understanding market conditions and
testing hypotheses than as a way to be told what to do. That is the intended
use.

## Success criteria

Phase 1 succeeds if the engine is correct, deterministic, tested and
explainable, and if nothing in the product overstates what it can do.

Long term, it succeeds if a user can answer "why did the system say that?" for
any signal it ever produced, and if the confidence number eventually means
something measurable — which requires collecting real outcomes and calibrating
against them. See [ai-architecture.md](ai-architecture.md).
