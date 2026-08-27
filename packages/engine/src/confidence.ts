import type {
  ConfidenceComponent,
  ConfidenceResult,
  Confirmation,
  Conflict,
  DataQualityReport,
  RegimeAssessment,
  SignalDirection,
} from '@binaryai/types';
import { clamp01, normalizeRange, round } from '@binaryai/utils';

/**
 * The confidence engine.
 *
 * WHAT THIS IS: a transparent weighted blend of six components, each derived
 * from the analysis and the strategy's own evidence.
 *
 * WHAT THIS IS NOT: a probability. Nothing here has been fitted to outcomes, so
 * a 0.80 does not mean 80% of such signals win. Every result is stamped
 * `uncalibrated_heuristic` with `sampleSize: null`, and the UI renders that
 * label beside the number. Calibration becomes possible once `signal_outcomes`
 * holds enough settled signals -- see docs/ai-architecture.md.
 */

export const CONFIDENCE_DISCLAIMER =
  'Heuristic score from rule-based evidence weighting. Not a win probability and not ' +
  'calibrated against historical outcomes.';

const SEVERITY_MULTIPLIER: Readonly<Record<Conflict['severity'], number>> = {
  minor: 0.5,
  major: 1,
  blocking: 2.5,
};

/** Component weights. They sum to 1 and are asserted to do so in the tests. */
export const CONFIDENCE_WEIGHTS = {
  evidenceBalance: 0.3,
  regimeAlignment: 0.2,
  momentumAgreement: 0.15,
  volatilityFit: 0.15,
  dataQuality: 0.1,
  historyDepth: 0.1,
} as const;

export interface ConfidenceInput {
  readonly direction: SignalDirection;
  readonly confirmations: readonly Confirmation[];
  readonly conflicts: readonly Conflict[];
  readonly regime: RegimeAssessment;
  readonly dataQuality: DataQualityReport;
  readonly requiredHistory: number;
  /** ATR% considered comfortable for short-dated expiries. */
  readonly comfortableAtrPercent?: number;
  readonly maxAtrPercent?: number;
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  if (input.direction === 'none') {
    return {
      score: 0,
      components: [
        {
          key: 'no_direction',
          label: 'No candidate direction',
          score: 0,
          weight: 1,
          contribution: 0,
          detail: 'The strategy did not produce a direction, so there is nothing to score.',
        },
      ],
      calibration: 'uncalibrated_heuristic',
      sampleSize: null,
      disclaimer: CONFIDENCE_DISCLAIMER,
    };
  }

  const components = [
    evidenceBalance(input),
    regimeAlignment(input),
    momentumAgreement(input),
    volatilityFit(input),
    dataQualityComponent(input),
    historyDepth(input),
  ];

  const score = components.reduce((total, component) => total + component.contribution, 0);

  return {
    score: round(clamp01(score), 4),
    components,
    calibration: 'uncalibrated_heuristic',
    sampleSize: null,
    disclaimer: CONFIDENCE_DISCLAIMER,
  };
}

function component(
  key: string,
  label: string,
  score: number,
  weight: number,
  detail: string,
): ConfidenceComponent {
  const bounded = clamp01(score);
  return {
    key,
    label,
    score: round(bounded, 4),
    weight,
    contribution: round(bounded * weight, 4),
    detail,
  };
}

/**
 * Confirmations against severity-weighted conflicts. The +0.6 prior stops a
 * single weak confirmation with no conflicts from scoring a perfect 1.0.
 */
function evidenceBalance(input: ConfidenceInput): ConfidenceComponent {
  const support = input.confirmations.reduce((total, item) => total + item.weight, 0);
  const opposition = input.conflicts.reduce(
    (total, item) => total + item.weight * SEVERITY_MULTIPLIER[item.severity],
    0,
  );
  const score = support / (support + opposition + 0.6);
  return component(
    'evidence_balance',
    'Evidence balance',
    score,
    CONFIDENCE_WEIGHTS.evidenceBalance,
    `${input.confirmations.length} confirmation(s) totalling ${round(support, 2)} against ` +
      `${input.conflicts.length} conflict(s) totalling ${round(opposition, 2)} (severity-weighted).`,
  );
}

