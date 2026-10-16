/**
 * @binaryai/runtime -- the continuous workers.
 *
 *   COINBASE -> ingestion -> PostgreSQL -> analysis (evaluateDecision)
 *            -> signals -> expiry settlement -> outcomes -> calibration dataset
 *
 * Every worker delegates to code that already exists: ingestion calls the
 * bounded market-data worker, analysis calls the engine's `evaluateDecision`,
 * settlement calls the engine's `settleBinaryOutcome`. There is no second
 * implementation of anything in this package.
 *
 * It ingests, analyses, records and settles. It does not place orders, connect
 * to a broker, or manage money -- and there is no code path here that could.
 */

export {
  createScheduler,
  type Scheduler,
  type SchedulerOptions,
  type SchedulerStats,
} from './scheduler.js';

export {
  runIngestionCycle,
  DEFAULT_INGESTION_CYCLE,
  type IngestionCycleDeps,
  type IngestionCycleOptions,
  type IngestionCycleResult,
} from './ingestion-loop.js';

export {
  runAnalysisCycle,
  analysisSignalKey,
  finalizedCandles,
  countMissingIntervals,
  DEFAULT_ANALYSIS_OPTIONS,
  type AnalysisCycleDeps,
  type AnalysisCycleOptions,
  type AnalysisCycleResult,
  type AnalysisSkipReason,
  type ResolvedAnalysisInstrument,
} from './analysis-loop.js';

export {
  runSettlementCycle,
  runPaperSettlementCycle,
  settlementCandleStart,
  type SettlementCycleResult,
  type SettlementDeps,
  type SettlementOptions,
  type SettlementSkipReason,
} from './settlement-worker.js';
export {
  runMaintenanceCycle,
  type MaintenanceDeps,
  type MaintenanceResult,
} from './maintenance-worker.js';

export {
  createRuntime,
  type Runtime,
  type RuntimeConfig,
  type RuntimeDeps,
  type RuntimeEvent,
} from './runtime.js';

export {
  InvalidPlanEntryError,
  parsePlanEntries,
  resolveAnalysisInstrument,
  resolveAnalysisInstruments,
  resolvePlan,
  resolvePlanFromConfig,
  UnknownAnalysisInstrumentError,
  type PlanEntryInput,
} from './resolve-instrument.js';
