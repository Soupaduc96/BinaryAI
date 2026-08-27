import { settlementCandleStart } from '@binaryai/runtime';
import type {
  AccountPaperPosition,
  PositionDetail,
  PositionQuery,
  Repositories,
} from '@binaryai/types';

/**
 * Positions with their settlement bar and simulated attribution resolved.
 *
 * Resolved on the server for two reasons, both about agreement rather than
 * convenience:
 *
 *  - **The settlement bar is computed by the worker's own rule.** A UI that
 *    derived its own bar could disagree with the one that actually settled the
 *    position, and the disagreement would be invisible.
 *  - **A simulated figure never travels without its model.** The version is
 *    read from the LEDGER ENTRY rather than from the model row, because the
 *    two are equal today and must not be assumed equal tomorrow.
 */
export async function resolvePositionDetails(
  repositories: Repositories,
  accountId: string,
  query?: PositionQuery,
): Promise<readonly (AccountPaperPosition & PositionDetail)[]> {
  const positions = await repositories.positions.list(accountId, query);
  if (positions.length === 0) return [];

  // One ledger read for the whole page rather than one per position.
  const entries = await repositories.ledger.list(accountId, 500);
  const simulated = new Map(
    entries
      .filter((entry) => entry.type === 'simulated_return' && entry.positionId !== null)
      .map((entry) => [entry.positionId as string, entry]),
  );

  // Models resolved once per distinct id, including deprecated ones: a position
  // settled under a model that was later withdrawn must still be explainable.
  const modelIds = new Set(
    [...simulated.values()]
      .map((entry) => entry.simulationModelId)
      .filter((id): id is string => id !== null),
  );
  const models = new Map(
    await Promise.all(
      [...modelIds].map(
        async (id) => [id, await repositories.simulationModels.findById(id)] as const,
      ),
    ),
  );

  return positions.map((position) => {
    const entry = simulated.get(position.id);
    const model = entry?.simulationModelId ? models.get(entry.simulationModelId) : null;
    return {
      ...position,
      settlementCandleAt: settlementCandleStart(position.expiresAt, position.timeframe),
      simulation:
        entry && model
          ? {
              delta: entry.amount,
              modelKey: model.modelKey,
              modelVersion: entry.simulationModelVersion ?? model.version,
              modelName: model.name,
            }
          : null,
    };
  });
}
