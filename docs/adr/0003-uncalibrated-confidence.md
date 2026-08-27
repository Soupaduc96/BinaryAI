# ADR-0003 — Confidence ships labelled uncalibrated

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Signal tools display a confidence percentage. Users read it as a win
probability — "87%" is naturally understood as "87 out of 100 of these win".

In almost every such tool, that reading is false. The number is a weighted sum
of indicator agreement, never validated against outcomes. It is a measure of
_how much the indicators agree_, which is not the same quantity as _how often
this wins_, and can differ from it wildly.

BinaryAI computes such a score: six weighted components producing 0–1. The
question was how to present it.

Options:

1. Show it as a percentage, like everyone else.
2. Hide it until calibrated.
3. Show it with a required, machine-readable calibration status.

## Decision

Option 3. `ConfidenceResult` carries:

```ts
calibration: 'uncalibrated_heuristic' | 'backtest_calibrated' | 'model_calibrated';
sampleSize: number | null;
disclaimer: string;
```

Today every result is `uncalibrated_heuristic` with `sampleSize: null`. The
fields are **required**, so a signal cannot exist without its calibration
status, and rendering the score without the label is a product bug.

## Rationale

**Against option 1.** It is misleading in a domain where being misled costs
money. Under an 80% payout, break-even is a ~55.6% win rate; a user who believes
an uncalibrated 0.87 is a probability will size positions on a number that
measures something else entirely.

**Against option 2.** The score is genuinely useful for _ranking_ — a 0.8 setup
has more supporting evidence than a 0.5 setup, and that is real information.
Hiding it discards signal to avoid a labelling problem.

**For option 3.** The number stays available for comparison while its status is
carried in the data rather than in a footnote someone can drop. Because
`calibration` is per-signal, the system can hold calibrated and uncalibrated
signals simultaneously — which is exactly what the transition period will look
like.

The score is also decomposed: six components, each with its score, weight,
contribution and a sentence. A user can see _why_ it is 0.74 rather than being
asked to trust it.

## Consequences

**Good.** No user is misled about what the number means. The path to a real
probability is defined and gated on data. `sampleSize` makes the evidence behind
any future calibration visible.

**Bad.** The product looks less impressive than competitors that print "94%
accuracy". That is the correct trade. The UI must carry an explanatory label
everywhere the score appears, which costs space.

**Neutral.** Calibration requires infrastructure that does not exist yet:
`signal_outcomes` storage, a few thousand settled signals, walk-forward
validation. Roadmap Phase 4.

## Revisit if

Enough settled outcomes exist to fit and validate a calibration curve. At that
point calibrated signals switch to `model_calibrated` with a real `sampleSize`,
and a reliability diagram is published alongside. Uncalibrated signals keep
their existing label — the field is per-signal precisely so history stays
honest.
