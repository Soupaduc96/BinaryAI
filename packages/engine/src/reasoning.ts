import type {
  ConfidenceResult,
  Confirmation,
  Conflict,
  DataQualityReport,
  ExecutionMode,
  RegimeAssessment,
  RiskAssessment,
  SignalDirection,
  SignalReasoning,
  Timeframe,
} from '@binaryai/types';
import { round } from '@binaryai/utils';

/**
 * Rule-based reasoning.
 *
 * This composes sentences from facts the engine already computed. It is a
 * template, not a language model, and it is stamped `generatedBy: 'rule_engine'`
 * so the UI can say so. When a real model is wired in (services/ai), it
 * produces the same `SignalReasoning` shape with `generatedBy: 'ai_model'`.
 */

export interface ReasoningInput {
  readonly asset: string;
  readonly timeframe: Timeframe;
  readonly direction: SignalDirection;
  readonly regime: RegimeAssessment;
  readonly confidence: ConfidenceResult;
  readonly risk: RiskAssessment;
  readonly confirmations: readonly Confirmation[];
  readonly conflicts: readonly Conflict[];
  readonly dataQuality: DataQualityReport;
  readonly executionMode: ExecutionMode;
  readonly strategyName: string;
  readonly abstainReason?: string;
}

const REGIME_LABEL: Readonly<Record<RegimeAssessment['regime'], string>> = {
  trend_up: 'an uptrend',
  trend_down: 'a downtrend',
  range: 'a range',
  volatile: 'volatile conditions',
  quiet: 'quiet conditions',
  unknown: 'an unclassified market',
};

export function buildReasoning(input: ReasoningInput): SignalReasoning {
  const percent = round(input.confidence.score * 100, 1);
  const regimeText = REGIME_LABEL[input.regime.regime];

  const summary =
    input.direction === 'none'
      ? `No directional setup on ${input.asset} ${input.timeframe}: ${input.abstainReason ?? 'conditions did not meet the strategy criteria'}. Market is in ${regimeText}.`
      : `${input.direction.toUpperCase()} candidate on ${input.asset} ${input.timeframe} from ${input.strategyName}. ` +
        `Market is in ${regimeText}; heuristic confidence ${percent}% (uncalibrated); risk ${input.risk.riskLevel}; ` +
        `${input.risk.outcome === 'allow' ? 'risk checks passed' : `blocked by ${input.risk.blockedBy.length} risk check(s)`}.`;

  const supporting = input.confirmations
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((item) => `${item.label}: ${item.detail}`);

  const opposing = input.conflicts
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((item) => `${item.label} (${item.severity}): ${item.detail}`);

  const caveats: string[] = [input.confidence.disclaimer];

  if (input.executionMode === 'demo') {
    caveats.push('Demo mode: no real order is placed by this system.');
  }
  if (!input.dataQuality.usable) {
    caveats.push('Market data failed integrity validation; treat this analysis as unreliable.');
  } else if (input.dataQuality.issues.length > 0) {
    caveats.push(
      `${input.dataQuality.issues.length} data-quality issue(s) detected (${summarizeIssues(input.dataQuality)}).`,
    );
  }
  if (input.risk.outcome === 'block') {
    caveats.push(`Risk engine blocked this signal: ${input.risk.blockedBy.join(', ')}.`);
  }
  if (input.regime.clarity < 0.4 && input.direction !== 'none') {
    caveats.push(`Regime classification is weak (clarity ${round(input.regime.clarity, 2)}).`);
  }

  return { summary, supporting, opposing, caveats, generatedBy: 'rule_engine' };
}

function summarizeIssues(report: DataQualityReport): string {
  const counts = new Map<string, number>();
  for (const item of report.issues) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => `${code} x${count}`).join(', ');
}
