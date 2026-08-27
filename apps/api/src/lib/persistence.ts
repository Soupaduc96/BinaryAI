import type { AppConfig } from '@binaryai/config';
import {
  createPersistenceLayer,
  createPostgresDatabase,
  describeDatabaseConfig,
} from '@binaryai/database';
import type {
  MarketAsset,
  PersistenceLayer,
  Signal,
  Strategy,
  StoredSignalRef,
} from '@binaryai/types';

/**
 * Persistence wiring for the API.
 *
 * The database is OPTIONAL. With no DATABASE_URL the API runs exactly as it did
 * in Phase 1 -- stateless, analysis on request. Persistence is additive, and
 * every route that uses it degrades to a stated reason rather than an error.
 */

export function createPersistenceFromConfig(config: AppConfig): PersistenceLayer | null {
  if (!config.database.configured || !config.database.url) return null;

  const database = createPostgresDatabase({
    url: config.database.url,
    ssl: config.database.ssl,
    maxConnections: config.database.maxConnections,
    applicationName: 'binaryai-api',
  });
  return createPersistenceLayer(database);
}

export function describePersistence(config: AppConfig): Record<string, unknown> | null {
  if (!config.database.configured || !config.database.url) return null;
  // Every field the pool is actually built with. Describing a default the pool
  // does not use would put a wrong number in the startup banner.
  return describeDatabaseConfig({
    url: config.database.url,
    ssl: config.database.ssl,
    maxConnections: config.database.maxConnections,
  });
}

export interface PersistSignalResult {
  readonly stored: StoredSignalRef;
  readonly strategyRowId: string;
}

/**
 * Writes a signal, its evidence, its asset and its strategy version in ONE
 * transaction. Half a signal -- rows with no strategy attribution, or an asset
 * that exists only because a signal referenced it -- is worse than none.
 *
 * The signal's `dataSource` travels with it, so a signal analysed from
 * synthetic candles is stored as synthetic and can never be read back as
 * live-provider data.
 *
 * `ownerAccountId` decides who the signal belongs to. Null means a SYSTEM
 * signal -- the shared analysis stream every user reads. A value means the
 * signal was produced for one account and is private to it. See
 * docs/adr/0011-ownership-model.md.
 */
export async function persistSignal(
  persistence: PersistenceLayer,
  signal: Signal,
  strategy: Strategy,
  asset: MarketAsset,
  ownerAccountId: string | null = null,
): Promise<PersistSignalResult> {
  return persistence.repositories.transaction(async (repositories) => {
    await repositories.assets.upsert(asset);
    const stored = await repositories.strategies.register(strategy.meta, strategy.parameters);
    const ref = await repositories.signals.save(signal, {
      strategyRowId: stored.id,
      accountId: ownerAccountId,
    });

    await repositories.systemEvents.record({
      level: 'info',
      category: 'signal',
      code: 'signal_persisted',
      message: `Stored ${signal.direction} signal for ${signal.asset} (${signal.dataSource} data)`,
      executionMode: signal.executionMode,
      context: {
        signalId: signal.id,
        dataSource: signal.dataSource,
        confidence: signal.confidence.score,
        calibration: signal.confidence.calibration,
        accountId: ownerAccountId,
      },
    });

    return { stored: ref, strategyRowId: stored.id };
  });
}
