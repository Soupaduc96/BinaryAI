# Authentication and per-user scoping

How BinaryAI knows who is asking, and what that decides they may see.

Two decisions shape everything here and are argued in full elsewhere:
[ADR-0010](adr/0010-opaque-server-sessions.md) (opaque server-side sessions, not
JWTs) and [ADR-0011](adr/0011-ownership-model.md) (shared analysis stream,
private account data).

## The path a request takes

```
  credential            principal              scope              data
  ──────────            ─────────              ─────              ────
  session cookie  ──┐
  Bearer token    ──┼──▶  user | service  ──▶  AccessScope  ──▶  WHERE account_id …
  nothing         ──┘        | anonymous
```

Every request carries a principal and a scope — an unauthenticated one gets the
anonymous principal and the shared-data scope, never `undefined`. Routes
therefore never ask _whether_ the caller is authenticated; they ask what this
caller may see, and there is always an answer.

Hook order in `apps/api/src/plugins/` is load-bearing:

1. **rate limit** (`security.ts`) — a flood is rejected before it reaches an
   Argon2 hash.
2. **resolve** (`auth.ts`) — who is this? Never rejects.
3. **CSRF** (`auth.ts`) — is a cookie-authenticated write from our own origin?
4. **guard** (`auth.ts`) — is this identity allowed on this route?

Resolving before guarding is what lets the guard give an accurate reason, and
lets public routes still know who is calling them.

## Principals

| Kind        | Comes from            | Owns    | Sees                        |
| ----------- | --------------------- | ------- | --------------------------- |
| `user`      | session cookie        | account | shared stream + own account |
| `service`   | `AUTH_API_KEY` bearer | nothing | shared stream only          |
| `anonymous` | no valid credential   | nothing | shared stream only          |

The service token authenticates a **machine**, not a person. It exists for CI
and self-hosted scripting. Because it has no user behind it, user-scoped
endpoints reject it with `403 user_required` rather than falling back to some
default account — which would hand a shared token another user's data.

## Sessions

A session token is 32 bytes of CSPRNG output, base64url-encoded, delivered as a
cookie and **never** in a response body. Only its SHA-256 is stored.

| Cookie attribute | Value                    | Why                                               |
| ---------------- | ------------------------ | ------------------------------------------------- |
| `HttpOnly`       | yes                      | JavaScript cannot read it, so XSS cannot steal it |
| `SameSite`       | `Lax`                    | primary CSRF defence                              |
| `Secure`         | yes (prod-enforced)      | never sent over plain HTTP                        |
| `Path`           | `/`                      | presented to every API route                      |
| `Max-Age`        | `AUTH_SESSION_TTL_HOURS` | matches the stored session's expiry               |

Resolution rules live in one pure function, `resolveSession`, so every caller
applies the same ones:

| State                       | Result          |
| --------------------------- | --------------- |
| no such token               | `not_found`     |
| `revoked_at` set            | `revoked`       |
| `expires_at <= now`         | `expired`       |
| user missing or deactivated | `user_inactive` |

Revocation is checked before expiry, so a session revoked after it lapsed is
still reported as revoked. A deactivated user's sessions stop working
immediately without a sweep.

The activity stamp is rewritten at most once every 5 minutes, so an active
session does not turn every read into a write.

## Passwords

Argon2id at OWASP parameters (m=19456 KiB, t=2, p=1, salted per hash). The
parameters live inside every digest, so raising them later does not invalidate
existing passwords — `needsRehash` detects the old ones and login upgrades them
transparently, at the one moment the plaintext is legitimately available.

Policy is length-first, per current NIST guidance:

- at least 12 characters, at most 200 (an unbounded password is a DoS vector)
- below 16 characters, at least three of: lowercase, uppercase, digits, symbols
- must not contain the local part of the email address
- rejected if it appears in a small built-in list of breach-corpus staples

The list is deliberately small and is **not** a substitute for a real
breach-corpus check; it catches the obvious cases without an outbound network
call during registration.

## Registration

Open signup is **off** by default. The single exception is the first account on
an empty instance, which is permitted so a fresh deployment is reachable without
hand-editing the database — and which becomes the administrator. That window
closes automatically as soon as any user exists.

```
AUTH_ALLOW_REGISTRATION=false   AUTH_BOOTSTRAP_ADMIN=true   (defaults)
  → first account:  allowed, role=admin
  → every account after: 403 registration_closed
```

Registration creates the user, their default demo account, and an audit event in
one transaction. A user without an account would own nothing and could never be
attributed a signal.

## Resisting enumeration

An attacker must not be able to learn which email addresses have accounts.

