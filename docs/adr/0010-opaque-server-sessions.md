# ADR-0010 — Opaque server-side sessions, not JWTs

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

Phase 3 turned a single-tenant instance into a multi-user one. That required a
way to carry identity across requests. `docs/security.md` had named the choice
as "JWT or session cookies" and left it open, and the environment schema
carried an unused `AUTH_JWT_SECRET` from Phase 1.

Three options were realistic:

1. **Stateless JWT** — a signed token holding user claims, verified in-process.
2. **Opaque server-side session** — an unguessable random token naming a row in
   a `sessions` table.
3. **Both** — JWT access tokens with a refresh-token table.

The system's shape matters here. The dashboard renders on the **server**, the
API and the web app are separate processes, and this is a single API instance
with a PostgreSQL database it already talks to on nearly every request.

## Decision

**Opaque server-side sessions**, stored in PostgreSQL, delivered as an httpOnly
cookie.

- The token is 32 bytes of CSPRNG output, base64url-encoded. It carries no
  claims and means nothing outside the `sessions` table.
- Only the **SHA-256 of the token** is stored. The raw value exists in the
  user's cookie and nowhere on the server.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` (production config refuses
  to disable it), `Path=/`.
- `AUTH_JWT_SECRET` is **removed** from the environment schema.

The shared `AUTH_API_KEY` survives as a **machine** credential for CI and
scripting. It authenticates a process, not a person, so it owns nothing and
user-scoped routes reject it outright.

## Rationale

**Revocation is the whole argument.** A signed JWT is valid until it expires;
there is no way to withdraw one without keeping server-side state — at which
point the statelessness that justified it is gone. BinaryAI needs revocation to
take effect immediately in three ordinary situations: signing out, an admin
disabling an account, and a password change after a suspected compromise. All
three are one `UPDATE` here and take effect on the next request.

**The cost JWTs avoid is a cost we were already paying.** The argument for
stateless tokens is skipping a database round trip. This API talks to
PostgreSQL on nearly every request already, and a session lookup is one probe
on a unique index over a 64-character digest. Saving that lookup buys nothing
measurable while giving up revocation.

**No token means no token-handling bugs.** There is no payload to decode, no
algorithm negotiation, no `alg: none` confusion, no key rotation, and no
temptation to put a stale copy of the user's role inside the credential. Claims
in a token are a snapshot; a session reads the user row as it is now.

**Hashing the token is not paranoia.** It costs one SHA-256 and means a leaked
database dump contains no usable sessions — the same reasoning that makes
storing password hashes obvious. Plain SHA-256 (not Argon2) is correct here
because the input is already 256 bits of uniform randomness: there is nothing to
brute-force, so a slow KDF would only add latency.

**Storing the raw token in a cookie instead of a response body** keeps it out of
JavaScript's reach, out of `localStorage`, and out of any client that logs
responses. An XSS bug then cannot exfiltrate the session.

## Consequences

**Good**

- Sign-out, suspension and password change are effective immediately.
- Active sessions are enumerable, so "your devices" and "sign out everywhere"
  are simple reads and writes rather than new infrastructure.
- A database leak yields no live sessions.
- One credential format to reason about.

**Bad, and accepted**

- **Every authenticated request reads the database.** With no database the API
  cannot authenticate a user at all; it falls back to the machine token, and
  `/v1/auth/*` returns 503 with the reason.
- **This does not scale horizontally for free.** Many API instances would share
  one PostgreSQL and add load to it. At that point the answer is a cache in
  front of the session lookup, not a JWT.
- **Sessions accumulate.** Revoked rows are kept for the audit trail;
  `deleteExpired` exists and is not yet scheduled (see below).
- **Cookies constrain deployment.** The API and dashboard must share a
  registrable domain, and cookies are keyed by host — which is why
  `NEXT_PUBLIC_API_URL` must use the same hostname the dashboard is served from,
  not `127.0.0.1` against a `localhost` dashboard.

## Not done

- **No session-pruning worker.** `SessionRepository.deleteExpired` is
  implemented and tested but nothing calls it on a schedule. Expired sessions
  are already refused at resolution time, so this is housekeeping, not a
  correctness gap.
- **No refresh/idle-timeout distinction.** A session has one absolute lifetime
  (`AUTH_SESSION_TTL_HOURS`, default 7 days) and an activity stamp that is not
  yet used to expire idle sessions early.
- **No multi-factor authentication, password reset, or email verification.**
  Each needs an email transport, which this build does not have.

## Revisit when

- A second API instance is deployed and session lookups become measurable — add
  a cache, and only then reconsider token formats.
- A third-party client needs delegated access, which is an OAuth problem, not a
  session problem.
- Sessions must survive a database outage, which would be a decision to accept
  unrevocable credentials in exchange for availability.
