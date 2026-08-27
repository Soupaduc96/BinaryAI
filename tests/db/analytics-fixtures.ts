import type { AccessScope } from '@binaryai/types';
import type { Database } from '@binaryai/database';

/**
 * Shared fixtures for the analytics suites.
 *
 * Rows are inserted with direct SQL rather than through the engine. That is
 * deliberate: these tests need to control the exact persisted shape, including
 * combinations the engine would never produce — a rejected signal that also has
 * a settled outcome, a settlement with no recorded origin — precisely so the
 * eligibility rules can be shown to reject them.
 */

export const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
export const MINUTE = 60_000;
export const DAY = 86_400_000;

export const SYSTEM: AccessScope = { kind: 'system' };
export const ALL: AccessScope = { kind: 'all' };

export const accountScope = (accountId: string, includeSystem = true): AccessScope => ({
  kind: 'account',
  accountId,
  includeSystem,
});

export interface SeedOptions {
  readonly accountId?: string | null;
  readonly status?: 'accepted' | 'rejected' | 'candidate';
  readonly direction?: 'call' | 'put' | 'none';
  readonly result?: 'win' | 'loss' | 'tie' | 'unresolved' | null;
  readonly confidence?: number;
  readonly regime?: string;
  readonly timeframe?: string;
  readonly asset?: string;
  readonly dataSource?: string;
  readonly settledAt?: number;
  readonly decidedAt?: number;
  readonly withStrategy?: boolean;
  /** Explicit null writes an outcome with no `dataOrigin`, which is invalid. */
  readonly settlementOrigin?: string | null;
}

export interface Fixtures {
  readonly accountA: string;
  readonly accountB: string;
  readonly strategyId: string;
}

/** Creates two users with default accounts, and one registered strategy. */
export async function setupFixtures(database: Database): Promise<Fixtures> {
  const userA = await database.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('a@test.local', 'x') RETURNING id`,
  );
  const userB = await database.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('b@test.local', 'x') RETURNING id`,
  );
  const acctA = await database.query<{ id: string }>(
    `INSERT INTO accounts (user_id) VALUES ($1) RETURNING id`,
    [userA.rows[0]?.id],
  );
  const acctB = await database.query<{ id: string }>(
    `INSERT INTO accounts (user_id) VALUES ($1) RETURNING id`,
    [userB.rows[0]?.id],
  );
  const strategy = await database.query<{ id: string }>(
    `INSERT INTO strategies (strategy_key, version, name, description)
     VALUES ('trend-momentum', '1.0.0', 'Trend Momentum', 'test') RETURNING id`,
  );

  return {
    accountA: acctA.rows[0]?.id ?? '',
    accountB: acctB.rows[0]?.id ?? '',
    strategyId: strategy.rows[0]?.id ?? '',
  };
}

/** Inserts one signal and, when a result is given, its settled outcome. */
export async function seedSignal(
  database: Database,
  fixtures: Fixtures,
  options: SeedOptions = {},
): Promise<string> {
  const decidedAt = options.decidedAt ?? BASE;
  const settledAt = options.settledAt ?? decidedAt + 5 * MINUTE;

  const signal = await database.query<{ id: string }>(
    `INSERT INTO signals (
       account_id, asset_symbol, timeframe, strategy_id, direction, status,
       market_regime, confidence, price, decided_at, expires_at,
       expiration_seconds, data_source
     ) VALUES (
       $1, $2, $3, $4, $5::signal_direction, $6::signal_status,
       $7::market_regime, $8, 100, to_timestamp($9::double precision / 1000),
       to_timestamp($10::double precision / 1000), 300, $11::data_source
     ) RETURNING id`,
    [
      options.accountId ?? null,
      options.asset ?? 'BTC-USD',
      options.timeframe ?? '5m',
      options.withStrategy === false ? null : fixtures.strategyId,
      options.direction ?? 'call',
      options.status ?? 'accepted',
      options.regime ?? 'trend_up',
      options.confidence ?? 0.7,
      decidedAt,
      decidedAt + 5 * MINUTE,
      options.dataSource ?? 'live_provider',
    ],
  );
  const id = signal.rows[0]?.id ?? '';

  if (options.result) {
    const origin =
      options.settlementOrigin === null ? null : (options.settlementOrigin ?? 'exchange');
    await database.query(
      `INSERT INTO signal_outcomes (signal_id, settled_at, settlement_price, result, price_delta, metadata)
       VALUES ($1, to_timestamp($2::double precision / 1000), 101, $3::trade_outcome, 1, $4::jsonb)`,
      [
        id,
        settledAt,
        options.result,
        origin === null ? '{}' : JSON.stringify({ dataOrigin: origin }),
      ],
    );
  }
  return id;
}

/** Seeds `count` settled outcomes, the first `wins` of them winning. */
export async function seedMany(
  database: Database,
  fixtures: Fixtures,
  count: number,
  wins: number,
  options: SeedOptions = {},
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedSignal(database, fixtures, {
      ...options,
      result: index < wins ? 'win' : 'loss',
      decidedAt: (options.decidedAt ?? BASE) + index * MINUTE,
    });
  }
}
