import type {
  AiCapability,
  AiCapabilityStatus,
  AiExplainRequest,
  AiExplainResponse,
  AiProvider,
} from '@binaryai/types';

/**
 * The default AI provider: rule-based, and it says so.
 *
 * It implements exactly one capability -- turning already-computed facts into
 * prose -- and reports every other capability as `not_implemented` rather than
 * pretending. Swapping in a real model means implementing `AiProvider`
 * elsewhere (an HTTP client to services/ai) and injecting it; nothing that
 * consumes this interface changes.
 */

const CAPABILITIES: readonly AiCapabilityStatus[] = [
  {
    capability: 'explanation',
    implementation: 'rule_based',
    available: true,
    notes: 'Template text composed from engine facts. No model involved.',
  },
  {
    capability: 'regime_classification',
    implementation: 'rule_based',
    available: true,
    notes: 'Threshold rules over ADX/ATR/EMA slope in @binaryai/engine, not a trained classifier.',
  },
  ...(
    [
      'signal_ranking',
      'anomaly_detection',
      'pattern_matching',
      'strategy_optimization',
    ] as const satisfies readonly AiCapability[]
  ).map((capability): AiCapabilityStatus => ({
    capability,
    implementation: 'not_implemented',
    available: false,
    notes: 'Interface defined; no implementation exists yet.',
  })),
];

export function createRuleBasedAiProvider(): AiProvider {
  return {
    id: 'rule-based-local',
    capabilities: () => CAPABILITIES,
    explain(request: AiExplainRequest): Promise<AiExplainResponse> {
      const { reasoning } = request.signal;
      const lines = [
        reasoning.summary,
        ...(reasoning.supporting.length > 0
          ? ['', 'Supporting:', ...reasoning.supporting.map((item) => `- ${item}`)]
          : []),
        ...(reasoning.opposing.length > 0
          ? ['', 'Against:', ...reasoning.opposing.map((item) => `- ${item}`)]
          : []),
        ...(reasoning.caveats.length > 0
          ? ['', 'Caveats:', ...reasoning.caveats.map((item) => `- ${item}`)]
          : []),
      ];

      return Promise.resolve({
        text: lines.join('\n'),
        implementation: 'rule_based',
        disclosesUncertainty: reasoning.caveats.length > 0,
      });
    },
  };
}
