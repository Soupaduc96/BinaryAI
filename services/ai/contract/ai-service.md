# AI service HTTP contract

Version 0.1.0 (draft — no implementation exists).

A service that satisfies this contract can be dropped in behind
`AI_PROVIDER=http_service` with no change to `apps/api` beyond constructing an
`HttpAiProvider`. The shapes mirror the `AiProvider` interface in
`@binaryai/types` exactly; if they drift, the TypeScript types are authoritative.

## Conventions

- JSON over HTTP, UTF-8.
- `Authorization: Bearer <AI_API_KEY>` when configured.
- The API applies its own timeout and falls back to the local rule-based
  provider on failure. **The AI layer is never on the critical path**: analysis,
  signals and risk must all work with the service down.
- Errors use the same envelope as the main API:
  `{ "error": { "code": string, "message": string } }`.

## `GET /health`

```json
{ "status": "ok", "service": "binaryai-ai", "version": "0.1.0" }
```

## `GET /v1/capabilities`

Required. The API surfaces this verbatim at `/v1/ai/capabilities`.

```json
{
  "provider": "binaryai-ai-python",
  "capabilities": [
    {
      "capability": "explanation",
      "implementation": "llm",
      "available": true,
      "notes": "claude-sonnet-4-5, temperature 0.2"
    },
    {
      "capability": "signal_ranking",
      "implementation": "not_implemented",
      "available": false,
      "notes": "Interface defined; no model trained."
    }
  ]
}
```

`implementation` must be one of `rule_based`, `statistical_model`, `llm`,
`not_implemented`, and must describe what actually produced the output.

## `POST /v1/explain`

Request:

```json
{
  "signal": { "...": "a full Signal object" },
  "analysis": { "...": "a full MarketAnalysis object" },
  "locale": "en"
}
```

Response:

```json
{
  "text": "CALL candidate on EURUSD 1m ...",
  "implementation": "llm",
  "model": "claude-sonnet-4-5",
  "disclosesUncertainty": true
}
```

`disclosesUncertainty` must be `true` when the text states that the confidence
figure is an uncalibrated heuristic. A response that presents the score as a
probability is a contract violation.

**The service must not invent facts.** It receives the numbers the engine
computed and explains them. It must not assert a market condition that is not in
the payload, and it must not offer financial advice.

## `POST /v1/classify-regime` _(planned)_

```json
{ "candles": [{ "timestamp": 0, "open": 0, "high": 0, "low": 0, "close": 0 }] }
```

```json
{
  "regime": "trend_up",
  "clarity": 0.82,
  "implementation": "statistical_model",
  "model": "regime-gbm-v1"
}
```

Returns `501` with `implementation: "not_implemented"` until a model exists. The
engine's rule-based classifier remains the fallback.

## `POST /v1/calibrate-confidence` _(planned)_

The capability that actually matters. Maps a heuristic score plus its components
onto an empirical win probability, fitted on `signal_outcomes`.

```json
{ "score": 0.78, "components": [{ "key": "evidence_balance", "score": 0.8 }] }
```

```json
{
  "probability": 0.61,
  "calibration": "model_calibrated",
  "sampleSize": 4821,
  "model": "isotonic-v1"
}
```

Until this exists, every confidence score in BinaryAI carries
`calibration: "uncalibrated_heuristic"` and `sampleSize: null`.
