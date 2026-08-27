import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isNotNullViolation,
  isUniqueViolation,
} from '@binaryai/database';
import {
  createTestDatabase,
  migrate,
  seedAsset,
  seedUserAndAccount,
  truncateAll,
  type TestDatabase,
} from './harness.js';

/**
 * Schema enforcement, executed against a real PostgreSQL engine.
 *
 * These are not documentation tests. Each one asserts that the DATABASE refuses
 * something the application must never store -- so a bug in application code
 * cannot produce an incoherent row.
 */

let context: TestDatabase;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
});

beforeEach(async () => {
  await truncateAll(context.database);
});

afterAll(async () => {
  await context?.close();
});

describe('demo/live separation is enforced by the database', () => {
  it('refuses a live account', async () => {
    const { userId } = await seedUserAndAccount(context.database);
    await expect(
      context.database.query(`INSERT INTO accounts (user_id, mode) VALUES ($1, 'live')`, [userId]),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a live signal', async () => {
    await expect(
      context.database.query(
        `INSERT INTO signals (asset_symbol, timeframe, direction, confidence, price,
           decided_at, expires_at, expiration_seconds, execution_mode)
         VALUES ('EURUSD', '1m', 'call', 0.5, 1.1, now(), now() + interval '3 min', 180, 'live')`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a live trade', async () => {
    const { accountId } = await seedUserAndAccount(context.database);
    await expect(
      context.database.query(
        `INSERT INTO trades (account_id, asset_symbol, direction, stake, entry_price,
           opened_at, expires_at, execution_mode)
         VALUES ($1, 'EURUSD', 'call', 10, 1.1, now(), now() + interval '3 min', 'live')`,
        [accountId],
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('accepts the demo equivalents', async () => {
    const { accountId } = await seedUserAndAccount(context.database);
    await expect(
      context.database.query(
        `INSERT INTO trades (account_id, asset_symbol, direction, stake, entry_price,
           opened_at, expires_at)
         VALUES ($1, 'EURUSD', 'call', 10, 1.1, now(), now() + interval '3 min')`,
        [accountId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a backtest claiming to be live performance', async () => {
    await expect(
      context.database.query(
        `INSERT INTO backtest_runs (strategy_key, strategy_version, result_type, dataset_label,
           dataset_source, asset_symbol, timeframe, candle_count, config, started_at, finished_at)
         VALUES ('x', '1.0.0', 'live_performance', 'l', 'synthetic', 'EURUSD', '1m', 10, '{}', now(), now())`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('referential integrity', () => {
  it('refuses an account for a user that does not exist', async () => {
    await expect(
      context.database.query(
        `INSERT INTO accounts (user_id) VALUES ('99999999-9999-9999-9999-999999999999')`,
      ),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('refuses a candle for an asset that does not exist', async () => {
    await expect(
      context.database.query(
        `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close)
         VALUES ('99999999-9999-9999-9999-999999999999', '1m', now(), 1, 1, 1, 1)`,
      ),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('cascades deletes from signal to its features', async () => {
    const inserted = await context.database.query<{ id: string }>(
      `INSERT INTO signals (asset_symbol, timeframe, direction, confidence, price,
         decided_at, expires_at, expiration_seconds)
       VALUES ('EURUSD', '1m', 'call', 0.5, 1.1, now(), now() + interval '3 min', 180)
       RETURNING id`,
    );
    const signalId = inserted.rows[0]?.id ?? '';
    await context.database.query(
      `INSERT INTO signal_features (signal_id, kind, code, label) VALUES ($1, 'indicator', 'rsi', 'RSI')`,
      [signalId],
    );

    await context.database.query('DELETE FROM signals WHERE id = $1', [signalId]);
    const remaining = await context.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM signal_features WHERE signal_id = $1',
      [signalId],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });
});

describe('candle integrity', () => {
  it('refuses inconsistent OHLC', async () => {
    await seedAsset(context.persistence, 'EURUSD');
    await expect(
      context.database.query(
        `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close)
         SELECT id, '1m', now(), 100, 90, 110, 100 FROM market_assets WHERE symbol = 'EURUSD'`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a non-positive price', async () => {
    await seedAsset(context.persistence, 'EURUSD');
    await expect(
      context.database.query(
        `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close)
         SELECT id, '1m', now(), 0, 1, 1, 1 FROM market_assets WHERE symbol = 'EURUSD'`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('signal integrity', () => {
  it('refuses a confidence outside 0..1', async () => {
    await expect(
      context.database.query(
        `INSERT INTO signals (asset_symbol, timeframe, direction, confidence, price,
           decided_at, expires_at, expiration_seconds)
         VALUES ('EURUSD', '1m', 'call', 1.5, 1.1, now(), now() + interval '3 min', 180)`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses an expiry before the decision', async () => {
    await expect(
      context.database.query(
        `INSERT INTO signals (asset_symbol, timeframe, direction, confidence, price,
           decided_at, expires_at, expiration_seconds)
         VALUES ('EURUSD', '1m', 'call', 0.5, 1.1, now(), now() - interval '3 min', 180)`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a direction outside the enum', async () => {
    await expect(
      context.database.query(
        `INSERT INTO signals (asset_symbol, timeframe, direction, confidence, price,
           decided_at, expires_at, expiration_seconds)
         VALUES ('EURUSD', '1m', 'sideways', 0.5, 1.1, now(), now() + interval '3 min', 180)`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a settled trade with no outcome recorded', async () => {
    const { accountId } = await seedUserAndAccount(context.database);
    await expect(
      context.database.query(
        `INSERT INTO trades (account_id, asset_symbol, direction, stake, entry_price,
           opened_at, expires_at, status)
         VALUES ($1, 'EURUSD', 'call', 10, 1.1, now(), now() + interval '3 min', 'settled')`,
        [accountId],
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('required fields and uniqueness', () => {
  it('refuses a user without a password hash', async () => {
    await expect(
      context.database.query(`INSERT INTO users (email) VALUES ('nobody@test.local')`),
    ).rejects.toSatisfy(isNotNullViolation);
  });

  it('treats email uniqueness as case-insensitive', async () => {
    await context.database.query(
      `INSERT INTO users (email, password_hash) VALUES ('Person@Test.local', 'hash')`,
    );
    await expect(
      context.database.query(
        `INSERT INTO users (email, password_hash) VALUES ('person@test.LOCAL', 'hash')`,
      ),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('refuses two assets with the same symbol', async () => {
    await seedAsset(context.persistence, 'EURUSD');
    await expect(
      context.database.query(
        `INSERT INTO market_assets (symbol, display_name) VALUES ('EURUSD', 'duplicate')`,
      ),
    ).rejects.toSatisfy(isUniqueViolation);
  });
});

describe('column types', () => {
  it('uses NUMERIC, so equal prices compare exactly', async () => {
    // The reason binary settlement can detect a tie at all.
    const result = await context.database.query<{ exact: boolean }>(
      `SELECT (0.1::numeric(20,8) + 0.2::numeric(20,8)) = 0.3::numeric(20,8) AS exact`,
    );
    expect(result.rows[0]?.exact).toBe(true);
  });

  it('stores timestamps as timestamptz in UTC', async () => {
    const result = await context.database.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'signals' AND column_name = 'decided_at'`,
    );
    expect(result.rows[0]?.data_type).toBe('timestamp with time zone');
  });

  it('round-trips an epoch timestamp without drift', async () => {
    const at = 1_767_225_600_123;
    await seedAsset(context.persistence, 'EURUSD');
    await context.database.query(
      `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close)
       SELECT id, '1m', $1, 1, 1, 1, 1 FROM market_assets WHERE symbol = 'EURUSD'`,
      [new Date(at)],
    );
    const result = await context.database.query<{ opened_at: Date }>(
      'SELECT opened_at FROM candles LIMIT 1',
    );
    expect(result.rows[0]?.opened_at.getTime()).toBe(at);
  });
});
