import type {
  AccountRiskDecision,
  AccountRiskPolicy,
  AccountRuleCode,
  AccountRuleEvaluation,
  MarketDataOrigin,
  RiskLimits,
  SignalDirection,
  SignalStatus,
  Timeframe,
} from '@binaryai/types';
import { DEFAULT_RISK_LIMITS } from './risk.js';

/**
 * Account-level risk enforcement.
 *
 * The signal-level risk engine (`assessRisk`) answers "is this analysis sound
 * enough to act on at all?" — the same question for every user, because it is a
 * property of the market data. This module answers a different one: "may THIS
 * account act on it, right now, given its own policy and its own open
 * positions?"
 *
 * Keeping them separate is what stops the runtime from having to know about
 * accounts. One market analysis produces one system signal; an account action
 * is evaluated here, afterwards, against state the analysis knows nothing about.
 *
 * Pure by construction: no database, no clock, no HTTP. `now` is an input, so
 * every decision is reproducible from its inputs alone.
 */

/** Exposure window semantics, stated once and referenced everywhere. */
export const EXPOSURE_WINDOW_HOURS = 24;

/**
 * The daily exposure window is a ROLLING 24 hours ending at `now`, not a
 * calendar day.
 *
 * A calendar day needs a timezone, and there is no defensible one to pick: the
 * user's, the server's and the exchange's all differ, and any choice silently
 * changes when a limit resets. A rolling window has no such ambiguity and
 * cannot be gamed by acting just before midnight.
 */
export function exposureWindow(now: number): { fromMs: number; toMs: number } {
  return { fromMs: now - EXPOSURE_WINDOW_HOURS * 60 * 60 * 1000, toMs: now };
}

/** What the account layer needs to know about the signal being acted on. */
export interface SignalCandidate {
  readonly id: string;
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  readonly direction: SignalDirection;
  readonly status: SignalStatus;
  readonly strategyKey: string | null;
  readonly expiresAt: number;
  readonly entryPrice: number;
  readonly dataOrigin: MarketDataOrigin | 'synthetic' | null;
}

/** Live account state the decision depends on. */
export interface AccountRiskContext {
  readonly accountActive: boolean;
  readonly openPositions: number;
  /** Units committed to positions opened within the exposure window. */
  readonly exposureInWindow: number;
  readonly consecutiveLosses: number;
  /** Epoch ms of the most recent settled loss, or null. */
  readonly lastLossAt: number | null;
  readonly availableUnits: number;
}

export interface AccountActionInput {
  readonly policy: AccountRiskPolicy;
  readonly signal: SignalCandidate;
  readonly context: AccountRiskContext;
  readonly size: number;
  readonly now: number;
}

/**
 * Is a numeric input safe to act on?
 *
 * Rejects NaN, both infinities, negatives and negative zero. Negative zero is
 * called out explicitly because `-0 > 0` is false but `Object.is(-0, 0)` is
 * also false, and it serializes as `-0` — a value that passes a naive
 * `size >= 0` check and then reads as a malformed size everywhere downstream.
 */
export function isValidSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !Object.is(value, -0);
}

/**
 * Is a policy internally coherent?
 *
 * An incoherent policy fails CLOSED: the decision is `invalid_policy` and no
 * action is permitted. Falling back to defaults would silently replace the
 * operator's intent with something they never configured.
 */