function regimeAlignment(input: ConfidenceInput): ConfidenceComponent {
  const { regime } = input.regime;
  const wantsUp = input.direction === 'call';
  let base: number;
  let detail: string;

  switch (regime) {
    case 'trend_up':
      base = wantsUp ? 1 : 0.1;
      detail = wantsUp ? 'CALL aligns with the uptrend.' : 'PUT fights the uptrend.';
      break;
    case 'trend_down':
      base = wantsUp ? 0.1 : 1;
      detail = wantsUp ? 'CALL fights the downtrend.' : 'PUT aligns with the downtrend.';
      break;
    case 'range':
      base = 0.45;
      detail = 'Ranging market: direction is less reliable in either direction.';
      break;
    case 'quiet':
      base = 0.35;
      detail = 'Quiet market: moves may be too small to clear the spread by expiry.';
      break;
    case 'volatile':
      base = 0.2;
      detail = 'Volatile market: short-dated direction is unstable.';
      break;
    case 'unknown':
      base = 0.25;
      detail = 'Regime could not be classified from the available history.';
      break;
  }

  // A regime we are unsure about should not dominate the score either way.
  const clarityAdjusted = 0.5 + (base - 0.5) * clamp01(Math.max(input.regime.clarity, 0.35));
  return component(
    'regime_alignment',
    'Regime alignment',
    clarityAdjusted,
    CONFIDENCE_WEIGHTS.regimeAlignment,
    `${detail} Regime clarity ${round(input.regime.clarity, 2)}.`,
  );
}

function momentumAgreement(input: ConfidenceInput): ConfidenceComponent {
  const signed = input.direction === 'call' ? input.regime.momentum : -input.regime.momentum;
  const score = (signed + 1) / 2;
  return component(
    'momentum_agreement',
    'Momentum agreement',
    score,
    CONFIDENCE_WEIGHTS.momentumAgreement,
    `Directional momentum reads ${round(signed, 2)} on a -1..1 scale.`,
  );
}

function volatilityFit(input: ConfidenceInput): ConfidenceComponent {
  const { comfortableAtrPercent = 0.35, maxAtrPercent = 1.5 } = input;
  const atrPercent = input.regime.volatility.atrPercent;

  if (atrPercent === null) {
    return component(
      'volatility_fit',
      'Volatility fit',
      0.5,
      CONFIDENCE_WEIGHTS.volatilityFit,
      'ATR unavailable; scored neutrally rather than assumed favourable.',
    );
  }
  if (atrPercent <= comfortableAtrPercent) {
    // Too quiet is also a problem for binary expiries: price may not move enough.
    const score = 0.6 + 0.4 * normalizeRange(atrPercent, 0, comfortableAtrPercent);
    return component(
      'volatility_fit',
      'Volatility fit',
      score,
      CONFIDENCE_WEIGHTS.volatilityFit,
      `ATR ${round(atrPercent, 3)}% is at or below the comfortable floor.`,
    );
  }
  const score = 1 - normalizeRange(atrPercent, comfortableAtrPercent, maxAtrPercent * 1.5);
  return component(
    'volatility_fit',
    'Volatility fit',
    score,
    CONFIDENCE_WEIGHTS.volatilityFit,
    `ATR ${round(atrPercent, 3)}% against a ${maxAtrPercent}% ceiling.`,
  );
}

function dataQualityComponent(input: ConfidenceInput): ConfidenceComponent {
  return component(
    'data_quality',
    'Data quality',
    input.dataQuality.score,
    CONFIDENCE_WEIGHTS.dataQuality,
    `${input.dataQuality.issues.length} integrity issue(s) across ` +
      `${input.dataQuality.candleCount} candles.`,
  );
}

function historyDepth(input: ConfidenceInput): ConfidenceComponent {
  const required = Math.max(input.requiredHistory, 1);
  const score = normalizeRange(input.dataQuality.candleCount, required, required * 4);
  return component(
    'history_depth',
    'History depth',
    score,
    CONFIDENCE_WEIGHTS.historyDepth,
    `${input.dataQuality.candleCount} candles against a ${required}-candle minimum.`,
  );
}
