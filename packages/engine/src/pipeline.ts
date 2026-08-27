import { resolveParameters } from '@binaryai/strategies';
import type {
  CandleSeries,
  ExecutionMode,
  MarketAnalysis,
  MarketAsset,
  RiskAssessment,
  RiskContext,
  RiskLimits,
  Signal,
  SignalRecommendation,
  SignalStatus,
  Strategy,
  StrategyEvaluation,
  StrategyParameters,
} from '@binaryai/types';
import { createPrefixedId, InvariantError } from '@binaryai/utils';
import { scoreConfidence } from './confidence.js';
import { assessDataQuality } from './market-data.js';
import { buildReasoning } from './reasoning.js';
import { classifyRegime, type RegimeOptions } from './regime.js';
import { assessRisk, DEFAULT_RISK_CONTEXT, resolveRiskLimits } from './risk.js';

/**
 * The decision pipeline.
 *
 * validate -> analyse -> strategy -> confidence -> risk -> decision
 *
 * The order matters and is enforced here rather than left to callers: a signal
 * can never be produced without a data-quality report, and a recommendation can
 * never be produced without a risk assessment. That is the whole point of
 * section 2 of the brief.
 */

export interface DecisionRequest {
  readonly asset: MarketAsset;
  readonly series: CandleSeries;
  readonly strategy: Strategy;
  readonly parameters?: StrategyParameters;
  readonly executionMode?: ExecutionMode;
  readonly riskLimits?: Partial<RiskLimits>;
  readonly riskContext?: Partial<RiskContext>;
  readonly regimeOptions?: RegimeOptions;
  /** Epoch ms treated as "now". Defaults to the last candle's timestamp. */
  readonly now?: number;
  /** Injectable so backtests can produce reproducible ids. */
  readonly idFactory?: () => string;
}

export interface DecisionResult {
  readonly analysis: MarketAnalysis;
  readonly evaluation: StrategyEvaluation;
  readonly risk: RiskAssessment;
  readonly signal: Signal;
}

/** Analysis only -- no strategy, no signal. Used by the /v1/analysis endpoint. */
export function analyzeMarket(
  series: CandleSeries,
  options: { requiredHistory?: number; regimeOptions?: RegimeOptions } = {},
): MarketAnalysis {
  const dataQuality = assessDataQuality(series, {
    ...(options.requiredHistory === undefined ? {} : { requiredHistory: options.requiredHistory }),
  });
  const regime = classifyRegime(series, options.regimeOptions ?? {});
  const last = series.candles.at(-1);

  return {
    asset: series.asset,
    timeframe: series.timeframe,
    at: last?.timestamp ?? 0,
    lastPrice: last?.close ?? 0,
    regime,
    indicators: [],
    dataQuality,
  };
}

