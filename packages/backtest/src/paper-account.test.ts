import { describe, expect, it } from 'vitest';
import {
  cancelPaperPosition,
  createPaperAccount,
  openPaperPosition,
  PaperTradingError,
  settlePaperPosition,
} from './paper-account.js';

function openAccountWithPosition(direction: 'call' | 'put' = 'call') {
  const account = createPaperAccount({ id: 'acct_test', startingBalance: 1000, now: 0 });
  return openPaperPosition({
    account,
    asset: 'SYNTH',
    direction,
    stake: 50,
    entryPrice: 100,
    openedAt: 0,
    expirationSeconds: 60,
    positionId: 'pos_test',
  });
}

describe('createPaperAccount', () => {
  it('is always in demo mode', () => {
    expect(createPaperAccount().mode).toBe('demo');
  });

  it('rejects a non-positive starting balance', () => {
    expect(() => createPaperAccount({ startingBalance: 0 })).toThrow(PaperTradingError);
  });
});

describe('openPaperPosition', () => {
  it('reserves the stake as exposure without touching the balance', () => {
    const { account, position } = openAccountWithPosition();
    expect(account.openExposure).toBe(50);
    expect(account.balance).toBe(1000);
    expect(position.status).toBe('open');
    expect(position.expiresAt).toBe(60_000);
  });

  it('rejects a stake larger than the available balance', () => {
    const account = createPaperAccount({ startingBalance: 20 });
    expect(() =>
      openPaperPosition({
        account,
        asset: 'SYNTH',
        direction: 'call',
        stake: 50,
        entryPrice: 100,
        openedAt: 0,
        expirationSeconds: 60,
      }),
    ).toThrow(/exceeds the available balance/);
  });

  it('rejects invalid stakes and prices', () => {
    const account = createPaperAccount();
    const base = {
      account,
      asset: 'SYNTH',
      direction: 'call' as const,
      entryPrice: 100,
      openedAt: 0,
      expirationSeconds: 60,
    };
    expect(() => openPaperPosition({ ...base, stake: 0 })).toThrow(PaperTradingError);
    expect(() => openPaperPosition({ ...base, stake: 10, entryPrice: -1 })).toThrow(
      PaperTradingError,
    );
    expect(() => openPaperPosition({ ...base, stake: 10, expirationSeconds: 0 })).toThrow(
      PaperTradingError,
    );
  });

  it('does not mutate the account it was given', () => {
    const account = createPaperAccount({ startingBalance: 1000 });
    openPaperPosition({
      account,
      asset: 'SYNTH',
      direction: 'call',
      stake: 50,
      entryPrice: 100,
      openedAt: 0,
      expirationSeconds: 60,
    });
    expect(account.openExposure).toBe(0);
  });
});

describe('settlePaperPosition', () => {
  it('credits a win at the payout rate and releases the exposure', () => {
    const opened = openAccountWithPosition('call');
    const settled = settlePaperPosition(opened.account, opened.position, 101, 60_000);
    expect(settled.position.outcome).toBe('win');
    expect(settled.position.pnl).toBeCloseTo(40, 6); // 50 * 0.8
    expect(settled.account.balance).toBeCloseTo(1040, 6);
    expect(settled.account.openExposure).toBe(0);
    expect(settled.account.consecutiveLosses).toBe(0);
  });

  it('debits the full stake on a loss and records the loss time', () => {
    const opened = openAccountWithPosition('call');
    const settled = settlePaperPosition(opened.account, opened.position, 99, 60_000);
    expect(settled.position.outcome).toBe('loss');
    expect(settled.account.balance).toBeCloseTo(950, 6);
    expect(settled.account.consecutiveLosses).toBe(1);
    expect(settled.account.lastLossAt).toBe(60_000);
  });

  it('refunds an exact tie under the default payout model', () => {
    const opened = openAccountWithPosition('call');
    const settled = settlePaperPosition(opened.account, opened.position, 100, 60_000);
    expect(settled.position.outcome).toBe('tie');
    expect(settled.account.balance).toBe(1000);
  });

  it('settles a put correctly', () => {
    const opened = openAccountWithPosition('put');
    const settled = settlePaperPosition(opened.account, opened.position, 99, 60_000);
    expect(settled.position.outcome).toBe('win');
  });

  it('refuses to settle before expiry', () => {
    const opened = openAccountWithPosition();
    expect(() => settlePaperPosition(opened.account, opened.position, 101, 100)).toThrow(
      /before its expiry/,
    );
  });

  it('refuses to settle a position twice', () => {
    const opened = openAccountWithPosition();
    const settled = settlePaperPosition(opened.account, opened.position, 101, 60_000);
    expect(() => settlePaperPosition(settled.account, settled.position, 101, 60_000)).toThrow(
      /already settled/,
    );
  });

  it('refuses a position from another account', () => {
    const opened = openAccountWithPosition();
    const other = createPaperAccount({ id: 'acct_other' });
    expect(() => settlePaperPosition(other, opened.position, 101, 60_000)).toThrow(
      /does not belong/,
    );
  });
});

describe('cancelPaperPosition', () => {
  it('releases exposure without changing the balance', () => {
    const opened = openAccountWithPosition();
    const cancelled = cancelPaperPosition(opened.account, opened.position);
    expect(cancelled.position.status).toBe('cancelled');
    expect(cancelled.account.openExposure).toBe(0);
    expect(cancelled.account.balance).toBe(1000);
  });
});