- **Login** returns the identical status, code and message for an unknown
  address and a wrong password. An unknown address is verified against a decoy
  Argon2 digest so both paths cost the same time. Measured: ~0.24 s either way;
  without the decoy an unknown address returns in ~2 ms.
- **Account disabled** is checked _after_ the password, so the state is only
  revealed to someone who already proved they own the account.
- **A record you may not read returns 404, not 403.** A 403 would confirm the id
  exists.
- **Registration is the deliberate exception.** It cannot hide that an address
  is taken without silently doing nothing, which is worse for the legitimate
  user. The tight per-IP limit on that endpoint is what stops it becoming a bulk
  oracle.

## Throttling

Two independent limits, because either alone is insufficient:

| Limit           | Scope    | Default    | Stops                           |
| --------------- | -------- | ---------- | ------------------------------- |
| credential rate | per IP   | 10/minute  | one host guessing rapidly       |
| account lockout | per user | 5 failures | many hosts guessing one account |

The lockout escalates (1 min, 2, 4, 8) and is capped at 15 minutes. The cap is
deliberate: a permanent lock would let anyone who knows an email address deny
its owner access indefinitely. One correct login clears the history.

## Scope

`AccessScope` is a value, not a convention:

```ts
{ kind: 'system' }                                            // unowned rows only
{ kind: 'account', accountId: string, includeSystem: boolean } // one account (+ shared)
{ kind: 'all' }                                                // no filter
```

It is a **required** parameter on ownership-sensitive queries, so forgetting to
filter is a type error rather than a silent leak. `scopeForPrincipal` derives it
from the principal; `allScope()` is the explicit escalation, and an admin does
**not** get it implicitly — a broad read is always visible at the call site.

Two implementations must agree: `scopeCondition` builds the SQL `WHERE`
fragment for list queries, and `visibleUnder` performs the same check on a
single fetched row. If they ever disagree, a record becomes reachable by id that
never appears in a list — the classic IDOR bug.

## Endpoints

| Method | Path                           | Auth     | Notes                            |
| ------ | ------------------------------ | -------- | -------------------------------- |
| GET    | `/v1/auth/context`             | public   | what a sign-in screen asks first |
| POST   | `/v1/auth/register`            | public   | gated by registration/bootstrap  |
| POST   | `/v1/auth/login`               | public   | uniform failure                  |
| POST   | `/v1/auth/logout`              | any      | always clears the cookie         |
| GET    | `/v1/auth/me`                  | **user** | identity + default account       |
| GET    | `/v1/auth/sessions`            | **user** | active sessions, current marked  |
| POST   | `/v1/auth/sessions/revoke-all` | **user** | sign out everywhere              |
| POST   | `/v1/auth/password`            | **user** | revokes every session on success |

"**user**" rejects the shared machine token.

## Running it locally

Sessions need a database. Without one, `/v1/auth/*` returns `503` with the
reason, and the machine token still works.

```bash
# A PostgreSQL-protocol endpoint with no server installed (dev only).
npm run dev:db

# In another shell:
DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm run db:migrate

DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres \
AUTH_ENABLED=true AUTH_COOKIE_SECURE=false \
DATABASE_MAX_CONNECTIONS=1 \
npm run dev:api
```

`DATABASE_MAX_CONNECTIONS=1` is required against `dev:db` specifically: the
PGlite socket bridge accepts one connection, and the default pool of 10 produces
`ECONNRESET` under the dashboard's parallel fetches. This is a limitation of the
development convenience, not of the API — see
[ADR-0007](adr/0007-two-engine-database-testing.md).

Point the dashboard at the **same hostname** it is served from
(`http://localhost:4000`, not `127.0.0.1`). Cookies are keyed by host and ignore
the port, so a mismatch stores the session somewhere the dashboard can never
read it and sign-in silently does nothing.

## What is not implemented

Stated plainly, because listing only what works is misleading.

- **No password reset, email verification or MFA.** All need an email transport.
- **No admin user-management endpoints.** Roles exist and are enforced; there is
  no route to create, disable or promote a user. Bootstrap plus direct SQL is
  the current path.
- **No account deletion.** Which is fortunate, because `signals.account_id` is
  `ON DELETE SET NULL` — deleting an account today would promote its private
  signals to the shared stream. This must be resolved before deletion is added.
- **Per-account risk limits are stored but not enforced.** The column
  round-trips; the risk engine still reads global defaults.
- **No scheduled session pruning.** Expired sessions are refused at resolution
  time; nothing calls `deleteExpired` periodically.
- **Sign-in and sign-out are not written to `system_events`.** Registration is.
