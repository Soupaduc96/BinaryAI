# Environment variables

All variables are declared, validated and typed in
[`packages/config/src/env.ts`](../packages/config/src/env.ts). Nothing else in
the codebase reads `process.env`. Invalid configuration aborts boot with a list
of problems rather than failing later as a mystery 500.

Copy [`.env.example`](../.env.example) to `.env` to start.

## Runtime

| Variable    | Default       | Notes                                   |
| ----------- | ------------- | --------------------------------------- |
| `NODE_ENV`  | `development` | `development` \| `test` \| `production` |
| `LOG_LEVEL` | `info`        | `fatal`…`trace`                         |

## API

| Variable                     | Default                 | Notes                                                  |
| ---------------------------- | ----------------------- | ------------------------------------------------------ |
| `API_HOST`                   | `127.0.0.1`             | Use `0.0.0.0` in a container                           |
| `API_PORT`                   | `4000`                  | 1–65535                                                |
| `API_CORS_ORIGINS`           | `http://localhost:3000` | Comma-separated allow-list. `*` rejected in production |
| `RATE_LIMIT_WINDOW_MS`       | `60000`                 | Fixed window for the general class                     |
| `RATE_LIMIT_MAX_REQUESTS`    | `120`                   | General budget per identity per window                 |
| `RATE_LIMIT_STORE`           | `memory`                | `memory` (per process) or `redis` (shared)             |
| `RATE_LIMIT_ALLOW_IN_MEMORY` | `false`                 | Explicit opt-in to per-instance limiting in production |

