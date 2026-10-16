import type { PayoutModel } from './backtest.js';
import type { Timeframe } from './market.js';
import type { MarketDataOrigin } from './market-data.js';
import type { RiskLimits } from './risk.js';
import type { SignalDirection, SignalOutcome } from './signal.js';

/**
 * Paper accounts, positions and the account risk policy.
 *
 * Everything in this file describes a SIMULATION. A paper position is an
 * accounting object recording that a user chose to act on a signal; it is not
 * an order, it is never sent anywhere, and BinaryAI holds no money on anyone's
 * behalf. The vocabulary avoids broker language deliberately -- there is no
 * "order id", no "fill", and no "profit".
 *
 * Two decisions shape the model and are argued in
 * docs/adr/0013-paper-accounts-and-risk-enforcement.md:
 *
 *  1. **No payout economics.** A binary option's payout is entirely
 *     broker-defined, and BinaryAI has no broker. Converting a win into a
 *     monetary gain would require inventing a rate. The ledger therefore tracks
 *     EXPOSURE (committed and released), never profit and loss.
 *  2. **A signal is not a position.** One system signal may be acted on by many
 *     accounts. The signal is analysis; the position is one account's action on
 *     it. They are separate rows, and the signal is never duplicated.
 */

// -------------------------------------------------------------- policy --

/**
 * An account's risk policy.
 *
 * `limits` reuses the existing `RiskLimits` from the engine rather than
 * redefining eleven fields that already exist. The extra fields here are the
 * dimensions that only make sense for an ACCOUNT ACTION -- restrictions on what
 * an account may act on, and how large a single action may be.
 */
export interface AccountRiskPolicy {
  readonly accountId: string;
  /** Incremented on every update. Stamped on every decision made under it. */
  readonly version: number;
  /** Epoch ms. */
  readonly updatedAt: number;
  /** The engine's limits, as they apply to this account. */
  readonly limits: RiskLimits;
  /** Largest single paper position, in account units. */
  readonly maxPositionSize: number;
  /** Total units that may be committed within one exposure window. */
  readonly maxDailyExposure: number;
  /**
   * Allowlists. The semantics are explicit and NOT interchangeable:
   *
   *  - `null`  -- **unset**. The dimension is not restricted.
   *  - `[]`    -- **allow none**. Every action on this dimension is blocked.
   *
   * An empty array failing closed is deliberate: an operator who clears a list
   * has expressed "nothing", and interpreting that as "everything" would turn a
   * restriction into its opposite.
   */
  readonly allowedStrategies: readonly string[] | null;
  readonly allowedTimeframes: readonly Timeframe[] | null;
  readonly allowedAssets: readonly string[] | null;
  /**
   * OPTIONAL per-instrument limits, keyed by canonical catalogue symbol.
   *
   * R4. The account limits above are account-wide, and they remain the ABSOLUTE
   * CEILING: nothing here can raise them. What this adds is the ability to
   * subdivide that ceiling, because with several instruments analysed a single
   * account-wide `maxOpenPositions: 1` means the first instrument to signal
   * takes the only slot and every other instrument is blocked for as long as it
   * is held — a starvation nobody configured.
   *
   * Absent (or an absent key) means NO instrument-specific restriction, which
   * is exactly the behaviour that existed before this field. Backward
   * compatibility is therefore the default, not a special case.
   */
  readonly perInstrument: Readonly<Record<string, InstrumentRiskLimits>> | null;
}

/**
 * Limits that apply to ONE instrument.
 *
 * Deliberately a small set. Consecutive losses, daily loss and cooldown stay
 * account-wide: they describe the ACCOUNT's condition, not a market's, and a
 * per-instrument cooldown would let an account keep trading through a losing
 * streak by rotating instruments — which is the opposite of what a cooldown is
 * for. See `isolateCooldown` for the one deliberate exception.
 */
export interface InstrumentRiskLimits {
  /** Open positions allowed on this instrument. Never raises the account cap. */
  readonly maxOpenPositions?: number;
  /**
   * Fraction of the account's exposure allowance this instrument may hold,
   * 0..1. Applied against the same window the account limit uses.
   */
  readonly maxExposureFraction?: number;
  /**
   * Confine the loss cooldown to this instrument.
   *
   * Defaults to FALSE, so a loss cools the whole account down exactly as it
   * does today. Setting it true is an explicit statement that a loss on one
   * market says nothing about another — a defensible position, but one the
   * operator must take deliberately rather than inherit.
   */
  readonly isolateCooldown?: boolean;
}

/** The subset a user may change. `allowLiveExecution` is deliberately absent. */
export type AccountRiskPolicyUpdate = {
  readonly limits?: Partial<Omit<RiskLimits, 'allowLiveExecution'>>;
  readonly maxPositionSize?: number;
  readonly maxDailyExposure?: number;
  readonly allowedStrategies?: readonly string[] | null;
  readonly allowedTimeframes?: readonly Timeframe[] | null;
  readonly allowedAssets?: readonly string[] | null;
  readonly perInstrument?: Readonly<Record<string, InstrumentRiskLimits>> | null;
};

