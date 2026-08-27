import type { AnalyticsRepository } from './analytics-repository.js';
import type { Account, AccessScope, Session, User, UserRole, UserWithCredentials } from './auth.js';
import type {
  AccountPaperPosition,
  AccountPaperPositionStatus,
  AccountRiskPolicy,
  LedgerEntry,
  NewAccountPaperPosition,
  NewLedgerEntry,
} from './paper.js';
import type { RiskLimits } from './risk.js';
import type { SimulationModel, SimulationResult } from './simulation-model.js';
import type { BacktestResult, PayoutModel } from './backtest.js';
import type { RiskEvent } from './risk.js';
import type { SystemEvent } from './events.js';
import type { CandleSeries, MarketAsset, MarketDataSource, Timeframe } from './market.js';
import type {
  MarketRegime,
  RiskLevel,
  Signal,
  SignalDirection,
  SignalOutcome,
  SignalStatus,
} from './signal.js';
import type { StrategyMetadata, StrategyParameterSpec } from './strategy.js';

/**
 * Persistence contracts.
 *
 * These are storage-agnostic on purpose: no SQL, no connection, no driver type
 * appears here. `@binaryai/database` implements them against PostgreSQL, and
 * the API depends on the interface — the same shape the AI layer already uses.
 *
 * The engine does NOT import this file. Analysis stays a pure function of
 * market data; persistence is the caller's concern.
 */

/** Row identity and audit columns added by the storage layer. */
export interface StoredRecord {
  readonly id: string;
  /** Epoch ms. */
  readonly createdAt: number;
}

// ------------------------------------------------------------------ assets --

export interface StoredAsset extends MarketAsset, StoredRecord {
  readonly isActive: boolean;
}

export interface AssetRepository {
  /** Insert or update by symbol. Returns the stored row. */
  upsert(asset: MarketAsset): Promise<StoredAsset>;
  findBySymbol(symbol: string): Promise<StoredAsset | null>;
  list(): Promise<readonly StoredAsset[]>;
}

// ----------------------------------------------------------------- candles --

export interface CandleRangeQuery {
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  /** Epoch ms, inclusive. */
  readonly from?: number;
  /** Epoch ms, inclusive. */
  readonly to?: number;
  readonly limit?: number;
}

export interface CandleRepository {
  /**
   * Idempotent write: re-delivering a bar updates it rather than duplicating.
   * The series' `source` is stored as given — synthetic data stays labelled
   * synthetic all the way into the database.
   */
  upsertSeries(series: CandleSeries): Promise<number>;
  findRange(query: CandleRangeQuery): Promise<CandleSeries | null>;
  latest(assetSymbol: string, timeframe: Timeframe, limit: number): Promise<CandleSeries | null>;
  count(assetSymbol: string, timeframe: Timeframe): Promise<number>;
}

// -------------------------------------------------------------- strategies --

export interface StoredStrategy extends StoredRecord {
  readonly strategyKey: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly StrategyParameterSpec[];
}

export interface StrategyRepository {
  /** Records a strategy version so historical signals stay attributable. */
  register(
    meta: StrategyMetadata,
    parameters: readonly StrategyParameterSpec[],
  ): Promise<StoredStrategy>;
  find(strategyKey: string, version: string): Promise<StoredStrategy | null>;
  list(): Promise<readonly StoredStrategy[]>;
}

// ----------------------------------------------------------------- signals --

export interface SignalLinks {
  readonly accountId?: string | null;
  /** Row id from `StrategyRepository.register`. */
  readonly strategyRowId?: string | null;
}

export interface StoredSignalRef {
  readonly id: string;
  readonly storedAt: number;
  /** Indicators, confirmations, conflicts and confidence components written. */
  readonly featureCount: number;
}

export type SignalFeatureKind = 'indicator' | 'confirmation' | 'conflict' | 'confidence_component';

export interface StoredSignalFeature {
  readonly kind: SignalFeatureKind;
  readonly code: string;
  readonly label: string;
  readonly numericValue: number | null;
  readonly weight: number | null;
  readonly severity: string | null;
  readonly detail: string | null;
}

