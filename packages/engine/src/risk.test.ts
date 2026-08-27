import { describe, expect, it } from 'vitest';
import type { Conflict, DataQualityReport, RegimeAssessment } from '@binaryai/types';
import {
  assertExecutionAllowed,
  assessRisk,
  DEFAULT_RISK_CONTEXT,
  DEFAULT_RISK_LIMITS,
  deriveRiskLevel,
  LiveExecutionDisabledError,
  resolveRiskLimits,
  type RiskInput,
} from './risk.js';

const regime: RegimeAssessment = {
  regime: 'trend_up',
  clarity: 0.9,
  trendDirection: 'up',
  trendStrength: 0.8,
  momentum: 0.6,
  volatility: { atr: 0.2, atrPercent: 0.2, level: 'normal' },
  metrics: {},
};

const dataQuality: DataQualityReport = {
  usable: true,
  score: 1,
  candleCount: 300,
  firstTimestamp: 0,
  lastTimestamp: 1,
  issues: [],
};

const baseInput: RiskInput = {
  direction: 'call',
  confidence: 0.8,
  conflicts: [],
  regime,
  dataQuality,
  limits: DEFAULT_RISK_LIMITS,
  context: { ...DEFAULT_RISK_CONTEXT, now: 1_000_000 },
};

describe('default limits', () => {
  it('ship with live execution disabled', () => {
    expect(DEFAULT_RISK_LIMITS.allowLiveExecution).toBe(false);
  });

  it('are conservative by default', () => {
    expect(DEFAULT_RISK_LIMITS.maxExposureFraction).toBeLessThanOrEqual(0.05);
    expect(DEFAULT_RISK_LIMITS.maxOpenPositions).toBeLessThanOrEqual(3);
    expect(DEFAULT_RISK_LIMITS.minConfidence).toBeGreaterThanOrEqual(0.5);
  });

  it('merge overrides without losing unspecified fields', () => {
    const limits = resolveRiskLimits({ minConfidence: 0.9 });
    expect(limits.minConfidence).toBe(0.9);
    expect(limits.allowLiveExecution).toBe(false);
  });
});

describe('assertExecutionAllowed', () => {
  it('throws for live mode while live execution is disabled', () => {
    expect(() => assertExecutionAllowed('live', DEFAULT_RISK_LIMITS)).toThrow(
      LiveExecutionDisabledError,
    );
  });

  it('permits demo mode', () => {
    expect(() => assertExecutionAllowed('demo', DEFAULT_RISK_LIMITS)).not.toThrow();
  });
});

describe('assessRisk', () => {
  it('allows a clean demo signal', () => {
    const result = assessRisk(baseInput);
    expect(result.outcome).toBe('allow');
    expect(result.blockedBy).toHaveLength(0);
  });

  it('blocks live mode outright', () => {
    const result = assessRisk({
      ...baseInput,
      context: { ...baseInput.context, executionMode: 'live' },
    });
    expect(result.outcome).toBe('block');
    expect(result.blockedBy).toContain('live_execution_disabled');
  });

  it('blocks when there is no direction', () => {
    expect(assessRisk({ ...baseInput, direction: 'none' }).blockedBy).toContain('no_direction');
  });

  it('blocks below the confidence threshold', () => {
    expect(assessRisk({ ...baseInput, confidence: 0.1 }).blockedBy).toContain(
      'confidence_below_threshold',
    );
  });

  it('blocks on unusable market data', () => {
    const result = assessRisk({
      ...baseInput,
      dataQuality: { ...dataQuality, usable: false, score: 0.2 },
    });
    expect(result.blockedBy).toContain('data_quality_too_low');
  });

  it('blocks when volatility exceeds the ceiling', () => {
    const result = assessRisk({
      ...baseInput,
      regime: { ...regime, volatility: { atr: 9, atrPercent: 9, level: 'extreme' } },
    });
    expect(result.blockedBy).toContain('volatility_too_high');
  });

  it('blocks a regime that is not on the allow-list', () => {
    const result = assessRisk({ ...baseInput, regime: { ...regime, regime: 'volatile' } });
    expect(result.blockedBy).toContain('regime_not_allowed');
  });

  it('blocks on a blocking conflict', () => {
    const blocking: Conflict = {
      code: 'trending_market',
      label: 'Trending',
      weight: 1,
      severity: 'blocking',
      detail: '',
    };
    expect(assessRisk({ ...baseInput, conflicts: [blocking] }).blockedBy).toContain(
      'blocking_conflict',
    );
  });

  it('blocks when the consecutive-loss limit is reached', () => {
    const result = assessRisk({
      ...baseInput,
      context: { ...baseInput.context, consecutiveLosses: 3 },
    });
    expect(result.blockedBy).toContain('consecutive_loss_limit');
  });

  it('blocks during the cooldown window and allows once it expires', () => {
    const now = 1_000_000;
    const during = assessRisk({
      ...baseInput,
      context: { ...baseInput.context, now, lastLossAt: now - 60_000 },
    });
    expect(during.blockedBy).toContain('cooldown_active');

    const after = assessRisk({
      ...baseInput,
      context: { ...baseInput.context, now, lastLossAt: now - 400_000 },
    });
    expect(after.blockedBy).not.toContain('cooldown_active');
  });

  it('blocks when the daily loss limit is hit', () => {
    const result = assessRisk({
      ...baseInput,
      context: { ...baseInput.context, dayStartBalance: 1000, accountBalance: 940 },
    });
    expect(result.blockedBy).toContain('daily_loss_limit');
  });

  it('blocks when the exposure budget is exhausted', () => {
    const result = assessRisk({
      ...baseInput,
      context: { ...baseInput.context, openExposure: 20 },
    });
    expect(result.blockedBy).toContain('exposure_limit');
    expect(result.maxStake).toBe(0);
  });

  it('caps the stake at the exposure fraction of the balance', () => {
    const result = assessRisk(baseInput);
    expect(result.maxStake).toBeCloseTo(1000 * DEFAULT_RISK_LIMITS.maxExposureFraction, 6);
  });

  it('reports every check it ran, passed or failed', () => {
    const result = assessRisk(baseInput);
    expect(result.checks.length).toBeGreaterThanOrEqual(12);
    expect(result.checks.every((check) => typeof check.detail === 'string')).toBe(true);
  });
});

describe('deriveRiskLevel', () => {
  it('is low for clean conditions', () => {
    expect(deriveRiskLevel(baseInput)).toBe('low');
  });

  it('rises with major conflicts', () => {
    const conflicts: Conflict[] = [
      { code: 'a', label: 'a', weight: 1, severity: 'major', detail: '' },
      { code: 'b', label: 'b', weight: 1, severity: 'major', detail: '' },
    ];
    expect(deriveRiskLevel({ ...baseInput, conflicts })).not.toBe('low');
  });

  it('is extreme when data is unusable in a volatile market', () => {
    const level = deriveRiskLevel({
      ...baseInput,
      confidence: 0.2,
      regime: {
        ...regime,
        regime: 'volatile',
        volatility: { atr: 9, atrPercent: 9, level: 'extreme' },
      },
      dataQuality: { ...dataQuality, usable: false, score: 0.1 },
    });
    expect(level).toBe('extreme');
  });
});