export function validatePolicy(policy: AccountRiskPolicy): readonly string[] {
  const problems: string[] = [];

  if (!isValidSize(policy.maxPositionSize)) {
    problems.push('maxPositionSize must be a finite number greater than zero.');
  }
  if (!isValidSize(policy.maxDailyExposure)) {
    problems.push('maxDailyExposure must be a finite number greater than zero.');
  }
  if (
    isValidSize(policy.maxPositionSize) &&
    isValidSize(policy.maxDailyExposure) &&
    policy.maxPositionSize > policy.maxDailyExposure
  ) {
    // Not merely odd: it would let a single action exceed the window ceiling,
    // making the daily limit unreachable and therefore meaningless.
    problems.push('maxPositionSize exceeds maxDailyExposure, so the daily limit could never bind.');
  }
  if (!Number.isInteger(policy.limits.maxOpenPositions) || policy.limits.maxOpenPositions < 0) {
    problems.push('limits.maxOpenPositions must be a non-negative integer.');
  }
  if (policy.limits.allowLiveExecution) {
    // Unreachable through the API, which never accepts this field. If it is
    // ever true in storage, the policy is not one this build may act under.
    problems.push('allowLiveExecution is true. This build is demo-only and refuses to act.');
  }
  if (
    !Number.isFinite(policy.limits.cooldownSecondsAfterLoss) ||
    policy.limits.cooldownSecondsAfterLoss < 0
  ) {
    problems.push('limits.cooldownSecondsAfterLoss must be a non-negative number.');
  }
  return problems;
}

/**
 * Is a value permitted by an allowlist?
 *
 *  - `null` — unset, so unrestricted.
 *  - `[]`   — allow none. Fails closed.
 *
 * The two are deliberately different. An operator who cleared a list expressed
 * "nothing", and reading that as "everything" would invert the restriction.
 */
export function allowlistPermits(list: readonly string[] | null, value: string): boolean {
  if (list === null) return true;
  return list.includes(value);
}

function evaluation(
  code: AccountRuleCode,
  label: string,
  passed: boolean,
  detail: string,
  observed: number | string | null = null,
  limit: number | string | null = null,
  window: { fromMs: number; toMs: number } | null = null,
): AccountRuleEvaluation {
  return { code, label, passed, observed, limit, window, detail };
}

/**
 * Evaluates whether an account may open a paper position on a signal.
 *
 * Every rule is evaluated and reported, not short-circuited, so the caller sees
 * the full picture rather than only the first failure — a user blocked by three
 * rules should not have to fix them one request at a time.
 *
 * The OUTCOME, however, is chosen from the first failure in evaluation order,
 * because rules are ordered from most fundamental to most transient: an
 * inactive account is reported as such even if a cooldown also happens to be
 * running.
 */
