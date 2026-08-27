/**
 * @binaryai/strategies -- independent, pure strategy modules plus the registry
 * that makes them pluggable.
 *
 * Adding a strategy: implement the `Strategy` contract from @binaryai/types,
 * export it here, and add it to `createDefaultRegistry`. Nothing in the engine,
 * API or UI needs to change.
 */

import type { Strategy } from '@binaryai/types';
import { createStrategyRegistry, type StrategyRegistry } from './registry.js';
import { meanReversionStrategy } from './mean-reversion.js';
import { trendMomentumStrategy } from './trend-momentum.js';

export {
  createStrategyRegistry,
  StrategyNotFoundError,
  type StrategyRegistry,
} from './registry.js';
export {
  resolveParameters,
  numberParam,
  integerParam,
  StrategyParameterError,
} from './parameters.js';
export { toSeriesView, lastCandle, type SeriesView } from './series.js';
export { abstain, confirmation, conflict, snapshot } from './evidence.js';
export { trendMomentumStrategy } from './trend-momentum.js';
export { meanReversionStrategy } from './mean-reversion.js';

export const builtInStrategies: readonly Strategy[] = [
  trendMomentumStrategy,
  meanReversionStrategy,
];

export function createDefaultRegistry(): StrategyRegistry {
  return createStrategyRegistry(builtInStrategies);
}
