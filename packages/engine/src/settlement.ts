import type { SignalDirection, SignalOutcome } from '@binaryai/types';

/**
 * Binary settlement semantics — the single definition in the system.
 *
 * Previously this rule lived inside the backtester. Live settlement needs the
 * identical rule, and a second copy would eventually drift: the moment a
 * backtest and a live outcome disagree about the same price pair, every
 * calibration sample built from them is worthless.
 *
 * The rule itself, unchanged:
 *   expiry == entry  -> tie   (exact equality; this is why prices are NUMERIC)
 *   direction agrees with the move -> win
 *   otherwise -> loss
 *
 * This determines DIRECTIONAL CORRECTNESS ONLY. It says nothing about profit:
 * payout economics belong to a broker's terms, which BinaryAI does not have.
 * See docs/runtime.md.
 */

export type SettlementResult = SignalOutcome['result'];

export function settleBinaryOutcome(
  direction: Exclude<SignalDirection, 'none'>,
  entryPrice: number,
  expiryPrice: number,
): SettlementResult {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(expiryPrice)) return 'unresolved';
  if (expiryPrice === entryPrice) return 'tie';
  const moved_up = expiryPrice > entryPrice;
  return (direction === 'call') === moved_up ? 'win' : 'loss';
}
