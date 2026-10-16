import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@binaryai/database';
import {
  createTestDatabase,
  loadMigrationFiles,
  resetSchema,
  type TestDatabase,
} from './harness.js';

/**
 * Migration 0010, against both a fresh database and one carrying real history.
 *
 * The second case is the one that matters. 0010 renames `BTC-USD` to `BTCUSD`
 * across five tables, and a rename that misses a table leaves signals pointing
 * at a symbol no asset row has — a break that no test of an empty database can
 * possibly catch.
 *
 * The rename is a NORMALISATION, not a reinterpretation: `BTC-USD` and `BTCUSD`
 * were always the same instrument, stored under two spellings because the
 * ingest route wrote the caller's string verbatim. What these tests pin down is
 * that no row is lost, no row changes meaning, and the two spellings end up
 * pointing at one history rather than two.
 */

let context: TestDatabase;

beforeAll(async () => {
  context = await createTestDatabase();
});

afterAll(async () => {
  await context?.close();
});

/** Applies every migration to a genuinely empty database. */
async function migrateFromZero(): Promise<readonly string[]> {
  await resetSchema(context.database);
  const result = await runMigrations(context.database, await loadMigrationFiles());
  return result.applied;
}

/** Applies everything up to, but not including, the given version. */
async function migrateUpTo(version: string): Promise<void> {
  await resetSchema(context.database);
  const all = await loadMigrationFiles();
  await runMigrations(
    context.database,
    all.filter((migration) => migration.version < version),
  );
}

async function applyRemaining(): Promise<readonly string[]> {
  const result = await runMigrations(context.database, await loadMigrationFiles());
  return result.applied;
}

