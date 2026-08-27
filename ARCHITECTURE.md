# Architecture

How BinaryAI is put together, and why it is put together that way.

## The organising idea

Most trading tools are built as `signal → trade`. BinaryAI is built as:

```
validate → analyse → strategy → confidence → risk → recommendation
```

Each stage is a separate module with its own types, and the sequence is enforced
in one place (`evaluateDecision` in `@binaryai/engine`) rather than left to
callers. A signal cannot exist without a data-quality report attached, and a
recommendation cannot exist without a risk assessment attached, because the
functions that build them require those inputs.

The output is not "CALL 87%". It is a direction, a score with its calibration
status, the regime it was formed in, the evidence for and against, a risk level,
the checks that passed and failed, and a recommendation that may well be _wait_
or _skip_.

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│  apps/web  ·  Next.js dashboard                                      │
│  Presentation only. No analysis, no secrets, no direct DB access.    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP (JSON)
┌───────────────────────────────▼──────────────────────────────────────┐
│  apps/api  ·  Fastify                                                │
│  Routing, schema validation, auth, rate limiting, error mapping.     │
│  Contains NO domain logic — it wires packages together.              │
│                                                                      │
│  Request order is load-bearing:                                      │
│    network rate limit → identity → CSRF → guard → account limit      │
│  The first pass runs BEFORE identity so a flood is refused before it  │
│  reaches an Argon2 hash; the last runs after, because there is no    │
│  account to key on until authentication has happened.                │
└───┬───────────────┬───────────────┬───────────────┬──────────────────┘
    │               │               │               │
    ▼               ▼               ▼               ▼
┌────────┐   ┌────────────┐   ┌───────────┐   ┌──────────────┐
│ config │   │ strategies │   │  engine   │   │   backtest   │
│ rate-  │   │ + registry │   │ pipeline  │   │ + paper acct │
│ limit  │   │            │   │           │   │              │
└────────┘   └─────┬──────┘   └─────┬─────┘   └──────┬───────┘
                   │                │                │
                   └────────┬───────┴────────────────┘
                            ▼
                   ┌────────────────┐      ┌────────┐
                   │   indicators   │      │ types  │  (shared vocabulary)
                   │  (pure maths)  │      │ utils  │
                   └────────────────┘      └────────┘

  services/ai  ·  contract only, not running — reached through AiProvider

