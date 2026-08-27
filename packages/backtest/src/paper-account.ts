import { assertExecutionAllowed, resolveRiskLimits } from '@binaryai/engine';
import type { PaperAccount, PaperPosition, PayoutModel, SignalDirection } from '@binaryai/types';
import { createPrefixedId, round } from '@binaryai/utils';
import { DEFAULT_PAYOUT_MODEL } from './runner.js';

/**
 * Paper (demo) trading.
 *
 * Every function here is pure: it returns new account/position objects rather
 * than mutating, so state transitions are auditable and testable. There is no
 * live counterpart in this build, and `PaperAccount.mode` is the literal
 * 'demo', so a live account cannot be passed in by mistake.
 */

export class PaperTradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperTradingError';
  }
}

export interface CreatePaperAccountOptions {
  readonly id?: string;
  readonly currency?: string;
  readonly startingBalance?: number;
  readonly now?: number;
}

export function createPaperAccount(options: CreatePaperAccountOptions = {}): PaperAccount {
  const {
    id = createPrefixedId('acct'),
    currency = 'USD',
    startingBalance = 1000,
    now = 0,
  } = options;
  if (startingBalance <= 0) {
    throw new PaperTradingError('startingBalance must be greater than zero');
  }
  return {
    id,
    mode: 'demo',
    currency,
    balance: startingBalance,
    dayStartBalance: startingBalance,
    openExposure: 0,
    consecutiveLosses: 0,
    lastLossAt: null,
    createdAt: now,
  };
}

export interface OpenPositionRequest {
  readonly account: PaperAccount;
  readonly asset: string;
  readonly direction: Exclude<SignalDirection, 'none'>;
  readonly stake: number;
  readonly entryPrice: number;
  readonly openedAt: number;
  readonly expirationSeconds: number;
  readonly signalId?: string;
  readonly payout?: PayoutModel;
  readonly positionId?: string;
}

export function openPaperPosition(request: OpenPositionRequest): {
  account: PaperAccount;
  position: PaperPosition;
} {
  const { account, stake, entryPrice, expirationSeconds } = request;

  // Belt and braces: this path is demo-only by type, and by assertion.
  assertExecutionAllowed(account.mode, resolveRiskLimits());

  if (!Number.isFinite(stake) || stake <= 0) {
    throw new PaperTradingError('stake must be a positive, finite number');
  }
  if (stake > account.balance - account.openExposure) {
    throw new PaperTradingError('stake exceeds the available balance');
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new PaperTradingError('entryPrice must be a positive, finite number');
  }
  if (!Number.isFinite(expirationSeconds) || expirationSeconds <= 0) {
    throw new PaperTradingError('expirationSeconds must be a positive, finite number');
  }

  const position: PaperPosition = {
    id: request.positionId ?? createPrefixedId('pos'),
    accountId: account.id,
    signalId: request.signalId ?? null,
    asset: request.asset,
    direction: request.direction,
    stake,
    entryPrice,
    openedAt: request.openedAt,
    expiresAt: request.openedAt + expirationSeconds * 1000,
    payout: request.payout ?? DEFAULT_PAYOUT_MODEL,
    status: 'open',
    settlementPrice: null,
    outcome: null,
    pnl: null,
  };

  return {
    account: { ...account, openExposure: round(account.openExposure + stake, 8) },
    position,
  };
}

export function settlePaperPosition(
  account: PaperAccount,
  position: PaperPosition,
  settlementPrice: number,
  settledAt: number,
): { account: PaperAccount; position: PaperPosition } {
  if (position.status !== 'open') {
    throw new PaperTradingError(`position ${position.id} is already ${position.status}`);
  }
  if (position.accountId !== account.id) {
    throw new PaperTradingError('position does not belong to this account');
  }
  if (settledAt < position.expiresAt) {
    throw new PaperTradingError('cannot settle a position before its expiry');
  }

  const outcome: 'win' | 'loss' | 'tie' =
    settlementPrice === position.entryPrice
      ? 'tie'
      : (position.direction === 'call') === settlementPrice > position.entryPrice
        ? 'win'
        : 'loss';

  const pnl =
    outcome === 'win'
      ? position.stake * position.payout.winPayoutRate
      : outcome === 'loss'
        ? -position.stake * (1 - position.payout.lossRefundRate)
        : position.payout.tiePolicy === 'refund'
          ? 0
          : -position.stake;

  return {
    account: {
      ...account,
      balance: round(account.balance + pnl, 8),
      openExposure: round(Math.max(account.openExposure - position.stake, 0), 8),
      consecutiveLosses: outcome === 'loss' ? account.consecutiveLosses + 1 : 0,
      lastLossAt: outcome === 'loss' ? settledAt : account.lastLossAt,
    },
    position: {
      ...position,
      status: 'settled',
      settlementPrice,
      outcome,
      pnl: round(pnl, 8),
    },
  };
}

export function cancelPaperPosition(
  account: PaperAccount,
  position: PaperPosition,
): { account: PaperAccount; position: PaperPosition } {
  if (position.status !== 'open') {
    throw new PaperTradingError(`position ${position.id} is already ${position.status}`);
  }
  return {
    account: {
      ...account,
      openExposure: round(Math.max(account.openExposure - position.stake, 0), 8),
    },
    position: { ...position, status: 'cancelled' },
  };
}
