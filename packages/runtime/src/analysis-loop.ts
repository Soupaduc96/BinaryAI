import { evaluateDecision } from '@binaryai/engine';
import {
  TIMEFRAME_SECONDS,
  type CandleSeries,
  type MarketAsset,
  type Repositories,
  type Signal,
  type Strategy,
  type Timeframe,
} from '@binaryai/types';
import { deterministicId } from '@binaryai/utils';

/**
 * Live analysis.
 *
 * Calls the EXACT function the API and the backtester call — `evaluateDecision`
 * from @binaryai/engine. There is no live-specific indicator, strategy,
 * confidence or risk path, because a live decision that differs from a
 * backtested one on the same input would make every backtest meaningless.
 *
 * The loop's own job is narrow and entirely about preconditions:
 *  - decide only on a CLOSED candle,
 *  - decide each candle exactly once,
 *  - refuse to decide on data that is insufficient or has holes in it.
 */

export type AnalysisSkipReason =
  | 'no_persistence'
  | 'no_candles'
  | 'no_finalized_candle'
  | 'insufficient_history'
  | 'data_gap'
  | 'already_analyzed'
  | 'unusable_data';

export interface AnalysisCycleResult {
  readonly analyzed: boolean;
  readonly skipped?: AnalysisSkipReason;
  readonly detail?: string;
  /** Decision bar, when one was identified. */
  readonly candleTimestamp?: number;
  readonly signalKey?: string;
  readonly signal?: Signal;
  readonly persistedId?: string;
}

export interface AnalysisCycleDeps {
  readonly repositories: Repositories | null;
  readonly strategy: Strategy;
  /**
   * THE instrument this cycle analyses — the single source of truth.
   *
   * D3: this used to sit beside an independent `options.symbol`, and nothing
   * cross-checked them. `deps.asset` decided which `market_assets` row was
   * upserted and what metadata the strategy saw; `options.symbol` decided which
   * candles were loaded and what the signal was stamped with. Production
   * happened to pass matching values, so the divergence was invisible — and
   * multi-asset analysis means a loop over instruments, which is exactly the
   * shape where a mismatched pair is easy to build and impossible to notice.
   *
   * One object now answers both questions. There is no second string to
   * disagree with it.
   */
  readonly instrument: ResolvedAnalysisInstrument;
  readonly now?: () => number;
}

/**
 * An instrument resolved from the catalogue, ready to be analysed.
 *
 * Carries canonical identity AND the persisted projection together, so no
 * downstream function has to rebuild either from loose strings.
 */
export interface ResolvedAnalysisInstrument {
  /** Canonical BinaryAI symbol. Names the candles AND stamps the signal. */
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** The row written to `market_assets`, derived from the catalogue. */
  readonly asset: MarketAsset;
}

export interface AnalysisCycleOptions {
  /** Extra bars above the strategy's minimum, for indicator stability. */
  readonly warmupBuffer?: number;
  /** Missing intervals tolerated inside the analysis window. */
  readonly maxMissingIntervals?: number;
}

export const DEFAULT_ANALYSIS_OPTIONS = {
  warmupBuffer: 50,
  maxMissingIntervals: 0,
} as const;

/**
 * The deterministic identity of one analysis event.
 *
 * Same asset + timeframe + decision bar + strategy version => same id, forever.
 * That makes deduplication a property of the data rather than of a cache: a
 * restarted process, a duplicated tick and a manual re-run all collapse onto
 * the same row, and the unique index on `signals.signal_key` is the final
 * guarantee even if two workers race.
 */
export function analysisSignalKey(input: {
  symbol: string;
  timeframe: Timeframe;
  candleTimestamp: number;
  strategyId: string;
  strategyVersion: string;
}): string {
  const fingerprint =
    `${input.symbol}:${input.timeframe}:${input.candleTimestamp}:` +
    `${input.strategyId}@${input.strategyVersion}`;
  return `sig_${deterministicId(fingerprint)}`;
}

/** Bars whose close time has passed. A forming bar is not a decision input. */
export function finalizedCandles(series: CandleSeries, now: number): CandleSeries {
  const stepMs = TIMEFRAME_SECONDS[series.timeframe] * 1000;
  return {
    ...series,
    candles: series.candles.filter((candle) => candle.complete && candle.timestamp + stepMs <= now),
  };
}

/** Missing intervals inside a window. Gaps break indicator continuity. */
export function countMissingIntervals(series: CandleSeries): number {
  const stepMs = TIMEFRAME_SECONDS[series.timeframe] * 1000;
  let missing = 0;
  for (let index = 1; index < series.candles.length; index += 1) {
    const previous = series.candles[index - 1];
    const current = series.candles[index];
    if (!previous || !current) continue;
    const delta = current.timestamp - previous.timestamp;
    if (delta > stepMs) missing += Math.round(delta / stepMs) - 1;
  }
  return missing;
}

