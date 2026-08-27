# Development principles

The 15 project rules, what each means in this codebase, and how each is
enforced. "Enforced" means a tool fails, not that someone remembers.

---

### 1. Do not fabricate APIs

Every endpoint in `apps/api` is implemented and covered by an integration test.
Endpoints that cannot do their job yet (`/v1/assets`, `/v1/signals`) return an
empty result **plus the reason**, rather than sample data.

_Enforced by:_ `tests/integration/api.test.ts` asserts the empty payloads and
their stated reasons.

### 2. Do not fabricate market data

Synthetic data lives in one package, `@binaryai/fixtures`, which nothing in the
runtime path imports. Every generated series carries `source: 'synthetic'` and a
label containing `NOT MARKET DATA`. Any backtest run on it emits a warning.

_Enforced by:_ the package boundary; the `source` field is part of `CandleSeries`
and travels with the data; tests assert the warning appears.

### 3. Do not fabricate trading performance

Backtest results are typed `resultType: 'historical_simulation'` and carry
`BACKTEST_DISCLAIMER`. Metrics that have no data are `null`, never `0` — a win
rate of "no trades" is not 0%. The demo script defaults to zero drift because a
trending synthetic series produces a ~99% win rate that means nothing.

_Enforced by:_ the type only permits one `resultType`; tests assert `winRate` is
`null` for an empty trade list.

### 4. Do not claim an AI model is intelligent if it is only rule-based

`AiCapabilityStatus.implementation` is a required field on every capability, and
the honest values are reported: `rule_based` for the explainer and the regime
classifier, `not_implemented` for everything else. `SignalReasoning.generatedBy`
distinguishes `rule_engine` from `ai_model` on every signal.

_Enforced by:_ required fields on the types; integration tests assert the values.

### 5. Do not mix frontend, backend and strategy logic

The dashboard performs no analysis and holds no secrets. The API contains no
domain logic — it validates, calls the engine, serialises. Strategies compute no
confidence and know nothing about HTTP.

_Enforced by:_ the dependency graph. `apps/web` depends only on `@binaryai/types`;
no package imports an app.

### 6. Do not create giant monolithic files

_Enforced by:_ ESLint `max-lines` (400, excluding blanks and comments).

### 7. Prefer reusable modules

Indicators are used by strategies, the regime classifier and (through both) the
backtester. `evaluateDecision` is called by the API and the backtester alike.

### 8. Use strong typing

`strict`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`. `any` is an ESLint **error**, not a warning. There is no
`any` in the codebase.

_Enforced by:_ `tsconfig.base.json` and `@typescript-eslint/no-explicit-any`.

### 9. Validate external data

Zod schemas at every boundary: HTTP bodies, candle payloads, environment
variables, strategy parameters. Database reads are _parsed_, not cast:
`toDirection('sideways')` throws rather than fabricating a signal direction. Unknown strategy parameters are **rejected**, not
ignored — a typo would otherwise silently run defaults and invalidate a backtest.

_Enforced by:_ `normalizeCandleSeries`, `parseBody`, `loadConfig`,
`resolveParameters`, each with tests.

### 10. Write tests for important logic

850 tests, weighted toward the parts where a bug is silent and expensive:
indicators (42), engine (56), database (75 against a real PostgreSQL engine,
plus 22 unit), backtest and simulation (30), strategies (21), API (40),
config (10).

### 11. Document important architectural decisions

Five ADRs in [`docs/adr/`](adr/), each stating context, decision, consequences
and what would reverse it.

### 12. Keep demo and live functionality strictly separated

Four independent layers: configuration refusal, risk check, execution guard,
database constraint. `PaperAccount.mode` is the literal `'demo'`, so a live
account is not merely disallowed — it is unrepresentable.

_Enforced by:_ the type system, `loadConfig`, `assessRisk`,
`assertExecutionAllowed`, and SQL `CHECK` constraints, all tested.

### 13. Never hard-code secrets

`packages/config` is the only module that reads `process.env`. `describeConfig`
produces the log-safe view and reports secrets as present/absent, never by value.
Fastify redacts `authorization` and `cookie` headers. `.env` is gitignored.

_Enforced by:_ a test that asserts no secret value appears in `describeConfig`
output.

### 14. Do not add unnecessary dependencies

Runtime dependencies: `fastify`, `@fastify/cors`, `zod`, `pg`, and Next/React
for the dashboard. `@binaryai/indicators` has zero dependencies. Rate limiting is
~30 lines rather than a package, and persistence is hand-written SQL rather than
an ORM ([ADR-0006](adr/0006-query-layer-node-postgres.md)).

### 15. Build incrementally

Phase 1 is the engine and its contracts. Providers, persistence and models come
later, on top of interfaces that already exist. See [roadmap.md](roadmap.md).

---

## Conventions

**Purity in the engine.** Indicators, strategies, confidence and risk are pure
functions. Clocks and id generators are injected (`now`, `idFactory`) so results
are reproducible.

**Null means unknown.** Indicator warm-up is `null`, never `0`. An unavailable
metric is `null`, never a neutral-looking default.

**Errors are values at boundaries, exceptions inside.** External input returns
`Result`; internal invariant violations throw.

**Comments explain why.** The what is in the code. Comments cover non-obvious
decisions: why Wilder smoothing rather than an EMA, why the confidence prior is
0.6, why the backtester slices the series.
