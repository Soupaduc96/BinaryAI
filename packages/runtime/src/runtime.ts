import type { IngestionTracker } from '@binaryai/market-data';
import type {
  AnalysisRuntimeStatus,
  MarketAsset,
  MarketDataProvider,
  Repositories,
  RuntimeStatus,
  SettlementRuntimeStatus,
  Strategy,
  Timeframe,
  WorkerStatus,
} from '@binaryai/types';
import { runAnalysisCycle, type AnalysisSkipReason } from './analysis-loop.js';
import { runIngestionCycle } from './ingestion-loop.js';
import { createScheduler, type Scheduler, type SchedulerStats } from './scheduler.js';
import { runMaintenanceCycle } from './maintenance-worker.js';
import { runPaperSettlementCycle, runSettlementCycle } from './settlement-worker.js';

/**
 * The continuous runtime: three independent workers on one lifecycle.
 *
 *   ingestion  -> candles into PostgreSQL
 *   analysis   -> closed candles into signals, via the existing engine
 *   settlement -> expired signals into outcomes
 *
 * They are separate schedulers rather than one pipeline because they fail
 * independently and recover independently: a provider outage stops ingestion
 * but must not stop settlement of signals that already expired.
 *
 * Everything durable lives in the database. These objects hold counters for
 * the status endpoint; losing them to a restart costs observability, never
 * correctness.
 */

export interface RuntimeConfig {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly ingestion: { readonly enabled: boolean; readonly intervalMs: number };
  readonly analysis: { readonly enabled: boolean; readonly intervalMs: number };
  readonly settlement: { readonly enabled: boolean; readonly intervalMs: number };
  readonly maintenance: { readonly enabled: boolean; readonly intervalMs: number };
}

export interface RuntimeDeps {
  readonly provider: MarketDataProvider | null;
  readonly repositories: Repositories | null;
  readonly strategy: Strategy;
  readonly asset: MarketAsset;
  readonly tracker?: IngestionTracker;
  readonly now?: () => number;
  readonly onEvent?: (event: RuntimeEvent) => void;
}