export function evaluateAccountAction(input: AccountActionInput): AccountRiskDecision {
  const { policy, signal, context, size, now } = input;
  const evaluations: AccountRuleEvaluation[] = [];
  const window = exposureWindow(now);

  // 1. Account state.
  evaluations.push(
    evaluation(
      'account_active',
      'Account active',
      context.accountActive,
      context.accountActive ? 'Account is active.' : 'Account is not active.',
    ),
  );

  // 2. Policy coherence. Everything after this reads policy values, so an
  //    incoherent policy has to be caught before they are trusted.
  const policyProblems = validatePolicy(policy);
  evaluations.push(
    evaluation(
      'policy_valid',
      'Policy valid',
      policyProblems.length === 0,
      policyProblems.length === 0 ? 'Policy is coherent.' : policyProblems.join(' '),
    ),
  );

  // 3. Is the signal something an account may act on at all?
  const actionable =
    signal.status === 'accepted' && signal.direction !== 'none' && signal.expiresAt > now;
  evaluations.push(
    evaluation(
      'signal_actionable',
      'Signal actionable',
      actionable,
      signal.direction === 'none'
        ? 'Signal made no directional claim.'
        : signal.status !== 'accepted'
          ? `Signal status is "${signal.status}"; only an accepted signal may be acted on.`
          : signal.expiresAt <= now
            ? 'Signal has already expired.'
            : 'Signal is accepted, directional and unexpired.',
      signal.status,
      'accepted',
    ),
  );

  // 4. Allowlists.
  const strategyOk = allowlistPermits(policy.allowedStrategies, signal.strategyKey ?? '');
  evaluations.push(
    evaluation(
      'strategy_allowed',
      'Strategy permitted',
      strategyOk,
      policy.allowedStrategies === null
        ? 'No strategy restriction configured.'
        : strategyOk
          ? `Strategy "${signal.strategyKey}" is on the allowlist.`
          : policy.allowedStrategies.length === 0
            ? 'The strategy allowlist is empty, which permits nothing.'
            : `Strategy "${signal.strategyKey}" is not on the allowlist.`,
      signal.strategyKey,
      policy.allowedStrategies === null ? null : policy.allowedStrategies.length,
    ),
  );

  const timeframeOk = allowlistPermits(policy.allowedTimeframes, signal.timeframe);
  evaluations.push(
    evaluation(
      'timeframe_allowed',
      'Timeframe permitted',
      timeframeOk,
      policy.allowedTimeframes === null
        ? 'No timeframe restriction configured.'
        : timeframeOk
          ? `Timeframe ${signal.timeframe} is on the allowlist.`
          : policy.allowedTimeframes.length === 0
            ? 'The timeframe allowlist is empty, which permits nothing.'
            : `Timeframe ${signal.timeframe} is not on the allowlist.`,
      signal.timeframe,
      policy.allowedTimeframes === null ? null : policy.allowedTimeframes.length,
    ),
  );

  const assetOk = allowlistPermits(policy.allowedAssets, signal.assetSymbol);
  evaluations.push(
    evaluation(
      'asset_allowed',
      'Asset permitted',
      assetOk,
      policy.allowedAssets === null
        ? 'No asset restriction configured.'
        : assetOk
          ? `${signal.assetSymbol} is on the allowlist.`
          : policy.allowedAssets.length === 0
            ? 'The asset allowlist is empty, which permits nothing.'
            : `${signal.assetSymbol} is not on the allowlist.`,
      signal.assetSymbol,
      policy.allowedAssets === null ? null : policy.allowedAssets.length,
    ),
  );

  // 5. Size.
  const sizeValid = isValidSize(size);
  evaluations.push(
    evaluation(
      'position_size_valid',
      'Position size valid',
      sizeValid,
      sizeValid
        ? 'Size is a positive finite number.'
        : 'Size must be a finite number greater than zero.',
      sizeValid ? size : String(size),
    ),
  );

  const withinMaxSize = sizeValid && size <= policy.maxPositionSize;
  evaluations.push(
    evaluation(
      'max_position_size',
      'Within maximum position size',
      withinMaxSize,
      withinMaxSize
        ? `Size ${size} is within the ${policy.maxPositionSize} ceiling.`
        : `Size ${size} exceeds the maximum position size of ${policy.maxPositionSize}.`,
      sizeValid ? size : null,
      policy.maxPositionSize,
    ),
  );

  // 6. Concurrency.
  const withinOpen = context.openPositions < policy.limits.maxOpenPositions;
  evaluations.push(
    evaluation(
      'max_open_positions',
      'Open position capacity',
      withinOpen,
      withinOpen
        ? `${context.openPositions} of ${policy.limits.maxOpenPositions} slots in use.`
        : `${context.openPositions} position(s) already open; the limit is ${policy.limits.maxOpenPositions}.`,
      context.openPositions,
      policy.limits.maxOpenPositions,
    ),
  );

  // 7. Exposure over the rolling window.
  const projected = context.exposureInWindow + (sizeValid ? size : 0);
  const withinExposure = projected <= policy.maxDailyExposure;
  evaluations.push(
    evaluation(
      'daily_exposure_limit',
      'Exposure within window',
      withinExposure,
      withinExposure
        ? `${projected} of ${policy.maxDailyExposure} units committed in the last ${EXPOSURE_WINDOW_HOURS}h.`
        : `This action would bring ${EXPOSURE_WINDOW_HOURS}h exposure to ${projected}, over the ${policy.maxDailyExposure} limit.`,
      projected,
      policy.maxDailyExposure,
      window,
    ),
  );

  // 8. Allocation. Exposure cannot be committed that the account was never
  //    allocated -- otherwise the derived ledger balance would go negative and
  //    "available units" would stop meaning anything.
  const sufficientUnits = sizeValid && size <= context.availableUnits;
  evaluations.push(
    evaluation(
      'sufficient_units',
      'Sufficient allocated units',
      sufficientUnits,
      sufficientUnits
        ? `${context.availableUnits} unit(s) available.`
        : `Action needs ${size} unit(s); ${context.availableUnits} available.`,
      context.availableUnits,
      sizeValid ? size : null,
    ),
  );

  // 9. Loss streak.
  const withinLosses = context.consecutiveLosses < policy.limits.maxConsecutiveLosses;
  evaluations.push(
    evaluation(
      'consecutive_loss_limit',
      'Consecutive losses',
      withinLosses,
      withinLosses
        ? `${context.consecutiveLosses} consecutive loss(es); the limit is ${policy.limits.maxConsecutiveLosses}.`
        : `${context.consecutiveLosses} consecutive losses reached the limit of ${policy.limits.maxConsecutiveLosses}.`,
      context.consecutiveLosses,
      policy.limits.maxConsecutiveLosses,
    ),
  );

  // 10. Cooldown.
  const cooldownMs = policy.limits.cooldownSecondsAfterLoss * 1000;
  const cooldownEndsAt = context.lastLossAt === null ? null : context.lastLossAt + cooldownMs;
  const inCooldown = cooldownEndsAt !== null && now < cooldownEndsAt;
  evaluations.push(
    evaluation(
      'cooldown_active',
      'Cooldown',
      !inCooldown,
      inCooldown
        ? `Cooldown active for another ${Math.ceil((cooldownEndsAt - now) / 1000)}s after the last loss.`
        : 'No cooldown in force.',
      context.lastLossAt,
      cooldownEndsAt,
      cooldownEndsAt === null
        ? null
        : { fromMs: context.lastLossAt as number, toMs: cooldownEndsAt },
    ),
  );

  const failed = evaluations.filter((rule) => !rule.passed);
  const blockedBy = failed.map((rule) => rule.code);

  return {
    outcome: outcomeFor(failed),
    allowed: failed.length === 0,
    evaluations,
    blockedBy,
    decidedAt: now,
    policyVersion: policy.version,
    retryAfterMs: inCooldown && cooldownEndsAt !== null ? cooldownEndsAt - now : null,
  };
}

