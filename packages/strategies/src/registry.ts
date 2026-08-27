import type { Strategy, StrategyMetadata } from '@binaryai/types';

export class StrategyNotFoundError extends Error {
  constructor(id: string) {
    super(`strategy "${id}" is not registered`);
    this.name = 'StrategyNotFoundError';
  }
}

/**
 * The extension point for section 10: new strategies are added by registering
 * a module, not by editing the engine, the API or the UI.
 */
export interface StrategyRegistry {
  register(strategy: Strategy): void;
  get(id: string): Strategy;
  has(id: string): boolean;
  list(): readonly Strategy[];
  describe(): readonly StrategyMetadata[];
}

export function createStrategyRegistry(initial: readonly Strategy[] = []): StrategyRegistry {
  const strategies = new Map<string, Strategy>();

  const registry: StrategyRegistry = {
    register(strategy: Strategy): void {
      const { id } = strategy.meta;
      const existing = strategies.get(id);
      if (existing && existing.meta.version !== strategy.meta.version) {
        throw new Error(
          `strategy "${id}" is already registered at version ${existing.meta.version}; ` +
            'change the id rather than shadowing a version that historical signals reference',
        );
      }
      strategies.set(id, strategy);
    },
    get(id: string): Strategy {
      const strategy = strategies.get(id);
      if (!strategy) throw new StrategyNotFoundError(id);
      return strategy;
    },
    has: (id: string): boolean => strategies.has(id),
    list: (): readonly Strategy[] => [...strategies.values()],
    describe: (): readonly StrategyMetadata[] => [...strategies.values()].map((s) => s.meta),
  };

  for (const strategy of initial) registry.register(strategy);
  return registry;
}
