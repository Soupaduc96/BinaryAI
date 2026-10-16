import type { Timeframe } from './market.js';

/**
 * Runtime status of the continuous workers.
 *
 * Every field reports what the process actually did, not what configuration
 * says it should do. A worker that is enabled but has never completed a cycle
 * reports `running` with a null `lastRunAt` — it does not report healthy.
 */

export interface WorkerStatus {
  readonly name: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly ticks: number;
  /** Cycles skipped because the previous one was still in flight. */
  readonly skipped: number;
  readonly failures: number;
  readonly lastRunAt: number | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly inFlight: boolean;
}

export interface AnalysisRuntimeStatus extends WorkerStatus {
  /** The first configured instrument. Null when analysis is disabled. */
  readonly symbol: string | null;
  /**
   * EVERY configured analysis instrument.
   *
   * Empty when analysis is disabled. The list is what makes "which instruments
   * does this deployment actually analyse" answerable from the status endpoint
   * rather than inferred from a single symbol.
   */
  readonly symbols: readonly string[];
  /**
   * The resolved analysis plan: each instrument with the timeframe it is
   * analysed at, and its asset class.
   *
   * R2. `timeframe` above can only describe one entry; with a mixed plan
   * (BTCUSD@1m, AAPL@1d) it names the wrong one for every other instrument.
   */
  readonly plan: readonly {
    readonly symbol: string;
    readonly timeframe: Timeframe;
    readonly assetClass: string;
  }[];
  readonly timeframe: Timeframe | null;
  /** Decision bar of the most recent completed analysis. */
  readonly lastAnalyzedCandleAt: number | null;
  readonly lastSignalKey: string | null;
  readonly lastSignalAt: number | null;
  readonly lastSignalDirection: string | null;
  readonly lastSignalStatus: string | null;
  /** Why the most recent cycle produced no signal, when it produced none. */
  readonly lastSkipReason: string | null;
  readonly signalsCreated: number;
  readonly duplicatesPrevented: number;
}

export interface SettlementRuntimeStatus extends WorkerStatus {
  readonly lastSettlementAt: number | null;
  readonly settledTotal: number;
  readonly unresolvedLastCycle: number;
  /** Directional signals past expiry still awaiting a settlement candle. */
  readonly pendingExpirations: number | null;
}

export interface RuntimeStatus {
  readonly ingestion: WorkerStatus;
  readonly analysis: AnalysisRuntimeStatus;
  readonly settlement: SettlementRuntimeStatus;
  /** Scheduled housekeeping. Retention, not an authorisation control. */
  readonly maintenance: MaintenanceRuntimeStatus;
  readonly startedAt: number | null;
}

export interface MaintenanceRuntimeStatus extends WorkerStatus {
  /** Expired session rows removed since start. Null when never run. */
  readonly sessionsDeleted: number | null;
  readonly lastSweepAt: number | null;
}