/**
 * Chooses the outcome category from the failures.
 *
 * Ordered by how a user should read it: a policy that cannot be evaluated is
 * reported before a limit that merely happens to bind, and a cooldown — which
 * clears on its own — is distinguished from a limit, which clears only when
 * something else changes.
 */
function outcomeFor(failed: readonly AccountRuleEvaluation[]): AccountRiskDecision['outcome'] {
  if (failed.length === 0) return 'allowed';

  const codes = new Set(failed.map((rule) => rule.code));
  if (codes.has('policy_valid')) return 'invalid_policy';
  if (codes.has('account_active') || codes.has('signal_actionable')) return 'insufficient_context';
  if (codes.has('cooldown_active')) return 'cooldown';
  if (
    codes.has('max_open_positions') ||
    codes.has('daily_exposure_limit') ||
    codes.has('sufficient_units') ||
    codes.has('consecutive_loss_limit')
  ) {
    return 'limit_reached';
  }
  return 'blocked';
}

/**
 * The default policy for a new account.
 *
 * Conservative by construction: one open position, a small ceiling, and a
 * five-minute cooldown. A new account is immediately usable and immediately
 * bounded — there is no window in which it has no policy.
 *
 * Allowlists default to `null` (unrestricted) rather than `[]`, because a new
 * account that could act on nothing would look broken rather than safe.
 */
export function defaultAccountPolicy(accountId: string, at: number): AccountRiskPolicy {
  return {
    accountId,
    version: 1,
    updatedAt: at,
    limits: { ...DEFAULT_RISK_LIMITS },
    maxPositionSize: 10,
    maxDailyExposure: 50,
    allowedStrategies: null,
    allowedTimeframes: null,
    allowedAssets: null,
  };
}

/**
 * Merges a user's update onto a stored policy.
 *
 * `allowLiveExecution` is stripped rather than merged. The API never accepts it
 * and this is the second place that is enforced, because a single missed field
 * in one Zod schema would otherwise be enough to let a request set it.
 */
