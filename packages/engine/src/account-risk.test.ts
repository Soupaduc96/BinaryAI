import { describe, expect, it } from 'vitest';
import type { AccountRiskPolicy } from '@binaryai/types';
import {
  allowlistPermits,
  applyPolicyUpdate,
  defaultAccountPolicy,
  evaluateAccountAction,
  exposureWindow,
  isValidSize,
  tightenLimits,
  validatePolicy,
  type AccountRiskContext,
  type SignalCandidate,
} from './account-risk.js';
import { DEFAULT_RISK_LIMITS } from './risk.js';

/**
 * Account risk enforcement.
 *
 * These are the rules that decide whether a user's paper action is permitted.
 * The properties they defend are the ones a bug would quietly remove: a limit
 * that binds, an allowlist that fails closed, and a size that cannot be
 * malformed.
 */

const NOW = 1_800_000_000_000;

function policy(overrides: Partial<AccountRiskPolicy> = {}): AccountRiskPolicy {
  return { ...defaultAccountPolicy('account-1', NOW), ...overrides };
}

function signal(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    id: 'signal-1',
    assetSymbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'call',
    status: 'accepted',
    strategyKey: 'trend-momentum',
    expiresAt: NOW + 300_000,
    entryPrice: 100,
    dataOrigin: 'exchange',
    ...overrides,
  };
}

function context(overrides: Partial<AccountRiskContext> = {}): AccountRiskContext {
  return {
    accountActive: true,
    openPositions: 0,
    exposureInWindow: 0,
    consecutiveLosses: 0,
    lastLossAt: null,
    availableUnits: 100,
    // Default to the ACCOUNT figures, which is what a caller that does not
    // distinguish instruments supplies — the conservative default.
    instrumentOpenPositions: 0,
    instrumentExposureInWindow: 0,
    instrumentLastLossAt: null,
    ...overrides,
  };
}

const decide = (over: {
  policy?: Partial<AccountRiskPolicy>;
  signal?: Partial<SignalCandidate>;
  context?: Partial<AccountRiskContext>;
  size?: number;
}) =>
  evaluateAccountAction({
    policy: policy(over.policy),
    signal: signal(over.signal),
    context: context(over.context),
    size: over.size ?? 5,
    now: NOW,
  });

describe('defaults', () => {
  it('gives a new account a usable, bounded policy immediately', () => {
    const fresh = defaultAccountPolicy('account-1', NOW);

    // There must be no window in which an account has no policy.
    expect(fresh.version).toBe(1);
    expect(validatePolicy(fresh)).toEqual([]);
    expect(fresh.limits.maxOpenPositions).toBe(1);
    expect(fresh.limits.allowLiveExecution).toBe(false);
  });

  it('leaves allowlists unset rather than empty', () => {
    const fresh = defaultAccountPolicy('account-1', NOW);

    // `[]` would mean "allow none" and a new account could act on nothing,
    // which looks broken rather than safe.
    expect(fresh.allowedStrategies).toBeNull();
    expect(fresh.allowedTimeframes).toBeNull();
    expect(fresh.allowedAssets).toBeNull();
  });

  it('permits an ordinary action under the defaults', () => {
    expect(decide({}).allowed).toBe(true);
    expect(decide({}).outcome).toBe('allowed');
  });
});

describe('size validation', () => {
  it('rejects every malformed numeric value', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, -0]) {
      expect(isValidSize(bad), `${String(bad)} must be rejected`).toBe(false);
    }
    expect(isValidSize(0.5)).toBe(true);
  });

  it('rejects negative zero specifically', () => {
    // -0 passes a naive `size >= 0` check and then serializes as "-0".
    expect(isValidSize(-0)).toBe(false);
    expect(decide({ size: -0 }).allowed).toBe(false);
  });

  it('blocks a malformed size at the decision layer too', () => {
    const decision = decide({ size: Number.NaN });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('position_size_valid');
  });

  it('enforces the maximum position size', () => {
    const decision = decide({ policy: { maxPositionSize: 10 }, size: 11 });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('max_position_size');
    const rule = decision.evaluations.find((r) => r.code === 'max_position_size');
    // Auditable: the observed value and the limit both travel with the refusal.
    expect(rule?.observed).toBe(11);
    expect(rule?.limit).toBe(10);
  });
});

