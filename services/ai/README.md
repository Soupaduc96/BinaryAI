# services/ai

The AI service boundary.

## Status: contract only — nothing here is implemented

There is no trained model, no inference, and no running service. What exists is
the **interface** (`AiProvider` in `@binaryai/types`), a **default local
implementation** that is rule-based and says so, and the **contract** a future
Python service must satisfy.

This is deliberate. Development rule 4: _do not claim an AI model is intelligent
if it is only rule-based._ Today's explanations are template text composed from
numbers the engine already computed. Calling that AI would be a lie, so the
provider reports `implementation: "rule_based"` and the UI prints it.

## Why a separate service at all

The deterministic core — indicators, strategies, confidence, risk, backtesting —
is TypeScript and stays that way, so live analysis and backtesting run literally
the same code ([ADR-0002](../../docs/adr/0002-typescript-core-python-for-ml.md)).

Machine learning has genuinely different requirements: numpy/pandas/scikit-learn
/torch, notebook-driven iteration, GPU access, long-running training jobs. Those
belong in Python, out of the request path, behind an HTTP boundary. Splitting on
_runtime requirements_ rather than on _feature area_ is what keeps the split from
becoming duplicated logic.

## Current wiring

```
apps/api ──> AiProvider (interface, @binaryai/types)
               ├── createRuleBasedAiProvider()   <- default, local, rule-based
               └── HttpAiProvider(AI_SERVICE_URL) <- not implemented yet
```

Set `AI_PROVIDER=http_service` and `AI_SERVICE_URL` once a service exists.
Configuration validation already rejects `http_service` without a URL. Nothing
that consumes `AiProvider` changes when the implementation is swapped.

## Capability reporting is mandatory

Every provider must answer `GET /v1/capabilities` with an honest
`implementation` for each capability:

| kind                | meaning                                  |
| ------------------- | ---------------------------------------- |
| `rule_based`        | thresholds and templates, no model       |
| `statistical_model` | fitted model (e.g. logistic calibration) |
| `llm`               | language model                           |
| `not_implemented`   | interface exists, nothing behind it      |

The dashboard renders this verbatim. A provider that reports `llm` for something
backed by an `if` statement is a bug, not a shortcut.

## Planned capabilities (none implemented)

- **explanation** — natural-language reasoning over engine facts. _Currently rule_based._
- **regime_classification** — trained classifier to replace the ADX/ATR/EMA thresholds. _Currently rule_based._
- **signal_ranking** — rank concurrent candidates by expected quality.
- **anomaly_detection** — flag market conditions unlike anything in history.
- **pattern_matching** — retrieve historically similar windows and their outcomes.
- **strategy_optimization** — parameter search with proper walk-forward validation.

The first genuinely useful model is **confidence calibration**, and it is blocked
on data: it needs a few thousand settled signals in `signal_outcomes` before it
can turn the heuristic score into a probability. See
[docs/ai-architecture.md](../../docs/ai-architecture.md).

## Contract

[`contract/ai-service.md`](contract/ai-service.md) defines the HTTP endpoints.

## Reference implementation

[`reference-python/`](reference-python/) is a FastAPI skeleton that implements
the contract's shape and returns `501 Not Implemented` for every capability it
does not have. It is **not installed, not wired up and not run by CI** — Python
is not a dependency of this repository today.
