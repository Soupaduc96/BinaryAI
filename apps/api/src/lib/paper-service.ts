import { resolvePositionDetails } from './position-details.js';
import {
  applyPolicyUpdate,
  defaultAccountPolicy,
  describeModel,
  evaluateAccountAction,
  exposureWindow,
  resolveRiskLimits,
  returnFraction,
  simulatedValue,
  validateParameters,
  type SignalCandidate,
} from '@binaryai/engine';
import type {
  Account,
  AccountPaperPosition,
  AccountRiskDecision,
  AccountRiskPolicy,
  AccountRiskPolicyUpdate,
  AccountSimulationSummary,
  PaperAccountState,
  PositionDetail,
  PositionQuery,
  PositionSimulation,
  Repositories,
  SimulationModel,
} from '@binaryai/types';

/**
 * Paper accounts, risk enforcement and position lifecycle.
 *
 * The heart of Phase 5 is `openPosition`, and its shape is deliberate: the risk
 * evaluation and the insert happen inside ONE transaction holding a lock on the
 * account row. Evaluating outside the transaction would make the open-position
 * limit advisory — two concurrent requests would each read "0 open, limit 1"
 * and each create a position.
 *
 * Everything else follows from two rules:
 *
 *  - **A blocked decision writes no position.** It writes a risk event instead,
 *    so the refusal is auditable without a phantom row existing.
 *  - **The account policy is authoritative.** A request cannot supply limits.
 *    The only thing a caller controls is the size, and that is checked against
 *    the stored policy rather than against anything it sent.
 */

/**
 * Units allocated to a new paper account.
 *
 * A unit is an accounting quantity, not a currency and not a claim on anything.
 * The allocation exists so a new account can act immediately and so exposure
 * has something to be measured against; it is not a balance, and no outcome
 * ever increases or decreases it.
 */
export const DEFAULT_PAPER_ALLOCATION = 100;

/**
 * Thrown when a requested simulation model cannot be selected.
 *
 * Deliberately does not distinguish "no such model" from "not selectable": a
 * caller probing ids learns only that the selection was refused.
 */
export class ModelSelectionRejected extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join(' '));
    this.name = 'ModelSelectionRejected';
    this.problems = problems;
  }
}

/**
 * Stated wherever units are shown, so nobody reads them as money.
 *
 * The last sentence is deliberately about EXPOSURE rather than about the
 * account as a whole. Since Phase 6 an account may also carry a simulated
 * value, and a blanket "no profit or loss is recorded" would contradict the
 * simulation module sitting beside it. Exposure still records none: it is
 * committed and released in full, and a simulated return is a separate figure
 * produced by a stated model, never by broker terms.
 */
export const ACCOUNTING_NOTE =
  'Units are a paper accounting quantity, not currency and not money held by BinaryAI. ' +
  'Exposure is committed when a position opens and released in full when it settles, so ' +
  'exposure itself records no profit or loss. Any simulated value is computed separately by ' +
  'the simulation model the account has selected, and never by broker terms.';

export type OpenPositionResult =
  | {
      readonly ok: true;
      readonly position: AccountPaperPosition;
      readonly decision: AccountRiskDecision;
      readonly duplicate: boolean;
    }
  | { readonly ok: false; readonly decision: AccountRiskDecision };

