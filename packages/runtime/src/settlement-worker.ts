import { applySimulationModel, settleBinaryOutcome } from '@binaryai/engine';
import {
  TIMEFRAME_SECONDS,
  type ExpiredSignal,
  type MarketDataOrigin,
  type Repositories,
  type SignalOutcome,
  type Timeframe,
} from '@binaryai/types';

/**
 * Automatic expiry settlement.
 *
 * Finds signals whose expiry has passed with no recorded outcome, locates the
 * candle that determines the result, and writes it. This is what turns a stream
 * of predictions into the labelled dataset future confidence calibration needs.
 *
 * Two rules it will not bend:
 *
 *  1. **No guessing.** If the settlement candle is missing or still forming,
 *     the signal stays unresolved with a stated reason. "Latest available
 *     price" is not settlement — it silently changes what was measured.
 *  2. **No payout economics.** The outcome records DIRECTION correctness only.
 *     BinaryAI has no broker terms, so attaching a payout would fabricate
 *     profit from a directional result. See docs/runtime.md.
 */

export type SettlementSkipReason =
  'candle_missing' | 'candle_not_finalized' | 'already_settled' | 'invalid_price';

export interface SettlementOutcomeRecord {
  readonly signalKey: string;
  readonly result: SignalOutcome['result'];
  readonly settlementPrice: number;
  readonly settlementCandleAt: number;
}

export interface SettlementCycleResult {
  readonly scanned: number;
  readonly settled: number;
  readonly unresolved: number;
  readonly failed: number;
  readonly outcomes: readonly SettlementOutcomeRecord[];
  readonly skipped: ReadonlyArray<{
    signalKey: string;
    reason: SettlementSkipReason;
    detail: string;
  }>;
}

export interface SettlementDeps {
  readonly repositories: Repositories | null;
  readonly now?: () => number;
  /** Provenance of the settlement price. Never 'broker' without a broker feed. */
  readonly dataOrigin?: MarketDataOrigin;
}

export interface SettlementOptions {
  readonly batchSize?: number;
}

/**
 * The bar that determines the outcome.
 *
 * The last bar whose CLOSE falls at or before expiry:
 *   start = floor((expiresAt - step) / step) * step
 *
 * Deterministic and reproducible. Using the bar that merely *contains* expiry
 * would settle on a close that happens after the option expired; using "the
 * latest price" would make the result depend on when the worker happened to run.
 */
export function settlementCandleStart(expiresAt: number, timeframe: Timeframe): number {
  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  return Math.floor((expiresAt - stepMs) / stepMs) * stepMs;
}

export async function runSettlementCycle(
  deps: SettlementDeps,
  options: SettlementOptions = {},
): Promise<SettlementCycleResult> {
  const { repositories, now = Date.now, dataOrigin = 'exchange' } = deps;
  const { batchSize = 100 } = options;

  const empty: SettlementCycleResult = {
    scanned: 0,
    settled: 0,
    unresolved: 0,
    failed: 0,
    outcomes: [],
    skipped: [],
  };
  if (!repositories) return empty;

  const at = now();
  const pending = await repositories.signals.findExpiredUnsettled(at, batchSize);
  if (pending.length === 0) return empty;

  const outcomes: SettlementOutcomeRecord[] = [];
  const skipped: Array<{ signalKey: string; reason: SettlementSkipReason; detail: string }> = [];
  let settled = 0;
  let failed = 0;

  for (const signal of pending) {
    const resolution = await resolveOne(repositories, signal, at, dataOrigin);
    if (resolution.kind === 'settled') {
      settled += 1;
      outcomes.push(resolution.record);
    } else if (resolution.kind === 'skipped') {
      skipped.push({
        signalKey: signal.signalKey,
        reason: resolution.reason,
        detail: resolution.detail,
      });
    } else {
      failed += 1;
    }
  }

  return {
    scanned: pending.length,
    settled,
    unresolved: skipped.length,
    failed,
    outcomes,
    skipped,
  };
}

type Resolution =
  | { kind: 'settled'; record: SettlementOutcomeRecord }
  | { kind: 'skipped'; reason: SettlementSkipReason; detail: string }
  | { kind: 'failed'; detail: string };