// ------------------------------------------------------------ decision --

/**
 * Why an account action was or was not permitted.
 *
 * Wider than the signal-level `RiskAssessment.outcome` on purpose. "Blocked"
 * covers too much: a cooldown clears by itself, a limit clears when a position
 * settles, and an invalid policy needs an operator. Collapsing them into one
 * word would make the interface unable to tell a user what to do next.
 */
export type AccountRiskOutcome =
  'allowed' | 'blocked' | 'cooldown' | 'limit_reached' | 'invalid_policy' | 'insufficient_context';

/** Every rule the account layer can evaluate. */
export type AccountRuleCode =
  | 'account_active'
  | 'policy_valid'
  | 'signal_actionable'
  | 'strategy_allowed'
  | 'timeframe_allowed'
  | 'asset_allowed'
  | 'position_size_valid'
  | 'max_position_size'
  | 'max_open_positions'
  // Per-instrument, evaluated only when the policy names limits for the
  // instrument being acted on. Never raises the account limits above.
  | 'instrument_max_open_positions'
  | 'instrument_exposure_limit'
  | 'daily_exposure_limit'
  | 'sufficient_units'
  | 'consecutive_loss_limit'
  | 'cooldown_active'
  | 'signal_risk_assessment';

/**
 * One rule's evaluation, with the numbers behind it.
 *
 * `observed` and `limit` are what make a decision auditable: "blocked" alone
 * tells a user nothing, whereas "2 open, limit 2" tells them exactly what
 * changed and what would clear it.
 */
export interface AccountRuleEvaluation {
  readonly code: AccountRuleCode;
  readonly label: string;
  readonly passed: boolean;
  /** Current value the rule measured. Null when the rule is not numeric. */
  readonly observed: number | string | null;
  /** Configured ceiling or allowlist size. Null when not numeric. */
  readonly limit: number | string | null;
  /** The window the observation covers, when one applies. */
  readonly window: { readonly fromMs: number; readonly toMs: number } | null;
  readonly detail: string;
}

export interface AccountRiskDecision {
  readonly outcome: AccountRiskOutcome;
  readonly allowed: boolean;
  readonly evaluations: readonly AccountRuleEvaluation[];
  /** Codes of failed rules, in evaluation order. First is the primary cause. */
  readonly blockedBy: readonly AccountRuleCode[];
  /** Epoch ms the decision was made. */
  readonly decidedAt: number;
  readonly policyVersion: number;
  /** When a cooldown or limit clears on its own. Null when it will not. */
  readonly retryAfterMs: number | null;
}

// ------------------------------------------------------------ position --

/**
 * Paper position lifecycle.
 *
 * Named `AccountPaperPosition` to distinguish it from `PaperPosition` in
 * simulation.ts, which is a different thing: an in-memory position inside a
 * BACKTEST, carrying an explicit `PayoutModel`. A payout assumption is
 * legitimate there because a backtest states its assumptions and reports
 * results under them. This type is a persisted record of what a user actually
 * did, and has no payout model at all.
 *
 * `pending_settlement` is named rather than folded into `open` because the two
 * mean different things to a user: an open position may still change, one past
 * expiry cannot and is only waiting for the settlement bar to become available.
 *
 * `rejected` is a terminal state that the creation path NEVER produces -- a
 * blocked risk decision records a risk event and creates no position at all
 * (see docs). It exists so that a future reversal has somewhere to land, and so
 * the enum covers every terminal condition rather than reusing `cancelled` for
 * two different meanings.
 */
export type AccountPaperPositionStatus =
  'open' | 'pending_settlement' | 'settled' | 'cancelled' | 'rejected';