export interface PaperService {
  policyFor(account: Account): AccountRiskPolicy;
  updatePolicy(account: Account, update: AccountRiskPolicyUpdate): Promise<Account>;
  /** Dry run. Evaluates without locking or writing anything. */
  evaluate(account: Account, signalId: string, size: number): Promise<AccountRiskDecision>;
  openPosition(input: {
    account: Account;
    signalId: string;
    size: number;
    actionKey: string;
  }): Promise<OpenPositionResult>;
  listPositions(accountId: string, query?: PositionQuery): Promise<readonly AccountPaperPosition[]>;
  /**
   * Positions with their settlement bar and simulated attribution resolved.
   *
   * Resolved here rather than in the client for two reasons: the settlement bar
   * must be computed by the same rule the worker used, and a simulated figure
   * must never appear without the model that produced it. Both are properties
   * of the server's arithmetic, not of a display.
   */
  listPositionDetails(
    accountId: string,
    query?: PositionQuery,
  ): Promise<readonly (AccountPaperPosition & PositionDetail)[]>;
  getPosition(id: string, accountId: string): Promise<AccountPaperPosition | null>;
  cancelPosition(id: string, accountId: string): Promise<AccountPaperPosition | null>;
  state(account: Account): Promise<PaperAccountState>;
  /** The published models a user may choose between. */
  listModels(): Promise<readonly SimulationModel[]>;
  /** The model this account has selected, or null when simulation is off. */
  modelFor(account: Account): Promise<SimulationModel | null>;
  /**
   * Selects a model by id, or null to turn simulation off.
   *
   * The id must name a SELECTABLE model. A caller cannot reach a draft model
   * or anything outside the catalogue, which is what keeps a client from
   * choosing arithmetic that was never published for use.
   */
  selectModel(account: Account, modelId: string | null): Promise<Account>;
  /** Simulated standing, which exists ONLY when a model is selected. */
  simulationSummary(account: Account): Promise<AccountSimulationSummary>;
  /** One position's simulated result, or nulls when none was produced. */
  positionSimulation(positionId: string, accountId: string): Promise<PositionSimulation | null>;
  /** Allocates starting units. Idempotent: only ever runs on an unfunded account. */
  ensureAllocation(accountId: string): Promise<void>;
}

/** Stated wherever a simulated figure is shown. Never omitted. */
export const SIMULATION_DISCLOSURE =
  'Simulated under a stated model. These are not broker results, not real trading ' +
  'performance and not a prediction. No order was placed and no counterparty exists.';

export interface PaperServiceDeps {
  readonly repositories: Repositories;
  readonly now?: () => number;
}

/** Projects the stored account row into the policy the engine evaluates. */
function toPolicy(account: Account): AccountRiskPolicy {
  return {
    accountId: account.id,
    version: account.policyVersion,
    updatedAt: account.policyUpdatedAt,
    // Stored overrides layered onto the engine defaults, so a partially
    // configured account still has every field.
    limits: resolveRiskLimits(account.riskLimits),
    maxPositionSize: account.maxPositionSize,
    maxDailyExposure: account.maxDailyExposure,
    allowedStrategies: account.allowedStrategies,
    allowedTimeframes: account.allowedTimeframes,
    allowedAssets: account.allowedAssets,
    // Not persisted yet: per-instrument limits are configured through the
    // policy update path and stored alongside the other overrides.
    perInstrument: account.perInstrument ?? null,
  };
}

