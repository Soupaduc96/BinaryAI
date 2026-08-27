# ADR-0014 — Versioned paper simulation models

- **Status:** accepted
- **Date:** 2026-08-26
- **Supersedes:** the per-account payout assumption introduced alongside migration `0007`
- **Related:** [ADR-0004 demo-only execution](0004-demo-only-execution.md),
  [ADR-0012 calibration methodology](0012-calibration-methodology.md),
  [ADR-0013 paper accounts and risk enforcement](0013-paper-accounts-and-risk-enforcement.md)

## Why a simulation model exists at all

BinaryAI has no broker. It therefore has no settlement terms, no counterparty
and no basis on which to say what a position "earned". Phase 5 concluded from
this that the honest accounting model was **exposure only**: units are committed
when a position opens and released in full when it settles, so a win and a loss
move the balance identically. That is defensible, and it remains the accounting
of record.

It is also unsatisfying in a specific way. A user evaluating whether a signal
stream is worth following wants to know what a run of outcomes would amount to,
and "the balance did not move" answers a different question than the one being
asked.

The resolution is not to invent a payout. It is to **state a rule, name it,
version it, and report what that rule computes**. That converts the claim from

> this strategy earned 4 units — a claim BinaryAI cannot support

into

> under BinaryAI Demo Return v1.0.0, which returns 80% of exposure on a correct
> call, these outcomes compute to +4 units

which is arithmetic on a declared premise, and is defensible precisely because
the premise travels with the number.

## Why the model belongs to the server

An earlier iteration of this phase let the account holder `PATCH` their own
payout rate onto their account. It was rejected, and the reasoning is worth
recording because the earlier design looked more honest, not less: the rate was
explicitly the _user's_ assumption, so BinaryAI asserted nothing.

The problems are structural:

1. **Every figure was only as trustworthy as the last request body.** A number
   on the account screen could be changed by anyone with the session, and
   nothing recorded that it had been.
2. **Two accounts were not comparable.** Different rates produced different
   figures with no record of why they differed.
3. **The client authored the accounting model.** That is the same category of
   mistake as trusting a client-supplied price.

So models are now **defined by the server, published by migration, and reviewed
in version control** alongside the constraints that bound them. A user selects
among them. A user cannot describe one. The selection endpoint accepts an id and
nothing else, and `.strict()` on the schema means a body smuggling a
`simulatedReturnRate` is _rejected_ rather than silently ignored — a client that
believes it set a rate is told plainly that it did not.

## The three things that must stay apart

```
exchange market data     what the market did            a fact
observed outcome         whether the call was right     a fact
simulated return         what a stated model computes   arithmetic on a premise
```

The first two are recorded from exchange candles and never rewritten. The third
is derived, and is stored in its own ledger entry type so that a reader can
always recover what happened from what was assumed.

Notably, **a simulated return is never a broker settlement**, and the schema
comment on `ledger_entry_type` says so, because a type name is the thing a
future maintainer reads first.

## Model structure

A model is `(model_key, version)` — stable identity plus semver — carrying:

| Parameter             | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `startingUnits`       | Simulated account value before anything settles                |
| `simulatedReturnRate` | Fraction of exposure returned as gain on a correct call        |
| `lossRule`            | `forfeit_exposure` or `partial_refund`                         |
| `lossRefundRate`      | Fraction returned on an incorrect call, under `partial_refund` |
| `tieRule`             | `refund_exposure` or `treat_as_loss`                           |
| `roundingDecimals`    | Scale the result is rounded to                                 |
| `settlementRule`      | How the settling price is chosen, recorded for the reader      |

The name `simulatedReturnRate` is deliberate. It is not `payoutRate`,
`brokerPayout` or `expectedProfit`: nothing pays out, and no counterparty
exists. The UI labels it a **simulation parameter** wherever it appears.

Every parameter that materially affects a figure is in this list, enforced by a
database `CHECK`. A model missing its tie rule cannot be published, because the
application would then settle ties by whatever it happened to default to — an
assumption hidden in code rather than stated in the catalogue.

### Bounds

`simulatedReturnRate` is capped at 5 (500%) in the database `CHECK` **and** in
`validateParameters`. Two layers agree on purpose: a bound enforced in one place
is a bound some future endpoint forgets, and the failure is silent — nothing
breaks, the account screen simply starts reporting impressive numbers.

## Versioning and immutability

A published model is immutable. A trigger refuses `UPDATE` of its parameters and
`DELETE` of the row; only `status` may advance (`draft` → `active` →
`deprecated`).

This matters more than it first appears. Ledger entries are stamped with the
model id **and** the version string. If a published model's arithmetic could be
edited, every entry stamped with it would silently change meaning while the
entries themselves remained untouched — an audit trail that lies without ever
being modified. Versioning only helps if versions are fixed points.

