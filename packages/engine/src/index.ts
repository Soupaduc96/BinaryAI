/**
 * @binaryai/engine -- the decision core.
 *
 * Contains the market-data boundary, the rule-based regime classifier, the
 * confidence scorer, the risk engine and the pipeline that sequences them.
 * Pure and side-effect free: no database, no network, no clock except the one
 * the caller passes in. Live analysis and backtesting both run through here,
 * which is what makes the two comparable.
 */

export {
  normalizeCandleSeries,
  assessDataQuality,
  sliceSeries,
  rawCandleSchema,
  rawCandleSeriesSchema,
  type DataQualityOptions,
  type RawCandle,
  type RawCandleSeries,
} from './market-data.js';

export { classifyRegime, type RegimeOptions } from './regime.js';

export {
  scoreConfidence,
  CONFIDENCE_WEIGHTS,
  CONFIDENCE_DISCLAIMER,
  type ConfidenceInput,
} from './confidence.js';

export {
  assessRisk,
  deriveRiskLevel,
  resolveRiskLimits,
  assertExecutionAllowed,
  DEFAULT_RISK_LIMITS,
  DEFAULT_RISK_CONTEXT,
  LiveExecutionDisabledError,
  type RiskInput,
} from './risk.js';

export { buildReasoning, type ReasoningInput } from './reasoning.js';
export { settleBinaryOutcome, type SettlementResult } from './settlement.js';
export { createRuleBasedAiProvider } from './ai-provider.js';

export {
  evaluateDecision,
  analyzeMarket,
  type DecisionRequest,
  type DecisionResult,
} from './pipeline.js';

export {
  EXPOSURE_WINDOW_HOURS,
  allowlistPermits,
  applyPolicyUpdate,
  defaultAccountPolicy,
  evaluateAccountAction,
  exposureWindow,
  isValidSize,
  tightenLimits,
  validatePolicy,
  type AccountActionInput,
  type AccountRiskContext,
  type SignalCandidate,
} from './account-risk.js';

export {
  MAX_SIMULATED_RETURN_RATE,
  NO_SIMULATION,
  applySimulationModel,
  describeModel,
  returnFraction,
  simulatedValue,
  validateParameters,
  type ParameterValidation,
} from './simulation-model.js';
