# Security

## Implemented today

**Secrets are isolated.** `packages/config` is the only module that reads
`process.env`. `describeConfig` produces the log-safe view — secrets appear as
`apiKeySet: true`, never by value — and it is what gets logged at boot. A test
asserts no secret value can appear in that output. `.env` is gitignored; only
`.env.example` is committed, with placeholders.

**Input is validated at every boundary.** Zod schemas on HTTP bodies, candle
payloads, environment variables and strategy parameters. Unknown strategy
parameters are rejected rather than ignored. Request bodies are capped at 8 MB.
Candle arrays are capped at 50,000 entries.

**Authentication.** Optional in development, mandatory in production
(`loadConfig` refuses `NODE_ENV=production` without `AUTH_ENABLED=true`).
User accounts with Argon2id and opaque server-side sessions are the primary
path; a shared bearer token remains for machine callers, compared in **constant
time** so a wrong key cannot be discovered byte by byte. `/health*` stays public
for probes.

**Rate limiting.** Five traffic classes behind a swappable store, keyed on the
identity a credential resolves to rather than on the credential. Returns `429`
with `Retry-After` and a stable code. Production refuses per-process counting
unless an operator opts in by name. See "Rate limiting" below.

**Error handling leaks nothing.** One error handler maps known domain errors to
precise status codes; anything else is a 500 carrying only a request id.
Internal messages are suppressed when `NODE_ENV=production`.

**Log redaction.** Fastify redacts `authorization` and `cookie` headers. Request
bodies are never logged.

**CORS is explicit.** An allow-list from `API_CORS_ORIGINS`; a wildcard is
rejected in production.

**The frontend holds no secrets.** The dashboard is a pure API client. Only
`NEXT_PUBLIC_*` variables reach it, and by definition those are public.

**Live execution is blocked at four layers.** See
[risk-management.md](risk-management.md).

**The database enforces its own constraints.** `CHECK` constraints on execution
mode, positive prices, OHLC consistency and settled-trade completeness, so
application bugs cannot write incoherent rows.

## Authentication and authorization

**Passwords are Argon2id.** OWASP parameters (m=19456 KiB, t=2, p=1), salted per
hash, upgraded transparently on login if the parameters are ever raised. The
digest leaves the repository layer through exactly one method, which the login
flow alone calls; every other read projects a column list without it.

**Sessions are opaque and server-side.** A 32-byte random token in an httpOnly,
`SameSite=Lax`, `Secure` cookie, stored only as its SHA-256. Sign-out, account
suspension and password change revoke immediately. See
[ADR-0010](adr/0010-opaque-server-sessions.md).

**Login does not reveal which accounts exist.** An unknown address and a wrong
password produce the same status, code and message, and an unknown address is
verified against a decoy digest so the two take the same time. Measured at
~0.24 s either way; without the decoy an unknown address returns in ~2 ms.

**Brute force is throttled twice.** Per-IP, on the credential endpoints
specifically (10/minute, far tighter than the general limit), and per-account,
with an escalating lock after 5 consecutive failures capped at 15 minutes. The
cap is deliberate: a permanent lock would let anyone who knows an email address
deny its owner access.

**CSRF is defended twice.** `SameSite=Lax` stops the browser attaching the
cookie to cross-site writes at all, and cookie-authenticated writes are rejected
unless their `Origin` is in the CORS allow-list. Bearer-token callers are
exempt, because a token has to be attached deliberately.

**Account mutations verify ownership before anything else runs.** Every account
route resolves through one function that checks the session owns the account; a
foreign account returns **404, not 403**, so the endpoint cannot be used to
discover which account ids exist. A path parameter names an account, it never
authorizes one.

**Risk limits cannot be relaxed by a request.** The stored account policy is
authoritative. A caller-supplied override may only TIGHTEN it, per field and in
the correct direction; `allowLiveExecution` is forced false from every path.
Before Phase 5 the analysis endpoint accepted arbitrary limits, which made the
stored policy advisory.

