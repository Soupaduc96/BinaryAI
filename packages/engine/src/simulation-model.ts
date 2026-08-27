import type {
  SignalOutcome,
  SimulationModel,
  SimulationParameters,
  SimulationResult,
} from '@binaryai/types';

/**
 * Applying a versioned simulation model to a settled paper position.
 *
 * Pure and deterministic by construction: everything that affects the result
 * arrives as an argument, and the same (model version, outcome, exposure)
 * always produces the same number. That is what makes a settlement retry safe
 * to run and a stored figure safe to re-derive years later.
 *
 * This module replaces the per-account payout assumption shipped earlier, in
 * which the account holder PATCHed their own rate. That let the client author
 * the accounting model — the one thing a simulation producing money-shaped
 * numbers must never permit. Models are now server-defined; a user selects,
 * never invents.
 *
 * See docs/adr/0014-simulation-model.md.
 */

/**
 * Upper bound on a stated return rate.
 *
 * Enforced here AND by a database CHECK. A bound kept in one place is a bound
 * some future endpoint forgets, and the failure is silent: nothing breaks, the
 * account screen just starts reporting impressive numbers.
 */
export const MAX_SIMULATED_RETURN_RATE = 5;

/** No model in force. Distinct from a model that computes zero. */
export const NO_SIMULATION: SimulationResult = {
  delta: 0,
  applied: false,
  modelId: null,
  modelKey: null,
  modelVersion: null,
  reason: 'No simulation model is selected, so no simulated value is derived from outcomes.',
  result: null,
};

export interface ParameterValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Checks a model's parameters before it is published.
 *
 * Fails closed. An incoherent model is refused rather than repaired, because
 * silently correcting a parameter would leave the catalogue describing rules
 * that are not the rules actually in force.
 */
export function validateParameters(parameters: SimulationParameters): ParameterValidation {
  const problems: string[] = [];
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

  const { startingUnits, simulatedReturnRate, lossRefundRate, roundingDecimals } = parameters;

  // `-0` is excluded deliberately: it compares equal to 0 but formats as "-0",
  // which surfaces in the UI as a negative figure that is not negative.
  if (!finite(startingUnits) || startingUnits < 0 || Object.is(startingUnits, -0)) {
    problems.push('startingUnits must be a finite number of zero or more.');
  }
  if (!finite(simulatedReturnRate) || simulatedReturnRate < 0) {
    problems.push('simulatedReturnRate must be a finite number of zero or more.');
  } else if (simulatedReturnRate > MAX_SIMULATED_RETURN_RATE) {
    problems.push(`simulatedReturnRate exceeds the maximum of ${MAX_SIMULATED_RETURN_RATE}.`);
  }
  if (!finite(lossRefundRate) || lossRefundRate < 0 || lossRefundRate > 1) {
    problems.push('lossRefundRate must be between 0 and 1: more than the exposure cannot return.');
  }
  if (
    !finite(roundingDecimals) ||
    !Number.isInteger(roundingDecimals) ||
    roundingDecimals < 0 ||
    roundingDecimals > 8
  ) {
    problems.push('roundingDecimals must be a whole number between 0 and 8.');
  }
  if (parameters.lossRule !== 'forfeit_exposure' && parameters.lossRule !== 'partial_refund') {
    problems.push('lossRule must be "forfeit_exposure" or "partial_refund".');
  }
  if (parameters.tieRule !== 'refund_exposure' && parameters.tieRule !== 'treat_as_loss') {
    problems.push('tieRule must be "refund_exposure" or "treat_as_loss".');
  }
  // A refund rate under a rule that ignores refunds is not dangerous, but it
  // is a lie about what the model does, and the catalogue is meant to be read.
  if (parameters.lossRule === 'forfeit_exposure' && finite(lossRefundRate) && lossRefundRate > 0) {
    problems.push('lossRefundRate must be 0 when lossRule is "forfeit_exposure".');
  }
  if (parameters.lossRule === 'partial_refund' && finite(lossRefundRate) && lossRefundRate === 0) {
    problems.push('lossRule "partial_refund" needs a lossRefundRate above zero.');
  }
  if (typeof parameters.settlementRule !== 'string' || parameters.settlementRule.length === 0) {
    problems.push('settlementRule must be stated.');
  }
  return { ok: problems.length === 0, problems };
}

