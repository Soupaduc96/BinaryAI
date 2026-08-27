# BinaryAI

[![CI](https://github.com/Soupaduc96/BinaryAI/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Soupaduc96/BinaryAI/actions/workflows/ci.yml)

An analysis and decision-support platform for binary-options markets.

BinaryAI reads market data, analyses it, produces a candidate signal, scores its
own confidence, assesses risk, and explains every step. It does **not** place
trades. It is not connected to a broker, and this build cannot be configured to
place a real order.

```
validate → analyse → strategy → confidence → risk → recommendation
```

Signals are an output of that pipeline, not a shortcut through it.

---

## Status

**Phase 2A — persistence.** The engine and the storage layer are real and
tested. The external integrations are not built. This table is the honest
picture:

| Area                                                                        | Status                                      |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| Technical indicators (SMA, EMA, RSI, MACD, ATR, Bollinger, ADX, ROC, slope) | Implemented, 42 tests                       |
| Market-data validation and quality scoring                                  | Implemented                                 |
| Rule-based regime classification                                            | Implemented                                 |
| Strategy system + 2 example strategies                                      | Implemented, pluggable                      |
| Confidence scoring                                                          | Implemented — **heuristic, uncalibrated**   |
| Risk engine (12 checks)                                                     | Implemented                                 |
| Backtesting + paper trading                                                 | Implemented, deterministic                  |
| REST API                                                                    | Implemented, 40 integration tests           |
| Dashboard shell                                                             | Implemented — empty states, no live data    |
| PostgreSQL persistence                                                      | Implemented — applied, tested, repositories |
| Signal / outcome / backtest storage                                         | Implemented, opt-in per request             |
| Calibration data foundation                                                 | Collecting samples — **no calibration**     |
| Market-data provider                                                        | Coinbase Exchange (crypto, no credentials)  |
| Historical ingestion + quality validation                                   | Implemented, verified on live data          |
| Continuous ingestion / live analysis / expiry settlement                    | Implemented, opt-in workers                 |
| Broker / live execution                                                     | **Not implemented, blocked by design**      |
| Trained AI models                                                           | **None. Interfaces only**                   |
| CI                                                                          | GitHub Actions: verify + PostgreSQL 16      |
| End-to-end tests                                                            | Scaffolded, Playwright not installed        |

850 tests pass. See [the report at the end of this file](#what-is-deliberately-not-built-yet).

---

## Quick start

Requires **Node.js ≥ 20.9** (developed on 24.15) and npm 10+.

```bash
npm install
cp .env.example .env

npm run verify          # format + lint + typecheck + test
npm run backtest:demo   # run the engine end to end on synthetic data

npm run dev:api         # API   -> http://localhost:4000
npm run dev:web         # UI    -> http://localhost:3000  <- open this one
```

Use `localhost` for both, not `127.0.0.1`. Cookies are keyed by host and
ignore the port, so `localhost:3000` and `localhost:4000` share a cookie jar
while `127.0.0.1:4000` does not — pointing the dashboard at `127.0.0.1` stores
the session cookie where it can never be read back, and sign-in silently does
nothing.

### Optional: persistence

The API runs stateless without a database. To store signals and outcomes:

```bash
docker compose up -d                      # PostgreSQL 16 + Redis
export DATABASE_URL=postgresql://binaryai:binaryai@localhost:5432/binaryai
npm run db:migrate                        # apply migrations
npm run db:status                         # what is applied, what is pending
```

Then pass `"persist": true` to `/v1/signals/evaluate` to store a signal with
its evidence, and `POST /v1/signals/:id/outcome` to record what happened at
expiry. Database tests need no setup at all — they run on an embedded
PostgreSQL engine:

```bash
npm run test:db
```

The dashboard reads the API for system status and the strategy list. Everything
else shows an empty state, because there is no market-data provider and
inventing one would defeat the point.

### Try the pipeline

```bash
curl -X POST http://localhost:4000/v1/signals/evaluate \
  -H 'content-type: application/json' \
  -d '{
    "strategyId": "trend-momentum",
    "series": {
      "asset": "EURUSD", "timeframe": "1m", "source": "historical_file",
      "candles": [{ "timestamp": 1767225600000, "open": 1.1, "high": 1.11, "low": 1.09, "close": 1.105 }]
    }
  }'
```

With one candle you get a rejected signal and a data-quality report explaining
why — which is the correct answer, and a good demonstration of the design.

---

## Scripts

| Command                       | What it does                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `npm run verify`              | format check → lint → typecheck → test. Run before committing. |
| `npm test`                    | Vitest across packages and integration tests                   |
| `npm run typecheck`           | Builds packages, typechecks tests and the web app              |
| `npm run lint` / `lint:fix`   | ESLint (flat config)                                           |
| `npm run format`              | Prettier write                                                 |
| `npm run build`               | Packages → API → web                                           |
| `npm run dev:api` / `dev:web` | Development servers                                            |
| `npm run backtest:demo`       | Demo backtest on a labelled synthetic dataset                  |
| `npm run db:migrate`          | Apply pending migrations (needs `DATABASE_URL`)                |
| `npm run db:status`           | Show applied and pending migrations                            |
| `npm run test:db`             | Database suite on an embedded PostgreSQL, no setup             |
| `npm run clean`               | Remove build output                                            |

---

## Layout

```
apps/
  api/          Fastify REST API (thin: validation, routing, no domain logic)
  web/          Next.js dashboard (presentation only)
packages/
  types/        Shared vocabulary. No runtime code.
  utils/        Small helpers. No domain logic.
  config/       The only module that reads process.env.
  indicators/   Pure technical analysis. Zero dependencies.
  strategies/   Independent strategy modules + registry.
  engine/       Data validation, regime, confidence, risk, decision pipeline.
  backtest/     Historical simulation + paper trading.
  database/     PostgreSQL repositories, migrations, connection pool.
  fixtures/     SYNTHETIC test data. Never imported by runtime code.
services/
  ai/           AI boundary: contract + Python reference skeleton (not running).
database/       SQL migrations and schema rationale.
docs/           Architecture, principles, ADRs.
tests/          db/ + integration/ (both running), e2e/ (scaffolded).
```

Full rationale: [docs/folder-structure.md](docs/folder-structure.md).

---

## Documentation

| Document                                                         | Contents                                           |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                               | How the components fit together and communicate    |
| [docs/vision.md](docs/vision.md)                                 | What BinaryAI is for, and what it refuses to be    |
| [docs/development-principles.md](docs/development-principles.md) | The 15 rules, and how each is enforced             |
| [docs/signal-model.md](docs/signal-model.md)                     | The canonical signal object, field by field        |
| [docs/data-architecture.md](docs/data-architecture.md)           | Market-data boundary, validation, storage          |
| [docs/market-data.md](docs/market-data.md)                       | Provider abstraction, ingestion, failure modes     |
| [docs/runtime.md](docs/runtime.md)                               | Continuous workers, analysis loop, settlement      |
| [docs/authentication.md](docs/authentication.md)                 | Users, sessions, scoping, and what is not built    |
| [docs/analytics.md](docs/analytics.md)                           | Outcome measurement, evidence policy, terminology  |
| [docs/paper-accounts.md](docs/paper-accounts.md)                 | Paper accounts, enforced risk limits, positions    |
| [docs/risk-management.md](docs/risk-management.md)               | Risk philosophy and every check                    |
| [docs/ai-architecture.md](docs/ai-architecture.md)               | What is and is not AI here; the calibration path   |
| [docs/testing-strategy.md](docs/testing-strategy.md)             | What is tested at which level, and why             |
| [docs/security.md](docs/security.md)                             | Auth, secrets, validation, rate limiting, audit    |
| [docs/verification.md](docs/verification.md)                     | What has been run against what, and what it proves |
| [docs/environment.md](docs/environment.md)                       | Every environment variable                         |
| [docs/local-development.md](docs/local-development.md)           | Setup and daily workflow                           |
| [docs/roadmap.md](docs/roadmap.md)                               | Phases, with entry criteria                        |
| [docs/adr/](docs/adr/)                                           | Architecture decision records                      |

---

## What is deliberately not built yet

Listing this explicitly is part of the design:

- **No market-data provider.** Candles come from the request body. Nothing
  streams, nothing polls, and the UI shows no prices.
- **No broker, no live execution.** Blocked at four layers: configuration
  refuses `ALLOW_LIVE_EXECUTION=true`, the risk engine fails the
  `live_execution_disabled` check, `assertExecutionAllowed()` throws, and the
  database has `CHECK (execution_mode = 'demo')`.
- **No trained models.** The AI interfaces exist; every capability reports
  `rule_based` or `not_implemented`. Nothing here is machine learning.
- **No calibrated confidence.** Scores are heuristic weightings stamped
  `uncalibrated_heuristic`. A 0.8 is not an 80% win rate and the UI says so.
  Outcomes are now _collected_ so calibration becomes possible later;
  `GET /v1/calibration/status` reports `implemented: false` regardless of how
  many samples exist.
- **No performance claims.** Backtests are labelled `historical_simulation` and
  carry a disclaimer. The demo dataset is synthetic and labelled as such.
- **No user accounts.** Auth is a single shared bearer token; real sessions are
  Phase 2.

---

## Disclaimer

BinaryAI is software for analysing markets and explaining its own reasoning. It
is not financial advice, it does not predict prices, and no output should be
read as a recommendation to trade. Binary options are high-risk instruments with
negative expected value under typical payout structures; most participants lose
money. Confidence scores in this system are uncalibrated heuristics, and
backtest results are simulations under assumptions that real execution will not
match.