describe('migration 0010 — from zero', () => {
  it('applies cleanly to an empty database', async () => {
    const applied = await migrateFromZero();
    expect(applied).toContain('0010_instrument_catalogue');
  });

  it('creates every instrument metadata column', async () => {
    const result = await context.database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'market_assets'`,
    );
    const columns = new Set(result.rows.map((row) => row.column_name));

    for (const column of [
      'display_symbol',
      'base_currency',
      'quote_currency',
      'provider_id',
      'provider_symbol',
      'quantity_precision',
      'minimum_size',
      'trading_schedule',
      'supported_timeframes',
      'in_catalogue',
    ]) {
      expect(columns).toContain(column);
    }
  });

  it('constrains trading_schedule to the declared values', async () => {
    await context.database.query(
      `INSERT INTO market_assets (symbol, display_name, asset_class, price_precision)
       VALUES ('TESTSYM', 'Test', 'crypto', 2)`,
    );
    await expect(
      context.database.query(
        `UPDATE market_assets SET trading_schedule = 'whenever' WHERE symbol = 'TESTSYM'`,
      ),
    ).rejects.toThrow();
    await context.database.query(`DELETE FROM market_assets WHERE symbol = 'TESTSYM'`);
  });

  it('defaults a new row to unknown schedule and empty timeframes', async () => {
    // Not NULL and not a guess: "we have not been told" is the honest state.
    await context.database.query(
      `INSERT INTO market_assets (symbol, display_name, asset_class, price_precision)
       VALUES ('DEFAULTS', 'Defaults', 'crypto', 2)`,
    );
    const result = await context.database.query<{
      trading_schedule: string;
      supported_timeframes: string[];
      in_catalogue: boolean;
    }>(
      `SELECT trading_schedule, supported_timeframes, in_catalogue
         FROM market_assets WHERE symbol = 'DEFAULTS'`,
    );
    expect(result.rows[0]?.trading_schedule).toBe('unknown');
    expect(result.rows[0]?.supported_timeframes).toEqual([]);
    expect(result.rows[0]?.in_catalogue).toBe(false);
    await context.database.query(`DELETE FROM market_assets WHERE symbol = 'DEFAULTS'`);
  });

  it('is idempotent — re-running applies nothing and breaks nothing', async () => {
    const applied = await applyRemaining();
    expect(applied).toHaveLength(0);
  });
});

describe('migration 0010 — against an existing database', () => {
  /**
   * Rebuilds the pre-0010 world: an asset stored as `BTC-USD`, with candles, a
   * signal, and a paper position referencing it. This is the shape the live
   * development database was actually in.
   */
  async function seedLegacyWorld(): Promise<{ signalId: string; accountId: string }> {
    const database = context.database;

    const asset = await database.query<{ id: string }>(
      `INSERT INTO market_assets (symbol, display_name, asset_class, price_precision)
       VALUES ('BTC-USD', 'BTC-USD', 'crypto', 2) RETURNING id`,
    );
    const assetId = asset.rows[0]!.id;

    await database.query(
      `INSERT INTO candles (asset_id, timeframe, opened_at, open, high, low, close, volume, source, complete)
       VALUES ($1, '1m', now() - interval '2 minutes', 100, 101, 99, 100.5, 5, 'historical_provider', true),
              ($1, '1m', now() - interval '1 minute',  100.5, 102, 100, 101, 6, 'historical_provider', true)`,
      [assetId],
    );

    const user = await database.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ('legacy@test.local', 'x', 'admin') RETURNING id`,
    );
    const account = await database.query<{ id: string }>(
      `INSERT INTO accounts (user_id, name, balance, day_start_balance)
       VALUES ($1, 'Legacy', 1000, 1000) RETURNING id`,
      [user.rows[0]!.id],
    );
    const accountId = account.rows[0]!.id;

    const signal = await database.query<{ id: string }>(
      `INSERT INTO signals
         (signal_key, asset_id, asset_symbol, timeframe, direction, status, recommendation,
          confidence, price, decided_at, expires_at, expiration_seconds)
       VALUES ('sig_legacy', $1, 'BTC-USD', '1m', 'call', 'accepted', 'consider',
               0.6, 100, now() - interval '1 minute', now() + interval '1 minute', 60)
       RETURNING id`,
      [assetId],
    );
    const signalId = signal.rows[0]!.id;

    await database.query(
      `INSERT INTO paper_positions
         (account_id, signal_id, action_key, asset_symbol, timeframe, direction,
          size, entry_price, opened_at, expires_at, status, policy_version)
       VALUES ($1, $2, 'legacy-key', 'BTC-USD', '1m', 'call', 5, 100,
               now(), now() + interval '1 minute', 'open', 1)`,
      [accountId, signalId],
    );

    await database.query(
      `INSERT INTO trades
         (account_id, signal_id, asset_symbol, direction, stake, entry_price,
          opened_at, expires_at, execution_mode)
       VALUES ($1, $2, 'BTC-USD', 'call', 5, 100,
               now(), now() + interval '1 minute', 'demo')`,
      [accountId, signalId],
    );

    return { signalId, accountId };
  }

  let seeded: { signalId: string; accountId: string };

  beforeAll(async () => {
    await migrateUpTo('0010_instrument_catalogue');
    seeded = await seedLegacyWorld();
    await applyRemaining();
  });

  it('renames the asset without deleting it', async () => {
    const rows = await context.database.query<{ symbol: string; id: string }>(
      `SELECT symbol, id FROM market_assets`,
    );
    expect(rows.rows.map((row) => row.symbol)).toEqual(['BTCUSD']);
  });

  it('preserves the candle history through the rename', async () => {
    // The point of a rename over a delete-and-recreate: history survives.
    const result = await context.database.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM candles c
         JOIN market_assets a ON a.id = c.asset_id
        WHERE a.symbol = 'BTCUSD'`,
    );
    expect(Number(result.rows[0]?.total)).toBe(2);
  });

  it('updates every table that carries the symbol', async () => {
    // A missed table would leave a signal naming an asset that no longer exists.
    for (const table of ['signals', 'trades', 'paper_positions']) {
      const stale = await context.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM ${table} WHERE asset_symbol = 'BTC-USD'`,
      );
      expect(Number(stale.rows[0]?.total), `${table} still has BTC-USD`).toBe(0);

      const renamed = await context.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM ${table} WHERE asset_symbol = 'BTCUSD'`,
      );
      expect(Number(renamed.rows[0]?.total), `${table} missing BTCUSD`).toBeGreaterThan(0);
    }
  });

  it('keeps the signal and its position joined to each other', async () => {
    // The rename must not break referential meaning: the position still points
    // at the signal it was opened on, and both now name the same instrument.
    const result = await context.database.query<{
      signal_symbol: string;
      position_symbol: string;
    }>(
      `SELECT s.asset_symbol AS signal_symbol, p.asset_symbol AS position_symbol
         FROM paper_positions p
         JOIN signals s ON s.id = p.signal_id
        WHERE p.signal_id = $1`,
      [seeded.signalId],
    );
    expect(result.rows[0]?.signal_symbol).toBe('BTCUSD');
    expect(result.rows[0]?.position_symbol).toBe('BTCUSD');
  });

  it('leaves the append-only ledger untouched', async () => {
    // paper_ledger_entries carries no symbol — it reaches an instrument through
    // position_id — which is exactly why its immutability trigger never had to
    // be worked around. Asserted so a future migration does not assume it can.
    const columns = await context.database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'paper_ledger_entries'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('asset_symbol');
  });

  it('backfills catalogue metadata onto the renamed row', async () => {
    const result = await context.database.query<{
      display_symbol: string;
      base_currency: string;
      quote_currency: string;
      provider_id: string;
      in_catalogue: boolean;
    }>(
      `SELECT display_symbol, base_currency, quote_currency, provider_id, in_catalogue
         FROM market_assets WHERE symbol = 'BTCUSD'`,
    );
    expect(result.rows[0]).toMatchObject({
      display_symbol: 'BTC/USD',
      base_currency: 'BTC',
      quote_currency: 'USD',
      provider_id: 'coinbase',
      in_catalogue: true,
    });
  });

  it('is idempotent against the migrated database', async () => {
    expect(await applyRemaining()).toHaveLength(0);
  });
});

describe('migration 0010 — refuses an ambiguous merge', () => {
  it('raises rather than silently choosing which history survives', async () => {
    // Both spellings present means two candle histories, and picking a winner
    // is a data decision a migration has no basis to make on its own.
    await migrateUpTo('0010_instrument_catalogue');
    await context.database.query(
      `INSERT INTO market_assets (symbol, display_name, asset_class, price_precision)
       VALUES ('BTC-USD', 'Legacy', 'crypto', 2), ('BTCUSD', 'Canonical', 'crypto', 2)`,
    );

    await expect(applyRemaining()).rejects.toThrow(/Merge them manually/);
  });

  /**
   * Leave the database MIGRATED, not stuck mid-migration.
   *
   * This file is the only one that deliberately parks a database in a state
   * where `migrate()` throws, and against PGlite that was harmless: every test
   * file gets its own embedded engine. Against a SHARED PostgreSQL server —
   * which is what `npm run verify:postgres` and the PostgreSQL 16 CI job use —
   * it poisoned every file that ran afterwards. Each one called `migrate()`,
   * hit this migration's ambiguity guard, and failed with an error that had
   * nothing to do with what it was testing.
   *
   * Twelve unrelated suites failed that way before this cleanup existed.
   */
  afterAll(async () => {
    await context.database.query(`DELETE FROM market_assets WHERE symbol = 'BTC-USD'`);
    await applyRemaining();
  });
});