async function resolveOne(
  repositories: Repositories,
  signal: ExpiredSignal,
  at: number,
  dataOrigin: MarketDataOrigin,
): Promise<Resolution> {
  const stepMs = TIMEFRAME_SECONDS[signal.timeframe] * 1000;
  const candleStart = settlementCandleStart(signal.expiresAt, signal.timeframe);

  // The settlement bar must itself be closed.
  if (candleStart + stepMs > at) {
    return {
      kind: 'skipped',
      reason: 'candle_not_finalized',
      detail: `Settlement candle ${new Date(candleStart).toISOString()} has not closed yet.`,
    };
  }

  const series = await repositories.candles.findRange({
    assetSymbol: signal.assetSymbol,
    timeframe: signal.timeframe,
    from: candleStart,
    to: candleStart,
  });
  const candle = series?.candles[0];

  if (!candle) {
    // Left unresolved on purpose: the next cycle retries once ingestion
    // backfills the bar. Substituting another price would change the measurement.
    return {
      kind: 'skipped',
      reason: 'candle_missing',
      detail: `No stored candle at ${new Date(candleStart).toISOString()} for ${signal.assetSymbol} ${signal.timeframe}.`,
    };
  }
  if (!Number.isFinite(candle.close) || candle.close <= 0) {
    return {
      kind: 'skipped',
      reason: 'invalid_price',
      detail: 'Settlement candle has an invalid close.',
    };
  }

  const result = settleBinaryOutcome(signal.direction, signal.entryPrice, candle.close);

  try {
    await repositories.transaction(async (tx) => {
      await tx.outcomes.record({
        signalId: signal.signalKey,
        settledAt: at,
        settlementPrice: candle.close,
        result,
        // No `payout`: BinaryAI has no broker terms, and inventing one would
        // turn a directional result into a fabricated profit figure.
        metadata: {
          settledBy: 'settlement-worker',
          dataOrigin,
          settlementCandleAt: candle.timestamp,
          settlementRule: 'close of the last bar ending at or before expiry',
          entryPrice: signal.entryPrice,
          note: 'Directional outcome from exchange data. Not a broker settlement result.',
        },
      });

      await tx.systemEvents.record({
        level: 'info',
        category: 'signal',
        code: 'signal_settled',
        message: `${signal.assetSymbol} ${signal.timeframe} ${signal.direction} settled ${result}`,
        executionMode: 'demo',
        context: {
          signalKey: signal.signalKey,
          result,
          entryPrice: signal.entryPrice,
          settlementPrice: candle.close,
          dataOrigin,
        },
      });
    });
  } catch (error) {
    // A racing worker may have settled it first; the outcome table's primary
    // key is the final guard, and losing that race is not a failure.
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate|unique|already/i.test(message)) {
      return { kind: 'skipped', reason: 'already_settled', detail: 'Settled by another worker.' };
    }
    return { kind: 'failed', detail: message };
  }

  return {
    kind: 'settled',
    record: {
      signalKey: signal.signalKey,
      result,
      settlementPrice: candle.close,
      settlementCandleAt: candle.timestamp,
    },
  };
}

// ------------------------------------------------------ paper positions --

export interface PaperSettlementResult {
  readonly scanned: number;
  readonly settled: number;
  readonly pending: number;
  readonly failed: number;
}

/**
 * Settles expired paper positions.
 *
 * Runs alongside signal settlement and uses the SAME rule — the close of the
 * last bar ending at or before expiry — so an account's recorded outcome can
 * never disagree with the analysis outcome for the same signal.
 *
 * The two are deliberately separate writes, not one:
 *
 *  - `signal_outcomes` is the canonical ANALYSIS observation, and is what
 *    calibration reads. There is exactly one per signal, however many accounts
 *    acted on it.
 *  - `paper_positions.result` is one ACCOUNT's record of its own action.
 *
 * Collapsing them would either duplicate one signal's outcome into N
 * calibration samples, or make an account's history depend on whether anyone
 * else happened to act on the same signal.
 */
export async function runPaperSettlementCycle(
  deps: SettlementDeps,
  options: SettlementOptions = {},
): Promise<PaperSettlementResult> {
  const { repositories, now = Date.now, dataOrigin = 'exchange' } = deps;
  const { batchSize = 100 } = options;

  const empty: PaperSettlementResult = { scanned: 0, settled: 0, pending: 0, failed: 0 };
  if (!repositories) return empty;

  const at = now();
  const expired = await repositories.positions.findExpired(at, batchSize);
  if (expired.length === 0) return empty;

  let settled = 0;
  let pending = 0;
  let failed = 0;

  for (const position of expired) {
    const stepMs = TIMEFRAME_SECONDS[position.timeframe] * 1000;
    const candleStart = settlementCandleStart(position.expiresAt, position.timeframe);

    // The settlement bar must itself have closed.
    if (candleStart + stepMs > at) {
      await repositories.positions.markPendingSettlement(position.id, at);
      pending += 1;
      continue;
    }

    const series = await repositories.candles.findRange({
      assetSymbol: position.assetSymbol,
      timeframe: position.timeframe,
      from: candleStart,
      to: candleStart,
    });
    const candle = series?.candles[0];

    if (!candle || !Number.isFinite(candle.close) || candle.close <= 0) {
      // Left unsettled on purpose. Substituting the latest price would change
      // what was measured, and marking it a loss would invent an outcome.
      await repositories.positions.markPendingSettlement(position.id, at);
      pending += 1;
      continue;
    }

    const result = settleBinaryOutcome(position.direction, position.entryPrice, candle.close);

    // The account's selected simulation model, if it has one. Resolved per
    // position rather than cached for the cycle: an account that switched
    // models between positions must settle each under the model in force when
    // it settles, and the version stamped on the ledger entry is what keeps
    // the earlier entries interpretable afterwards.
    //
    // A model is looked up by id even when deprecated. Deprecation stops new
    // SELECTION, not the settlement of positions already governed by it --
    // refusing here would strand them unsettled forever.
    const account = await repositories.accounts.findById(position.accountId);
    const model = account?.simulationModelId
      ? await repositories.simulationModels.findById(account.simulationModelId)
      : null;
    const simulation = applySimulationModel({
      model,
      exposure: position.size,
      result,
    });

    try {
      await repositories.transaction(async (tx) => {
        await tx.positions.settle({
          positionId: position.id,
          settledAt: at,
          settlementPrice: candle.close,
          result,
          dataOrigin,
          simulation,
        });
      });
      settled += 1;
    } catch {
      failed += 1;
    }
  }

  return { scanned: expired.length, settled, pending, failed };
}