Deprecation stops new **selection**, not settlement. A position opened under a
model must be able to settle under it; refusing would strand it unsettled
forever. `findById` therefore resolves deprecated models, while `listSelectable`
does not return them.

## Deterministic settlement

`applySimulationModel` is pure. Everything affecting the result arrives as an
argument, so the same `(model version, observed outcome, exposure)` always
produces the same number. Results are rounded to the model's stated scale, so a
stored value and a recomputed one cannot disagree by a floating-point artefact,
and `-0` is normalised to `0` — it compares equal but formats as `"-0"`, which
reads as a negative figure that is not negative.

Idempotency is guaranteed by the database, not by application care: the unique
index on `(position_id, type)` means a position carries at most one
`simulated_return` however many times settlement is retried. Verified live: three
settlement cycles over the same position produced exactly one entry.

## Tie treatment

A tie is a third outcome and stays one. The model must state its treatment
explicitly; there is no default. Under `refund_exposure` the simulated delta is
exactly zero — and that zero is _computed_, which is not the same as the absence
of a figure. `SimulationResult.applied` distinguishes them, and a caller reading
only `delta` would record a pending position as settled.

No `simulated_return` entry is written for a zero delta: there is nothing to
record, and the position's own `result` already carries that it tied.

## Unresolved outcomes

An expired position whose settling candle is missing or still forming stays
`pending_settlement`. It is **never** counted as a loss, never assigned a value,
and is surfaced in its own `unresolved` field in the account summary rather than
folded into any other tally. Substituting a later candle would change what was
measured; marking it a loss would invent an outcome the market never produced.

## Accounting rules

Exposure accounting is untouched by the simulation. Committing 5 units always
releases 5 units, whatever the outcome. The simulated return is a **separate
ledger entry**, which is what lets a reader recover the facts from the
arithmetic. Both are append-only, enforced by a trigger.

Simulated account value is derived, never stored:

```
currentUnits = model.startingUnits + Σ(simulated_return amounts, in occurrence order)
```

The order is fixed by the query so that floating-point association cannot make
the same history total differently on two reads.

Superseded `simulated_payout` entries are **excluded** from this sum. They were
produced by the client-supplied rate this ADR replaces, and totalling both
regimes would yield a number belonging to neither. They remain readable through
the ledger listing, preserved as history.

## Auditability

Every simulated figure traces to: account → position → observed outcome → model
→ version → ledger entry. A `CHECK` constraint makes this structural rather than
aspirational:

```sql
(type = 'simulated_return' AND simulation_model_id IS NOT NULL
                           AND simulation_model_version IS NOT NULL)
OR (type <> 'simulated_return' AND simulation_model_id IS NULL
                               AND simulation_model_version IS NULL)
```

There is no way to write an unattributable simulated number, including from a
future code path that forgets to try. The version string is stored denormalised
beside the foreign key so the trail survives even a catastrophic mistake in the
catalogue.

## Calibration separation

Calibration measures **signal confidence against observed directional outcome**
and nothing else. It never reads a simulated figure, and no payout or simulated
value is written to `signal_outcomes`. Verified live and in tests: zero outcome
rows carry a payout after a settled, simulated position.

The calibration model remains `implemented: false` per ADR-0012. Nothing in this
phase changes that, and a simulated return is not evidence about calibration.

## Risk separation

A simulation model is **not a risk override**. Paper actions still pass account
ownership, account status, position size, open-position limits, exposure limits,
regime restrictions and the live-execution refusal. Verified live: with a model
active, an oversized action was still refused by `max_position_size`.

## Security boundaries

- The catalogue is read-only to the application. There is no create or update
  method on the repository and none on any route, so "a client cannot author the
  accounting model" holds structurally rather than by convention.
- Selection is validated against the **selectable** set, not merely against
  existence, so a draft or deprecated model cannot be chosen.
- Account-scoped reads resolve ownership through the existing mechanism. A
  foreign position returns 404, identically to one that does not exist — the
  distinction would confirm another user's position exists.
- A rejected selection does not distinguish "no such model" from "not
  selectable"; a caller probing ids learns only that it was refused.

## Limitations

- **The rate is a demonstration parameter, not a market observation.** `demo_return`
  returns 80% because that is a plausible illustrative figure, not because any
  broker quotes it. Nothing here is calibrated against real instruments.
- **A simulated figure is not a prediction and not a track record.** It states
  what a rule computes over outcomes that have already happened.
- **No fees, slippage, spread or execution risk are modelled.** Real trading has
  all four, so a simulated figure is optimistic relative to any real analogue.
- **Sample sizes are small.** A handful of settled positions supports no
  conclusion about a strategy, whatever the simulated value says.
- **PostgreSQL 16 CI has not run.** All verification is against PGlite, in-process
  for tests and over the TCP bridge for the live sequence. See ADR-0007.
