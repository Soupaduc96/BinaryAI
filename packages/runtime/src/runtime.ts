import type { IngestionTracker, RateBudget } from '@binaryai/market-data';
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
import {
  runAnalysisCycle,
  type AnalysisSkipReason,
  type ResolvedAnalysisInstrument,
} from './analysis-loop.js';
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
  /**
   * Catalogue metadata for the analysis worker's first instrument.
   *
   * Retained for callers that still hand the runtime a single descriptor.
   * Neither worker reads it any more — each cycle carries its own resolved
   * instrument, which is what stops one from writing another's asset row.
   */
  readonly asset: MarketAsset;
  /**
   * The instruments the ANALYSIS worker runs, each already resolved from the
   * catalogue. One entry preserves the previous behaviour exactly.
   */
  readonly analysisInstruments: readonly ResolvedAnalysisInstrument[];
  /**
   * The instruments the INGESTION worker keeps fresh, each with its own
   * timeframe.
   *
   * R1. Separate from the analysis plan on purpose: an instrument may have
   * market data without being analysed. Before this existed the worker polled
   * one symbol, so every hand-added instrument received a single backfill and
   * then aged — BTC/USD 49 seconds old beside gold at eleven hours.
   */
  readonly ingestionInstruments: readonly ResolvedAnalysisInstrument[];
  /**
   * Resolves the shared request budget for an asset class.
   *
   * Supplied by the router, which owns one budget per provider instance.
   * Optional so a caller without a router keeps the per-run fallback.
   */
  readonly budgetFor?: (assetClass: MarketAsset['assetClass']) => RateBudget | null;
  /**
   * The provider that serves an asset class.
   *
   * Ingestion used to poll EVERY configured instrument through the single
   * `provider` above, which is resolved for the ANALYSED instrument. With
   * BTCUSD analysed that provider is Coinbase, so an ingestion plan of
   * `BTCUSD@1m,ETHUSD@1m,EURUSD@1h,AAPL@1d` asked a crypto exchange for a
   * currency pair and a US equity. Observed live: BTC and ETH advanced every
   * cycle while EUR/USD sat four hours stale and AAPL five, with the worker
   * reporting `failures: 0` throughout — the wrong provider simply returns
   * nothing, and nothing is not an error.
   *
   * Class-aware like `budgetFor`, and optional for the same reason: a
   * single-provider deployment or a test that injects one provider keeps
   * working through the `provider` fallback.
   */
  readonly providerFor?: (assetClass: MarketAsset['assetClass']) => MarketDataProvider | null;
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
  const {
    provider,
    repositories,
    strategy,
    analysisInstruments,
    ingestionInstruments,
    budgetFor,
    providerFor,
    tracker,
    now = Date.now,
    onEvent,
  } = deps;

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

  /**
   * Instruments that have already had their one deep-history attempt.
   *
   * Per process, per instrument: enough to repair a truncated first ingest on
   * the next start, bounded so a provider with genuinely no deeper history is
   * asked once rather than every cycle.
   */
  const deepStarted = new Set<string>();

  const ingestionScheduler = createScheduler(
    async () => {
      if (!provider) return;
      /*
       * One poll per configured instrument, in sequence.
       *
       * Sequential, like analysis: each cycle writes candles, and the provider
       * budget is shared (see `createProviderRouter`), so racing them would
       * only queue inside the throttle while making the counters below
       * describe an interleaving nobody can reconstruct.
       */
      let cycle: Awaited<ReturnType<typeof runIngestionCycle>> | null = null;
      for (const instrument of ingestionInstruments) {
        // The provider for THIS instrument's class, not the analysed one's.
        const instrumentProvider =
          providerFor === undefined ? provider : (providerFor(instrument.asset.assetClass) ?? null);

        /*
         * A class with no configured provider is REPORTED, not skipped in
         * silence. Saying nothing is what let four stale instruments look
         * healthy: the operator configured them, the worker claimed success,
         * and no candle ever arrived.
         */
        if (!instrumentProvider) {
          emit({
            worker: 'ingestion',
            code: 'ingestion_no_provider',
            level: 'warning',
            message:
              `No market-data provider is configured for ${instrument.asset.assetClass}, ` +
              `so ${instrument.symbol} cannot be ingested.`,
          });
          continue;
        }

        const outcome = await runIngestionCycle(
          {
            provider: instrumentProvider,
            repositories,
            // Catalogue metadata for THIS instrument, so the asset row is
            // never written with another instrument's class.
            asset: instrument.asset,
            // The budget belongs to the PROVIDER, so every instrument routed
            // there queues through one allowance (R15).
            ...(budgetFor === undefined
              ? {}
              : { budget: budgetFor(instrument.asset.assetClass) ?? undefined }),
            ...(tracker === undefined ? {} : { tracker }),
            now,
          },
          {
            symbol: instrument.symbol,
            timeframe: instrument.timeframe,
            // One deep window per instrument per process, to repair a history
            // that a truncated first ingest left short.
            deepStart: !deepStarted.has(instrument.symbol),
          },
        );
        deepStarted.add(instrument.symbol);
        if (cycle === null || (!cycle.ran && outcome.ran)) cycle = outcome;
      }
      if (cycle === null) return;

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
      /*
       * One cycle per configured instrument, run in sequence.
       *
       * Sequential rather than concurrent on purpose: each cycle writes a
       * signal and upserts an asset row, and the scheduler's whole contract is
       * that one tick is one unit of work. Racing them would also make the
       * status counters below describe an interleaving nobody can reconstruct.
       *
       * Each carries its OWN resolved instrument, which is the D3 fix: there is
       * no shared symbol for one iteration to leak into the next.
       */
      let cycle: Awaited<ReturnType<typeof runAnalysisCycle>> | null = null;
      for (const instrument of analysisInstruments) {
        const outcome = await runAnalysisCycle({ repositories, strategy, instrument, now });
        // The reported cycle is the first that actually analysed something;
        // otherwise the last, so a skip reason is still surfaced.
        if (cycle === null || (!cycle.analyzed && outcome.analyzed)) cycle = outcome;
      }
      if (cycle === null) return;

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
        symbol: enabled.analysis ? (analysisInstruments[0]?.symbol ?? null) : null,
        symbols: enabled.analysis ? analysisInstruments.map((entry) => entry.symbol) : [],
        // The full plan: each instrument WITH the timeframe it is analysed at.
        // R2 — a single `timeframe` here could only describe one entry, and
        // named the wrong one for every other instrument in the plan.
        plan: enabled.analysis
          ? analysisInstruments.map((entry) => ({
              symbol: entry.symbol,
              timeframe: entry.timeframe,
              assetClass: entry.asset.assetClass,
            }))
          : [],
        // First entry's timeframe, kept for single-instrument readers.
        timeframe: enabled.analysis ? (analysisInstruments[0]?.timeframe ?? null) : null,
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