export function applyPolicyUpdate(
  current: AccountRiskPolicy,
  update: {
    limits?: Partial<RiskLimits>;
    maxPositionSize?: number;
    maxDailyExposure?: number;
    allowedStrategies?: readonly string[] | null;
    allowedTimeframes?: readonly Timeframe[] | null;
    allowedAssets?: readonly string[] | null;
  },
  at: number,
): AccountRiskPolicy {
  const { allowLiveExecution: _ignored, ...limitUpdates } = update.limits ?? {};

  return {
    ...current,
    version: current.version + 1,
    updatedAt: at,
    limits: { ...current.limits, ...limitUpdates, allowLiveExecution: false },
    maxPositionSize: update.maxPositionSize ?? current.maxPositionSize,
    maxDailyExposure: update.maxDailyExposure ?? current.maxDailyExposure,
    allowedStrategies:
      update.allowedStrategies === undefined ? current.allowedStrategies : update.allowedStrategies,
    allowedTimeframes:
      update.allowedTimeframes === undefined ? current.allowedTimeframes : update.allowedTimeframes,
    allowedAssets:
      update.allowedAssets === undefined ? current.allowedAssets : update.allowedAssets,
  };
}

/**
 * Merges caller-supplied limits onto an account's policy, TIGHTENING ONLY.
 *
 * A request may ask for stricter limits than its account allows -- "be more
 * careful than usual on this one" is a legitimate thing to want. It may never
 * ask for looser ones, or the stored policy would be advisory: any user could
 * bypass their own limits by sending different ones with each request.
 *
 * Direction of "tighter" differs per field, which is why this cannot be a
 * generic merge:
 *
 *   minConfidence, minDataQualityScore, cooldownSecondsAfterLoss  -> higher
 *   every ceiling (max*)                                          -> lower
 *   allowedRegimes                                                -> intersection
 *   maxRiskLevel                                                  -> lower rank
 *   allowLiveExecution                                            -> always false
 */
export function tightenLimits(
  base: RiskLimits,
  overrides: Partial<RiskLimits> | undefined,
): RiskLimits {
  if (!overrides) return base;

  const order: readonly RiskLimits['maxRiskLevel'][] = ['low', 'medium', 'high', 'extreme'];
  const stricterLevel = (
    a: RiskLimits['maxRiskLevel'],
    b: RiskLimits['maxRiskLevel'] | undefined,
  ): RiskLimits['maxRiskLevel'] =>
    b === undefined ? a : order.indexOf(b) < order.indexOf(a) ? b : a;

  const higher = (a: number, b: number | undefined): number =>
    b === undefined || !Number.isFinite(b) ? a : Math.max(a, b);
  const lower = (a: number, b: number | undefined): number =>
    b === undefined || !Number.isFinite(b) ? a : Math.min(a, b);

  return {
    minConfidence: higher(base.minConfidence, overrides.minConfidence),
    minDataQualityScore: higher(base.minDataQualityScore, overrides.minDataQualityScore),
    cooldownSecondsAfterLoss: higher(
      base.cooldownSecondsAfterLoss,
      overrides.cooldownSecondsAfterLoss,
    ),
    maxOpenPositions: lower(base.maxOpenPositions, overrides.maxOpenPositions),
    maxExposureFraction: lower(base.maxExposureFraction, overrides.maxExposureFraction),
    maxDailyLossFraction: lower(base.maxDailyLossFraction, overrides.maxDailyLossFraction),
    maxConsecutiveLosses: lower(base.maxConsecutiveLosses, overrides.maxConsecutiveLosses),
    maxVolatilityAtrPercent: lower(base.maxVolatilityAtrPercent, overrides.maxVolatilityAtrPercent),
    maxRiskLevel: stricterLevel(base.maxRiskLevel, overrides.maxRiskLevel),
    // Intersection: a request can narrow the permitted regimes but never add
    // one the account does not already allow.
    allowedRegimes:
      overrides.allowedRegimes === undefined
        ? base.allowedRegimes
        : base.allowedRegimes.filter((regime) => overrides.allowedRegimes?.includes(regime)),
    // Never negotiable, from any direction.
    allowLiveExecution: false,
  };
}
