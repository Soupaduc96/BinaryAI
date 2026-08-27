import type {
  Conflict,
  DataQualityReport,
  ExecutionMode,
  RegimeAssessment,
  RiskAssessment,
  RiskCheck,
  RiskCheckCode,
  RiskContext,
  RiskLevel,
  RiskLimits,
  SignalDirection,
} from '@binaryai/types';
import { round } from '@binaryai/utils';

/**
 * The risk engine.
 *
 * Every rule here can only ever REDUCE activity. There is deliberately no
 * setting that increases stake, loosens a filter automatically, or "recovers"
 * losses -- martingale-style behaviour is the fastest way to ruin an account
 * and is out of scope by design. See docs/risk-management.md.
 */

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  minConfidence: 0.6,
  maxRiskLevel: 'medium',
  allowedRegimes: ['trend_up', 'trend_down', 'range'],
  maxOpenPositions: 1,
  maxExposureFraction: 0.02,
  maxDailyLossFraction: 0.05,
  maxConsecutiveLosses: 3,
  cooldownSecondsAfterLoss: 300,
  maxVolatilityAtrPercent: 1.5,
  minDataQualityScore: 0.8,
  // Ships false. No code path in this phase sets it true; see assertExecutionAllowed.
  allowLiveExecution: false,
};

export function resolveRiskLimits(overrides: Partial<RiskLimits> = {}): RiskLimits {
  return { ...DEFAULT_RISK_LIMITS, ...overrides };
}

export const DEFAULT_RISK_CONTEXT: RiskContext = {
  executionMode: 'demo',
  accountBalance: 1000,
  dayStartBalance: 1000,
  openPositions: 0,
  openExposure: 0,
  consecutiveLosses: 0,
  lastLossAt: null,
  now: 0,
};

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  extreme: 3,
};

export interface RiskInput {
  readonly direction: SignalDirection;
  readonly confidence: number;
  readonly conflicts: readonly Conflict[];
  readonly regime: RegimeAssessment;
  readonly dataQuality: DataQualityReport;
  readonly limits: RiskLimits;
  readonly context: RiskContext;
}

/**
 * Derive a risk level from conditions. Independent of the confidence score so
 * that a confident signal in dangerous conditions is still reported as risky.
 */
export function deriveRiskLevel(input: RiskInput): RiskLevel {
  let points = 0;

  for (const conflict of input.conflicts) {
    if (conflict.severity === 'blocking') points += 3;
    else if (conflict.severity === 'major') points += 1;
  }

  const volatility = input.regime.volatility.level;
  if (volatility === 'extreme') points += 2;
  else if (volatility === 'high') points += 1;

  if (input.regime.regime === 'volatile' || input.regime.regime === 'unknown') points += 1;
  if (input.confidence < 0.5) points += 1;
  if (input.dataQuality.score < 0.9) points += 1;
  if (!input.dataQuality.usable) points += 2;

  if (points >= 6) return 'extreme';
  if (points >= 4) return 'high';
  if (points >= 2) return 'medium';
  return 'low';
}