Only the general class is tunable. `auth_attempt`, `analytics`, `ingestion` and
`paper_action` have fixed budgets because they bound specific costs — see
[security.md](security.md#rate-limiting) and
[ADR-0016](adr/0016-shared-rate-limiting.md).

## Storage — optional

| Variable       | Default | Notes                                                      |
| -------------- | ------- | ---------------------------------------------------------- |
| `DATABASE_URL` | unset   | PostgreSQL connection string. Unset = stateless API        |
| `DATABASE_SSL` | `false` | Enables TLS on the pool                                    |
| `REDIS_URL`    | unset   | Required by `RATE_LIMIT_STORE=redis`. Not used for caching |

Without `DATABASE_URL` the API runs exactly as it did in Phase 1: analysis
works, nothing is stored, and persistence-backed routes return an empty result
with the reason. With it set, run `npm run db:migrate` before starting.

`DATABASE_URL` is also read by the test harness: when set, the database suite
runs against that server instead of the embedded engine.

## Market data

| Variable               | Default | Notes                                |
| ---------------------- | ------- | ------------------------------------ |
| `MARKET_DATA_PROVIDER` | `none`  | `none` is the only supported value   |
| `MARKET_DATA_API_KEY`  | unset   | Placeholder for a future integration |
| `MARKET_DATA_WS_URL`   | unset   | Placeholder                          |

No provider is integrated. Candles are supplied in the request body.

## Broker

| Variable            | Default | Notes                |
| ------------------- | ------- | -------------------- |
| `BROKER_PROVIDER`   | `none`  | Only supported value |
| `BROKER_API_KEY`    | unset   | Placeholder          |
| `BROKER_API_SECRET` | unset   | Placeholder          |

BinaryAI cannot place orders. These exist so the shape of a future integration
is visible.

## AI

| Variable         | Default      | Notes                            |
| ---------------- | ------------ | -------------------------------- |
| `AI_PROVIDER`    | `rule_based` | `rule_based` \| `http_service`   |
| `AI_SERVICE_URL` | unset        | **Required** when `http_service` |
| `AI_API_KEY`     | unset        | Bearer token for the service     |

`http_service` has no implementation yet; see
[services/ai](../services/ai/README.md).

## Auth

| Variable                  | Default            | Notes                                                          |
| ------------------------- | ------------------ | -------------------------------------------------------------- |
| `AUTH_ENABLED`            | `false`            | **Required `true`** when `NODE_ENV=production`                 |
| `AUTH_API_KEY`            | unset              | Shared **machine** token. Owns nothing; reads shared data only |
| `AUTH_SESSION_TTL_HOURS`  | `168` (7 days)     | Session lifetime                                               |
| `AUTH_COOKIE_NAME`        | `binaryai_session` | Session cookie name                                            |
| `AUTH_COOKIE_SECURE`      | `true`             | `false` is **refused** in production                           |
| `AUTH_COOKIE_DOMAIN`      | unset              | Leave unset for host-only cookies                              |
| `AUTH_ALLOW_REGISTRATION` | `false`            | Open signup. Off by default                                    |
| `AUTH_BOOTSTRAP_ADMIN`    | `true`             | First user on an empty instance becomes admin                  |

There is **no `AUTH_JWT_SECRET`**. BinaryAI uses opaque server-side sessions so
that logout and suspension take effect on the next request; a stateless JWT
cannot be revoked before it expires. See
[ADR-0010](adr/0010-session-strategy.md).

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Analytics

| Variable                | Default | Notes                                                 |
| ----------------------- | ------- | ----------------------------------------------------- |
| `ANALYTICS_MIN_SAMPLES` | `30`    | Settled outcomes required before any rate is reported |

Below the minimum, every rate is `null` and the interface reports insufficient
evidence. Lowering the value lowers the bar for publishing a figure; it does not
make the figure more reliable. See
[ADR-0012](adr/0012-calibration-methodology.md).

## Execution

| Variable               | Default | Notes                 |
| ---------------------- | ------- | --------------------- |
| `EXECUTION_MODE`       | `demo`  | `live` is **refused** |
| `ALLOW_LIVE_EXECUTION` | `false` | `true` is **refused** |

Both refusals are intentional and tested. See
[ADR-0004](adr/0004-demo-only-execution.md). `loadConfig` always returns
`{ mode: 'demo', allowLive: false }` regardless of input.

## Monitoring

| Variable             | Default | Notes                      |
| -------------------- | ------- | -------------------------- |
| `MONITORING_ENABLED` | `false` | No integration implemented |
| `MONITORING_DSN`     | unset   | Placeholder                |

## Web

| Variable                     | Default                 | Notes                                     |
| ---------------------------- | ----------------------- | ----------------------------------------- |
| `NEXT_PUBLIC_API_URL`        | `http://localhost:4000` | **Public by definition — never a secret** |
| `NEXT_PUBLIC_SESSION_COOKIE` | `binaryai_session`      | Must match `AUTH_COOKIE_NAME` on the API  |

Use the **same hostname** for the API as the dashboard is served from. Cookies
are keyed by host and ignore the port, so `localhost:3000` and
`localhost:4000` share a cookie jar while `127.0.0.1:4000` does not — pointing
the dashboard at `127.0.0.1` stores the session cookie where it can never be
read back, and sign-in silently does nothing.

## Cross-field rules

Validated together, because a per-field schema cannot express them:

- `AI_PROVIDER=http_service` requires `AI_SERVICE_URL`.
- `AUTH_ENABLED=true` requires `DATABASE_URL` (user accounts) or `AUTH_API_KEY`.
- `NODE_ENV=production` forbids `AUTH_COOKIE_SECURE=false`.
- `NODE_ENV=production` requires `AUTH_ENABLED=true`.
- `NODE_ENV=production` forbids a wildcard CORS origin.
- `ALLOW_LIVE_EXECUTION=true` or `EXECUTION_MODE=live` is always refused.
- `RATE_LIMIT_STORE=redis` requires `REDIS_URL`.
- `NODE_ENV=production` forbids `RATE_LIMIT_STORE=memory` unless
  `RATE_LIMIT_ALLOW_IN_MEMORY=true`. Per-process counting multiplies the
  effective limit by the instance count, so it must be chosen rather than
  arrived at.

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`.

## Adding a variable

1. Add it to `envSchema` with a validated type and a default.
2. Map it into `AppConfig`.
3. Add it to `describeConfig` — secrets as `xSet: boolean`, never the value.
4. Document it in `.env.example` and here.
5. Add a test if it has cross-field rules.