export interface RuntimeEvent {
  readonly worker: 'ingestion' | 'analysis' | 'settlement' | 'maintenance';
  readonly code: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

export interface Runtime {
  start(): void;
  stop(): Promise<void>;
  status(): Promise<RuntimeStatus>;
  /** Runs one cycle of each enabled worker. Used by tests and manual triggers. */
  runOnce(): Promise<void>;
}

function toWorkerStatus(stats: SchedulerStats, enabled: boolean): WorkerStatus {
  return {
    name: stats.name,
    enabled,
    running: stats.running,
    ticks: stats.ticks,
    skipped: stats.skipped,
    failures: stats.failures,
    lastRunAt: stats.lastRunAt,
    lastDurationMs: stats.lastDurationMs,
    lastError: stats.lastError,
    inFlight: stats.inFlight,
  };
}

export function createRuntime(config: RuntimeConfig, deps: RuntimeDeps): Runtime {
  const { provider, repositories, strategy, asset, tracker, now = Date.now, onEvent } = deps;

  let startedAt: number | null = null;

  // Analysis observability
  let lastAnalyzedCandleAt: number | null = null;
  let lastSignalKey: string | null = null;
  let lastSignalAt: number | null = null;
  let lastSignalDirection: string | null = null;
  let lastSignalStatus: string | null = null;
  let lastSkipReason: AnalysisSkipReason | null = null;
  let signalsCreated = 0;
  let duplicatesPrevented = 0;

  // Settlement observability
  let lastSettlementAt: number | null = null;
  let settledTotal = 0;
  // Housekeeping counters. Reported so a job that silently does nothing is
  // distinguishable from one that has never run.
  let lastSweepAt: number | null = null;
  let sessionsDeleted = 0;
  let unresolvedLastCycle = 0;

  const emit = (event: RuntimeEvent): void => onEvent?.(event);

  const ingestionScheduler = createScheduler(
    async () => {
      if (!provider) return;
      const cycle = await runIngestionCycle(
        { provider, repositories, ...(tracker === undefined ? {} : { tracker }), now },
        { symbol: config.symbol, timeframe: config.timeframe },
      );

      if (!cycle.ran) {
        emit({
          worker: 'ingestion',
          code: 'ingestion_skipped',
          level: 'info',
          message: cycle.reason ?? 'Nothing to ingest.',
        });
        return;
      }
      // Only report a cycle that actually changed something; a tick that
      // stored zero new candles is the normal steady state and logging it
      // every interval would bury the events that matter.
      const stored = cycle.result?.metrics.candlesStored ?? 0;
      if (stored > 0 || cycle.result?.status !== 'completed') {
        emit({
          worker: 'ingestion',
          code: cycle.result?.status === 'failed' ? 'ingestion_failed' : 'ingestion_completed',
          level: cycle.result?.status === 'failed' ? 'error' : 'info',
          message: `Ingestion ${cycle.result?.status}: ${stored} candle(s) stored.`,
          context: { stored, rejected: cycle.result?.metrics.candlesRejected ?? 0 },
        });
      }
    },
    {
      name: 'ingestion',
      intervalMs: config.ingestion.intervalMs,
      runImmediately: true,
      onError: (error) =>
        emit({
          worker: 'ingestion',
          code: 'ingestion_error',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    },
  );

  const analysisScheduler = createScheduler(
    async () => {
      const cycle = await runAnalysisCycle(
        { repositories, strategy, asset, now },
        { symbol: config.symbol, timeframe: config.timeframe },
      );

      if (!cycle.analyzed) {
        lastSkipReason = cycle.skipped ?? null;
        if (cycle.skipped === 'already_analyzed') duplicatesPrevented += 1;

        // Waiting for the current bar to close is the normal state between
        // candles and is not worth an event every tick.
        if (cycle.skipped !== 'no_finalized_candle' && cycle.skipped !== 'already_analyzed') {
          emit({
            worker: 'analysis',
            code: `analysis_skipped_${cycle.skipped ?? 'unknown'}`,
            level: cycle.skipped === 'data_gap' ? 'warning' : 'info',
            message: cycle.detail ?? 'Analysis skipped.',
          });
        }
        return;
      }

      lastSkipReason = null;
      lastAnalyzedCandleAt = cycle.candleTimestamp ?? null;
      lastSignalKey = cycle.signalKey ?? null;
      lastSignalAt = now();
      lastSignalDirection = cycle.signal?.direction ?? null;
      lastSignalStatus = cycle.signal?.status ?? null;
      if (cycle.signal?.status === 'accepted') signalsCreated += 1;

      emit({
        worker: 'analysis',
        code: cycle.signal?.status === 'accepted' ? 'signal_created' : 'analysis_no_signal',
        level: 'info',
        message: `${cycle.signal?.direction} ${cycle.signal?.status} (${cycle.signal?.recommendation})`,
        context: { signalKey: cycle.signalKey, candle: cycle.candleTimestamp },
      });
    },
    {
      name: 'analysis',
      intervalMs: config.analysis.intervalMs,
      onError: (error) =>
        emit({
          worker: 'analysis',
          code: 'analysis_error',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    },
  );

  const settlementScheduler = createScheduler(
    async () => {
      const cycle = await runSettlementCycle({ repositories, now, dataOrigin: 'exchange' });
      unresolvedLastCycle = cycle.unresolved;

      // Paper positions settle in the same cycle and under the same rule, but
      // as a separate write. One signal outcome is the canonical analysis
      // observation; each account's position is its own record of acting on it.
      const paper = await runPaperSettlementCycle({ repositories, now, dataOrigin: 'exchange' });
      if (paper.settled > 0) {
        emit({
          worker: 'settlement',
          code: 'paper_settlement_completed',
          level: 'info',
          message: `Settled ${paper.settled} paper position(s).`,
          context: { settled: paper.settled, pending: paper.pending },
        });
      }
      if (cycle.settled > 0) {
        settledTotal += cycle.settled;
        lastSettlementAt = now();
        emit({
          worker: 'settlement',
          code: 'settlement_completed',
          level: 'info',
          message: `Settled ${cycle.settled} signal(s).`,
          context: { settled: cycle.settled, unresolved: cycle.unresolved },
        });
      }
      if (cycle.failed > 0) {
        emit({
          worker: 'settlement',
          code: 'settlement_failed',
          level: 'error',
          message: `${cycle.failed} settlement(s) failed.`,
        });
      }
    },
    {
      name: 'settlement',
      intervalMs: config.settlement.intervalMs,
      onError: (error) =>
        emit({
          worker: 'settlement',
          code: 'settlement_error',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    },
  );

  const maintenanceScheduler = createScheduler(
    async () => {
      const result = await runMaintenanceCycle({ repositories, now });
      if (!result.ran) return;
      lastSweepAt = now();
      sessionsDeleted += result.sessionsDeleted;
      // Emitted only when something was actually removed. A sweep that finds
      // nothing is the normal case and does not need a line in the log.
      if (result.sessionsDeleted > 0) {
        emit({
          worker: 'maintenance',
          code: 'sessions_swept',
          level: 'info',
          message: `Removed ${result.sessionsDeleted} expired session row(s).`,
          context: { sessionsDeleted: result.sessionsDeleted },
        });
      }
    },
    {
      name: 'maintenance',
      intervalMs: config.maintenance.intervalMs,
      onError: (error) =>
        emit({
          worker: 'maintenance',
          code: 'maintenance_error',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    },
  );

  const enabled = {
    ingestion: config.ingestion.enabled && provider !== null,
    analysis: config.analysis.enabled && repositories !== null,
    settlement: config.settlement.enabled && repositories !== null,
    maintenance: config.maintenance.enabled && repositories !== null,
  };

  const schedulers: Array<[Scheduler, boolean]> = [
    [ingestionScheduler, enabled.ingestion],
    [analysisScheduler, enabled.analysis],
    [settlementScheduler, enabled.settlement],
    [maintenanceScheduler, enabled.maintenance],
  ];

  return {
    start(): void {
      startedAt = now();
      for (const [scheduler, isEnabled] of schedulers) {
        if (isEnabled) scheduler.start();
      }
    },

    async stop(): Promise<void> {
      // Stop scheduling first, then await in-flight work, so nothing writes
      // after shutdown and no timer keeps the process alive.
      await Promise.all(schedulers.map(([scheduler]) => scheduler.stop()));
      startedAt = null;
    },

    async runOnce(): Promise<void> {
      if (enabled.ingestion) await ingestionScheduler.runNow();
      if (enabled.analysis) await analysisScheduler.runNow();
      if (enabled.settlement) await settlementScheduler.runNow();
      if (enabled.maintenance) await maintenanceScheduler.runNow();
    },

    async status(): Promise<RuntimeStatus> {
      // The status endpoint must survive a database outage, because an outage
      // is precisely when somebody reads it. A rejected query here used to
      // propagate and turn /v1/system/status into a 500 -- so the one call
      // that would tell an operator the database was down instead looked like
      // the API itself had failed.
      //
      // `null` already means "not known", which is the honest answer: the
      // count could not be read. It is deliberately NOT zero, which would
      // claim nothing is awaiting settlement.
      let pendingExpirations: number | null = null;
      if (repositories) {
        try {
          pendingExpirations = (await repositories.signals.findExpiredUnsettled(now(), 500)).length;
        } catch {
          pendingExpirations = null;
        }
      }

      const analysis: AnalysisRuntimeStatus = {
        ...toWorkerStatus(analysisScheduler.stats(), enabled.analysis),
        symbol: enabled.analysis ? config.symbol : null,
        timeframe: enabled.analysis ? config.timeframe : null,
        lastAnalyzedCandleAt,
        lastSignalKey,
        lastSignalAt,
        lastSignalDirection,
        lastSignalStatus,
        lastSkipReason,
        signalsCreated,
        duplicatesPrevented,
      };

      const settlement: SettlementRuntimeStatus = {
        ...toWorkerStatus(settlementScheduler.stats(), enabled.settlement),
        lastSettlementAt,
        settledTotal,
        unresolvedLastCycle,
        pendingExpirations,
      };

      return {
        ingestion: toWorkerStatus(ingestionScheduler.stats(), enabled.ingestion),
        analysis,
        settlement,
        maintenance: {
          ...toWorkerStatus(maintenanceScheduler.stats(), enabled.maintenance),
          // Null until a sweep has actually happened: zero would claim a sweep
          // ran and found nothing, which is a different fact.
          sessionsDeleted: lastSweepAt === null ? null : sessionsDeleted,
          lastSweepAt,
        },
        startedAt,
      };
    },
  };
}
