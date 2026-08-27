import type {
  StrategyParameters,
  StrategyParameterSpec,
  StrategyParameterValue,
} from '@binaryai/types';

export class StrategyParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategyParameterError';
  }
}

/**
 * Merge caller-supplied parameters over a strategy's declared defaults,
 * validating types and ranges. Unknown keys are rejected rather than ignored:
 * a typo in a parameter name would otherwise silently run the default and make
 * a backtest result meaningless.
 */
export function resolveParameters(
  specs: readonly StrategyParameterSpec[],
  provided: StrategyParameters = {},
): StrategyParameters {
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));

  for (const key of Object.keys(provided)) {
    if (!byKey.has(key)) {
      throw new StrategyParameterError(
        `unknown parameter "${key}" (expected one of: ${specs.map((s) => s.key).join(', ')})`,
      );
    }
  }

  const resolved: Record<string, StrategyParameterValue> = {};
  for (const spec of specs) {
    const raw = provided[spec.key];
    resolved[spec.key] = raw === undefined ? spec.defaultValue : validate(spec, raw);
  }
  return resolved;
}

function validate(
  spec: StrategyParameterSpec,
  value: StrategyParameterValue,
): StrategyParameterValue {
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new StrategyParameterError(`parameter "${spec.key}" must be a finite number`);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new StrategyParameterError(`parameter "${spec.key}" must be >= ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new StrategyParameterError(`parameter "${spec.key}" must be <= ${spec.max}`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new StrategyParameterError(`parameter "${spec.key}" must be a boolean`);
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.options?.includes(value)) {
        throw new StrategyParameterError(
          `parameter "${spec.key}" must be one of: ${(spec.options ?? []).join(', ')}`,
        );
      }
      return value;
    }
  }
}

/** Read a validated numeric parameter. Throws if the key was never declared. */
export function numberParam(parameters: StrategyParameters, key: string): number {
  const value = parameters[key];
  if (typeof value !== 'number') {
    throw new StrategyParameterError(`parameter "${key}" is missing or not a number`);
  }
  return value;
}

export function integerParam(parameters: StrategyParameters, key: string): number {
  const value = numberParam(parameters, key);
  if (!Number.isInteger(value)) {
    throw new StrategyParameterError(`parameter "${key}" must be an integer`);
  }
  return value;
}
