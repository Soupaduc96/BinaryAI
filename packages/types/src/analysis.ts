import type { DataQualityReport, Timeframe } from './market.js';
import type { IndicatorSnapshot, MarketRegime } from './signal.js';

export type VolatilityLevel = 'low' | 'normal' | 'high' | 'extreme';

export interface VolatilityAssessment {
  /** Average True Range in price units. */
  readonly atr: number | null;
  /** ATR as a percentage of price -- comparable across assets. */
  readonly atrPercent: number | null;
  readonly level: VolatilityLevel;
}

export interface RegimeAssessment {
  readonly regime: MarketRegime;
  /** How clearly the data fits the chosen regime, 0..1. Rule-based. */
  readonly clarity: number;
  readonly trendDirection: 'up' | 'down' | 'flat';
  /** 0..1, derived from ADX. */
  readonly trendStrength: number;
  /** -1..1, derived from RSI and rate of change. */
  readonly momentum: number;
  readonly volatility: VolatilityAssessment;
  /** Raw numbers behind the assessment, for display and debugging. */
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface MarketAnalysis {
  readonly asset: string;
  readonly timeframe: Timeframe;
  /** Epoch ms of the last candle analysed. */
  readonly at: number;
  readonly lastPrice: number;
  readonly regime: RegimeAssessment;
  readonly indicators: readonly IndicatorSnapshot[];
  readonly dataQuality: DataQualityReport;
}
