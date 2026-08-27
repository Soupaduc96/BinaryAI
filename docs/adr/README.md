# Architecture decision records

Each record states the context, the decision, its consequences (including the
bad ones), and what would cause it to be revisited. They are dated and
immutable: a decision that changes gets a new ADR that supersedes the old one,
rather than an edit that erases the reasoning.

| ADR                                                 | Decision                                                        | Status                      |
| --------------------------------------------------- | --------------------------------------------------------------- | --------------------------- |
| [0001](0001-monorepo-npm-workspaces.md)             | Monorepo on npm workspaces + TypeScript project references      | Accepted                    |
| [0002](0002-typescript-core-python-for-ml.md)       | Deterministic core in TypeScript; Python reserved for ML        | Accepted                    |
| [0003](0003-uncalibrated-confidence.md)             | Confidence ships labelled uncalibrated                          | Accepted                    |
| [0004](0004-demo-only-execution.md)                 | Demo-only execution, enforced at four layers                    | Accepted                    |
| [0005](0005-sql-first-persistence.md)               | Plain SQL migrations; ORM choice deferred                       | Accepted, completed by 0006 |
| [0006](0006-query-layer-node-postgres.md)           | Hand-written SQL over node-postgres; no ORM                     | Accepted                    |
| [0007](0007-two-engine-database-testing.md)         | Embedded PostgreSQL locally, real server in CI                  | Accepted                    |
| [0008](0008-market-data-provider.md)                | Coinbase Exchange as the first market-data provider             | Accepted                    |
| [0009](0009-in-process-workers.md)                  | In-process workers; PostgreSQL as the coordination point        | Accepted                    |
| [0010](0010-opaque-server-sessions.md)              | Opaque server-side sessions, not JWTs                           | Accepted                    |
| [0011](0011-ownership-model.md)                     | Shared analysis stream, private account data                    | Accepted                    |
| [0012](0012-calibration-methodology.md)             | Bucketed frequency measurement, not probabilistic calibration   | Accepted                    |
| [0013](0013-paper-accounts-and-risk-enforcement.md) | Paper accounts, exposure-only accounting, enforced account risk | Accepted                    |
| [0014](0014-simulation-model.md)                    | Server-defined, versioned paper simulation models               | Accepted                    |
| [0015](0015-multi-instance-guarantees.md)           | What is and is not safe across multiple instances               | Accepted                    |
| [0016](0016-shared-rate-limiting.md)                | Shared rate limiting behind a store abstraction                 | Accepted                    |
