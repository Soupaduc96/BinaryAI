import type {
  Account,
  AccountRepository,
  AccountRiskPolicy,
  NewAccount,
  RiskLimits,
} from '@binaryai/types';
import { RecordNotFoundError, type Row, type SqlExecutor } from '../executor.js';
import {
  fromJson,
  toTimestamp,
  toBoolean,
  toEpochMs,
  toJsonParam,
  toNullableEpochMs,
  toNullableText,
  toNumber,
  toText,
} from '../mappers.js';

/**
 * Demo accounts.
 *
 * `mode` is never a parameter. The column defaults to 'demo' and carries a
 * CHECK that permits nothing else, so a live account cannot be created here
 * even by a caller that wants to. That is the fourth of the four independent
 * layers described in docs/risk-management.md, and the only one an application
 * bug cannot bypass.
 *
 * Balances are NUMERIC in the database and read back through `toNumber`, which
 * fails loudly on anything that is not exactly representable rather than
 * silently rounding money.
 */

interface AccountRow extends Row {
  id: string;
  user_id: string;
  name: string;
  mode: string;
  currency: string;
  balance: string | number;
  day_start_balance: string | number;
  open_exposure: string | number;
  consecutive_losses: number | string;
  last_loss_at: Date | null;
  is_default: boolean;
  risk_limits: unknown;
  created_at: Date;
  risk_policy_version: number | string;
  risk_policy_updated_at: Date;
  max_position_size: string | number;
  max_daily_exposure: string | number;
  allowed_strategies: string[] | null;
  allowed_timeframes: string[] | null;
  allowed_assets: string[] | null;
  per_instrument_limits: unknown;
  allocated_units: string | number;
  simulation_model_id: string | null;
}

const COLUMNS = `id, user_id, name, mode, currency, balance, day_start_balance, open_exposure,
                 consecutive_losses, last_loss_at, is_default, risk_limits, created_at,
                 risk_policy_version, risk_policy_updated_at, max_position_size,
                 max_daily_exposure, allowed_strategies, allowed_timeframes, allowed_assets,
                 allocated_units, simulation_model_id, per_instrument_limits`;

function toAccount(row: AccountRow): Account {
  const mode = toText(row.mode, 'account.mode');
  if (mode !== 'demo') {
    // Unreachable while the CHECK stands. If it ever fires, something has
    // altered the schema, and failing here is far better than handing back an
    // account this build has no business operating.
    throw new Error(`Account ${row.id} has mode "${mode}"; this build only supports demo.`);
  }
  return {
    id: toText(row.id, 'account.id'),
    userId: toText(row.user_id, 'account.user_id'),
    name: toText(row.name, 'account.name'),
    mode: 'demo',
    currency: toText(row.currency, 'account.currency'),
    balance: toNumber(row.balance, 'account.balance'),
    dayStartBalance: toNumber(row.day_start_balance, 'account.day_start_balance'),
    openExposure: toNumber(row.open_exposure, 'account.open_exposure'),
    consecutiveLosses: toNumber(row.consecutive_losses, 'account.consecutive_losses'),
    lastLossAt: toNullableEpochMs(row.last_loss_at),
    isDefault: toBoolean(row.is_default),
    riskLimits: fromJson<Partial<RiskLimits>>(row.risk_limits, {}),
    createdAt: toEpochMs(row.created_at, 'account.created_at'),
    policyVersion: toNumber(row.risk_policy_version, 'account.risk_policy_version'),
    policyUpdatedAt: toEpochMs(row.risk_policy_updated_at, 'account.risk_policy_updated_at'),
    maxPositionSize: toNumber(row.max_position_size, 'account.max_position_size'),
    maxDailyExposure: toNumber(row.max_daily_exposure, 'account.max_daily_exposure'),
    // NULL stays null (unrestricted); an empty array stays empty (allow none).
    // Coalescing either into the other would invert the operator's intent.
    allowedStrategies: row.allowed_strategies,
    allowedTimeframes: row.allowed_timeframes as Account['allowedTimeframes'],
    allowedAssets: row.allowed_assets,
    // NULL stays null: no instrument-specific limits is the default, and the
    // account limits alone then behave exactly as they always have.
    perInstrument: (row.per_instrument_limits ?? null) as Account['perInstrument'],
    allocatedUnits: toNumber(row.allocated_units, 'account.allocated_units'),
    // NULL means no simulation is selected, which is a real state rather than
    // a missing one: the account keeps exposure-only accounting and has no
    // simulated value at all.
    simulationModelId: toNullableText(row.simulation_model_id),
  };
}