/** The sentence that must accompany any figure this model produces. */
export function describeModel(model: SimulationModel): string {
  const rate = Math.round(model.parameters.simulatedReturnRate * 100);
  const loss =
    model.parameters.lossRule === 'partial_refund'
      ? `${Math.round(model.parameters.lossRefundRate * 100)}% of exposure returns on an incorrect call`
      : 'an incorrect call forfeits the exposure';
  const tie =
    model.parameters.tieRule === 'refund_exposure'
      ? 'an exact tie returns the exposure'
      : 'an exact tie is treated as an incorrect call';
  return (
    `Simulated under ${model.name} v${model.version}: a correct call returns ${rate}% of ` +
    `exposure, ${loss}, and ${tie}. This is a stated simulation model, not broker terms, ` +
    'and no order was placed.'
  );
}

/**
 * What a settled position is worth under a model.
 *
 * Returns a signed delta ON TOP of the exposure release. The release is
 * unchanged and unconditional — committing 5 units always returns 5 units,
 * whatever happened — so this delta is purely the simulated result. Keeping
 * them separate is what lets a reader recover what actually occurred from what
 * was assumed.
 *
 *   win    +exposure × simulatedReturnRate
 *   loss   −exposure × (1 − lossRefundRate)
 *   tie     0 under refund_exposure, −exposure under treat_as_loss
 *
 * An `unresolved` outcome produces NOTHING and is reported as such. It has not
 * settled; assigning it a value would turn a pending position into a realised
 * result, and assigning it zero would be indistinguishable from a refunded tie.
 */
export function applySimulationModel(input: {
  readonly model: SimulationModel | null;
  readonly exposure: number;
  readonly result: SignalOutcome['result'];
}): SimulationResult {
  const { model, exposure, result } = input;

  if (!model) return NO_SIMULATION;

  const attributed = {
    modelId: model.id,
    modelKey: model.modelKey,
    modelVersion: model.version,
  };

  if (model.status === 'draft') {
    return {
      ...NO_SIMULATION,
      ...attributed,
      result,
      reason: `${model.name} v${model.version} is a draft and is not applied to real settlements.`,
    };
  }
  if (!Number.isFinite(exposure) || exposure <= 0) {
    return {
      ...NO_SIMULATION,
      ...attributed,
      result,
      reason: 'The position has no positive exposure, so the model has nothing to apply to.',
    };
  }
  if (result === 'unresolved') {
    return {
      ...NO_SIMULATION,
      ...attributed,
      result,
      reason:
        'The outcome is unresolved, so no simulated value exists. This is not a loss and not a zero result.',
    };
  }
  const check = validateParameters(model.parameters);
  if (!check.ok) {
    // Refuse rather than guess. A model that cannot be trusted to compute must
    // not produce a number that looks exactly like one that can.
    return {
      ...NO_SIMULATION,
      ...attributed,
      result,
      reason: `${model.name} v${model.version} has incoherent parameters and was not applied: ${check.problems.join(' ')}`,
    };
  }

  const { simulatedReturnRate, lossRefundRate, lossRule, tieRule, roundingDecimals } =
    model.parameters;

  const raw =
    result === 'win'
      ? exposure * simulatedReturnRate
      : result === 'loss'
        ? -(exposure * (1 - (lossRule === 'partial_refund' ? lossRefundRate : 0)))
        : tieRule === 'refund_exposure'
          ? 0
          : -exposure;

  // Rounded to the model's stated scale so a stored value and a recomputed one
  // can never disagree by a float artefact. `+ 0` normalises -0 to 0.
  const delta = Number(raw.toFixed(roundingDecimals)) + 0;

  return {
    delta,
    applied: true,
    ...attributed,
    reason: describeModel(model),
    result,
  };
}

/**
 * Simulated account value from a starting point and its settled deltas.
 *
 * Summation order is fixed by the caller (the ledger returns entries in
 * occurrence order) so that floating-point association cannot make the same
 * history total differently on two reads.
 */
export function simulatedValue(startingUnits: number, deltas: readonly number[]): number {
  const total = deltas.reduce((sum, delta) => sum + delta, startingUnits);
  return Number(total.toFixed(8)) + 0;
}

/**
 * Return as a fraction of starting units.
 *
 * Null when there is nothing to compare against. A percentage of zero is not
 * infinity and not zero — it is undefined, and reporting it as a number would
 * be the sort of fabricated precision this project refuses.
 */
export function returnFraction(startingUnits: number, currentUnits: number): number | null {
  if (!Number.isFinite(startingUnits) || startingUnits <= 0) return null;
  if (!Number.isFinite(currentUnits)) return null;
  return Number(((currentUnits - startingUnits) / startingUnits).toFixed(6)) + 0;
}
