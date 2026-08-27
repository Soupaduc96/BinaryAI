import type { SignalOutcome } from './signal.js';

/**
 * Versioned paper simulation models.
 *
 * BinaryAI has no broker, so it has no settlement terms and cannot say what a
 * position "earned". What it CAN do is state a rule, name it, version it, and
 * report what that rule computes — which is arithmetic on a declared premise
 * rather than a claim about money.
 *
 * The distinction this module exists to preserve:
 *
 *     exchange market data   what the market did          (a fact)
 *     observed outcome       whether the call was right   (a fact)
 *     simulated return       what a named model computes  (arithmetic)
 *
 * Models are defined by the SERVER and selected by the user. A client cannot
 * supply its own rate: that would make every figure only as trustworthy as
 * whatever the caller last typed, and would make two accounts' results
 * incomparable with no record of why they differ.
 *
 * See docs/adr/0014-simulation-model.md.
 */

/** What happens to the exposure when a call is wrong. */
export type SimulationLossRule = 'forfeit_exposure' | 'partial_refund';

/**
 * What happens on an exact tie.
 *
 * Explicit because a tie is a real third outcome. A model that does not say
 * how it treats one would have the application decide, which is exactly the
 * hidden assumption this type exists to prevent.
 */
export type SimulationTieRule = 'refund_exposure' | 'treat_as_loss';

export type SimulationModelStatus = 'draft' | 'active' | 'deprecated';

/**
 * Every assumption that materially affects a simulated figure.
 *
 * If a number cannot be reproduced from these parameters plus the observed
 * outcome and the exposure, then some assumption is hidden in code, and the
 * model is not auditable.
 */
export interface SimulationParameters {
  /** Simulated account value before any position settles. */
  readonly startingUnits: number;
  /**
   * Fraction of exposure returned as gain on a correct call. 0.8 = +80%.
   *
   * Named `simulatedReturnRate` and never `payoutRate`: nothing pays out. This
   * is the rate of a named model, and the UI is required to label it as a
   * simulation parameter wherever it appears.
   */
  readonly simulatedReturnRate: number;
  readonly lossRule: SimulationLossRule;
  /** Fraction of exposure returned on a wrong call. Only meaningful under `partial_refund`. */
  readonly lossRefundRate: number;
  readonly tieRule: SimulationTieRule;
  /** Decimal places the result is rounded to, so stored and recomputed values agree exactly. */
  readonly roundingDecimals: number;
  /** How the settling price is chosen. Recorded, never applied by this module. */
  readonly settlementRule: string;
}

/** A published, immutable model version. */
export interface SimulationModel {
  readonly id: string;
  /** Stable across versions, e.g. 'demo_return'. */
  readonly modelKey: string;
  /** Semver. Stamped on every ledger entry the model produces. */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: SimulationParameters;
  readonly status: SimulationModelStatus;
  readonly effectiveAt: number;
  readonly createdAt: number;
}

/**
 * The outcome of applying a model to one settled position.
 *
 * `applied: false` with `delta: 0` is NOT the same as a model computing zero.
 * The first means no simulation ran; the second means one ran and returned
 * nothing. `reason` says which, and callers must not collapse them.
 */
export interface SimulationResult {
  /** Signed units, on top of the unconditional exposure release. */
  readonly delta: number;
  readonly applied: boolean;
  /** Null only when no model was in force. */
  readonly modelId: string | null;
  readonly modelKey: string | null;
  readonly modelVersion: string | null;
  /** Plain-language statement of what produced this figure, or why none was. */
  readonly reason: string;
  /** The observed outcome the model was applied to. */
  readonly result: SignalOutcome['result'] | null;
}

/**
 * An account's simulated standing under its selected model.
 *
 * Every field is null when no model is selected. There is no zero-valued
 * fallback: "this account has no simulation" and "this account has simulated
 * zero units" are different statements and the UI renders them differently.
 */
export interface AccountSimulationSummary {
  readonly enabled: boolean;
  readonly model: SimulationModel | null;
  readonly startingUnits: number | null;
  /** startingUnits plus the sum of every simulated_return entry. */
  readonly currentUnits: number | null;
  readonly simulatedReturn: number | null;
  /**
   * Return as a fraction of starting units. Null when startingUnits is zero,
   * because a percentage of nothing is not a number.
   */
  readonly returnFraction: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** Settled positions that produced a simulated entry. */
  readonly simulatedPositions: number;
  /** Expired positions with no usable settling candle. Never counted as losses. */
  readonly unresolved: number;
  /** The sentence that must accompany any figure above. */
  readonly disclosure: string;
}

/**
 * A position with everything needed to explain it, resolved server-side.
 *
 * `settlementCandleAt` is computed with the SAME rule the settlement worker
 * applies, rather than re-derived in the client. A UI that computed its own
 * settlement bar could disagree with the one that actually settled the
 * position, and the disagreement would be invisible.
 */
export interface PositionDetail {
  readonly settlementCandleAt: number | null;
  /** Null when no model produced a figure for this position. */
  readonly simulation: {
    readonly delta: number;
    readonly modelKey: string;
    readonly modelVersion: string;
    readonly modelName: string;
  } | null;
}

/** One position's simulated result, for the position-detail surface. */
export interface PositionSimulation {
  readonly positionId: string;
  readonly exposure: number;
  readonly observedOutcome: SignalOutcome['result'] | null;
  readonly delta: number | null;
  readonly modelKey: string | null;
  readonly modelVersion: string | null;
  readonly modelName: string | null;
  readonly occurredAt: number | null;
}