export function evaluateDecision(request: DecisionRequest): DecisionResult {
  const {
    asset,
    series,
    strategy,
    executionMode = 'demo',
    idFactory = () => createPrefixedId('sig'),
  } = request;

  const lastCandle = series.candles.at(-1);
  const now = request.now ?? lastCandle?.timestamp ?? 0;

  // A caller-supplied `now` that predates the decision bar produces a signal
  // expiring before the candle it was decided on -- an incoherent object that
  // the database's signals_expiry_after_decision CHECK rejects outright.
  // Failing here, loudly, beats silently "correcting" the timestamp: the
  // caller's clock is the actual bug, and a quiet fix hides it.
  if (lastCandle !== undefined && now < lastCandle.timestamp) {
    throw new InvariantError(
      `evaluateDecision received now=${now}, which precedes the decision candle at ` +
        `${lastCandle.timestamp}. Pass a timestamp at or after the last candle, or omit ` +
        'it to default to the candle timestamp.',
    );
  }
  const limits = resolveRiskLimits(request.riskLimits);
  const context: RiskContext = {
    ...DEFAULT_RISK_CONTEXT,
    executionMode,
    now,
    ...request.riskContext,
  };

  // 1. Validate.
  const dataQuality = assessDataQuality(series, { requiredHistory: strategy.meta.requiredHistory });

  // 2. Analyse.
  const regime = classifyRegime(series, request.regimeOptions ?? {});

  // 3. Strategy.
  const parameters = resolveParameters(strategy.parameters, request.parameters ?? {});
  const evaluation: StrategyEvaluation = dataQuality.usable
    ? strategy.evaluate({ asset, timeframe: series.timeframe, series, parameters, now })
    : {
        strategyId: strategy.meta.id,
        strategyVersion: strategy.meta.version,
        direction: 'none',
        indicators: [],
        confirmations: [],
        conflicts: [],
        regimeHint: 'unknown',
        expirationSeconds: 60,
        notes: ['Strategy not evaluated: market data failed integrity validation.'],
        abstainReason: 'market data failed integrity validation',
      };

  const analysis: MarketAnalysis = {
    asset: series.asset,
    timeframe: series.timeframe,
    at: lastCandle?.timestamp ?? 0,
    lastPrice: lastCandle?.close ?? 0,
    regime,
    indicators: evaluation.indicators,
    dataQuality,
  };

  // 4. Confidence.
  const confidence = scoreConfidence({
    direction: evaluation.direction,
    confirmations: evaluation.confirmations,
    conflicts: evaluation.conflicts,
    regime,
    dataQuality,
    requiredHistory: strategy.meta.requiredHistory,
    maxAtrPercent: limits.maxVolatilityAtrPercent,
  });

  // 5. Risk.
  const risk = assessRisk({
    direction: evaluation.direction,
    confidence: confidence.score,
    conflicts: evaluation.conflicts,
    regime,
    dataQuality,
    limits,
    context,
  });

  // 6. Decision.
  const { status, recommendation } = decide(evaluation, risk, confidence.score, limits);

  const reasoning = buildReasoning({
    asset: series.asset,
    timeframe: series.timeframe,
    direction: evaluation.direction,
    regime,
    confidence,
    risk,
    confirmations: evaluation.confirmations,
    conflicts: evaluation.conflicts,
    dataQuality,
    executionMode,
    strategyName: strategy.meta.name,
    ...(evaluation.abstainReason === undefined ? {} : { abstainReason: evaluation.abstainReason }),
  });

  const signal: Signal = {
    id: idFactory(),
    createdAt: now,
    asset: series.asset,
    timeframe: series.timeframe,
    direction: evaluation.direction,
    timestamp: lastCandle?.timestamp ?? now,
    price: lastCandle?.close ?? 0,
    expiration: {
      seconds: evaluation.expirationSeconds,
      expiresAt: now + evaluation.expirationSeconds * 1000,
    },
    confidence,
    riskLevel: risk.riskLevel,
    marketRegime: regime.regime,
    strategy: {
      id: strategy.meta.id,
      version: strategy.meta.version,
      name: strategy.meta.name,
    },
    indicators: evaluation.indicators,
    confirmations: evaluation.confirmations,
    conflicts: evaluation.conflicts,
    reasoning,
    status,
    recommendation,
    executionMode,
    dataSource: series.source,
    dataQuality,
  };

  return { analysis, evaluation, risk, signal };
}

function decide(
  evaluation: StrategyEvaluation,
  risk: RiskAssessment,
  confidence: number,
  limits: RiskLimits,
): { status: SignalStatus; recommendation: SignalRecommendation } {
  if (evaluation.direction === 'none') {
    return { status: 'rejected', recommendation: 'skip' };
  }
  if (risk.outcome === 'block') {
    return { status: 'rejected', recommendation: 'skip' };
  }

  const hasMajorConflict = evaluation.conflicts.some((conflict) => conflict.severity !== 'minor');
  const strongEnough = confidence >= Math.max(limits.minConfidence + 0.1, 0.7);

  return {
    status: 'accepted',
    recommendation: strongEnough && !hasMajorConflict ? 'consider' : 'wait_for_confirmation',
  };
}
