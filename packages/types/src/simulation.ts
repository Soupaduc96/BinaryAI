import type { PayoutModel } from './backtest.js';
import type { ExecutionMode, SignalDirection } from './signal.js';

/**
 * Paper trading. `PaperAccount.mode` is the literal 'demo' -- a live account is
 * a different type that does not exist yet, so it is impossible to pass a live
 * account to the simulator by mistake.
 */
export interface PaperAccount {
  readonly id: string;
  readonly mode: Extract<ExecutionMode, 'demo'>;
  readonly currency: string;
  readonly balance: number;
  /** Balance at the start of the current trading day. */
  readonly dayStartBalance: number;
  readonly openExposure: number;
  readonly consecutiveLosses: number;
  readonly lastLossAt: number | null;
  readonly createdAt: number;
}

export interface PaperPosition {
  readonly id: string;
  readonly accountId: string;
  readonly signalId: string | null;
  readonly asset: string;
  readonly direction: Exclude<SignalDirection, 'none'>;
  readonly stake: number;
  readonly entryPrice: number;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly payout: PayoutModel;
  readonly status: 'open' | 'settled' | 'cancelled';
  readonly settlementPrice: number | null;
  readonly outcome: 'win' | 'loss' | 'tie' | null;
  readonly pnl: number | null;
}
