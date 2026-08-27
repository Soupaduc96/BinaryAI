# AI architecture

## Where things actually stand

**No machine learning exists in BinaryAI today.** Nothing is trained, fitted or
learned. What exists is the interface layer, a rule-based default
implementation, and a calibration plan blocked on data.

This document is written that way on purpose. The gap between "AI-powered" as
marketing and as an engineering claim is exactly where trading tools mislead
people.

| Capability            | Implementation today | Honest description          |
| --------------------- | -------------------- | --------------------------- |
| Explanation           | `rule_based`         | Templates over engine facts |
| Regime classification | `rule_based`         | ADX/ATR/EMA thresholds      |
| Signal ranking        | `not_implemented`    | Interface only              |
| Anomaly detection     | `not_implemented`    | Interface only              |
| Pattern matching      | `not_implemented`    | Interface only              |
| Strategy optimization | `not_implemented`    | Interface only              |

`GET /v1/ai/capabilities` returns exactly this, and the dashboard renders it
verbatim.

## The interface

```ts
interface AiProvider {
  readonly id: string;
  capabilities(): readonly AiCapabilityStatus[];
  explain(request: AiExplainRequest): Promise<AiExplainResponse>;
}
```

`AiCapabilityStatus.implementation` is required and must be one of `rule_based`,
`statistical_model`, `llm`, `not_implemented` — and must state what actually
produced the output. A provider reporting `llm` for an `if` statement is a bug.

`SignalReasoning.generatedBy` carries the same distinction onto every signal:
`rule_engine` or `ai_model`.

## Swapping in a real implementation

```
apps/api ──> AiProvider
              ├── createRuleBasedAiProvider()      default, local
              └── HttpAiProvider(AI_SERVICE_URL)   not implemented
```

Construct a different provider in `createAppContext`. Nothing else changes.
Configuration for the remote path already validates
(`AI_PROVIDER=http_service` requires `AI_SERVICE_URL`), and the contract is
specified in [services/ai/contract/ai-service.md](../services/ai/contract/ai-service.md).

**The AI layer is never on the critical path.** Analysis, signals, risk and
backtesting all work with it absent. It enriches; it does not gate.

## The capability that actually matters: confidence calibration

Today's confidence score is a weighted heuristic. A 0.80 means "these six
components summed to 0.80". It does **not** mean 80% of such signals win, and
every result says so via `calibration: 'uncalibrated_heuristic'` and
`sampleSize: null`.

Turning it into a probability is a well-understood supervised problem:

1. **Collect.** Every settled signal writes to `signal_outcomes` with its
   features in `signal_features`. This is why explainability is stored
   relationally rather than only as JSON.
2. **Wait for enough data.** A few thousand settled signals, spread across
   regimes and assets. There is no shortcut: a model fitted on 200 signals from
   one month of one instrument learns that month, not the market.
3. **Fit.** Isotonic regression or Platt scaling from heuristic score → observed
   win rate, validated **walk-forward** (train on earlier data, test on later).
   K-fold on time series leaks the future and inflates every metric.
4. **Report.** Switch to `calibration: 'model_calibrated'` with the real
   `sampleSize`, and show a reliability diagram — predicted vs actual by bucket.
   A calibrated model whose reliability curve is not shown is still asking for
   trust it has not demonstrated.
5. **Monitor.** Markets change. Track calibration drift and fall back to the
   heuristic when it degrades.

Until step 4 completes, no BinaryAI number may be presented as a probability.

## Later capabilities, and their honest difficulty

**Regime classification (moderate).** Supervised over labelled windows, or
unsupervised clustering. Better than thresholds mainly because it can express
uncertainty properly. Same `RegimeAssessment` return type, so it drops in.

**Signal ranking (moderate).** Only meaningful once multiple concurrent
candidates exist — which needs the market-data provider first.

**Anomaly detection (moderate).** Flagging conditions unlike anything in
history is genuinely useful for risk: the right response to "I have never seen
this" is to stand down.

**Pattern matching (hard to do honestly).** Retrieving similar historical
windows is easy; making the result meaningful is not. With enough history you
can always find a similar-looking window, and the outcome distribution of
cherry-picked neighbours is close to noise. Would need strict statistical
discipline about multiple comparisons.

**Strategy optimization (hardest, most dangerous).** Parameter search overfits
by default. Any implementation must use walk-forward validation, report
out-of-sample results only, and penalise parameter counts. A grid search
reporting in-sample results is a machine for generating false confidence.

## LLM use, if it happens

An LLM would be appropriate for **explanation**: turning computed facts into
readable prose, in the user's language, at the requested level of detail.

It would not be appropriate for producing a signal, a confidence score, or a
market prediction. Constraints for any explanation implementation:

- It receives the facts the engine computed and explains **only** those facts.
- It must not assert market conditions absent from the payload.
- It must state that the confidence figure is uncalibrated
  (`disclosesUncertainty: true`).
- It must not give financial advice.
- Its output is labelled `generatedBy: 'ai_model'` with the model id.

## Why Python for this and not for the core

Model training needs numpy/pandas/scikit-learn/torch, notebooks, and long
offline jobs — genuinely different requirements from a request-path service, so
it earns a process boundary. The deterministic core stays TypeScript so live
analysis and backtesting run the same code. See
[ADR-0002](adr/0002-typescript-core-python-for-ml.md).
