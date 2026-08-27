import type { AccountRuleCode } from './paper.js';
import type { ExecutionMode, MarketRegime, RiskLevel } from './signal.js';

/**
 * Risk limits. Every field is a ceiling or a floor -- there is no field that
 * makes the system trade *more*. Defaults live in @binaryai/engine and are
 * deliberately conservative.
 */
export interface RiskLimits {
  /** Signals below this confidence are never promoted past 'candidate'. */
  readonly minConfidence: number;
  /** Highest acceptable risk level. */
  readonly maxRiskLevel: RiskLevel;
  /** Regimes in which signals may be accepted at all. */
  readonly allowedRegimes: readonly MarketRegime[];
  readonly maxOpenPositions: number;
  /** Fraction of balance allowed to be at risk simultaneously, 0..1. */
  readonly maxExposureFraction: number;
  /** Fraction of starting-of-day balance that may be lost before trading halts, 0..1. */
  readonly maxDailyLossFraction: number;
  /** Consecutive losses that trigger a halt. */
  readonly maxConsecutiveLosses: number;
  /** Enforced quiet period after a loss, in seconds. */
  readonly cooldownSecondsAfterLoss: number;
  /** Reject when ATR% exceeds this -- protects against unstable conditions. */
  readonly maxVolatilityAtrPercent: number;
  /** Reject when the data-quality score is below this, 0..1. */
  readonly minDataQualityScore: number;
  /**
   * Master switch for real-money execution. Ships as false and there is no
   * code path in this phase that sets it to true. See docs/risk-management.md.
   */
  readonly allowLiveExecution: boolean;
}

export interface RiskContext {
  readonly executionMode: ExecutionMode;
  readonly accountBalance: number;
  /** Balance at the start of the trading day, used for the daily-loss limit. */
  readonly dayStartBalance: number;
  readonly openPositions: number;
  /** Sum of stakes currently at risk. */
  readonly openExposure: number;
  readonly consecutiveLosses: number;
  /** Epoch ms of the most recent loss, or null. */
  readonly lastLossAt: number | null;
  readonly now: number;
}

export type RiskCheckCode =
  | 'live_execution_disabled'
  | 'confidence_below_threshold'
  | 'risk_level_too_high'
  | 'regime_not_allowed'
  | 'max_open_positions'
  | 'exposure_limit'
  | 'daily_loss_limit'
  | 'consecutive_loss_limit'
  | 'cooldown_active'
  | 'volatility_too_high'
  | 'data_quality_too_low'
  | 'blocking_conflict'
  | 'no_direction';

export interface RiskCheck {
  readonly code: RiskCheckCode;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface RiskAssessment {
  readonly outcome: 'allow' | 'block';
  readonly riskLevel: RiskLevel;
  readonly checks: readonly RiskCheck[];
  /** Codes of every failed check, in evaluation order. */
  readonly blockedBy: readonly RiskCheckCode[];
  /** Largest stake the limits permit right now, in account currency. */
  readonly maxStake: number;
  readonly notes: readonly string[];
}

export interface RiskEvent {
  readonly id: string;
  readonly at: number;
  /**
   * Signal-level check, account-level rule, or a lifecycle event.
   *
   * Account rules are included because a refused paper action is a risk event
   * in exactly the same sense a blocked signal is; giving them a separate table
   * would split one audit trail across two places.
   */
  readonly code: RiskCheckCode | AccountRuleCode | 'limits_updated' | 'halt' | 'resume';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly message: string;
  readonly executionMode: ExecutionMode;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}