export interface AccountPaperPosition {
  readonly id: string;
  readonly accountId: string;
  /** The analysis this action was taken on. Never duplicated per account. */
  readonly signalId: string;
  readonly signalKey: string | null;
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  readonly direction: Exclude<SignalDirection, 'none'>;
  /** Account units committed. NOT money, and not a stake against a payout. */
  readonly size: number;
  /** Price at the signal's decision bar. The reference the outcome measures. */
  readonly entryPrice: number;
  /** Epoch ms. */
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly status: AccountPaperPositionStatus;
  readonly settledAt: number | null;
  readonly settlementPrice: number | null;
  /** Directional result. There is no payout and therefore no P&L. */
  readonly result: SignalOutcome['result'] | null;
  /** Provenance of the settlement price. Never 'broker'. */
  readonly dataOrigin: MarketDataOrigin | null;
  /** Caller-supplied idempotency key for this action. */
  readonly actionKey: string;
  readonly policyVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewAccountPaperPosition {
  readonly accountId: string;
  readonly signalId: string;
  readonly size: number;
  readonly actionKey: string;
  readonly policyVersion: number;
}

/** Positions that count against open-position and exposure limits. */
export const ACTIVE_POSITION_STATUSES: readonly AccountPaperPositionStatus[] = [
  'open',
  'pending_settlement',
];

// -------------------------------------------------------------- ledger --

/**
 * What a ledger entry records.
 *
 * Note what is absent: there is no `win` or `loss` entry type. A directional
 * outcome moves no units on its own — settling releases exactly what opening
 * committed. Units move only when the account holder has configured their own
 * payout assumption, and then through a clearly separate `simulated_payout`
 * entry that carries the assumption with it.
 */
export type LedgerEntryType =
  | 'initial_allocation'
  | 'exposure_committed'
  | 'exposure_released'
  /**
   * SUPERSEDED. The result of a payout rate the account holder supplied
   * directly. Retained so entries written under that model stay readable;
   * nothing produces new ones. See 'simulated_return'.
   */
  | 'simulated_payout'
  /**
   * The result of a server-defined, VERSIONED simulation model applied at
   * settlement. Separate from the exposure release on purpose: the release is
   * a fact, this is arithmetic on a stated premise, and a reader must always
   * be able to tell the two apart. Every such entry names the model and
   * version that produced it, enforced by a database CHECK.
   */
  | 'simulated_return'
  | 'adjustment'
  | 'reset';

/**
 * An append-only accounting entry.
 *
 * Nothing updates or deletes these. Available units are DERIVED by summing
 * them, so a balance can always be reconstructed and audited rather than being
 * a mutable number nobody can explain.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly accountId: string;
  readonly type: LedgerEntryType;
  /** Signed delta in account units. Commit is negative, release positive. */
  readonly amount: number;
  /** The position or action this entry accounts for, when there is one. */
  readonly positionId: string | null;
  /** Epoch ms. */
  readonly occurredAt: number;
  readonly source: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * The versioned simulation model that produced this entry.
   *
   * Non-null exactly when `type` is 'simulated_return', and enforced by a
   * database CHECK rather than by convention: there is no way to record a
   * simulated number that cannot be traced to the arithmetic behind it.
   */
  readonly simulationModelId: string | null;
  readonly simulationModelVersion: string | null;
}

export interface NewLedgerEntry {
  readonly accountId: string;
  readonly type: LedgerEntryType;
  readonly amount: number;
  readonly positionId?: string | null;
  readonly occurredAt?: number;
  readonly source: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly simulationModelId?: string | null;
  readonly simulationModelVersion?: string | null;
}

/**
 * The accounting model in force.
 *
 * `exposure_only` is the only implemented model and means exactly what it says:
 * units are committed when a position opens and released when it settles. No
 * profit, no loss, no payout. `not_configured` is reserved for an account whose
 * allocation has never been set.
 */
export type AccountingModel = 'exposure_only' | 'not_configured';

/**
 * A ledger entry type is not evidence of a payout.
 *
 * 'simulated_return' entries move the SIMULATED account value only. Exposure
 * accounting is untouched by them, which is why the two are separate types and
 * separate rows.
 */

/** Derived account standing. Every field is computed from ledger entries. */
export interface PaperAccountState {
  readonly accountId: string;
  readonly accountingModel: AccountingModel;
  readonly unit: string;
  /** Total units allocated to the account. Not money. */
  readonly allocatedUnits: number;
  /** Units currently committed to active positions. */
  readonly committedUnits: number;
  /** allocated − committed. What a new position may draw on. */
  readonly availableUnits: number;
  readonly openPositions: number;
  readonly settledPositions: number;
  /** Epoch ms of the most recent ledger entry, or null. */
  readonly lastActivityAt: number | null;
  /**
   * Stated on every response. Profit and loss are NOT tracked, and this says so
   * rather than leaving a reader to assume `availableUnits` is a balance.
   */
  readonly accountingNote: string;
}

// ------------------------------------------------------ simulation payout --

/**
 * An account's OPTIONAL simulation payout assumption.
 *
 * The distinction this type exists to preserve: BinaryAI asserts no payout
 * rate. It has no broker and no terms from which one could be derived. What it
 * can honestly do is answer "what would this look like at the rate YOU
 * specified" -- so the rate belongs to the account holder, travels with every
 * figure derived from it, and is versioned so changing it later cannot rewrite
 * what a past settlement was worth.
 *
 * Disabled by default. A disabled account keeps exposure-only accounting and a
 * balance that does not move.
 */
export interface AccountSimulationPayout {
  readonly enabled: boolean;
  /** Reuses the backtester's PayoutModel; `note` carries the user's rationale. */
  readonly model: PayoutModel;
  /** Bumped on every change and stamped on every ledger entry it produces. */
  readonly version: number;
  readonly updatedAt: number;
}

/** What a settlement is worth under an assumption, and under which one. */
export interface SimulatedPayoutResult {
  /** Signed delta in account units. Zero when no assumption is configured. */
  readonly delta: number;
  /** True only when an enabled assumption actually produced the delta. */
  readonly applied: boolean;
  readonly payoutVersion: number;
  /** The exact model used, for the ledger entry. Null when none applied. */
  readonly model: PayoutModel | null;
  /**
   * The sentence that must accompany the number wherever it is shown.
   * Never omitted, because a delta without its assumption reads as a result.
   */
  readonly assumption: string;
}