export function createAccountRepository(executor: SqlExecutor): AccountRepository {
  return {
    async create(account: NewAccount): Promise<Account> {
      const balance = account.balance ?? 0;
      const result = await executor.query<AccountRow>(
        `INSERT INTO accounts
           (user_id, name, currency, balance, day_start_balance, is_default, risk_limits)
         VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb)
         RETURNING ${COLUMNS}`,
        [
          account.userId,
          account.name ?? 'Demo account',
          account.currency ?? 'USD',
          balance,
          account.isDefault ?? true,
          toJsonParam(account.riskLimits ?? {}),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('account', account.userId);
      return toAccount(row);
    },

    async findById(id: string): Promise<Account | null> {
      const result = await executor.query<AccountRow>(
        `SELECT ${COLUMNS} FROM accounts WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toAccount(row) : null;
    },

    async findDefaultForUser(userId: string): Promise<Account | null> {
      const result = await executor.query<AccountRow>(
        `SELECT ${COLUMNS} FROM accounts WHERE user_id = $1 AND is_default LIMIT 1`,
        [userId],
      );
      const row = result.rows[0];
      return row ? toAccount(row) : null;
    },

    async listForUser(userId: string): Promise<readonly Account[]> {
      const result = await executor.query<AccountRow>(
        `SELECT ${COLUMNS} FROM accounts WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      return result.rows.map(toAccount);
    },

    async updatePolicy(accountId: string, policy: AccountRiskPolicy): Promise<Account> {
      // The version comes from the caller, which computed it from the policy it
      // read. Writing it here rather than incrementing in SQL keeps the version
      // that was evaluated and the version that was stored identical.
      const result = await executor.query<AccountRow>(
        `UPDATE accounts
            SET risk_limits = $2::jsonb,
                risk_policy_version = $3,
                risk_policy_updated_at = $4,
                max_position_size = $5,
                max_daily_exposure = $6,
                allowed_strategies = $7,
                allowed_timeframes = $8,
                allowed_assets = $9,
                per_instrument_limits = $10::jsonb
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [
          accountId,
          toJsonParam(policy.limits),
          policy.version,
          toTimestamp(policy.updatedAt),
          policy.maxPositionSize,
          policy.maxDailyExposure,
          policy.allowedStrategies === null ? null : [...policy.allowedStrategies],
          policy.allowedTimeframes === null ? null : [...policy.allowedTimeframes],
          policy.allowedAssets === null ? null : [...policy.allowedAssets],
          policy.perInstrument === null ? null : toJsonParam(policy.perInstrument),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('account', accountId);
      return toAccount(row);
    },

    /**
     * Selects a server-defined simulation model, or none.
     *
     * This replaced updateSimulationPayout, which wrote a rate the CLIENT
     * supplied. The difference is the whole point of the model catalogue: a
     * caller may now choose among published models but cannot author one, so
     * every simulated figure traces to arithmetic that was reviewed and
     * versioned rather than typed into a request body.
     *
     * The FK does the enforcing. Passing an id that is not in the catalogue
     * fails at the database rather than storing a dangling reference.
     */
    async selectSimulationModel(accountId: string, modelId: string | null): Promise<Account> {
      const result = await executor.query<AccountRow>(
        `UPDATE accounts SET simulation_model_id = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
        [accountId, modelId],
      );
      const row = result.rows[0];
      if (!row) throw new RecordNotFoundError('account', accountId);
      return toAccount(row);
    },

    async allocateUnits(accountId: string, units: number, source: string): Promise<void> {
      // The column and the ledger entry are written together: an allocation
      // with no ledger entry would make the derived balance disagree with the
      // stated allocation, and there would be no way to tell which was right.
      await executor.query('UPDATE accounts SET allocated_units = $2 WHERE id = $1', [
        accountId,
        units,
      ]);
      await executor.query(
        `INSERT INTO paper_ledger_entries (account_id, type, amount, source, metadata)
         VALUES ($1, 'initial_allocation', $2, $3, '{"note":"Paper accounting units. Not currency."}'::jsonb)`,
        [accountId, units, source],
      );
    },
  };
}
