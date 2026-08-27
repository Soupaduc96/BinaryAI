import type {
  StoredStrategy,
  StrategyMetadata,
  StrategyParameterSpec,
  StrategyRepository,
} from '@binaryai/types';
import { DatabaseError, type Row, type SqlExecutor } from '../executor.js';
import { fromJson, toEpochMs, toJsonParam, toText } from '../mappers.js';

interface StrategyRow extends Row {
  id: string;
  strategy_key: string;
  version: string;
  name: string;
  description: string;
  parameters: unknown;
  registered_at: Date;
}

const SELECT =
  'SELECT id, strategy_key, version, name, description, parameters, registered_at FROM strategies';

function toStoredStrategy(row: StrategyRow): StoredStrategy {
  return {
    id: toText(row.id, 'strategy.id'),
    strategyKey: toText(row.strategy_key, 'strategy.strategy_key'),
    version: toText(row.version, 'strategy.version'),
    name: toText(row.name, 'strategy.name'),
    description: toText(row.description, 'strategy.description'),
    parameters: fromJson<StrategyParameterSpec[]>(row.parameters, []),
    createdAt: toEpochMs(row.registered_at, 'strategy.registered_at'),
  };
}

/**
 * Strategy version registry.
 *
 * Keyed on (strategy_key, version) so a signal decided by v1.0.0 stays
 * attributable after v1.1.0 ships. Re-registering the same version updates the
 * descriptive fields but keeps the row id, which existing signals reference.
 */
export function createStrategyRepository(executor: SqlExecutor): StrategyRepository {
  return {
    async register(
      meta: StrategyMetadata,
      parameters: readonly StrategyParameterSpec[],
    ): Promise<StoredStrategy> {
      const result = await executor.query<StrategyRow>(
        `INSERT INTO strategies (strategy_key, version, name, description, parameters)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (strategy_key, version) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           parameters = EXCLUDED.parameters
         RETURNING id, strategy_key, version, name, description, parameters, registered_at`,
        [meta.id, meta.version, meta.name, meta.description, toJsonParam(parameters)],
      );
      const row = result.rows[0];
      if (!row) throw new DatabaseError(`strategy ${meta.id}@${meta.version} was not registered`);
      return toStoredStrategy(row);
    },

    async find(strategyKey: string, version: string): Promise<StoredStrategy | null> {
      const result = await executor.query<StrategyRow>(
        `${SELECT} WHERE strategy_key = $1 AND version = $2`,
        [strategyKey, version],
      );
      const row = result.rows[0];
      return row ? toStoredStrategy(row) : null;
    },

    async list(): Promise<readonly StoredStrategy[]> {
      const result = await executor.query<StrategyRow>(`${SELECT} ORDER BY strategy_key, version`);
      return result.rows.map(toStoredStrategy);
    },
  };
}
