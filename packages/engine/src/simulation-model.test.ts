import { describe, expect, it } from 'vitest';
import type { SimulationModel, SimulationParameters } from '@binaryai/types';
import {
  MAX_SIMULATED_RETURN_RATE,
  NO_SIMULATION,
  applySimulationModel,
  describeModel,
  returnFraction,
  simulatedValue,
  validateParameters,
} from './simulation-model.js';

const PARAMS: SimulationParameters = {
  startingUnits: 1000,
  simulatedReturnRate: 0.8,
  lossRule: 'forfeit_exposure',
  lossRefundRate: 0,
  tieRule: 'refund_exposure',
  roundingDecimals: 8,
  settlementRule: 'close_of_last_bar_ending_at_or_before_expiry',
};

function model(overrides: Partial<SimulationModel> = {}): SimulationModel {
  return {
    id: 'model-1',
    modelKey: 'demo_return',
    version: '1.0.0',
    name: 'BinaryAI Demo Return',
    description: 'Illustrative fixed-return model.',
    parameters: PARAMS,
    status: 'active',
    effectiveAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

function withParams(overrides: Partial<SimulationParameters>): SimulationModel {
  return model({ parameters: { ...PARAMS, ...overrides } });
}

describe('applySimulationModel — outcomes', () => {
  it('returns the stated fraction of exposure on a win', () => {
    const result = applySimulationModel({ model: model(), exposure: 5, result: 'win' });
    expect(result.delta).toBe(4);
    expect(result.applied).toBe(true);
  });

  it('forfeits the exposure on a loss under forfeit_exposure', () => {
    expect(applySimulationModel({ model: model(), exposure: 5, result: 'loss' }).delta).toBe(-5);
  });

  it('returns part of the exposure on a loss under partial_refund', () => {
    const m = withParams({ lossRule: 'partial_refund', lossRefundRate: 0.1 });
    // 10% of 5 returns, so 4.5 is forfeited.
    expect(applySimulationModel({ model: m, exposure: 5, result: 'loss' }).delta).toBe(-4.5);
  });
});

describe('applySimulationModel — ties stay a third outcome', () => {
  it('returns exactly zero under refund_exposure, never a loss', () => {
    const result = applySimulationModel({ model: model(), exposure: 5, result: 'tie' });
    expect(result.delta).toBe(0);
    // The model DID run. This is a computed zero, not an absence.
    expect(result.applied).toBe(true);
    expect(result.result).toBe('tie');
  });

  it('forfeits the exposure under treat_as_loss', () => {
    const m = withParams({ tieRule: 'treat_as_loss' });
    expect(applySimulationModel({ model: m, exposure: 5, result: 'tie' }).delta).toBe(-5);
  });

  it('never silently picks a tie treatment: the two rules genuinely differ', () => {
    const refund = applySimulationModel({ model: model(), exposure: 5, result: 'tie' }).delta;
    const asLoss = applySimulationModel({
      model: withParams({ tieRule: 'treat_as_loss' }),
      exposure: 5,
      result: 'tie',
    }).delta;
    expect(refund).not.toBe(asLoss);
  });

  it('does not classify a tie as a win', () => {
    const tie = applySimulationModel({ model: model(), exposure: 5, result: 'tie' }).delta;
    const win = applySimulationModel({ model: model(), exposure: 5, result: 'win' }).delta;
    expect(tie).not.toBe(win);
  });
});

describe('applySimulationModel — unresolved produces nothing', () => {
  it('does not apply the model and says why', () => {
    const result = applySimulationModel({ model: model(), exposure: 5, result: 'unresolved' });
    expect(result.applied).toBe(false);
    expect(result.delta).toBe(0);
    expect(result.reason).toContain('unresolved');
  });

  it('is distinguishable from a refunded tie, which is also zero', () => {
    const unresolved = applySimulationModel({ model: model(), exposure: 5, result: 'unresolved' });
    const tie = applySimulationModel({ model: model(), exposure: 5, result: 'tie' });
    expect(unresolved.delta).toBe(tie.delta);
    // Same number, different meaning. `applied` is what separates them, and a
    // caller that reads only `delta` would record a pending position as settled.
    expect(unresolved.applied).toBe(false);
    expect(tie.applied).toBe(true);
  });

  it('is never reported as a loss', () => {
    const unresolved = applySimulationModel({ model: model(), exposure: 5, result: 'unresolved' });
    expect(unresolved.delta).not.toBeLessThan(0);
  });
});

describe('applySimulationModel — attribution', () => {
  it('stamps the model key and version on every applied result', () => {
    const result = applySimulationModel({ model: model(), exposure: 5, result: 'win' });
    expect(result.modelKey).toBe('demo_return');
    expect(result.modelVersion).toBe('1.0.0');
    expect(result.modelId).toBe('model-1');
  });

  it('still attributes a result it declined to apply', () => {
    // Otherwise "nothing happened" is indistinguishable from "no model exists".
    const result = applySimulationModel({ model: model(), exposure: 5, result: 'unresolved' });
    expect(result.modelVersion).toBe('1.0.0');
  });

  it('reports no attribution only when there is genuinely no model', () => {
    const result = applySimulationModel({ model: null, exposure: 5, result: 'win' });
    expect(result).toEqual(NO_SIMULATION);
    expect(result.modelKey).toBeNull();
  });

  it('carries the disclosure sentence with the figure', () => {
    const result = applySimulationModel({ model: model(), exposure: 5, result: 'win' });
    expect(result.reason).toContain('not broker terms');
  });
});

describe('applySimulationModel — determinism', () => {
  it('produces an identical result for identical inputs', () => {
    const once = applySimulationModel({ model: model(), exposure: 7.3, result: 'win' });
    const twice = applySimulationModel({ model: model(), exposure: 7.3, result: 'win' });
    expect(once).toEqual(twice);
  });

  it('is stable across many repetitions', () => {
    const deltas = new Set(
      Array.from(
        { length: 50 },
        () => applySimulationModel({ model: model(), exposure: 3.33, result: 'win' }).delta,
      ),
    );
    expect(deltas.size).toBe(1);
  });

  it('rounds to the model’s stated scale rather than leaving a float artefact', () => {
    const m = withParams({ simulatedReturnRate: 0.8, roundingDecimals: 2 });
    // 0.1 * 0.8 is 0.08000000000000002 in binary floating point.
    expect(applySimulationModel({ model: m, exposure: 0.1, result: 'win' }).delta).toBe(0.08);
  });

  it('never returns negative zero, which formats as "-0"', () => {
    const m = withParams({ lossRule: 'partial_refund', lossRefundRate: 1 });
    const delta = applySimulationModel({ model: m, exposure: 5, result: 'loss' }).delta;
    expect(Object.is(delta, -0)).toBe(false);
    expect(delta).toBe(0);
  });

  it('changing only the version changes the attribution, not the arithmetic', () => {
    const a = applySimulationModel({ model: model(), exposure: 5, result: 'win' });
    const b = applySimulationModel({
      model: model({ version: '2.0.0' }),
      exposure: 5,
      result: 'win',
    });
    expect(a.delta).toBe(b.delta);
    expect(a.modelVersion).not.toBe(b.modelVersion);
  });
});

describe('applySimulationModel — refusals', () => {
  it('does not apply a draft model', () => {
    const result = applySimulationModel({
      model: model({ status: 'draft' }),
      exposure: 5,
      result: 'win',
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('draft');
  });

  it('still applies a deprecated model, because positions opened under it must settle', () => {
    // Deprecating a model stops new SELECTION, not settlement of what it
    // already governs. Refusing here would strand open positions.
    const result = applySimulationModel({
      model: model({ status: 'deprecated' }),
      exposure: 5,
      result: 'win',
    });
    expect(result.applied).toBe(true);
  });

  it('refuses a model with incoherent parameters instead of guessing', () => {
    const result = applySimulationModel({
      model: withParams({ simulatedReturnRate: 99 }),
      exposure: 5,
      result: 'win',
    });
    expect(result.applied).toBe(false);
    expect(result.delta).toBe(0);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'declines to apply to a non-positive or non-finite exposure (%p)',
    (exposure) => {
      const result = applySimulationModel({ model: model(), exposure, result: 'win' });
      expect(result.applied).toBe(false);
      expect(result.delta).toBe(0);
    },
  );
});

describe('validateParameters', () => {
  it('accepts the demonstration parameters', () => {
    expect(validateParameters(PARAMS).ok).toBe(true);
  });

  it(`refuses a return rate above ${MAX_SIMULATED_RETURN_RATE}`, () => {
    const check = validateParameters({ ...PARAMS, simulatedReturnRate: 6 });
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('maximum');
  });

  it('refuses a loss refund above the exposure', () => {
    expect(validateParameters({ ...PARAMS, lossRefundRate: 1.5 }).ok).toBe(false);
  });

  it('refuses a refund rate under a rule that ignores refunds', () => {
    // Not dangerous, but the catalogue is meant to be read, and this would
    // describe behaviour the model does not have.
    const check = validateParameters({
      ...PARAMS,
      lossRule: 'forfeit_exposure',
      lossRefundRate: 0.2,
    });
    expect(check.ok).toBe(false);
  });

  it('refuses partial_refund with nothing to refund', () => {
    expect(
      validateParameters({ ...PARAMS, lossRule: 'partial_refund', lossRefundRate: 0 }).ok,
    ).toBe(false);
  });

  it.each([
    ['a non-integer rounding scale', { roundingDecimals: 2.5 }],
    ['a negative rounding scale', { roundingDecimals: -1 }],
    ['a rounding scale beyond the column scale', { roundingDecimals: 12 }],
    ['negative starting units', { startingUnits: -1 }],
    ['a non-finite return rate', { simulatedReturnRate: Number.NaN }],
    ['a missing settlement rule', { settlementRule: '' }],
  ])('refuses %s', (_label, overrides) => {
    expect(validateParameters({ ...PARAMS, ...overrides } as SimulationParameters).ok).toBe(false);
  });

  it.each([
    ['an unknown loss rule', 'lossRule'],
    ['an unknown tie rule', 'tieRule'],
  ])('refuses %s', (_label, field) => {
    const check = validateParameters({
      ...PARAMS,
      [field]: 'coin_flip',
    } as unknown as SimulationParameters);
    expect(check.ok).toBe(false);
  });

  it('reports every problem at once rather than the first', () => {
    const check = validateParameters({
      ...PARAMS,
      simulatedReturnRate: 99,
      roundingDecimals: 12,
    });
    expect(check.problems.length).toBeGreaterThan(1);
  });
});

describe('simulatedValue and returnFraction', () => {
  it('adds deltas to the starting units', () => {
    expect(simulatedValue(1000, [4, -5, 0, 4])).toBe(1003);
  });

  it('returns the starting units when nothing has settled', () => {
    expect(simulatedValue(1000, [])).toBe(1000);
  });

  it('does not accumulate a float artefact across many deltas', () => {
    expect(
      simulatedValue(
        0,
        Array.from({ length: 10 }, () => 0.1),
      ),
    ).toBe(1);
  });

  it('reports the return as a fraction of the starting units', () => {
    expect(returnFraction(1000, 1100)).toBe(0.1);
    expect(returnFraction(1000, 900)).toBe(-0.1);
  });

  it('returns null rather than a number when there is nothing to compare against', () => {
    // A percentage of zero is undefined, not zero and not infinity.
    expect(returnFraction(0, 50)).toBeNull();
    expect(returnFraction(-1, 50)).toBeNull();
  });
});

describe('describeModel', () => {
  it('names the model and version and denies broker terms', () => {
    const sentence = describeModel(model());
    expect(sentence).toContain('BinaryAI Demo Return v1.0.0');
    expect(sentence).toContain('not broker terms');
  });

  it('states the tie treatment explicitly', () => {
    expect(describeModel(model())).toContain('tie returns the exposure');
    expect(describeModel(withParams({ tieRule: 'treat_as_loss' }))).toContain(
      'tie is treated as an incorrect call',
    );
  });

  it('states the loss treatment explicitly', () => {
    expect(describeModel(model())).toContain('forfeits the exposure');
    expect(
      describeModel(withParams({ lossRule: 'partial_refund', lossRefundRate: 0.1 })),
    ).toContain('10% of exposure returns');
  });
});
