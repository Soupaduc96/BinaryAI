import type { ConfidenceResult } from './confidence.js';
import type { DataQualityReport, MarketDataSource, Timeframe } from './market.js';

export type SignalDirection = 'call' | 'put' | 'none';

/** Coarse market classification produced by the rule-based regime classifier. */
export type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'volatile' | 'quiet' | 'unknown';

export type RiskLevel = 'low' | 'medium' | 'high' | 'extreme';

export type SignalStatus =
  'candidate' | 'accepted' | 'rejected' | 'expired' | 'settled' | 'cancelled';

/**
 * What BinaryAI suggests a human considers. Never an instruction to execute --
 * the platform is decision *support*. See docs/risk-management.md.
 */
export type SignalRecommendation = 'consider' | 'wait_for_confirmation' | 'skip';

/** Demo and live are separate universes; state never crosses between them. */
export type ExecutionMode = 'demo' | 'live';

export type IndicatorInterpretation = 'bullish' | 'bearish' | 'neutral' | 'unavailable';

export interface IndicatorSnapshot {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly interpretation: IndicatorInterpretation;
  readonly detail?: string;
}

/** A piece of evidence supporting the candidate direction. Weight is 0..1. */
export interface Confirmation {
  readonly code: string;
  readonly label: string;
  readonly weight: number;
  readonly detail: string;
}

/** Evidence against the candidate direction, or a condition that degrades it. */
export interface Conflict {
  readonly code: string;
  readonly label: string;
  readonly weight: number;
  readonly severity: 'minor' | 'major' | 'blocking';
  readonly detail: string;
}

/**
 * Who produced the natural-language reasoning. The UI shows this so that a
 * rule-engine template is never mistaken for model output.
 */
export type ReasoningSource = 'rule_engine' | 'ai_model';

export interface SignalReasoning {
  readonly summary: string;
  readonly supporting: readonly string[];
  readonly opposing: readonly string[];
  readonly caveats: readonly string[];
  readonly generatedBy: ReasoningSource;
  /** Populated only when generatedBy is 'ai_model'. */
  readonly model?: string;
}

export interface StrategyRef {
  readonly id: string;
  readonly version: string;
  readonly name: string;
}

export interface SignalExpiration {
  readonly seconds: number;
  /** Epoch ms at which the binary option would settle. */
  readonly expiresAt: number;
}

/**
 * The canonical internal signal object. Produced by the decision pipeline,
 * persisted to `signals`, rendered by the dashboard.
 */
export interface Signal {
  readonly id: string;
  readonly createdAt: number;
  readonly asset: string;
  readonly timeframe: Timeframe;
  readonly direction: SignalDirection;
  /** Epoch ms of the candle the decision was made on. */
  readonly timestamp: number;
  readonly price: number;
  readonly expiration: SignalExpiration;
  readonly confidence: ConfidenceResult;
  readonly riskLevel: RiskLevel;
  readonly marketRegime: MarketRegime;
  readonly strategy: StrategyRef;
  readonly indicators: readonly IndicatorSnapshot[];
  readonly confirmations: readonly Confirmation[];
  readonly conflicts: readonly Conflict[];
  readonly reasoning: SignalReasoning;
  readonly status: SignalStatus;
  readonly recommendation: SignalRecommendation;
  readonly executionMode: ExecutionMode;
  readonly dataSource: MarketDataSource;
  readonly dataQuality: DataQualityReport;
}

/** Ground truth recorded after expiry; the input to future calibration. */
export interface SignalOutcome {
  readonly signalId: string;
  readonly settledAt: number;
  readonly settlementPrice: number;
  readonly result: 'win' | 'loss' | 'tie' | 'unresolved';
  readonly priceDelta: number;
}
