# Paper accounts, risk enforcement and positions

What a user's account can do, what the backend refuses, and what BinaryAI
deliberately does not account for.

The reasoning behind every decision here is in
[ADR-0013](adr/0013-paper-accounts-and-risk-enforcement.md).

## What a paper position is, and is not

A paper position records that a user **chose to act** on a signal. It is:

- an accounting object, and
- a record of a decision.

It is **not** an order. Nothing is transmitted anywhere, there is no broker, no
order id, no fill, and no counterparty. BinaryAI holds no money for anyone.

Every payload carrying position or unit data states this, and every module in
the dashboard is labelled `SIMULATED`.

## The flow

```
system signal          one analysis, one signal, account_id = NULL
      │
      ▼
account risk policy    per account, versioned, stored on `accounts`
      │
      ▼
evaluateAccountAction  pure; no database, no clock, no HTTP
      │
      ├── refused ──▶  risk_event written, NO position created
      │
      ▼ allowed
paper position         + exposure_committed ledger entry, one transaction
      │
      ▼
settlement worker      close of the last bar ending at or before expiry
      │
      ▼
settled position       + exposure_released ledger entry
```

A signal is never duplicated per account. One analysis may be acted on by many
accounts; each action is its own row.

## Accounting: exposure, and optionally a simulated value

Two separate things are accounted for, and keeping them separate is the whole
design:

|                     | What it is                                            | Moves on an outcome?  |
| ------------------- | ----------------------------------------------------- | --------------------- |
| **Exposure**        | Units committed against open positions                | No — released in full |
| **Simulated value** | What a stated model computes the outcomes to be worth | Yes                   |

### Exposure: no profit and loss

**Exposure records no profit and loss.** A binary option's settlement is
entirely broker-defined, BinaryAI has no broker, and inventing a rate would
fabricate the most consequential number in the product.

| Event              | Entry                | Amount     |
| ------------------ | -------------------- | ---------- |
| account created    | `initial_allocation` | +100 units |
| position opened    | `exposure_committed` | −size      |
| position settled   | `exposure_released`  | +size      |
| position cancelled | `exposure_released`  | +size      |

A win and a loss release **exactly the same amount**. The outcome is recorded on
the position and moves no exposure.

`availableUnits = allocatedUnits − committedUnits` measures **capacity**, not
performance. Units are not currency, carry no symbol, and convert to nothing.

The balance is **derived** by summing ledger entries, never stored. A stored
balance can drift from the entries that produced it, and when it does there is
no way to tell which is wrong.

### Simulated value: a stated model, or nothing

An account may select a **server-defined, versioned simulation model**. When one
is selected, settling a position also writes a `simulated_return` entry stamped
with the model id and version that produced it:

| Event                          | Entry              | Amount                |
| ------------------------------ | ------------------ | --------------------- |
| position settled, model active | `simulated_return` | signed, per the model |

```
simulated value = model.startingUnits + Σ(simulated_return amounts)
```

With **no model selected**, every simulated figure is `null` — not zero. "This
account has no simulation" and "this account has simulated zero units" are
different statements, and the dashboard renders them differently.

A user **selects** among published models and cannot describe one: the selection
endpoint accepts an id and nothing else, and rejects a body carrying its own
rate rather than ignoring it. See
[ADR-0014](adr/0014-simulation-model.md) for why the model belongs to the server
and what the versioning guarantees.

A `simulated_return` is **not a broker settlement** and not a prediction. It is
arithmetic on a declared premise, and the premise travels with every figure the
API returns.

The ledger is **append-only, enforced by a database trigger**: `UPDATE` and
`DELETE` are refused outright, so an audit trail cannot be quietly rewritten.

An account with no allocation reports `accountingModel: 'not_configured'`
rather than a zero balance — "not set up" and "nothing left" are different
states, and the dashboard says so rather than showing a zero.

## The risk policy

Stored on `accounts`, versioned, and stamped on every decision made under it.

| Field                      | Default | Meaning                                    |
| -------------------------- | ------- | ------------------------------------------ |
| `maxOpenPositions`         | 1       | concurrent open positions                  |
| `maxPositionSize`          | 10      | largest single action, in units            |
| `maxDailyExposure`         | 50      | units committed within the rolling window  |
| `maxConsecutiveLosses`     | 3       | streak that halts new actions              |
| `cooldownSecondsAfterLoss` | 300     | quiet period after a settled loss          |
| `minConfidence`            | 0.6     | signal-level floor                         |
| `allowLiveExecution`       | false   | **cannot be set**; refused from every path |

Plus three allowlists: `allowedStrategies`, `allowedTimeframes`,
`allowedAssets`.

### Allowlist semantics

- **`null`** — unset. The dimension is not restricted.
- **`[]`** — allow none. Every action on that dimension is blocked.

These are **not** interchangeable. An operator who cleared a list expressed
"nothing"; reading that as "everything" would invert the restriction. New
accounts default to `null`, because an account that could act on nothing would
look broken rather than safe.

### The exposure window

A **rolling 24 hours** ending at the moment of evaluation — not a calendar day.
A calendar day needs a timezone, and the user's, the server's and the exchange's
all differ; any choice silently moves when the limit resets, and lets the limit
be gamed by acting just before midnight.

