# ADR-0002 — Deterministic core in TypeScript; Python reserved for ML

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The brief suggested Node/TypeScript for application services and Python for
quantitative analysis, backtesting and ML, sketching `services/analysis`,
`services/backtesting` and `services/ai` as separate services.

The binding constraint is that **backtesting must run the same code as live
analysis**. If the two diverge, a backtest validates code that is not the code
making decisions — which is worse than having no backtest, because it produces
confidence in something untested.

Also relevant: the development machine for this phase has no Python and no
Docker, so a Python service could not have been run or verified here.

## Decision

The deterministic core — indicators, strategies, regime classification,
confidence, risk, the decision pipeline and the backtester — is TypeScript, in
packages, in one process.

Python is reserved for machine learning: training, evaluation, notebook
iteration. It sits behind an HTTP boundary (`services/ai`), off the request
path, reached through the `AiProvider` interface.

`analysis` and `backtesting` are **packages, not services**.

## Rationale

**Splitting analysis into a Python service** would force one of two outcomes.
Either indicator maths is implemented twice — and Wilder's smoothing, warm-up
alignment and ADX seeding are exactly the kind of details that drift silently —
or the backtester makes a network call per bar, turning a 400-bar run into 400
round trips.

**Keeping one language for the core** means `runBacktest` literally calls
`evaluateDecision`, the same function the API calls. Divergence is impossible
rather than discouraged.

**Python still earns a boundary for ML**, because its requirements genuinely
differ: numpy/pandas/scikit-learn/torch, notebooks, GPUs, long offline jobs.
That is a different runtime with a different lifecycle, which is a real reason
for a process split.

The general principle: **split on runtime requirements, not on feature area.**

## Consequences

**Good.** One implementation of every calculation. Backtests are trustworthy by
construction. No cross-language serialisation in the hot path. The whole engine
runs in a test with no infrastructure.

**Bad.** TypeScript's numerical ecosystem is thinner than Python's — no pandas,
no statsmodels — so indicators are hand-written (and therefore individually
tested, which is not a bad trade). Quant researchers who prefer Python cannot
prototype directly against the production engine; they will work against
exported datasets until a Python analysis client exists.

**Neutral.** `services/ai` exists as a contract and an unrun skeleton. That is
honest about its state and keeps the boundary designed rather than improvised.

## Revisit if

A strategy needs numerical machinery that is genuinely impractical in TypeScript
(heavy optimisation, deep learning inference per bar). The response then is a
Python service for _that specific computation_ behind an interface — not moving
the deterministic core.