export function createPaperService(deps: PaperServiceDeps): PaperService {
  const { repositories, now = Date.now } = deps;

  /** Reads the signal in the shape the risk engine needs. */
  async function loadCandidate(
    repos: Repositories,
    signalId: string,
  ): Promise<SignalCandidate | null> {
    // Unscoped on purpose: a user may act on a SYSTEM signal (account_id NULL),
    // which their own scope would not return. Ownership of the ACTION is what
    // matters here, and that is enforced by the account lock and the position's
    // account_id -- not by who owns the analysis.
    const persisted = await repos.signals.findById(signalId);
    if (!persisted) return null;

    const signal = persisted.signal;
    return {
      id: signalId,
      assetSymbol: signal.asset,
      timeframe: signal.timeframe,
      direction: signal.direction,
      status: signal.status,
      strategyKey: signal.strategy.id,
      expiresAt: signal.expiration.expiresAt,
      entryPrice: signal.price,
      dataOrigin: signal.dataSource === 'synthetic' ? 'synthetic' : 'exchange',
    };
  }

  /**
   * Live account state, optionally also scoped to the instrument being acted on.
   *
   * R4: the instrument counts come from the same query, and default to the
   * ACCOUNT totals when no instrument was named. That default is the
   * conservative one — an instrument limit then behaves like the account limit
   * rather than being silently unenforced.
   */
  async function buildContext(
    repos: Repositories,
    account: Account,
    at: number,
    assetSymbol?: string,
  ) {
    const window = exposureWindow(at);
    const [activity, committed] = await Promise.all([
      repos.positions.activity(account.id, window.fromMs, at, assetSymbol),
      repos.ledger.committed(account.id),
    ]);

    return {
      accountActive: true,
      openPositions: activity.openPositions,
      exposureInWindow: activity.exposureInWindow,
      consecutiveLosses: activity.consecutiveLosses,
      lastLossAt: activity.lastLossAt,
      availableUnits: Math.max(0, account.allocatedUnits - committed),
      instrumentOpenPositions: activity.instrumentOpenPositions ?? activity.openPositions,
      instrumentExposureInWindow: activity.instrumentExposureInWindow ?? activity.exposureInWindow,
      instrumentLastLossAt: activity.instrumentLastLossAt ?? activity.lastLossAt,
    };
  }

  return {
    policyFor: toPolicy,

    async updatePolicy(account, update) {
      const next = applyPolicyUpdate(toPolicy(account), update, now());
      const saved = await repositories.accounts.updatePolicy(account.id, next);

      await repositories.riskEvents.record({
        accountId: account.id,
        code: 'limits_updated',
        severity: 'info',
        message: `Risk policy updated to version ${next.version}.`,
        executionMode: 'demo',
        // The values, never the request body: a payload could carry anything.
        context: {
          policyVersion: next.version,
          maxPositionSize: next.maxPositionSize,
          maxDailyExposure: next.maxDailyExposure,
          maxOpenPositions: next.limits.maxOpenPositions,
        },
      });
      return saved;
    },

    async evaluate(account, signalId, size) {
      const at = now();
      const policy = toPolicy(account);
      const candidate = await loadCandidate(repositories, signalId);

      if (!candidate) {
        // A missing signal is reported as insufficient context rather than as a
        // blocked rule: there was nothing to evaluate against.
        return {
          outcome: 'insufficient_context',
          allowed: false,
          evaluations: [
            {
              code: 'signal_actionable',
              label: 'Signal actionable',
              passed: false,
              observed: null,
              limit: null,
              window: null,
              detail: 'No such signal.',
            },
          ],
          blockedBy: ['signal_actionable'],
          decidedAt: at,
          policyVersion: policy.version,
          retryAfterMs: null,
        };
      }

      const context = await buildContext(repositories, account, at, candidate.assetSymbol);
      return evaluateAccountAction({ policy, signal: candidate, context, size, now: at });
    },

    async openPosition({ account, signalId, size, actionKey }) {
      const at = now();
      const policy = toPolicy(account);

      // Everything below runs under a FOR UPDATE lock on the account row, so a
      // concurrent request for the same account waits here and then observes
      // this one's position when it counts.
      return repositories.positions.withAccountLock(account.id, async (tx) => {
        // Idempotency is checked BEFORE risk, and the order matters.
        //
        // A retry of an action that already succeeded must return that
        // position -- not be refused by the open-position limit which the
        // earlier success itself created. Evaluating risk first would tell a
        // user retrying a timed-out request that they had hit their limit,
        // when in fact their action had gone through.
        //
        // This read is inside the account lock, so it cannot race a concurrent
        // first attempt; the unique index remains the final authority.
        const priorAttempts = await tx.positions.list(account.id, { signalId, limit: 50 });
        const alreadyDone = priorAttempts.find((position) => position.actionKey === actionKey);
        if (alreadyDone) {
          return {
            ok: true as const,
            position: alreadyDone,
            decision: {
              outcome: 'allowed' as const,
              allowed: true,
              evaluations: [],
              blockedBy: [],
              decidedAt: at,
              policyVersion: alreadyDone.policyVersion,
              retryAfterMs: null,
            },
            duplicate: true,
          };
        }

        const candidate = await loadCandidate(tx, signalId);
        if (!candidate) {
          return {
            ok: false as const,
            decision: await this.evaluate(account, signalId, size),
          };
        }

        const context = await buildContext(tx, account, at, candidate.assetSymbol);
        const decision = evaluateAccountAction({
          policy,
          signal: candidate,
          context,
          size,
          now: at,
        });

        if (!decision.allowed) {
          // A blocked action leaves an audit trail and no position. Recording
          // a 'rejected' row instead would make it count toward listings and
          // would blur "was refused" with "was taken and failed".
          await tx.riskEvents.record({
            accountId: account.id,
            signalId,
            code: decision.blockedBy[0] ?? 'blocking_conflict',
            severity: 'warning',
            message: `Paper action refused: ${decision.outcome}.`,
            executionMode: 'demo',
            context: {
              outcome: decision.outcome,
              blockedBy: decision.blockedBy.join(','),
              policyVersion: decision.policyVersion,
              requestedSize: Number.isFinite(size) ? size : String(size),
              openPositions: context.openPositions,
              exposureInWindow: context.exposureInWindow,
            },
          });
          return { ok: false as const, decision };
        }

        try {
          const position = await tx.positions.open({
            accountId: account.id,
            signalId,
            size,
            actionKey,
            policyVersion: policy.version,
          });
          return { ok: true as const, position, decision, duplicate: false };
        } catch (error) {
          // The unique index is the authority on idempotency. A repeated action
          // key returns the EXISTING position rather than an error: the caller
          // asked for one position and there is exactly one.
          if (isUniqueViolation(error)) {
            const existing = await tx.positions.list(account.id, { signalId, limit: 50 });
            const match = existing.find((position) => position.actionKey === actionKey);
            if (match) {
              return { ok: true as const, position: match, decision, duplicate: true };
            }
          }
          throw error;
        }
      });
    },

    listPositions: (accountId, query) => repositories.positions.list(accountId, query),

    listPositionDetails: (accountId, query) =>
      resolvePositionDetails(repositories, accountId, query),

    getPosition: (id, accountId) => repositories.positions.findById(id, accountId),

    async cancelPosition(id, accountId) {
      return repositories.positions.cancel(id, accountId, now());
    },

    async state(account) {
      const [committed, activity] = await Promise.all([
        repositories.ledger.committed(account.id),
        repositories.positions.activity(account.id, exposureWindow(now()).fromMs, now()),
      ]);
      const entries = await repositories.ledger.list(account.id, 1);

      return {
        accountId: account.id,
        // An unfunded account has no accounting model rather than a zero
        // balance: "not configured" and "nothing left" are different states.
        accountingModel: account.allocatedUnits > 0 ? 'exposure_only' : 'not_configured',
        unit: 'paper unit',
        allocatedUnits: account.allocatedUnits,
        committedUnits: committed,
        availableUnits: Math.max(0, account.allocatedUnits - committed),
        openPositions: activity.openPositions,
        settledPositions: activity.settledPositions,
        lastActivityAt: entries[0]?.occurredAt ?? null,
        accountingNote: ACCOUNTING_NOTE,
      };
    },

    async listModels() {
      return repositories.simulationModels.listSelectable();
    },

    async modelFor(account) {
      if (!account.simulationModelId) return null;
      // By id, not filtered by status: an account settling positions under a
      // model that was since deprecated must still be able to read it.
      return repositories.simulationModels.findById(account.simulationModelId);
    },

    async selectModel(account, modelId) {
      if (modelId !== null) {
        // Checked against the SELECTABLE set, not merely against existence.
        // This is the boundary that stops a client from choosing arithmetic
        // that was never published for use.
        const selectable = await repositories.simulationModels.listSelectable();
        const chosen = selectable.find((model) => model.id === modelId);
        if (!chosen) {
          throw new ModelSelectionRejected([
            'That simulation model is not available for selection.',
          ]);
        }
        // Belt and braces: the catalogue is constrained, but a model whose
        // parameters could not compute must never become an account's model.
        const check = validateParameters(chosen.parameters);
        if (!check.ok) throw new ModelSelectionRejected(check.problems);
      }

      const saved = await repositories.accounts.selectSimulationModel(account.id, modelId);
      await repositories.riskEvents.record({
        accountId: account.id,
        code: 'limits_updated',
        severity: 'info',
        message: modelId
          ? 'Simulation model selected. Settlements from now on derive a simulated value.'
          : 'Simulation turned off; accounting returns to exposure-only.',
        executionMode: 'demo',
        context: { simulationModelId: modelId },
      });
      return saved;
    },

    async simulationSummary(account) {
      const model = account.simulationModelId
        ? await repositories.simulationModels.findById(account.simulationModelId)
        : null;

      // Counts come from the ledger joined onto settled positions, so a
      // simulated tally can never disagree with what actually settled.
      const counts = await repositories.ledger.simulatedOutcomeCounts(account.id);

      // Expired positions with no usable candle. Reported in their own field
      // and NEVER folded into losses: an unresolved position has no outcome,
      // and counting it as one would invent a result the market never produced.
      const pending = await repositories.positions.list(account.id, {
        status: 'pending_settlement',
        limit: 200,
      });

      if (!model) {
        // Every figure is null rather than zero. "No simulation" and
        // "simulated zero" are different statements, and a zero reads as the
        // second one.
        return {
          enabled: false,
          model: null,
          startingUnits: null,
          currentUnits: null,
          simulatedReturn: null,
          returnFraction: null,
          wins: counts.wins,
          losses: counts.losses,
          ties: counts.ties,
          simulatedPositions: counts.positions,
          unresolved: pending.length,
          disclosure:
            'No simulation model is selected, so this account has no simulated value. ' +
            'Exposure accounting is unaffected.',
        };
      }

      const deltas = await repositories.ledger.simulatedDeltas(account.id);
      const startingUnits = model.parameters.startingUnits;
      const currentUnits = simulatedValue(startingUnits, deltas);

      return {
        enabled: true,
        model,
        startingUnits,
        currentUnits,
        simulatedReturn: Number((currentUnits - startingUnits).toFixed(8)) + 0,
        returnFraction: returnFraction(startingUnits, currentUnits),
        wins: counts.wins,
        losses: counts.losses,
        ties: counts.ties,
        simulatedPositions: counts.positions,
        unresolved: pending.length,
        disclosure: `${describeModel(model)} ${SIMULATION_DISCLOSURE}`,
      };
    },

    async positionSimulation(positionId, accountId) {
      // Scoped by accountId in the query itself. A position belonging to
      // another account is indistinguishable from one that does not exist.
      const position = await repositories.positions.findById(positionId, accountId);
      if (!position) return null;

      const entry = await repositories.ledger.simulationForPosition(positionId, accountId);
      const model = entry?.simulationModelId
        ? await repositories.simulationModels.findById(entry.simulationModelId)
        : null;

      return {
        positionId,
        exposure: position.size,
        observedOutcome: position.result,
        // Null, not zero, when no simulated entry exists: the position may be
        // unresolved, or may have settled before any model was selected.
        delta: entry ? entry.amount : null,
        modelKey: model?.modelKey ?? null,
        modelVersion: entry?.simulationModelVersion ?? null,
        modelName: model?.name ?? null,
        occurredAt: entry?.occurredAt ?? null,
      };
    },

    async ensureAllocation(accountId) {
      const account = await repositories.accounts.findById(accountId);
      // Only ever funds an account that has never been funded, so calling this
      // twice cannot double an allocation.
      if (!account || account.allocatedUnits > 0) return;
      await repositories.accounts.allocateUnits(
        accountId,
        DEFAULT_PAPER_ALLOCATION,
        'account_created',
      );
    },
  };
}

/** Recognises a unique-constraint violation without importing the driver. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : '';
  return /duplicate key|unique constraint/i.test(message);
}

/** Default policy for an account that has none stored. Exported for tests. */
export { defaultAccountPolicy };