export async function runAnalysisCycle(
  deps: AnalysisCycleDeps,
  options: AnalysisCycleOptions = {},
): Promise<AnalysisCycleResult> {
  const { repositories, strategy, instrument, now = Date.now } = deps;
  // Both derived from ONE object, so they cannot disagree.
  const { symbol, timeframe, asset } = instrument;
  const {
    warmupBuffer = DEFAULT_ANALYSIS_OPTIONS.warmupBuffer,
    maxMissingIntervals = DEFAULT_ANALYSIS_OPTIONS.maxMissingIntervals,
  } = options;

  /*
   * The one invariant this refactor exists to make impossible to violate.
   *
   * A `ResolvedAnalysisInstrument` is built by `resolveAnalysisInstrument` from
   * the catalogue, so these always match. The check is cheap and it converts a
   * silent cross-instrument corruption — candles from one instrument stored
   * against another's asset row — into an immediate, named failure.
   */
  if (asset.symbol !== symbol) {
    throw new Error(
      `Analysis instrument is incoherent: candles are for "${symbol}" but the asset row is ` +
        `"${asset.symbol}". A resolved instrument must name one instrument.`,
    );
  }

  if (!repositories) {
    return {
      analyzed: false,
      skipped: 'no_persistence',
      detail: 'No database configured; a signal that cannot be persisted is not produced.',
    };
  }

  const at = now();
  const required = strategy.meta.requiredHistory + warmupBuffer;

  const stored = await repositories.candles.latest(symbol, timeframe, required + 10);
  if (!stored || stored.candles.length === 0) {
    return {
      analyzed: false,
      skipped: 'no_candles',
      detail: `No stored candles for ${symbol} ${timeframe}.`,
    };
  }

  // Only closed bars may inform a decision.
  const finalized = finalizedCandles(stored, at);
  const decisionCandle = finalized.candles.at(-1);
  if (!decisionCandle) {
    return {
      analyzed: false,
      skipped: 'no_finalized_candle',
      detail: 'The newest candle is still forming; waiting for it to close.',
    };
  }

  if (finalized.candles.length < strategy.meta.requiredHistory) {
    return {
      analyzed: false,
      skipped: 'insufficient_history',
      detail: `${finalized.candles.length} finalized candles available, ${strategy.meta.requiredHistory} required.`,
      candleTimestamp: decisionCandle.timestamp,
    };
  }

  const missing = countMissingIntervals(finalized);
  if (missing > maxMissingIntervals) {
    // Indicators assume a continuous series. Analysing across a hole produces
    // readings that describe a series the market never traded.
    return {
      analyzed: false,
      skipped: 'data_gap',
      detail: `${missing} missing interval(s) in the analysis window; tolerance is ${maxMissingIntervals}.`,
      candleTimestamp: decisionCandle.timestamp,
    };
  }

  const signalKey = analysisSignalKey({
    symbol,
    timeframe,
    candleTimestamp: decisionCandle.timestamp,
    strategyId: strategy.meta.id,
    strategyVersion: strategy.meta.version,
  });

  const existing = await repositories.signals.findById(signalKey);
  if (existing) {
    return {
      analyzed: false,
      skipped: 'already_analyzed',
      detail: `Candle ${new Date(decisionCandle.timestamp).toISOString()} was already analysed.`,
      candleTimestamp: decisionCandle.timestamp,
      signalKey,
    };
  }

  // The engine decides. Everything above was preconditions.
  const decision = evaluateDecision({
    asset,
    series: finalized,
    strategy,
    executionMode: 'demo',
    // At or after the decision bar, as the engine guard requires.
    now: Math.max(at, decisionCandle.timestamp),
    idFactory: () => signalKey,
  });

  if (!decision.signal.dataQuality.usable) {
    return {
      analyzed: false,
      skipped: 'unusable_data',
      detail: 'Market data failed integrity validation; no signal produced.',
      candleTimestamp: decisionCandle.timestamp,
      signalKey,
    };
  }

  // Persist the evaluation with its TRUE status. A risk-blocked candidate is
  // stored as `rejected`/`skip` -- an audit record, never a tradable signal --
  // which is also what makes deduplication survive a restart.
  const stored_ref = await repositories.transaction(async (tx) => {
    await tx.assets.upsert(asset);
    const strategyRow = await tx.strategies.register(strategy.meta, strategy.parameters);
    const ref = await tx.signals.save(decision.signal, { strategyRowId: strategyRow.id });

    await tx.systemEvents.record({
      level: 'info',
      category: 'analysis',
      code: decision.signal.status === 'accepted' ? 'signal_created' : 'analysis_no_signal',
      message:
        `${decision.signal.direction.toUpperCase()} ${decision.signal.status} for ${symbol} ` +
        `${timeframe} @ ${new Date(decisionCandle.timestamp).toISOString()}`,
      executionMode: 'demo',
      context: {
        signalKey,
        candle: decisionCandle.timestamp,
        direction: decision.signal.direction,
        recommendation: decision.signal.recommendation,
        riskOutcome: decision.risk.outcome,
        dataSource: decision.signal.dataSource,
      },
    });

    return ref;
  });

  return {
    analyzed: true,
    candleTimestamp: decisionCandle.timestamp,
    signalKey,
    signal: decision.signal,
    persistedId: stored_ref.id,
  };
}