function check(code: RiskCheckCode, label: string, passed: boolean, detail: string): RiskCheck {
  return { code, label, passed, detail };
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const { limits, context, regime, dataQuality } = input;
  const riskLevel = deriveRiskLevel(input);
  const checks: RiskCheck[] = [];

  checks.push(
    check(
      'live_execution_disabled',
      'Execution mode',
      context.executionMode === 'demo' || limits.allowLiveExecution,
      context.executionMode === 'demo'
        ? 'Demo mode: no real-money execution is possible.'
        : 'Live execution is disabled in this build.',
    ),
  );

  checks.push(
    check(
      'no_direction',
      'Direction',
      input.direction !== 'none',
      input.direction === 'none'
        ? 'No candidate direction was produced.'
        : `Direction ${input.direction}.`,
    ),
  );

  checks.push(
    check(
      'data_quality_too_low',
      'Data quality',
      dataQuality.usable && dataQuality.score >= limits.minDataQualityScore,
      `Score ${round(dataQuality.score, 2)} against a ${limits.minDataQualityScore} minimum` +
        (dataQuality.usable ? '.' : ' (series has blocking integrity errors).'),
    ),
  );

  const atrPercent = regime.volatility.atrPercent;
  checks.push(
    check(
      'volatility_too_high',
      'Volatility',
      atrPercent === null || atrPercent <= limits.maxVolatilityAtrPercent,
      atrPercent === null
        ? 'ATR unavailable.'
        : `ATR ${round(atrPercent, 3)}% against a ${limits.maxVolatilityAtrPercent}% ceiling.`,
    ),
  );

  checks.push(
    check(
      'regime_not_allowed',
      'Market regime',
      limits.allowedRegimes.includes(regime.regime),
      `Regime ${regime.regime}; allowed: ${limits.allowedRegimes.join(', ')}.`,
    ),
  );

  checks.push(
    check(
      'confidence_below_threshold',
      'Confidence threshold',
      input.confidence >= limits.minConfidence,
      `Confidence ${round(input.confidence, 3)} against a ${limits.minConfidence} minimum.`,
    ),
  );

  checks.push(
    check(
      'risk_level_too_high',
      'Risk level',
      RISK_ORDER[riskLevel] <= RISK_ORDER[limits.maxRiskLevel],
      `Risk ${riskLevel}; ceiling ${limits.maxRiskLevel}.`,
    ),
  );

  const blocking = input.conflicts.filter((conflict) => conflict.severity === 'blocking');
  checks.push(
    check(
      'blocking_conflict',
      'Blocking conflicts',
      blocking.length === 0,
      blocking.length === 0
        ? 'No blocking conflicts.'
        : `Blocked by: ${blocking.map((conflict) => conflict.code).join(', ')}.`,
    ),
  );

  checks.push(
    check(
      'max_open_positions',
      'Open positions',
      context.openPositions < limits.maxOpenPositions,
      `${context.openPositions} open against a ${limits.maxOpenPositions} limit.`,
    ),
  );

  const exposureCap = context.accountBalance * limits.maxExposureFraction;
  const remainingExposure = Math.max(exposureCap - context.openExposure, 0);
  checks.push(
    check(
      'exposure_limit',
      'Exposure',
      remainingExposure > 0,
      `${round(remainingExposure, 2)} of ${round(exposureCap, 2)} exposure budget remaining.`,
    ),
  );

  const dailyLoss = context.dayStartBalance - context.accountBalance;
  const dailyLossCap = context.dayStartBalance * limits.maxDailyLossFraction;
  checks.push(
    check(
      'daily_loss_limit',
      'Daily loss limit',
      dailyLoss < dailyLossCap,
      `${round(Math.max(dailyLoss, 0), 2)} lost today against a ${round(dailyLossCap, 2)} limit.`,
    ),
  );

  checks.push(
    check(
      'consecutive_loss_limit',
      'Consecutive losses',
      context.consecutiveLosses < limits.maxConsecutiveLosses,
      `${context.consecutiveLosses} consecutive against a ${limits.maxConsecutiveLosses} limit.`,
    ),
  );

  const cooldownUntil =
    context.lastLossAt === null
      ? null
      : context.lastLossAt + limits.cooldownSecondsAfterLoss * 1000;
  checks.push(
    check(
      'cooldown_active',
      'Cooldown',
      cooldownUntil === null || context.now >= cooldownUntil,
      cooldownUntil === null || context.now >= cooldownUntil
        ? 'No cooldown in effect.'
        : `Cooldown active for another ${Math.ceil((cooldownUntil - context.now) / 1000)}s.`,
    ),
  );

  const blockedBy = checks.filter((item) => !item.passed).map((item) => item.code);
  const notes: string[] = [];
  if (context.executionMode === 'demo') {
    notes.push('Demo mode. Nothing here places a real order.');
  }
  if (blockedBy.length > 0) {
    notes.push(`Blocked by ${blockedBy.length} failed check(s).`);
  }

  return {
    outcome: blockedBy.length === 0 ? 'allow' : 'block',
    riskLevel,
    checks,
    blockedBy,
    maxStake: round(remainingExposure, 2),
    notes,
  };
}

export class LiveExecutionDisabledError extends Error {
  constructor() {
    super(
      'Live execution is disabled in this build. BinaryAI is demo-only until a live ' +
        'integration is explicitly implemented and reviewed.',
    );
    this.name = 'LiveExecutionDisabledError';
  }
}

/**
 * The hard gate. Any future execution path must call this first; today it
 * always throws for live mode, and the tests assert that it does.
 */
export function assertExecutionAllowed(mode: ExecutionMode, limits: RiskLimits): void {
  if (mode === 'live' && !limits.allowLiveExecution) throw new LiveExecutionDisabledError();
}
