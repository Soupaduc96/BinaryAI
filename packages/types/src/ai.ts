import type { MarketAnalysis } from './analysis.js';
import type { Signal } from './signal.js';

/**
 * The AI layer's contract.
 *
 * Nothing in this file claims a capability is implemented. Every provider
 * reports, per capability, WHAT is actually behind it via
 * `AiImplementationKind`. A rule-based template must report 'rule_based' --
 * calling it AI in the UI would be a lie. See docs/ai-architecture.md.
 */

export type AiCapability =
  | 'explanation'
  | 'regime_classification'
  | 'signal_ranking'
  | 'anomaly_detection'
  | 'pattern_matching'
  | 'strategy_optimization';

export type AiImplementationKind = 'rule_based' | 'statistical_model' | 'llm' | 'not_implemented';

export interface AiCapabilityStatus {
  readonly capability: AiCapability;
  readonly implementation: AiImplementationKind;
  readonly available: boolean;
  readonly notes: string;
}

export interface AiExplainRequest {
  readonly signal: Signal;
  readonly analysis: MarketAnalysis;
  /** BCP-47 tag; providers may ignore it. */
  readonly locale?: string;
}

export interface AiExplainResponse {
  readonly text: string;
  readonly implementation: AiImplementationKind;
  /** Model identifier when implementation is 'llm'. */
  readonly model?: string;
  /** True when the text states the confidence figure is uncalibrated. */
  readonly disclosesUncertainty: boolean;
}

/**
 * Implemented locally by the rule-based explainer today, and by an HTTP client
 * to services/ai later. Consumers depend on this interface, never on either
 * implementation.
 */
export interface AiProvider {
  readonly id: string;
  capabilities(): readonly AiCapabilityStatus[];
  explain(request: AiExplainRequest): Promise<AiExplainResponse>;
}