Cancelled and rejected positions do not count toward it. Open, pending and
settled positions do.

### Loss streaks

- A **loss** extends the streak.
- A **tie breaks it.** A tie is not a loss, and treating it as one would trigger
  a halt the user did not earn.
- An **unresolved** position affects it not at all.
- The streak is counted from the newest settled positions backwards, stopping at
  the first non-loss.

## Position lifecycle

| Status               | Meaning                                         |
| -------------------- | ----------------------------------------------- |
| `open`               | created, before expiry                          |
| `pending_settlement` | past expiry, settlement bar not yet available   |
| `settled`            | resolved against the expiry bar                 |
| `cancelled`          | withdrawn by the owner before expiry            |
| `rejected`           | terminal; **never produced by the create path** |

`pending_settlement` is named rather than folded into `open` because the two
mean different things: an open position may still change, one past expiry cannot
and is only waiting for data.

A blocked risk decision writes a **risk event and no position**. `rejected`
exists so a future reversal has somewhere terminal to land rather than
overloading `cancelled`.

Two CHECK constraints hold the states honest:

- a `settled` row must carry `settled_at`, `settlement_price` and `result`;
- an unsettled row must carry **none** of them — which is what stops an open
  position from ever being displayed as a loss.

## Idempotency

Every action carries a caller-supplied `actionKey`. A unique index on
`(account_id, signal_id, action_key)` is the authority — a check-then-insert
would leave a window in which two concurrent requests both pass.

A repeated key returns the **existing** position with `duplicate: true` and HTTP
**200** (not 201): nothing was created.

The idempotency check runs **before** risk evaluation. A retry of an action that
already succeeded must not be refused by the open-position limit that its own
earlier success created.

## Concurrency

Position creation runs inside one transaction holding `SELECT … FOR UPDATE` on
the account row. Two concurrent requests for the same account serialize there,
so the second one's count includes the first one's position.

> **Not verified locally.** PGlite accepts one connection, so two genuinely
> simultaneous transactions cannot be run. The unique index and the lock's
> sequential behaviour (including full rollback on failure) are tested; a real
> race needs the `postgres:16` CI job, which has never run because no git remote
> is configured.

## Endpoints

All require a session. A shared machine token is refused: it has no user behind
it and therefore cannot own an account.

| Method | Path                                            | Notes                               |
| ------ | ----------------------------------------------- | ----------------------------------- |
| GET    | `/v1/accounts/:id`                              | account + derived paper state       |
| GET    | `/v1/accounts/:id/risk`                         | the policy in force                 |
| PATCH  | `/v1/accounts/:id/risk`                         | strict schema; bumps the version    |
| POST   | `/v1/accounts/:id/risk/evaluate`                | dry run; creates nothing            |
| GET    | `/v1/accounts/:id/positions`                    | scoped listing                      |
| POST   | `/v1/accounts/:id/positions`                    | idempotent; 201 new / 200 duplicate |
| GET    | `/v1/accounts/:id/positions/:positionId`        | 404 if not yours                    |
| POST   | `/v1/accounts/:id/positions/:positionId/cancel` | open positions only                 |
| GET    | `/v1/accounts/:id/ledger`                       | append-only entries + derived state |
| GET    | `/v1/accounts/:id/risk-events`                  | audit trail                         |

`:id` may be `me`, which resolves from the session — the safest request is one
that cannot name the wrong account.

### Error semantics

| Status | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| 401    | no session                                                      |
| 403    | authenticated, but not a user (machine token)                   |
| 404    | not available to you — **or** does not exist, indistinguishably |
| 409    | not cancellable                                                 |
| 422    | risk refused the action; the full decision is in the body       |
| 429    | cooldown; carries `retry-after`                                 |

A foreign account returns **404, not 403**. A 403 would confirm the id exists
and turn the endpoint into an account-enumeration oracle.

## What a refusal tells you

Every decision reports every rule it evaluated — not just the first failure —
with the observed value, the configured limit and the window:

```json
{
  "outcome": "limit_reached",
  "blockedBy": ["max_open_positions"],
  "policyVersion": 2,
  "evaluations": [
    { "code": "max_open_positions", "passed": false, "observed": 2, "limit": 2, ... }
  ]
}
```

"Blocked" alone tells a user nothing. "2 open, limit 2" tells them exactly what
changed and what would clear it.

## Calibration separation

A paper position **never becomes a calibration sample**. The signal outcome is
the canonical analysis observation, and there is exactly one per signal however
many accounts acted on it. Structurally this holds because
`calibration_eligibility` reads `signals` and `signal_outcomes` only —
`paper_positions` is not in the view at all.

## What is not implemented

- **No profit-and-loss accounting.** Deliberate; see above.
- **No multiple accounts per user.** One default account, as Phase 3 established.
  The routes verify ownership rather than assuming it, so adding more is a
  matter of selection semantics, not authorization.
- **No position editing.** A position can be opened or cancelled, nothing else.
- **No `rejected` positions in practice.** The state exists; the create path
  never writes it.
- **No admin reversal or adjustment endpoint.** `adjustment` and `reset` ledger
  types exist and are constrained, but nothing writes them.
- **Per-account risk limits do not affect the runtime worker.** The worker
  produces system signals, which belong to no account by design.
