# Folder structure

```
BinaryAI/
├── apps/
│   ├── api/                  Fastify REST API
│   │   └── src/
│   │       ├── routes/       system, strategies, analysis, backtest
│   │       ├── plugins/      security (CORS, rate limit, auth), errors
│   │       ├── lib/          app context (DI), HTTP helpers
│   │       ├── app.ts        buildApp() — testable, does not listen
│   │       └── server.ts     process entry point
│   └── web/                  Next.js dashboard
│       └── src/
│           ├── app/          App Router: layout, page, globals.css
│           ├── components/   primitives, panels, auth controls
│           └── lib/          api.ts (server-only: forwards the session cookie)
│                             api-base.ts (safe on both sides of the RSC boundary)
│
├── packages/
│   ├── types/                Shared vocabulary. No runtime code, no deps.
│   ├── utils/                Numbers, time, Result, ids, seeded RNG.
│   ├── config/               The ONLY module that reads process.env.
│   ├── indicators/           Pure TA. Zero dependencies.
│   ├── strategies/           Strategy modules + registry + parameter validation.
│   ├── engine/               Data boundary, regime, confidence, risk, pipeline,
│   │                         and account-level risk enforcement.
│   ├── backtest/             Historical simulation + paper trading.
│   ├── market-data/          Provider abstraction, normalization, quality scan.
│   ├── auth/                 Password hashing, session tokens, access scope.
│   ├── analytics/            Outcome statistics. Pure; no database, no HTTP.
│   ├── database/             PostgreSQL repositories. Hand-written SQL.
│   ├── runtime/              Ingestion, live analysis and settlement workers.
│   └── fixtures/             SYNTHETIC data. Never imported by runtime code.
│
├── services/
│   └── ai/                   Contract + Python reference skeleton (not running).
│
├── database/
│   ├── migrations/           Plain SQL, applied in order.
│   └── README.md             Schema decisions.
│
├── docs/
│   └── adr/                  Architecture decision records.
│
├── scripts/                  run-backtest, db-migrate, dev-database, screenshot
├── tests/
│   ├── db/                   Repositories against a real PostgreSQL engine
│   ├── integration/          API tests via inject() — running
│   └── e2e/                  Playwright — scaffolded, not installed
│
├── tsconfig.base.json        Strict compiler options, shared
├── tsconfig.build.json       Project-reference build graph
├── tsconfig.test.json        Typechecks test files
├── vitest.config.ts          Aliases @binaryai/* to source
├── eslint.config.mjs         Flat config
└── docker-compose.yml        PostgreSQL + Redis for development only
```

## The rules behind it

**Dependencies point one way.** `types` and `utils` at the bottom; `apps` at the
top. No package imports an app. A cycle means the boundary is wrong.

```
types ─┬─ utils ─┬─ indicators ─┬─ strategies ─┬─ engine ─┬─ backtest
       │         │              │              │          │
       └─ config │              │              │          └──┐
                 └─ fixtures    └──────────────┴─────────────┴──► apps
```

**`apps/` holds no domain logic.** The API validates, routes and serialises. The
dashboard renders. Both are replaceable without touching the engine — which is
what lets the backtester run the same pipeline in-process with no HTTP.

**One reason to exist per package.** `indicators` is maths. `strategies` is
opinions. `engine` is the decision sequence. `backtest` is simulation. When a
file no longer matches its package's reason, it moves.

**`fixtures` is a firewall.** Synthetic data lives in exactly one package that
nothing in the runtime path imports, which makes rules 2 and 3 (no fabricated
data or performance) structural rather than a matter of discipline.

**`config` is the only door to the environment.** One place to audit for secret
handling.

## Why `analysis` and `backtesting` are packages, not services

The brief sketched `services/analysis` and `services/backtesting`. They are
libraries here instead, and only the AI layer is a service.

The reason is that backtesting must run **the same code** as live analysis. Two
services means either duplicated indicator maths — which drifts, and a backtest
validating code that is not the code that trades is worse than no backtest — or
a network hop per bar, turning a 400-bar backtest into 400 HTTP round trips.

The AI layer is a service because its requirements genuinely differ: Python's ML
stack, notebooks, GPUs, long training jobs, all off the request path. Split on
_runtime requirements_, not on feature area. See
[ADR-0002](adr/0002-typescript-core-python-for-ml.md).

The boundaries the brief asked for are still hard boundaries — separate
packages, separate dependency edges, enforced by the compiler. They are just not
separate processes, because processes were not what made them boundaries.
