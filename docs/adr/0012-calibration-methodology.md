# ADR-0012 — Bucketed frequency measurement, not probabilistic calibration

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Phase 4 had to turn accumulated settled outcomes into something that answers
"was the confidence score any good?" — without turning the score into a claim it
cannot support.

The engine's confidence is a **rule-based heuristic**. It combines indicator
agreement, regime fit and data quality into a number in [0, 1]. Nothing in its
construction makes 0.80 mean "wins 80% of the time". It has shipped labelled
`uncalibrated_heuristic` since Phase 1 precisely so this stays visible
([ADR-0003](0003-uncalibrated-confidence.md)).

The obvious calibration metrics all assume otherwise:

- **Brier score** is the mean squared error of a forecast _probability_.
- **Expected Calibration Error** compares a forecast _probability_ against an
  observed frequency.
- **Log loss** is undefined for a score that is not a probability.

Each of these computes cleanly over a heuristic score. None of them errors. They
simply return a number that looks exactly like a real calibration metric while
answering a question nobody asked. That is the failure mode this decision exists
to avoid.

## Decision

**Bucketed frequency measurement** (`bucketed_frequency`, v1.0.0).

1. Partition eligible settled outcomes into five fixed confidence bands.
2. Within each band, report **observed accuracy** = wins / (wins + losses).
3. The **primary** measure is _rank-based_: does observed accuracy rise as
   confidence rises? Reported as `monotonic_increasing`,
   `monotonic_decreasing`, `non_monotonic` or `not_established`.
4. A **secondary** diagnostic, `divergence`, is the sample-weighted mean gap
   between a band's mean confidence and its observed accuracy. Structurally this
   is ECE. It is never named a calibration error, and it ships with the
   statement that reading it as one would require the score to be a probability.
5. `implemented` stays **false**. It answers "does a validated calibration MODEL
   exist?" — and none does.

Everything is versioned: method, sample definition, bucket boundaries and
confidence source travel on every report.

## Rationale

**A rank-based question is meaningful for any ordered score.** "Do
higher-confidence signals win more often?" needs no probabilistic
interpretation. It is the question a user actually has, and it can be answered
honestly today. Whether the score is _well-calibrated_ cannot be, because the
score is not a probability estimate in the first place.

**Bucket boundaries were fixed before any data was examined.** Five equal bands
over [0, 1]. They are not claimed to be statistically optimal, and that is the
point: choosing boundaries after seeing outcomes is how a flat relationship gets
shaped into a convincing curve. Re-cutting them is allowed and requires bumping
`BUCKET_VERSION`, so old figures keep their own boundaries.

**Flat is reported as `not_established`, not as monotonic.** Identical accuracy
in every band satisfies both a non-decreasing and a non-increasing test. Calling
that "increasing" would be a false positive of exactly the kind this metric
exists to prevent — so it is explicitly reported as no relationship.

**A rate below the minimum sample size is withheld entirely.** Three wins from
four signals is 75%, and displaying it beside a figure backed by 4,000
observations implies a comparability that does not exist. The count is still
shown, so the interface can say "4 settled, below minimum" rather than implying
nothing happened.

**Zero is never substituted for unknown.** Every rate is `number | null`, and
null survives all the way to the pixel. Zero wins from zero settled signals is
not 0% accuracy; it is no evidence. This single distinction is what most of the
type design in `@binaryai/analytics` exists to protect.

**Eligibility is explicit and auditable.** `calibration_eligibility` attaches a
verdict to every settled signal rather than filtering silently. "260 eligible, 3
excluded — 2 not accepted, 1 not settled" is a statement that can be checked;
"260 samples" is not.

## The minimum-sample thresholds

`ANALYTICS_MIN_SAMPLES` defaults to **30**, with evidence tiers at 30 / 100 / 500. These are reporting conventions, not the output of a power analysis, and
claiming otherwise would be the same false precision this ADR rejects. The
reasoning:

| Samples | 95% interval (≈) | Tier          |
| ------- | ---------------- | ------------- |
| < 30    | ±18 pts or worse | insufficient  |
| 30      | ±18 pts          | preliminary   |
| 100     | ±10 pts          | developing    |
| 500     | ±4.5 pts         | established   |
| 2,000   | ±2 pts           | model-capable |

Below 30, a single flipped result moves the rate by more than three points, so
no rate is published at all.

## What this measures, and what it does not

**Measures**

- How often directionally-correct predictions occurred, per confidence band,
  strategy, regime, timeframe and asset.
- Whether observed accuracy ordered with confidence over the samples collected.
- How much evidence stands behind each figure.

**Does not measure**

- **Profitability.** No payout model is applied. A directional result is not a
  return, and BinaryAI has no broker terms to convert one into the other.
- **Predictive validity.** Every figure is a description of past observations.
  Nothing here establishes that the score predicts future accuracy.
- **Causation.** "Accuracy was higher in trend_up" is an observation about
  co-occurrence, not a claim that the regime caused it.
- **Statistical significance.** No hypothesis test is performed. A rising
  sequence is reported as rising without any claim it is distinguishable from
  noise.

## Consequences

**Good**

- Nothing computed here requires the confidence score to be something it is not.
- Every figure carries its methodology version, so changing the method later
  cannot silently rewrite how a historical number should be read.
- The measurement infrastructure a real calibration model would need — eligible
  samples, temporal splitting, versioned methodology — exists now, so the model
  becomes a modelling problem rather than a plumbing problem.

**Bad, and accepted**

- **The primary metric is coarse.** Monotonic / non-monotonic over five bands is
  a weak instrument. It will not detect a subtle relationship, and it is not
  meant to.
- **`divergence` invites misreading** despite its label. It is published because
  withholding a computable diagnostic is its own form of dishonesty, but the
  name and the accompanying sentence are load-bearing and must not be softened.
- **No confidence intervals.** The evidence tier is a proxy for uncertainty,
  which is cruder than an interval. Intervals are the obvious next addition.
- **Ties are excluded from the denominator.** Defensible — the direction was
  neither right nor wrong — but it means accuracy is conditional on a decisive
  settlement, and a market that ties often would make the rate less
  representative than the sample count suggests.

## What would make `implemented` true

All of the following, not any one:

1. At least 2,000 eligible settled samples (`CALIBRATION_MODEL_MINIMUM_SAMPLES`).
2. A fitted mapping from heuristic score to observed frequency — isotonic
   regression or Platt scaling being the conventional choices.
3. **Walk-forward validation**: fitted on a training period, evaluated on a
   later period it never saw. `splitAt` exists for this and splits by time,
   never at random — a random hold-out lets the model learn from outcomes that
   occurred after the ones it is tested on, which cannot happen in production.
4. A demonstrated confidence/accuracy relationship in the evaluation period, not
   only in the training period.
5. A new `calibration_kind` on the signal, so a calibrated score is
   distinguishable from a heuristic one at the row level.

Sample volume alone must never set this flag, and no code path allows it to.

## Revisit when

- Eligible samples pass 2,000 and a model becomes fittable — at which point this
  ADR is superseded rather than edited.
- The bands prove too coarse to show a relationship that finer ones would, which
  is a `BUCKET_VERSION` bump and a documented re-cut.
- Confidence intervals replace evidence tiers as the uncertainty signal.