┌──────────────────────────────────────────────────────────────────────┐
│  @binaryai/database  ·  PostgreSQL                                   │
│  Implements the repository interfaces declared in @binaryai/types.   │
│  Optional: absent DATABASE_URL, the API runs stateless.              │
│  The ENGINE never imports it — analysis stays a pure function.       │
└──────────────────────────────────────────────────────────────────────┘
```

Dependencies point one way: `types` and `utils` at the bottom, `apps` at the
top. No package imports an app. `fixtures` (synthetic data) is a leaf that
nothing in the runtime path may import.

## Stage by stage

### 1. Market data boundary — `@binaryai/engine/market-data`

Everything from outside the process passes through `normalizeCandleSeries`,
which parses an untrusted payload with a Zod schema and produces a `CandleSeries`
or a list of errors. `assessDataQuality` then scans for structural problems:
non-monotonic or duplicate timestamps, gaps, OHLC inconsistency, non-positive
prices, negative volume, an incomplete final candle.

The result is a `DataQualityReport` with a 0–1 score and a `usable` flag. It is
an **input to the risk engine**, not a gate that silently drops data — the
system reports what is wrong with the data instead of pretending it is clean.

Because this boundary exists, `@binaryai/indicators` is allowed to throw on
non-finite input rather than defensively returning `NaN`.

### 2. Analysis — `@binaryai/engine/regime`

`classifyRegime` produces a `RegimeAssessment`: regime (`trend_up`, `trend_down`,
`range`, `volatile`, `quiet`, `unknown`), a clarity score, trend direction and
strength from ADX, momentum from RSI and slope, and volatility from ATR%.

This is threshold logic over conventional indicators. It is **rule-based and
labelled as such**; when a trained classifier replaces it, the return type does
not change, which is the point of returning `RegimeAssessment` rather than a
bare string.

### 3. Strategy — `@binaryai/strategies`

A strategy implements one interface:

```ts
interface Strategy {
  readonly meta: StrategyMetadata;
  readonly parameters: readonly StrategyParameterSpec[];
  evaluate(context: StrategyContext): StrategyEvaluation;
}
```

Three properties make the whole system work:

- **Pure and deterministic.** No clock, no randomness, no I/O. Same context in,
  same evaluation out — which is what makes a backtest reproducible.
- **No look-ahead by construction.** `StrategyContext.series` contains only
  candles up to the decision bar. The backtester slices it that way, so a
  strategy cannot see the future even if it tries.
- **No self-scoring.** A strategy returns evidence — confirmations and conflicts
  with weights — but never a confidence number. Scoring is centralised so every
  strategy is measured on one scale.

Strategies register in a `StrategyRegistry`. Adding one means writing a module
and registering it; the API exposes it and the dashboard lists it with no change
to either.

### 4. Confidence — `@binaryai/engine/confidence`

A weighted blend of six components that sum to weight 1.0: evidence balance
(0.30), regime alignment (0.20), momentum agreement (0.15), volatility fit
(0.15), data quality (0.10), history depth (0.10). Each component reports its
own score, weight, contribution and a sentence explaining it.

**Every result is stamped `calibration: 'uncalibrated_heuristic'` with
`sampleSize: null`.** The number is a weighted opinion, not a probability. See
[ADR-0003](docs/adr/0003-uncalibrated-confidence.md).

### 5. Risk — `@binaryai/engine/risk`

Twelve checks run on every signal: live-execution gate, direction present, data
quality, volatility, allowed regime, confidence floor, risk ceiling, blocking
conflicts, open positions, exposure, daily loss, consecutive losses, cooldown.

Every check reports pass/fail with a human-readable detail, so "blocked" always
comes with _why_. Every rule can only reduce activity — there is no setting that
increases stake or loosens a filter automatically.

### 6. Decision

`decide()` maps the pipeline's output to a status and a recommendation:
no direction or risk-blocked → `rejected` / `skip`; allowed but with a major
conflict or middling confidence → `accepted` / `wait_for_confirmation`; clean and
confident → `accepted` / `consider`. Never "execute".

### 7. Persistence (optional)

A stored signal is written as two representations in one transaction:

- **`signals.snapshot`** — the full domain object, so one decision can be
  replayed exactly as it was made, including fields the type gains later.
- **`signal_features`** — the same evidence as rows (indicator,
  confirmation, conflict, confidence component), so questions can be asked
  _across_ signals. "Which conflicts preceded losing signals?" is the query that
  must work before confidence calibration is possible at all, and it is not
  answerable against a JSON blob at any reasonable speed.

`signal_outcomes` records what actually happened at expiry, with the payout
terms that were assumed. The `signal_calibration_samples` view joins the three
into the row shape a future calibration model would consume. **None of this
calibrates anything** — collecting ground truth is a prerequisite for
calibration, not calibration. See
[ADR-0003](docs/adr/0003-uncalibrated-confidence.md).

Storage-level guarantees the application cannot bypass: demo-only `CHECK`
constraints, `NUMERIC` prices (float rounding would turn a tie into a loss),
idempotent candle writes keyed on `(asset, timeframe, opened_at)`, and
`data_source` travelling with every row so synthetic data can never be read
back as live.

## Communication between components

**Web ↔ API** — HTTP/JSON. The dashboard is a pure client: it holds no secrets,
performs no analysis, and models API failure as a value so it can render an
honest "API unreachable" state rather than a blank page.

**API ↔ engine** — direct function calls, in process. The API validates input
with Zod, calls `evaluateDecision`, serialises the result. It owns no domain
logic, which is why the same engine runs identically in the backtester and in a
future worker process.

**API ↔ AI layer** — through the `AiProvider` interface. The default
implementation is local and rule-based; a future HTTP client to `services/ai`
implements the same interface. The AI layer is **never on the critical path**:
analysis, signals and risk all work with it absent.

**API ↔ database** — through repository interfaces declared in
`@binaryai/types` and implemented in `@binaryai/database`, injected into the app
context exactly as the AI provider is. The engine never learns that storage
exists: `evaluateDecision` is the same pure function whether its result is
persisted or thrown away.

Persistence is **optional and opt-in**. With no `DATABASE_URL` the API behaves
exactly as it did in Phase 1, and routes that need storage return an empty
result with the reason rather than an error. With one, a caller sets
`"persist": true` to store a signal — evaluation itself stays read-only.

**Backtest ↔ engine** — the backtester calls `evaluateDecision`, the same
function the live path calls, over sliced history. There is no parallel
"backtest strategy logic" to drift out of sync. That duplication is the single
most common reason backtests lie, and the architecture forbids it structurally.

## Why TypeScript for the core, Python only for ML

The deterministic core is one language so that live analysis and backtesting run
the same code. Splitting analysis into a Python service would mean either
duplicating indicator maths (guaranteed drift) or a network hop on every bar.

Python earns its place where its requirements genuinely differ — model training,
notebook iteration, the numeric/ML ecosystem — which is out of the request path
and behind an HTTP boundary. See
[ADR-0002](docs/adr/0002-typescript-core-python-for-ml.md).

## Demo/live separation

Four independent layers, so no single mistake can enable real-money execution:

1. **Configuration** — `loadConfig` refuses `ALLOW_LIVE_EXECUTION=true` or
   `EXECUTION_MODE=live` and aborts boot with an explanation.
2. **Risk engine** — the `live_execution_disabled` check fails for live mode,
   blocking the signal regardless of quality.
3. **Execution guard** — `assertExecutionAllowed()` throws
   `LiveExecutionDisabledError`; the paper-trading path calls it even though it
   is demo-only by type.
4. **Database** — `CHECK (execution_mode = 'demo')` on accounts, trades and
   signals. Enabling live trading requires a migration someone must write and
   review.

The API does not accept an execution mode from the caller at all.

## Extension points

| To add          | Do this                                                            | Nothing else changes |
| --------------- | ------------------------------------------------------------------ | -------------------- |
| A strategy      | Implement `Strategy`, register it                                  | API, UI, backtester  |
| An indicator    | Add a pure function to `@binaryai/indicators`                      | —                    |
| A data provider | Map its payload to `RawCandleSeries`, call `normalizeCandleSeries` | Engine, strategies   |
| A real AI model | Implement `AiProvider`, inject it in `createAppContext`            | Every consumer       |
| A risk rule     | Add a check to `assessRisk` and a limit to `RiskLimits`            | Strategies           |
| Persistence     | Add repositories in the API layer                                  | Engine stays pure    |
| A scoped query  | Take an `AccessScope` parameter; never default it                  | Callers must decide  |
| A new statistic | Derive it in `@binaryai/analytics`; SQL only counts                | Testable, no drift   |
| A risk rule     | Add it to `evaluateAccountAction`; report observed and limit       | Auditable refusals   |

## Trade-offs taken

- **npm workspaces, not Nx/Turborepo.** Zero extra tooling; TypeScript project
  references already give incremental builds. Revisit if build times hurt.
- **Plain SQL over node-postgres, no ORM.** The queries that matter — a batched
  candle upsert with `ON CONFLICT`, a calibration view with a `jsonb_object_agg`
  — are a few lines of SQL each and would be raw escape hatches in any ORM.
  Typing comes from parsing at the read boundary, not casting
  ([ADR-0006](docs/adr/0006-query-layer-node-postgres.md)).
- **Database tests run on an embedded PostgreSQL locally, a real server in CI.**
  Not SQLite: the schema's value is in what it refuses, and SQLite refuses
  different things ([ADR-0007](docs/adr/0007-two-engine-database-testing.md)).
- **Rate limiting sits behind a store abstraction.** In-process counting is
  correct for exactly one instance and silently wrong for two — with N instances
  the effective limit is N times what was configured, and nothing at runtime
  looks wrong. So the store declares whether it is `shared`, the status endpoint
  reports it, and production refuses per-process counting unless an operator
  opts in by name ([ADR-0016](docs/adr/0016-shared-rate-limiting.md)). The
  Redis-backed store is implemented and tested against a deterministic fake and
  a real socket, but has never run against a real Redis server — implemented is
  not verified.
- **Multiple instances are safe for serving, uncoordinated for workers.**
  Idempotency, settle-once and every uniqueness rule are enforced by database
  constraints, so a race has one winner. Workers duplicate work rather than
  corrupting it, and no leader election exists
  ([ADR-0015](docs/adr/0015-multi-instance-guarantees.md)).
- **Opaque server-side sessions, not JWTs.** Revocation has to be immediate for
  sign-out, account suspension and password change; a signed token cannot be
  withdrawn before it expires without server state, at which point statelessness
  is already gone ([ADR-0010](docs/adr/0010-opaque-server-sessions.md)).
- **Exposure accounting tracks capacity, never profit.** A binary settlement is
  broker-defined and BinaryAI has no broker, so a win and a loss release exactly
  the same committed units
  ([ADR-0013](docs/adr/0013-paper-accounts-and-risk-enforcement.md)).
- **A moving balance requires a stated model, and the model belongs to the
  server.** An account may select a published, versioned simulation model; the
  `simulated_return` it produces is a separate ledger entry stamped with the
  model and version, so the facts stay recoverable from the arithmetic. A client
  cannot supply its own rate — that would make every reported figure only as
  trustworthy as the last request body
  ([ADR-0014](docs/adr/0014-simulation-model.md)).
- **Account risk is enforced in a transaction holding the account row lock.**
  Evaluating outside it would make the open-position limit advisory: two
  concurrent requests would each read the same count and each be permitted.
- **Outcome measurement is frequency-based, not probabilistic.** The engine's
  confidence is a heuristic, and a Brier score or ECE computed over it returns a
  real-looking number answering a question nobody asked. The primary metric is
  rank-based instead ([ADR-0012](docs/adr/0012-calibration-methodology.md)).
- **A statistic that cannot be computed is `null`, never `0`.** Zero wins from
  zero settled signals is no evidence, not 0% accuracy, and the null survives
  from the SQL aggregate to the rendered em dash.
- **The analysis stream is shared; account data is private.** One worker
  analyses public candles, so per-user duplication would produce N identical
  signals from the same bars. Trades, balances and user-generated signals are
  scoped to one account ([ADR-0011](docs/adr/0011-ownership-model.md)).
- **`noUncheckedIndexedAccess` on.** More verbose in indicator loops; catches the
  off-by-one errors that silently corrupt a numeric series.
- **Backtest fills at bar close, no spread or slippage.** Optimistic and stated
  as such in every result. Real fills are worse.
