import type {
  Confirmation,
  Conflict,
  IndicatorInterpretation,
  IndicatorSnapshot,
  MarketRegime,
  StrategyEvaluation,
} from '@binaryai/types';
import { clamp01, round } from '@binaryai/utils';

/**
 * Builders for the evidence a strategy reports.
 *
 * Weights are "how strong is this piece of evidence", 0..1 -- NOT a probability
 * and not a contribution to the final score. Turning evidence into a score is
 * the confidence engine's job, so that every strategy is scored on one scale.
 */

export function confirmation(
  code: string,
  label: string,
  weight: number,
  detail: string,
): Confirmation {
  return { code, label, weight: round(clamp01(weight), 4), detail };
}

export function conflict(
  code: string,
  label: string,
  weight: number,
  severity: Conflict['severity'],
  detail: string,
): Conflict {
  return { code, label, weight: round(clamp01(weight), 4), severity, detail };
}

export function snapshot(
  key: string,
  label: string,
  value: number | null,
  interpretation: IndicatorInterpretation,
  detail?: string,
): IndicatorSnapshot {
  return {
    key,
    label,
    value: value === null ? null : round(value, 6),
    interpretation: value === null ? 'unavailable' : interpretation,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** A strategy declining to act. Never a 'none' direction with no explanation. */
export function abstain(
  strategyId: string,
  strategyVersion: string,
  reason: string,
  expirationSeconds: number,
  indicators: readonly IndicatorSnapshot[] = [],
  regimeHint: MarketRegime = 'unknown',
): StrategyEvaluation {
  return {
    strategyId,
    strategyVersion,
    direction: 'none',
    indicators,
    confirmations: [],
    conflicts: [],
    regimeHint,
    expirationSeconds,
    notes: [reason],
    abstainReason: reason,
  };
}