describe('concurrency limit', () => {
  it('permits an action while a slot remains', () => {
    expect(
      decide({
        policy: { limits: { ...DEFAULT_RISK_LIMITS, maxOpenPositions: 2 } },
        context: { openPositions: 1 },
      }).allowed,
    ).toBe(true);
  });

  it('blocks when the limit is reached and says so precisely', () => {
    const decision = decide({ context: { openPositions: 1 } });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('limit_reached');
    expect(decision.blockedBy).toContain('max_open_positions');
  });

  it('treats the limit as a ceiling, not a target', () => {
    const limits = { ...DEFAULT_RISK_LIMITS, maxOpenPositions: 3 };
    expect(decide({ policy: { limits }, context: { openPositions: 2 } }).allowed).toBe(true);
    expect(decide({ policy: { limits }, context: { openPositions: 3 } }).allowed).toBe(false);
  });

  it('a zero limit blocks everything', () => {
    const limits = { ...DEFAULT_RISK_LIMITS, maxOpenPositions: 0 };
    expect(decide({ policy: { limits }, context: { openPositions: 0 } }).allowed).toBe(false);
  });
});

describe('exposure window', () => {
  it('is a rolling 24 hours ending now', () => {
    // Not a calendar day: that needs a timezone, and any choice would silently
    // move when the limit resets.
    const window = exposureWindow(NOW);
    expect(window.toMs).toBe(NOW);
    expect(window.fromMs).toBe(NOW - 24 * 60 * 60 * 1000);
  });

  it('blocks when the action would exceed the window ceiling', () => {
    const decision = decide({
      policy: { maxDailyExposure: 50 },
      context: { exposureInWindow: 48 },
      size: 5,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('daily_exposure_limit');
    const rule = decision.evaluations.find((r) => r.code === 'daily_exposure_limit');
    // The PROJECTED total, not the current one: that is what the limit binds on.
    expect(rule?.observed).toBe(53);
    expect(rule?.window).not.toBeNull();
  });

  it('permits an action that lands exactly on the ceiling', () => {
    expect(
      decide({ policy: { maxDailyExposure: 50 }, context: { exposureInWindow: 45 }, size: 5 })
        .allowed,
    ).toBe(true);
  });
});

describe('allocation', () => {
  it('blocks an action larger than the available units', () => {
    const decision = decide({ context: { availableUnits: 3 }, size: 5 });

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('sufficient_units');
  });

  it('permits an action that exactly consumes the remaining units', () => {
    expect(decide({ context: { availableUnits: 5 }, size: 5 }).allowed).toBe(true);
  });
});

describe('loss streak and cooldown', () => {
  it('blocks at the consecutive-loss limit', () => {
    const decision = decide({ context: { consecutiveLosses: 3 } });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('limit_reached');
    expect(decision.blockedBy).toContain('consecutive_loss_limit');
  });

  it('enforces a cooldown after a loss and reports when it clears', () => {
    const decision = decide({ context: { lastLossAt: NOW - 60_000 } });

    // Default cooldown is 300s; 60s have passed.
    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('cooldown');
    expect(decision.retryAfterMs).toBe(240_000);
  });

  it('clears the cooldown once it elapses', () => {
    const decision = decide({ context: { lastLossAt: NOW - 300_001 } });
    expect(decision.allowed).toBe(true);
    expect(decision.retryAfterMs).toBeNull();
  });

  it('reports cooldown rather than a generic block, because it clears itself', () => {
    // A user can act on "wait 4 minutes"; "blocked" tells them nothing.
    expect(decide({ context: { lastLossAt: NOW - 1000 } }).outcome).toBe('cooldown');
  });
});

describe('allowlists', () => {
  it('null means unrestricted', () => {
    expect(allowlistPermits(null, 'anything')).toBe(true);
    expect(decide({ policy: { allowedAssets: null } }).allowed).toBe(true);
  });

  it('an empty list means allow NONE and fails closed', () => {
    // The distinction that matters: an operator who cleared a list expressed
    // "nothing", and reading that as "everything" would invert the restriction.
    expect(allowlistPermits([], 'BTC-USD')).toBe(false);
    const decision = decide({ policy: { allowedAssets: [] } });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('asset_allowed');
  });

  it('permits a listed value and blocks an unlisted one', () => {
    expect(decide({ policy: { allowedAssets: ['BTC-USD'] } }).allowed).toBe(true);
    expect(decide({ policy: { allowedAssets: ['ETH-USD'] } }).allowed).toBe(false);
  });

  it('restricts strategies', () => {
    expect(decide({ policy: { allowedStrategies: ['trend-momentum'] } }).allowed).toBe(true);
    const blocked = decide({ policy: { allowedStrategies: ['range-mean-reversion'] } });
    expect(blocked.blockedBy).toContain('strategy_allowed');
  });

  it('restricts timeframes', () => {
    expect(decide({ policy: { allowedTimeframes: ['5m'] } }).allowed).toBe(true);
    expect(decide({ policy: { allowedTimeframes: ['1h'] } }).blockedBy).toContain(
      'timeframe_allowed',
    );
  });
});

describe('signal eligibility', () => {
  it('refuses a rejected signal', () => {
    // The engine declined to act on it. An account must not be able to override
    // that by acting on it anyway.
    const decision = decide({ signal: { status: 'rejected' } });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('signal_actionable');
    expect(decision.outcome).toBe('insufficient_context');
  });

  it('refuses a signal that made no directional claim', () => {
    expect(decide({ signal: { direction: 'none' } }).allowed).toBe(false);
  });

  it('refuses an already-expired signal', () => {
    expect(decide({ signal: { expiresAt: NOW - 1 } }).allowed).toBe(false);
  });

  it('refuses a candidate that was never accepted', () => {
    expect(decide({ signal: { status: 'candidate' } }).allowed).toBe(false);
  });
});

describe('policy validation', () => {
  it('accepts a coherent policy', () => {
    expect(validatePolicy(policy())).toEqual([]);
  });

  it('rejects a position size larger than the window ceiling', () => {
    // Otherwise a single action could exceed the daily limit, which would make
    // the daily limit unreachable and therefore decorative.
    const problems = validatePolicy(policy({ maxPositionSize: 100, maxDailyExposure: 50 }));
    expect(problems.join(' ')).toMatch(/could never bind/);
  });

  it('rejects malformed numeric limits', () => {
    expect(validatePolicy(policy({ maxPositionSize: 0 })).length).toBeGreaterThan(0);
    expect(validatePolicy(policy({ maxDailyExposure: Number.NaN })).length).toBeGreaterThan(0);
  });

  it('refuses to act under a policy claiming live execution', () => {
    const problems = validatePolicy(
      policy({ limits: { ...DEFAULT_RISK_LIMITS, allowLiveExecution: true } }),
    );
    expect(problems.join(' ')).toMatch(/demo-only/i);
  });

  it('fails closed on an incoherent policy rather than using defaults', () => {
    const decision = decide({ policy: { maxPositionSize: -1 } });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('invalid_policy');
  });
});

describe('policy updates', () => {
  it('bumps the version on every change', () => {
    const first = defaultAccountPolicy('account-1', NOW);
    const second = applyPolicyUpdate(first, { maxPositionSize: 5 }, NOW + 1);

    expect(second.version).toBe(first.version + 1);
    expect(second.updatedAt).toBe(NOW + 1);
  });

  it('never lets an update enable live execution', () => {
    const updated = applyPolicyUpdate(
      defaultAccountPolicy('account-1', NOW),
      { limits: { allowLiveExecution: true } as never },
      NOW,
    );
    expect(updated.limits.allowLiveExecution).toBe(false);
  });

  it('distinguishes an omitted allowlist from an explicit null', () => {
    const base = { ...defaultAccountPolicy('account-1', NOW), allowedAssets: ['BTC-USD'] };

    // Omitted: unchanged. Explicit null: cleared.
    expect(applyPolicyUpdate(base, {}, NOW).allowedAssets).toEqual(['BTC-USD']);
    expect(applyPolicyUpdate(base, { allowedAssets: null }, NOW).allowedAssets).toBeNull();
    expect(applyPolicyUpdate(base, { allowedAssets: [] }, NOW).allowedAssets).toEqual([]);
  });
});

describe('tightenLimits', () => {
  it('accepts a stricter override', () => {
    const tightened = tightenLimits(DEFAULT_RISK_LIMITS, { minConfidence: 0.9 });
    expect(tightened.minConfidence).toBe(0.9);
  });

  it('refuses a looser override', () => {
    // The whole point: a request must not be able to relax the stored policy,
    // or the policy would be advisory.
    const tightened = tightenLimits(DEFAULT_RISK_LIMITS, { minConfidence: 0.1 });
    expect(tightened.minConfidence).toBe(DEFAULT_RISK_LIMITS.minConfidence);
  });

  it('knows which direction is stricter per field', () => {
    const base = { ...DEFAULT_RISK_LIMITS, maxOpenPositions: 5, cooldownSecondsAfterLoss: 60 };

    // Ceilings tighten downward; floors and cooldowns tighten upward.
    expect(tightenLimits(base, { maxOpenPositions: 2 }).maxOpenPositions).toBe(2);
    expect(tightenLimits(base, { maxOpenPositions: 9 }).maxOpenPositions).toBe(5);
    expect(tightenLimits(base, { cooldownSecondsAfterLoss: 600 }).cooldownSecondsAfterLoss).toBe(
      600,
    );
    expect(tightenLimits(base, { cooldownSecondsAfterLoss: 10 }).cooldownSecondsAfterLoss).toBe(60);
  });

  it('intersects allowed regimes rather than replacing them', () => {
    const base = { ...DEFAULT_RISK_LIMITS, allowedRegimes: ['trend_up', 'range'] as const };
    const tightened = tightenLimits(base, { allowedRegimes: ['range', 'volatile'] });

    // 'volatile' was not permitted before and must not become permitted now.
    expect(tightened.allowedRegimes).toEqual(['range']);
  });

  it('never permits live execution from any direction', () => {
    expect(
      tightenLimits(DEFAULT_RISK_LIMITS, { allowLiveExecution: true }).allowLiveExecution,
    ).toBe(false);
  });

  it('is a no-op without overrides', () => {
    expect(tightenLimits(DEFAULT_RISK_LIMITS, undefined)).toEqual(DEFAULT_RISK_LIMITS);
  });
});

describe('decision auditability', () => {
  it('reports every rule, not only the failing one', () => {
    const decision = decide({ context: { openPositions: 5 } });

    // A user blocked by several rules should not have to fix them one request
    // at a time.
    expect(decision.evaluations.length).toBeGreaterThan(8);
    expect(decision.evaluations.every((rule) => typeof rule.detail === 'string')).toBe(true);
  });

  it('stamps the policy version on the decision', () => {
    const decision = decide({ policy: { version: 7 } });
    // Without this, a risk event becomes uninterpretable after a policy edit.
    expect(decision.policyVersion).toBe(7);
  });

  it('is deterministic for identical inputs', () => {
    const a = decide({ context: { openPositions: 1 } });
    const b = decide({ context: { openPositions: 1 } });
    expect(a).toEqual(b);
  });

  it('reports an inactive account as insufficient context', () => {
    const decision = decide({ context: { accountActive: false } });
    expect(decision.outcome).toBe('insufficient_context');
  });
});
