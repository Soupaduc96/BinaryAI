import { describe, expect, it } from 'vitest';
import type { Confirmation, Conflict, DataQualityReport, RegimeAssessment } from '@binaryai/types';
import { CONFIDENCE_WEIGHTS, scoreConfidence } from './confidence.js';

const regime: RegimeAssessment = {
  regime: 'trend_up',
  clarity: 0.8,
  trendDirection: 'up',
  trendStrength: 0.7,
  momentum: 0.5,
  volatility: { atr: 0.3, atrPercent: 0.3, level: 'normal' },
  metrics: {},
};

const dataQuality: DataQualityReport = {
  usable: true,
  score: 1,
  candleCount: 200,
  firstTimestamp: 0,
  lastTimestamp: 1,
  issues: [],
};

const confirmation = (weight: number): Confirmation => ({
  code: 'c',
  label: 'Confirmation',
  weight,
  detail: '',
});

const conflict = (weight: number, severity: Conflict['severity']): Conflict => ({
  code: 'x',
  label: 'Conflict',
  weight,
  severity,
  detail: '',
});

const baseInput = {
  direction: 'call' as const,
  confirmations: [confirmation(0.8), confirmation(0.6)],
  conflicts: [] as Conflict[],
  regime,
  dataQuality,
  requiredHistory: 50,
};

describe('confidence weights', () => {
  it('sum to exactly 1', () => {
    const total = Object.values(CONFIDENCE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('scoreConfidence', () => {
  it('always reports itself as uncalibrated with no sample behind it', () => {
    const result = scoreConfidence(baseInput);
    expect(result.calibration).toBe('uncalibrated_heuristic');
    expect(result.sampleSize).toBeNull();
    expect(result.disclaimer).toMatch(/not a win probability/i);
  });

  it('scores zero when there is no direction', () => {
    const result = scoreConfidence({ ...baseInput, direction: 'none' });
    expect(result.score).toBe(0);
    expect(result.components[0]?.key).toBe('no_direction');
  });

  it('stays within 0..1', () => {
    const extreme = scoreConfidence({
      ...baseInput,
      confirmations: Array.from({ length: 20 }, () => confirmation(1)),
    });
    expect(extreme.score).toBeGreaterThanOrEqual(0);
    expect(extreme.score).toBeLessThanOrEqual(1);
  });

  it('falls when conflicts are added', () => {
    const clean = scoreConfidence(baseInput).score;
    const conflicted = scoreConfidence({
      ...baseInput,
      conflicts: [conflict(0.8, 'major')],
    }).score;
    expect(conflicted).toBeLessThan(clean);
  });

  it('penalises a blocking conflict more than a minor one', () => {
    const minor = scoreConfidence({ ...baseInput, conflicts: [conflict(0.5, 'minor')] }).score;
    const blocking = scoreConfidence({
      ...baseInput,
      conflicts: [conflict(0.5, 'blocking')],
    }).score;
    expect(blocking).toBeLessThan(minor);
  });

  it('scores a counter-trend direction lower than a with-trend one', () => {
    const withTrend = scoreConfidence(baseInput).score;
    const against = scoreConfidence({ ...baseInput, direction: 'put' }).score;
    expect(against).toBeLessThan(withTrend);
  });

  it('penalises degraded data quality', () => {
    const degraded = scoreConfidence({
      ...baseInput,
      dataQuality: { ...dataQuality, score: 0.4, issues: [] },
    }).score;
    expect(degraded).toBeLessThan(scoreConfidence(baseInput).score);
  });

  it('penalises extreme volatility', () => {
    const volatile = scoreConfidence({
      ...baseInput,
      regime: {
        ...regime,
        volatility: { atr: 5, atrPercent: 5, level: 'extreme' },
      },
    }).score;
    expect(volatile).toBeLessThan(scoreConfidence(baseInput).score);
  });

  it('reports components whose contributions sum to the score', () => {
    const result = scoreConfidence(baseInput);
    const summed = result.components.reduce((total, item) => total + item.contribution, 0);
    expect(summed).toBeCloseTo(result.score, 3);
  });

  it('is deterministic', () => {
    expect(scoreConfidence(baseInput)).toStrictEqual(scoreConfidence(baseInput));
  });
});
