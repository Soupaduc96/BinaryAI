import { describe, expect, it } from 'vitest';
import type { PaperPositionView } from '@/lib/api';
import { pipelineState } from './SignalIntelligence';

/**
 * The signal → action → position → outcome state resolution.
 *
 * This function decides what a user is told happened to a signal, so its
 * failure mode is not a crash but a false report: a signal shown as ACTIVE when
 * nothing was opened, or an expired position shown as SETTLED when no bar ever
 * settled it. The assertions below are about those distinctions rather than
 * about label text.
 *
 * The rule the whole function encodes: STATE COMES FROM THE RECORD. With no
 * position there is no action to describe, and the furthest this may say is
 * whether the engine accepted the signal.
 */

function position(overrides: Partial<PaperPositionView> = {}): PaperPositionView {
  return {
    id: 'pos-1',
    signalId: 'sig-1',
    assetSymbol: 'SYNTH',
    timeframe: '1m',
    direction: 'call',
    size: 5,
    entryPrice: 100,
    openedAt: 0,
    expiresAt: 60_000,
    status: 'open',
    settledAt: null,
    settlementPrice: null,
    result: null,
    dataOrigin: null,
    settlementCandleAt: null,
    simulation: null,
    ...overrides,
  };
}

const accepted = { status: 'accepted', direction: 'call' };

describe('pipelineState — with no position', () => {
  it('reports an accepted signal as available to act on', () => {
    expect(pipelineState(accepted, undefined)).toBe('available');
  });

  it('does not report any position state when no position exists', () => {
    // The dangerous failure: telling a user something is ACTIVE when nothing
    // was ever opened.
    const state = pipelineState(accepted, undefined);
    expect(['active', 'settled', 'action_taken', 'unresolved']).not.toContain(state);
  });

  it.each([['rejected'], ['skipped'], ['expired']])(
    'reports a %s signal as risk blocked rather than available',
    (status) => {
      expect(pipelineState({ status, direction: 'call' }, undefined)).toBe('risk_blocked');
    },
  );

  it('reports a directionless signal as risk blocked', () => {
    // A 'none' direction is not something an account can act on at all.
    expect(pipelineState({ status: 'accepted', direction: 'none' }, undefined)).toBe(
      'risk_blocked',
    );
  });
});

describe('pipelineState — with a position', () => {
  it('reports an open position as active', () => {
    expect(pipelineState(accepted, position({ status: 'open' }))).toBe('active');
  });

  it('reports a settled position as settled', () => {
    expect(pipelineState(accepted, position({ status: 'settled', result: 'win' }))).toBe('settled');
  });

  it('reports an expired position awaiting a bar as unresolved, never as settled', () => {
    // An expired position with no usable settling bar has no outcome. Calling
    // it settled would assert a result the market never produced.
    const state = pipelineState(accepted, position({ status: 'pending_settlement' }));
    expect(state).toBe('unresolved');
    expect(state).not.toBe('settled');
  });

  it('never reports unresolved as a loss-bearing settled state', () => {
    const unresolved = pipelineState(accepted, position({ status: 'pending_settlement' }));
    const settled = pipelineState(accepted, position({ status: 'settled', result: 'loss' }));
    expect(unresolved).not.toBe(settled);
  });

  it.each([['cancelled'], ['rejected']])(
    'reports a %s position as action taken rather than active',
    (status) => {
      // Something WAS recorded, but nothing is live. Reporting it as active
      // would show a position that cannot settle as if it were running.
      const state = pipelineState(accepted, position({ status: status as 'cancelled' }));
      expect(state).toBe('action_taken');
      expect(state).not.toBe('active');
    },
  );

  it('lets the position override the signal status', () => {
    // A position exists, so what happened to the signal is settled history:
    // the record wins over the engine's original verdict.
    expect(pipelineState({ status: 'rejected', direction: 'call' }, position())).toBe('active');
  });
});