**Analytics are scoped in SQL, not in the UI.** Every analytics query takes an
`AccessScope` and applies it as a WHERE clause; there is no unscoped path and no
`?accountId=` parameter on any endpoint. Sample counts and exclusion tallies are
scoped too — a count discloses just as a row does, so "how many outcomes does
that account have?" must be unanswerable.

**Row-level scoping is a type, not a convention.** `AccessScope` is a required
parameter on ownership-sensitive queries, so failing to filter does not compile.
A record the caller may not read returns **404, not 403** — a 403 would confirm
the id exists.

**The shared API key is a machine credential.** It authenticates a process, not
a person. It owns nothing, reads only the shared analysis stream, and is
rejected outright by user-scoped endpoints.

**What is shared and what is private.** The runtime analysis stream is a shared
intelligence product readable by every authenticated user; trades, balances,
risk events and user-generated signals are private to one account. See
[ADR-0011](adr/0011-ownership-model.md) — and note this supersedes an earlier
sentence in this document that described _all_ signals as per-user.

## Known gaps

Stated plainly, because a security section that only lists strengths is
misleading.

**Redis is verified against 3.0.504, not against a modern Redis.** The client,
store, limiter and the two-instance shared budget all pass against a real Redis
server (`npm run verify:redis`, `REDIS_URL=… npm run verify:distributed`). The
server available on this platform is Microsoft's archived 3.0.504 port, so
anything introduced after Redis 3.0 -- `protected-mode`, ACLs, TLS, cluster
redirection, failover -- remains unverified. Run the same scripts against the
`redis:7-alpine` service in `docker-compose.yml` to close that.

**No secret rotation.** No key-management integration. `AUTH_API_KEY` is static.

**No password reset, email verification or MFA.** All three need an email
transport, which this build does not have. An administrator cannot yet reset a
password for a locked-out user through the API.

**Concurrency under contention is now proven — locally, against a real server.**
`npm run verify:postgres` starts a real PostgreSQL 16.14 server and runs
`tests/db/postgres-only.test.ts`, which races two live connections on row
locking, paper-action idempotency, settle-once and simulation-model
immutability. It still **skips** rather than passing vacuously when no server is
available. What remains unproven is behaviour under production-scale
contention, which is a load-testing question rather than a correctness one.

**The default local engine is still a different major version from the target.**
`npm test` runs on PGlite, which embeds PostgreSQL **18**, while production
targets **16** — so a green `npm test` is not evidence of 16 compatibility.
That gap is now closable on demand rather than only in CI:
`npm run verify:postgres` runs the same suites against a real 16.14 server.
Note the remaining difference: CI uses the musl Linux build
(`postgres:16-alpine`), the local server is the platform's own build of 16.x.

**Analytics queries are bounded but not cost-metered.** The window is capped at
two years and result sets at 200 rows, which bounds any single request. A caller
within the rate limit can still issue many bounded-but-expensive aggregations.

**No transport security in the repo.** TLS termination is a deployment concern;
nothing in the code enforces HTTPS. `Strict-Transport-Security` and friends
belong at the proxy.