export interface PersistedSignal {
  /** The exact signal as decided, replayed from its stored snapshot. */
  readonly signal: Signal;
  /** The queryable projection of the same evidence. */
  readonly features: readonly StoredSignalFeature[];
  readonly outcome: StoredSignalOutcome | null;
}

export interface SignalQuery {
  /**
   * Ownership filter. Omitted means UNSCOPED -- valid only for internal
   * callers such as the settlement worker. Every request-facing caller passes
   * the scope derived from its principal.
   */
  readonly scope?: AccessScope;
  readonly assetSymbol?: string;
  readonly strategyKey?: string;
  readonly status?: SignalStatus;
  readonly direction?: SignalDirection;
  /** Epoch ms. */
  readonly decidedAfter?: number;
  readonly decidedBefore?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SignalSummary {
  readonly id: string;
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  readonly direction: SignalDirection;
  readonly status: SignalStatus;
  readonly confidence: number;
  readonly riskLevel: RiskLevel;
  readonly marketRegime: MarketRegime;
  readonly decidedAt: number;
  readonly expiresAt: number;
  readonly dataSource: MarketDataSource;
  readonly hasOutcome: boolean;
}

/**
 * A live signal past its expiry with no outcome recorded yet.
 *
 * Only directional signals appear here: a 'none' signal made no prediction, so
 * there is nothing to settle and it is never scanned.
 */
export interface ExpiredSignal {
  readonly id: string;
  /** The engine's own signal id, used for outcome lookups. */
  readonly signalKey: string;
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  readonly direction: Exclude<SignalDirection, 'none'>;
  /** Price at the decision bar; the reference the outcome is measured against. */
  readonly entryPrice: number;
  readonly decidedAt: number;
  readonly expiresAt: number;
}

export interface SignalRepository {
  /** Writes the signal and its features atomically. */
  save(signal: Signal, links?: SignalLinks): Promise<StoredSignalRef>;
  /** Scope is optional only for internal callers; routes always pass one. */
  findById(id: string, scope?: AccessScope): Promise<PersistedSignal | null>;
  list(query?: SignalQuery): Promise<readonly SignalSummary[]>;
  count(query?: SignalQuery): Promise<number>;
  /** Directional signals past expiry that still have no recorded outcome. */
  findExpiredUnsettled(before: number, limit?: number): Promise<readonly ExpiredSignal[]>;
}

// ---------------------------------------------------------------- outcomes --

export interface NewSignalOutcome {
  readonly signalId: string;
  /** Epoch ms. */
  readonly settledAt: number;
  readonly settlementPrice: number;
  readonly result: SignalOutcome['result'];
  /** The payout terms assumed when scoring this outcome. */
  readonly payout?: PayoutModel;
  /** Free-form result metadata, e.g. settlement source or reconciliation notes. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StoredSignalOutcome extends SignalOutcome {
  readonly payout: PayoutModel | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * One settled signal with everything a future calibration model needs.
 *
 * This is a READ MODEL over signals + outcomes + features. Collecting these is
 * the entire point of Phase 2A — calibration itself is NOT implemented, and
 * confidence remains `uncalibrated_heuristic` until it is. See
 * docs/ai-architecture.md.
 */
export interface CalibrationSample {
  readonly signalId: string;
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  readonly direction: SignalDirection;
  readonly entryAt: number;
  readonly expiresAt: number;
  readonly settledAt: number;
  readonly entryPrice: number;
  readonly expiryPrice: number;
  readonly result: SignalOutcome['result'];
  readonly priceDelta: number;
  readonly payoutAssumption: PayoutModel | null;
  readonly strategyKey: string | null;
  readonly strategyVersion: string | null;
  readonly confidenceAtSignal: number;
  readonly confidenceCalibration: string;
  readonly marketRegime: MarketRegime;
  readonly riskLevel: RiskLevel;
  readonly dataQualityScore: number;
  readonly dataSource: MarketDataSource;
  /** Indicator readings at decision time, keyed by feature code. */
  readonly marketConditions: Readonly<Record<string, number>>;
  readonly resultMetadata: Readonly<Record<string, unknown>>;
}

export interface CalibrationQuery {
  readonly strategyKey?: string;
  readonly assetSymbol?: string;
  readonly settledAfter?: number;
  readonly limit?: number;
}

export interface SignalOutcomeRepository {
  record(outcome: NewSignalOutcome): Promise<StoredSignalOutcome>;
  findBySignalId(signalId: string): Promise<StoredSignalOutcome | null>;
  listCalibrationSamples(query?: CalibrationQuery): Promise<readonly CalibrationSample[]>;
  /** How many settled outcomes exist. The gate on any future calibration. */
  countSettled(): Promise<number>;
}

// --------------------------------------------------------------- backtests --

export interface StoredBacktestRef {
  readonly id: string;
  readonly runKey: string;
  readonly storedAt: number;
}

export interface BacktestRunSummary {
  readonly id: string;
  readonly runKey: string;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly datasetLabel: string;
  readonly datasetSource: MarketDataSource;
  readonly assetSymbol: string;
  readonly timeframe: Timeframe;
  readonly candleCount: number;
  readonly trades: number;
  readonly winRate: number | null;
  readonly netPnl: number;
  readonly startedAt: number;
  /** Always 'historical_simulation'. Never real performance. */
  readonly resultType: string;
}

export interface BacktestRepository {
  save(result: BacktestResult, options?: { userId?: string | null }): Promise<StoredBacktestRef>;
  findById(id: string): Promise<BacktestResult | null>;
  list(limit?: number): Promise<readonly BacktestRunSummary[]>;
}

// ------------------------------------------------------------------ events --

export interface NewSystemEvent extends Omit<SystemEvent, 'id' | 'at'> {
  readonly at?: number;
}

export interface NewRiskEvent extends Omit<RiskEvent, 'id' | 'at'> {
  readonly at?: number;
  readonly signalId?: string | null;
  readonly accountId?: string | null;
}

export interface EventQuery {
  readonly category?: string;
  readonly code?: string;
  readonly since?: number;
  readonly limit?: number;
}

export interface SystemEventRepository {
  record(event: NewSystemEvent): Promise<void>;
  list(query?: EventQuery): Promise<readonly SystemEvent[]>;
}

export interface RiskEventRepository {
  record(event: NewRiskEvent): Promise<void>;
  list(query?: EventQuery): Promise<readonly RiskEvent[]>;
  /** Scoped listing. There is no path that returns another account's events. */
  listForAccount(accountId: string, limit?: number): Promise<readonly RiskEvent[]>;
}

// ------------------------------------------------------------------ users --

export interface NewUser {
  readonly email: string;
  /** Already an Argon2id digest. A plaintext password must never reach here. */
  readonly passwordHash: string;
  readonly displayName?: string | null;
  readonly role?: UserRole;
}

export interface UserRepository {
  /**
   * Creates the user. Throws on a duplicate email so the caller cannot decide
   * to overwrite an existing account by accident.
   */
  create(user: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  /**
   * Credential lookup for the login flow ONLY. Returns the password digest, so
   * the result must never leave the authentication path.
   */
  findByEmailWithCredentials(email: string): Promise<UserWithCredentials | null>;
  list(limit?: number, offset?: number): Promise<readonly User[]>;
  count(): Promise<number>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  setActive(userId: string, isActive: boolean): Promise<void>;
  /** Clears the failure counter and stamps the login time. */
  recordLoginSuccess(userId: string, at: number): Promise<void>;
  /**
   * Increments the failure counter, locking the account until `lockUntil` when
   * one is given. Returns the new consecutive-failure count.
   */
  recordLoginFailure(userId: string, at: number, lockUntil: number | null): Promise<number>;
}

// --------------------------------------------------------------- sessions --

export interface NewSession {
  readonly userId: string;
  /** SHA-256 of the token. The raw token is never persisted. */
  readonly tokenHash: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

export interface SessionRepository {
  create(session: NewSession): Promise<Session>;
  /**
   * Looks a session up by token digest. Returns the row whatever its state --
   * expired or revoked included -- so the caller can distinguish "never
   * existed" from "no longer valid" when auditing.
   */
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  /** Refreshes the activity stamp. Cheap enough to call per request. */
  touch(sessionId: string, at: number): Promise<void>;
  revoke(sessionId: string, at: number): Promise<void>;
  /** Revokes every live session for a user. Returns how many were affected. */
  revokeAllForUser(userId: string, at: number): Promise<number>;
  /** Live sessions only, newest first. Powers the "your devices" list. */
  listActiveForUser(userId: string, at: number): Promise<readonly Session[]>;
  /** Deletes rows that expired before `before`. Returns how many were removed. */
  deleteExpired(before: number): Promise<number>;
}

// --------------------------------------------------------------- accounts --

export interface NewAccount {
  readonly userId: string;
  readonly name?: string;
  readonly currency?: string;
  readonly balance?: number;
  readonly isDefault?: boolean;
  readonly riskLimits?: Partial<RiskLimits>;
}

export interface AccountRepository {
  /**
   * Creates a demo account. `mode` is not a parameter: this build cannot
   * create a live account, and the database CHECK agrees.
   */
  create(account: NewAccount): Promise<Account>;
  findById(id: string): Promise<Account | null>;
  /** The account new signals and trades are attributed to. */
  findDefaultForUser(userId: string): Promise<Account | null>;
  listForUser(userId: string): Promise<readonly Account[]>;
  /** Replaces the account's whole risk policy and bumps its version. */
  updatePolicy(accountId: string, policy: AccountRiskPolicy): Promise<Account>;
  /** Sets the paper unit allocation. Writes a ledger entry, never a bare update. */
  allocateUnits(accountId: string, units: number, source: string): Promise<void>;
  /** Replaces the account's simulation payout assumption and bumps its version. */
  /** Selects a server-defined model, or none. A client may choose, never author. */
  selectSimulationModel(accountId: string, modelId: string | null): Promise<Account>;
}

// -------------------------------------------------------- paper positions --

export interface PositionQuery {
  readonly status?: AccountPaperPositionStatus;
  readonly signalId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Live account state the risk layer needs, read inside the same transaction. */
export interface AccountActivitySnapshot {
  readonly openPositions: number;
  /** Units committed by positions opened within the window. */
  readonly exposureInWindow: number;
  readonly consecutiveLosses: number;
  readonly lastLossAt: number | null;
  readonly settledPositions: number;
}

export interface PaperPositionRepository {
  /**
   * Opens a position and writes its exposure entry atomically.
   *
   * The caller must already have evaluated risk against a snapshot taken under
   * the same account lock -- see `withAccountLock`. Throws on a duplicate
   * action key; the unique index is the authority, not a prior check.
   */
  open(position: NewAccountPaperPosition): Promise<AccountPaperPosition>;
  findById(id: string, accountId: string): Promise<AccountPaperPosition | null>;
  /** Scoped by account. There is no unscoped list. */
  list(accountId: string, query?: PositionQuery): Promise<readonly AccountPaperPosition[]>;
  count(accountId: string, status?: AccountPaperPositionStatus): Promise<number>;
  /** Account state for the risk layer, as of `now`. */
  activity(accountId: string, windowFromMs: number, now: number): Promise<AccountActivitySnapshot>;
  /** Positions past expiry that still need settling, across all accounts. */
  findExpired(before: number, limit?: number): Promise<readonly AccountPaperPosition[]>;
  /**
   * Records the settlement and releases the committed exposure atomically.
   *
   * `payout` is the delta the CALLER computed from the account's assumption —
   * the repository never derives it, because that is a domain rule and belongs
   * in the engine. Omitted or zero means exposure-only accounting, which is
   * the default.
   */
  settle(input: {
    readonly positionId: string;
    readonly settledAt: number;
    readonly settlementPrice: number;
    readonly result: SignalOutcome['result'];
    readonly dataOrigin: string;
    readonly simulation?: SimulationResult;
  }): Promise<AccountPaperPosition>;
  /** Marks a position as awaiting its settlement bar. */
  markPendingSettlement(positionId: string, at: number): Promise<void>;
  cancel(positionId: string, accountId: string, at: number): Promise<AccountPaperPosition | null>;
  /**
   * Runs `work` with the account row locked FOR UPDATE.
   *
   * This is what makes the open-position limit hold under concurrency: two
   * requests for the same account serialize here, so the second sees the first
   * one's position when it counts. Without it both would read the same count
   * and both would be permitted.
   */
  withAccountLock<T>(accountId: string, work: (tx: Repositories) => Promise<T>): Promise<T>;
}

// ------------------------------------------------------ simulation models --

/**
 * The model catalogue.
 *
 * Read-only by design: models are published by migration and reviewed in
 * version control. There is deliberately no create or update method, so
 * "a client cannot author the accounting model" holds structurally rather
 * than by anyone remembering not to add one.
 */
export interface SimulationModelRepository {
  /** Models a user may select. Excludes draft and deprecated. */
  listSelectable(): Promise<readonly SimulationModel[]>;
  /** Any model, including deprecated, so settled positions stay explainable. */
  findById(id: string): Promise<SimulationModel | null>;
  findByKeyAndVersion(modelKey: string, version: string): Promise<SimulationModel | null>;
}

// ---------------------------------------------------------------- ledger --

export interface LedgerRepository {
  /** Appends an entry. There is no update and no delete, by design and by trigger. */
  append(entry: NewLedgerEntry): Promise<LedgerEntry>;
  list(accountId: string, limit?: number, offset?: number): Promise<readonly LedgerEntry[]>;
  /** Sum of every entry. The balance is derived, never stored. */
  balance(accountId: string): Promise<number>;
  /** Units currently committed to active positions, from the ledger. */
  committed(accountId: string): Promise<number>;
  /**
   * Simulated deltas in occurrence order, from 'simulated_return' entries only.
   *
   * Separate from `balance` so a caller must choose deliberately between "what
   * exposure this account holds" and "what a stated model computes those
   * outcomes to be worth". Conflating them is how a premise becomes a result.
   *
   * Ordered rather than pre-summed so the caller totals a fixed sequence: the
   * same history must not total differently on two reads.
   */
  simulatedDeltas(accountId: string): Promise<readonly number[]>;
  /**
   * The simulated entry for one position, scoped to an account.
   *
   * Account-scoped in the QUERY rather than filtered afterwards, so a position
   * belonging to someone else is indistinguishable from one that does not
   * exist. Returns null when the position produced no simulated value.
   */
  simulationForPosition(positionId: string, accountId: string): Promise<LedgerEntry | null>;
  /** Win/loss/tie tallies taken from the settled positions the entries attach to. */
  simulatedOutcomeCounts(accountId: string): Promise<{
    wins: number;
    losses: number;
    ties: number;
    positions: number;
  }>;
}

// ------------------------------------------------------------------ bundle --

export interface Repositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly accounts: AccountRepository;
  readonly assets: AssetRepository;
  readonly candles: CandleRepository;
  readonly strategies: StrategyRepository;
  readonly signals: SignalRepository;
  readonly outcomes: SignalOutcomeRepository;
  readonly analytics: AnalyticsRepository;
  readonly positions: PaperPositionRepository;
  readonly simulationModels: SimulationModelRepository;
  readonly ledger: LedgerRepository;
  readonly backtests: BacktestRepository;
  readonly systemEvents: SystemEventRepository;
  readonly riskEvents: RiskEventRepository;
  /**
   * Runs `work` inside a single transaction. The repositories handed to the
   * callback share that transaction; everything rolls back on a throw.
   */
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

/**
 * The persistence handle held by the application. Optional throughout: the API
 * runs stateless when no database is configured, which is still the default.
 */
export interface PersistenceLayer {
  readonly repositories: Repositories;
  /** True when the database answers. Used by the readiness probe. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
