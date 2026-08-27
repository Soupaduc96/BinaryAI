/**
 * @binaryai/database -- PostgreSQL persistence.
 *
 * Implements the storage-agnostic interfaces from @binaryai/types. The engine
 * never imports this package: analysis stays a pure function of market data,
 * and persistence is the caller's concern. The API owns the connection and
 * injects the repositories, exactly as it does for the AI provider.
 *
 * Nothing here reads process.env -- configuration is passed in.
 */

export {
  createPostgresDatabase,
  describeDatabaseConfig,
  DEFAULT_DATABASE_CONFIG,
  type DatabaseConfig,
} from './connection.js';

export {
  DatabaseError,
  RecordNotFoundError,
  SQL_STATE,
  hasSqlState,
  isCheckViolation,
  isForeignKeyViolation,
  isNotNullViolation,
  isUniqueViolation,
  toDatabaseError,
  type Database,
  type QueryResult,
  type Row,
  type SqlExecutor,
  type SqlStateCode,
} from './executor.js';

export {
  checksumOf,
  ensureMigrationsTable,
  getMigrationStatus,
  loadMigrations,
  readAppliedMigrations,
  runMigrations,
  type MigrationDrift,
  type MigrationFile,
  type MigrationRecord,
  type MigrationRunResult,
  type MigrationStatus,
  type RunMigrationsOptions,
} from './migrator.js';

export {
  createPersistenceLayer,
  createRepositories,
  createAssetRepository,
  createBacktestRepository,
  createCandleRepository,
  createRiskEventRepository,
  createSignalOutcomeRepository,
  createSignalRepository,
  createAnalyticsRepository,
  createPaperPositionRepository,
  createLedgerRepository,
  createStrategyRepository,
  createSystemEventRepository,
  isUuid,
  resolveAssetId,
  resolveSignalRowId,
  toFeatureInserts,
} from './repositories/index.js';

export {
  asNumericRecord,
  asRecord,
  fromJson,
  toBoolean,
  toEpochMs,
  toJsonParam,
  toNullableEpochMs,
  toNullableNumber,
  toNullableText,
  toNumber,
  toText,
  toTimestamp,
} from './mappers.js';