**Dependencies are not scanned automatically.** `npm audit` is not part of the
CI workflow. The workflow itself now exists and is correct, but has never
executed: the repository has no remote. See
[verification.md](verification.md#ci--external).

## Rate limiting

Counters live behind a `RateLimitStore` interface with two implementations. The
interface exists because the correctness argument changes completely depending
on where the counter lives: an in-process Map is exactly right for one instance
and silently wrong for two, since each keeps its own counters and the effective
limit becomes N times what the operator configured.

**Configuration fails closed at boot.** `RATE_LIMIT_STORE=memory` in production
is refused unless the operator types `RATE_LIMIT_ALLOW_IN_MEMORY=true`, and
`RATE_LIMIT_STORE=redis` without `REDIS_URL` is refused outright. Starting
anyway and quietly counting in memory is the exact failure this prevents: the
API would serve traffic while enforcing a limit far looser than configured, and
nothing at runtime would be wrong enough to notice.

### Traffic classes

One global budget per IP is the wrong shape. A dashboard polling status and a
script guessing passwords are the same traffic to a single counter, so a limit
loose enough for the first is useless against the second.

| Class          | Budget                    | Keyed on               | Store unreachable     |
| -------------- | ------------------------- | ---------------------- | --------------------- |
| `auth_attempt` | 10 / min                  | network (/64 for IPv6) | **fail closed** (503) |
| `api_request`  | `RATE_LIMIT_MAX_REQUESTS` | network                | fail open, degraded   |
| `analytics`    | 30 / min                  | user or service        | fail open, degraded   |
| `ingestion`    | 12 / min                  | user or service        | fail open, degraded   |
| `paper_action` | 30 / min                  | user or service        | fail open, degraded   |

Only `api_request` is operator-tunable. The rest bound specific costs — a
password-guessing budget, a provider's quota, a write path that takes row locks
— and raising them from an env var would remove that protection without the
review that adding it got.

### Key design

Keys are **never** a session token, an API key, a password, or a hash of one.
Two independent reasons: a key travels into the store, into logs when a limit is
hit, and into metrics; and a token-keyed limit is defeated by minting another
token. Authenticated traffic is keyed by the stable identifier the credential
resolves to (a user or account id, which is not a secret and cannot be rotated
by the caller), unauthenticated traffic by network identity.

IPv6 addresses are truncated to their **/64**, because a subscriber is routinely
handed a whole /64 and keying on the full address would give one attacker 2^64
independent login budgets. IPv4 is kept whole — a /24 would sweep unrelated
customers behind one carrier NAT into a shared budget.

### Failure policy

Credential traffic fails **closed** because an unreachable counter means
unlimited password guessing; a 503 with code `rate_limiter_unavailable` says the
limiter could not answer, rather than falsely telling the caller they were too
fast. Everything else fails **open** and is reported degraded, because refusing
every read during a cache outage converts a degraded dependency into a full
outage. `/v1/system/status` reports the limiter's real state, and `/health/ready`
returns 503 when a _configured shared_ store is unreachable — this instance
cannot serve a login.

### What is verified, and what is not

**Verified — the distributed property itself.** `npm run verify:distributed`
starts a real PostgreSQL 16 server, a shared counter in its own process, and
**two independent API instances** on different ports, then drives real HTTP
requests through both. 18/18 checks pass, including the one that matters:

> With a budget of 10, instance A served 6 and instance B served 4 before
> refusing. **One combined budget, not two.** A caller that has exhausted the
> budget stays refused when its next request reaches the other process.

Also verified across two instances: a session issued by A is accepted by B,
logout on A invalidates it on B, credential traffic fails **closed** (503
`rate_limiter_unavailable`) when the counter dies, general traffic fails open,
and readiness reports the counter unavailable while liveness stays 200.

**Verified — the RESP client.** Wire encoding, reply parsing, in-order reply
matching under pipelining, partial-frame reassembly across packet boundaries,
connection-drop rejection, AUTH/SELECT ordering — against real TCP sockets.

**Verified — against a real Redis server.** `npm run verify:redis` exercises the
client, store and limiter against Redis itself: 17/17. `REDIS_URL=… npm run
verify:distributed` then runs the two-instance shared-budget proof with that
Redis as the counter: 18/18. This matters because the unit tests use a fake and
the distributed run can use a stand-in, both written alongside the client — an
independent implementation is what rules out a shared misreading of the
protocol.

**NOT verified — a modern Redis.** The server is 3.0.504, the only genuine Redis
obtainable on this platform. The four commands used have had stable semantics
since 2.6, so the protocol evidence holds; but `protected-mode`, ACLs, TLS,
cluster redirection (MOVED/ASK), failover and modern eviction are untested.

**Why:** Redis has no supported native Windows build. `redis-memory-server`
compiles Redis from source on Linux and macOS but delegates to **Memurai** —
separate commercial software — on Windows. This is an **external prerequisite**,
not a code gap: point `REDIS_URL` at a real Redis on any Linux or macOS machine,
or run `docker compose up -d` (the compose file already defines `redis:7-alpine`)
and the same verification runs against it unchanged.

So: distributed rate limiting is **implemented**, its **multi-instance behaviour
is verified**, and **Redis as a product is unverified**.

## Session retention

Expired sessions are refused at resolution time — `findValid` checks the expiry
on every request — so an unswept row grants nothing. Retention is nevertheless a
real concern: every sign-in writes a row, and until Phase 6B nothing removed
one. The table grew without bound, and the rows that remained were exactly the
credential material an attacker would want from a database copy.

A **maintenance worker** now sweeps them hourly (`MAINTENANCE_INTERVAL_MS`,
floored at 60s). Two properties are deliberate:

- **The cutoff is `now`, never padded forward.** Deleting a row that expires in
  a minute would sign out a user who is still working, to reclaim a row the next
  cycle would have taken anyway. Verified against a real engine: a live session
  survives a sweep.
- **It is retention, not an authorisation control.** A failed sweep is a cleanup
  that runs again in an hour, not an incident. If it were load-bearing for
  security, its failure mode would be far more serious than it is.

## Audit trail

`system_events` records the auth lifecycle: `user_registered`,
`login_succeeded`, `login_failed`, `login_blocked`, `account_locked`,
`session_revoked`, `sessions_revoked_all`, `password_changed` and
`password_change_failed` — plus the risk, settlement and ingestion events
recorded elsewhere.

Two rules govern what may be written, and the second matters as much as the
first:

1. **Nothing secret reaches an event.** No password, session token, Argon2
   digest or authorization header. An audit table holding credentials is a
   second copy of the thing it was meant to protect, usually with weaker access
   controls than the table it was copied from.
2. **A failed write never fails the request.** Auditing is observability, not
   authorisation. If it threw, an unreachable database would stop people logging
   _out_ — the opposite of safe.

The email submitted for a login against an account that does not exist is
deliberately **not** recorded. It is an arbitrary string from an unauthenticated
caller, it may be a third party's real address typed by mistake, and an audit
table is a poor place for unvalidated input from strangers to accumulate. The
`userId` — recorded whenever the account is real — answers the operational
question of who is being attacked without it.

Enforced by `tests/integration/audit-log.test.ts`, which asserts both that the
events are written and that no password, digest or token appears in any of them.

## Rules for contributors

1. Never read `process.env` outside `packages/config`.
2. Never log a secret. Extend `describeConfig` when adding configuration.
3. Never trust request input. Parse it with Zod, then use the parsed value.
4. Never put a secret in a `NEXT_PUBLIC_*` variable.
5. Never widen the demo-only constraints without an ADR.
6. Never return an internal error message to a client in production.
7. Hash passwords with Argon2id when auth arrives. Never store plaintext.

## Threat notes specific to this domain

**Market data is untrusted input.** A provider can send malformed or hostile
payloads. The validation boundary is a security control, not only a correctness
one.

**Confidence scores are a social-engineering surface.** A number presented as a
probability when it is not can cause real financial loss. Mislabelling is
treated as a defect, which is why calibration status is a required field.

**Backtest results are persuasive.** Presenting a simulation as performance
would be misleading in a way that costs users money. Hence the required
`resultType` and disclaimer.

**A simulated account value is the most persuasive number in the product.** It
looks exactly like money and moves like a balance. Three controls keep it from
becoming a claim BinaryAI cannot support:

- **The client cannot author the accounting model.** Simulation models are
  server-defined and versioned; the selection endpoint accepts a model id and
  nothing else, and `.strict()` means a body smuggling its own rate is rejected
  rather than ignored. Accepting one would make every reported figure only as
  trustworthy as the last request body — the same category of mistake as
  trusting a client-supplied price.
- **No simulated figure can be written unattributed.** A CHECK constraint
  requires the model id and version on every `simulated_return` entry, so the
  arithmetic behind any number is always recoverable. Published models are
  immutable, because editing one would rewrite the meaning of every entry
  stamped with it while leaving the entries untouched.
- **The premise travels with the figure.** Every API response carrying a
  simulated value carries the model, its version and a sentence stating that it
  is not a broker result. See [ADR-0014](adr/0014-simulation-model.md).

**A simulation model is not a risk override.** Paper actions with a model active
still pass ownership, account status, position size, open-position limits,
exposure limits and the live-execution refusal.
