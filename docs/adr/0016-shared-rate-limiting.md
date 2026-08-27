# ADR-0016: Shared rate limiting behind a store abstraction

**Status:** Accepted
**Date:** 2026-08-27
**Related:** [ADR-0015](0015-multi-instance-guarantees.md)

## Context

Rate limiting was a single in-process sliding window keyed on IP, plus a tighter
window for credential endpoints. It was correct for one instance and had no
dependencies, which is why it shipped that way — but it had three problems that
only get worse as the system gets closer to being deployed:

1. **It multiplies with instances.** Two processes each allow the full budget.
   The operator configured 120 requests a minute and got 240. Nothing in the
   logs, the status endpoint or the metrics would have been wrong enough to
   notice.
2. **Two classes is not enough.** A dashboard polling status and a caller
   requesting an aggregation over an account's entire outcome history spent the
   same budget, so the limit had to be loose enough for the first — which made
   it useless against the second.
3. **There was no answer for "the counter is unreachable."** A Map cannot fail,
   so the question never came up. It is the central question for a shared store.

The obvious move is "add Redis." The obvious move is also how a security control
gets shipped untested: no Redis was reachable from the environment this was
built in, so an implementation written straight against a client library would
have been unrunnable code behind a config flag.

## Decision

**Put the counter behind a `RateLimitStore` interface with two implementations,
and make the difference between them something the system reports rather than
something it hides.**

```
Request → traffic class → identity → RateLimitStore → decision → API
                                          ├── memory (per process)
                                          └── redis  (shared)
```

Four parts, each with its own reason:

### 1. The store is an interface, and it declares whether it is shared

`shared: boolean` is not decoration. The API reports it in
`/v1/system/status`, the boot log states it every boot, and readiness consults
it. A deployment running per-process limits should not have to read its own
configuration to discover that — that is exactly the kind of fact that stays
unnoticed until an incident.

### 2. Configuration fails closed at boot, not at request time

Production refuses `RATE_LIMIT_STORE=memory` unless an operator types
`RATE_LIMIT_ALLOW_IN_MEMORY=true`. Refusing to start is loud, immediate and
fixable in one line. The alternative — start anyway, count in memory, serve
traffic under a limit N times looser than configured — is silent, and the brief
that prompted this work named it directly: _do not silently fall back to an
in-memory limiter in production mode_.

The escape hatch exists because a genuinely single-instance deployment should
not be forced to run a Redis it has no other use for. The requirement is that
the weaker guarantee is **chosen**, not that it is unreachable.

### 3. Five traffic classes, and only one is tunable

`auth_attempt`, `api_request`, `analytics`, `ingestion`, `paper_action`. Only
`api_request` reads from `RATE_LIMIT_MAX_REQUESTS`. The other four bound
specific costs — a password-guessing budget, a provider's quota, a write path
that takes row locks — and an operator raising them from an env var would be
removing a protection without the review that adding it got.

Keys are the stable identifier a credential resolves to, never the credential.
See `docs/security.md` for the full argument; the short version is that a key
travels into the store, into logs and into metrics, and a token-keyed limit is
defeated by minting another token anyway.

### 4. Three outcomes, not two

`allowed`, `limited`, `unavailable`. Collapsing the third is what makes rate
limiting lie: reported as `allowed` it silently removes the protection; reported
as `limited` it tells the caller to retry when retrying will not help.

Credential traffic **fails closed** on `unavailable` (503,
`rate_limiter_unavailable`) because an unreachable counter means unlimited
password guessing. Everything else **fails open** and is marked degraded,
because refusing every read during a cache outage converts a degraded dependency
into a full outage. The choice is per class and visible in the status endpoint,
so it is a decision rather than an accident.

## A four-command Redis client, not a client library

The store needs INCR, PEXPIRE, PTTL and PING. A general-purpose client brings
pub/sub, cluster routing, scripting, sentinel discovery and a connection pool —
none used here, all of it dependency surface in a security-relevant path. RESP2
for four integer replies is about a hundred lines, and those hundred lines can
be tested **against a real TCP socket**, which a mocked client library cannot be.

The verification boundary is stated in the source and repeated here because it
is the whole honesty question for this ADR:

- **Verified:** wire encoding, reply parsing, in-order reply matching under
  pipelining, partial-frame reassembly across packet boundaries, error
  propagation, connection-drop rejection — against a real in-process RESP
  server. Plus the store's command sequence against a deterministic fake
  implementing INCR/PEXPIRE/PTTL to documented semantics.
- **Not verified:** a real Redis server, ACLs, TLS, failover, cluster
  redirection (MOVED/ASK), or behaviour under genuine distributed concurrency.

Distributed rate limiting is therefore an **implemented** capability, not a
**verified** one, and nothing in the repository describes it otherwise.

## Consequences

**Horizontal scaling is now a configuration change**, not a code change —
provided Redis is real and reachable, which is the part that still needs
proving.

**A Redis outage is now a partial outage.** Logins fail with 503 while it lasts.
That is deliberate and is the safer half of the trade, but it is a new
dependency in the login path that did not exist before. `/health/ready` returns
503 so traffic routes to an instance that can serve, and `/health/live` still
returns 200 so the process is not restarted over a cache outage it cannot fix.

**The fixed-window algorithm permits a burst at a window boundary** — up to
twice the budget across two adjacent windows. Accepted: a sliding-log window
costs a sorted set per identity, and the burst it prevents is bounded and short.
Worth revisiting if a real deployment shows it matters.

## Alternatives considered

**A token bucket in Lua via EVAL.** More precise and a single round trip.
Rejected for now: it puts the algorithm in a language with no type checking and
no test coverage in this repository, to replace a fixed window whose failure
mode is a bounded burst.

**Keep per-process limiting and document it.** What the previous phase did. It
stopped being defensible once the stated goal became a production-ready
foundation: the gap is silent, security-relevant, and multiplies with exactly
the thing production does.

**Rate limiting at the proxy.** Legitimate and complementary — a proxy stops a
flood before it reaches Node at all. Rejected as a _replacement_ because the
proxy cannot key on an authenticated account, which is what the expensive
classes need.
