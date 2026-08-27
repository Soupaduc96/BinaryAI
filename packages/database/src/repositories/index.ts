import type { PersistenceLayer, Repositories } from '@binaryai/types';
import type { Database, SqlExecutor } from '../executor.js';
import { createAccountRepository } from './accounts.js';
import { createAnalyticsRepository } from './analytics.js';
import { createLedgerRepository } from './ledger.js';
import { createPaperPositionRepository } from './paper.js';
import { createAssetRepository } from './assets.js';
import { createBacktestRepository } from './backtests.js';
import { createCandleRepository } from './candles.js';
import { createRiskEventRepository, createSystemEventRepository } from './events.js';
import { createSignalOutcomeRepository } from './outcomes.js';
import { createSignalRepository } from './signals.js';
import { createSimulationModelRepository } from './simulation-models.js';
import { createStrategyRepository } from './strategies.js';
import { createSessionRepository } from './sessions.js';
import { createUserRepository } from './users.js';

type TransactionRunner = {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
} | null;

/**
 * Builds the repository bundle over one executor.
 *
 * `runner` is null when the executor is ALREADY inside a transaction. That is
 * what makes `repositories.transaction(...)` safe to nest: repositories that
 * would normally open their own transaction (signals, backtests) detect that
 * one is in progress and simply join it, rather than deadlocking on a second
 * connection or silently committing early.
 */
function build(executor: SqlExecutor, runner: TransactionRunner): Repositories {
  return {
    users: createUserRepository(executor),
    sessions: createSessionRepository(executor),
    accounts: createAccountRepository(executor),
    assets: createAssetRepository(executor),
    candles: createCandleRepository(executor),
    strategies: createStrategyRepository(executor),
    signals: createSignalRepository({ executor, runner }),
    outcomes: createSignalOutcomeRepository(executor),
    analytics: createAnalyticsRepository(executor),
    // Positions need to build a bundle over the LOCKED transaction, so they
    // receive the builder itself rather than a finished bundle -- otherwise the
    // work inside withAccountLock would run against the outer executor and
    // escape the lock entirely.
    positions: createPaperPositionRepository(executor, runner, (tx) => build(tx, null)),
    simulationModels: createSimulationModelRepository(executor),
    ledger: createLedgerRepository(executor),
    backtests: createBacktestRepository(executor, runner),
    systemEvents: createSystemEventRepository(executor),
    riskEvents: createRiskEventRepository(executor),

    async transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
      if (!runner) {
        // Already inside one; reuse it so the whole unit stays atomic.
        return work(build(executor, null));
      }
      return runner.transaction((tx) => work(build(tx, null)));
    },
  };
}

export function createRepositories(database: Database): Repositories {
  return build(database, database);
}

/** The handle the application holds: repositories plus connection lifecycle. */
export function createPersistenceLayer(database: Database): PersistenceLayer {
  return {
    repositories: createRepositories(database),
    ping: () => database.ping(),
    close: () => database.close(),
  };
}

export { createUserRepository } from './users.js';
export { createSessionRepository } from './sessions.js';
export { createAccountRepository } from './accounts.js';
export { createAnalyticsRepository } from './analytics.js';
export { createLedgerRepository } from './ledger.js';
export { createPaperPositionRepository } from './paper.js';
export { createAssetRepository, resolveAssetId } from './assets.js';
export { createCandleRepository } from './candles.js';
export { createStrategyRepository } from './strategies.js';
export { createSignalRepository, toFeatureInserts } from './signals.js';
export { createSignalOutcomeRepository } from './outcomes.js';
export { createBacktestRepository } from './backtests.js';
export { createSystemEventRepository, createRiskEventRepository } from './events.js';
export { isUuid, resolveSignalRowId } from './ids.js';
