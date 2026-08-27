import { describe, expect, it } from 'vitest';
import type { Strategy, StrategyContext, StrategyEvaluation } from '@binaryai/types';
import { createStrategyRegistry, StrategyNotFoundError } from './registry.js';
import { resolveParameters, StrategyParameterError } from './parameters.js';
import { trendMomentumStrategy } from './trend-momentum.js';
import { meanReversionStrategy } from './mean-reversion.js';

function stubStrategy(id: string, version = '1.0.0'): Strategy {
  return {
    meta: {
      id,
      name: id,
      version,
      description: 'stub',
      requiredHistory: 1,
      supportedTimeframes: 'any',
      tags: [],
    },
    parameters: [],
    evaluate(_context: StrategyContext): StrategyEvaluation {
      return {
        strategyId: id,
        strategyVersion: version,
        direction: 'none',
        indicators: [],
        confirmations: [],
        conflicts: [],
        regimeHint: 'unknown',
        expirationSeconds: 60,
        notes: [],
      };
    },
  };
}

describe('strategy registry', () => {
  it('registers and retrieves strategies by id', () => {
    const registry = createStrategyRegistry([stubStrategy('alpha')]);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.get('alpha').meta.id).toBe('alpha');
  });

  it('throws a typed error for an unknown id', () => {
    const registry = createStrategyRegistry();
    expect(() => registry.get('missing')).toThrow(StrategyNotFoundError);
  });

  it('refuses to shadow a registered id with a different version', () => {
    const registry = createStrategyRegistry([stubStrategy('alpha', '1.0.0')]);
    expect(() => registry.register(stubStrategy('alpha', '2.0.0'))).toThrow(/already registered/);
  });

  it('accepts new strategies without any change to existing ones', () => {
    const registry = createStrategyRegistry([trendMomentumStrategy]);
    registry.register(meanReversionStrategy);
    registry.register(stubStrategy('custom'));
    expect(registry.list()).toHaveLength(3);
    expect(registry.describe().map((meta) => meta.id)).toContain('custom');
  });
});

describe('resolveParameters', () => {
  const specs = trendMomentumStrategy.parameters;

  it('fills every declared default', () => {
    const resolved = resolveParameters(specs, {});
    expect(resolved['emaFastPeriod']).toBe(9);
    expect(resolved['emaSlowPeriod']).toBe(21);
    expect(Object.keys(resolved)).toHaveLength(specs.length);
  });

  it('applies overrides', () => {
    expect(resolveParameters(specs, { emaFastPeriod: 5 })['emaFastPeriod']).toBe(5);
  });

  it('rejects an unknown parameter instead of ignoring it', () => {
    expect(() => resolveParameters(specs, { emaFastPeroid: 5 })).toThrow(StrategyParameterError);
  });

  it('enforces declared bounds', () => {
    expect(() => resolveParameters(specs, { emaFastPeriod: 1 })).toThrow(/must be >= 2/);
    expect(() => resolveParameters(specs, { emaFastPeriod: 10_000 })).toThrow(/must be <= 200/);
  });

  it('enforces declared types', () => {
    expect(() => resolveParameters(specs, { emaFastPeriod: 'nine' })).toThrow(/finite number/);
  });
});
