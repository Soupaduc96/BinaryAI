import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySimulationModel } from '@binaryai/engine';
import type { Repositories, SimulationModel } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';

/**
 * Versioned simulation against a real PostgreSQL engine.
 *
 * The arithmetic itself is covered in packages/engine. What can only be checked
 * here is whether the DATABASE actually refuses what the design claims it
 * refuses: attribution, idempotency, immutability and account isolation. A
 * constraint that lives only in a migration nobody executed is not a guarantee,
 * so every one of them is provoked rather than assumed.
 *
 * This file replaces the superseded simulation-payout suite. The historical
 * ENTRIES that model produced are preserved and still covered below; what is
 * gone is the ability for a client to author the rate.
 */

let context: TestDatabase;
let repositories: Repositories;
let accountId = '';
let otherAccountId = '';
let signalId = '';
let demoModel: SimulationModel;

const NOW = Date.now();
const MINUTE = 60_000;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

afterAll(async () => {
  await context?.close();
});

async function seedAccount(email: string): Promise<string> {
  const user = await context.database.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  const account = await context.database.query<{ id: string }>(
    `INSERT INTO accounts (user_id, allocated_units) VALUES ($1, 100) RETURNING id`,
    [user.rows[0]?.id],
  );
  const id = account.rows[0]?.id ?? '';
  await repositories.ledger.append({
    accountId: id,
    type: 'initial_allocation',
    amount: 100,
    source: 'seed',
  });
  return id;
}

beforeEach(async () => {
  await truncateAll(context.database);
  await context.database.query('TRUNCATE TABLE paper_ledger_entries, paper_positions CASCADE');

  accountId = await seedAccount('p@test.local');
  otherAccountId = await seedAccount('other@test.local');

  await context.database.query(
    `INSERT INTO strategies (strategy_key, version, name, description)
     VALUES ('trend-momentum', '1.0.0', 'T', 't') ON CONFLICT DO NOTHING`,
  );
  const strategy = await context.database.query<{ id: string }>(
    `SELECT id FROM strategies WHERE strategy_key = 'trend-momentum' LIMIT 1`,
  );
  const signal = await context.database.query<{ id: string }>(
    `INSERT INTO signals (asset_symbol, timeframe, strategy_id, direction, status, market_regime,
                          confidence, price, decided_at, expires_at, expiration_seconds, data_source)
     VALUES ('BTC-USD', '5m', $1, 'call', 'accepted', 'trend_up', 0.7, 100,
             to_timestamp($2::double precision / 1000),
             to_timestamp($3::double precision / 1000), 300, 'live_provider')
     RETURNING id`,
    [strategy.rows[0]?.id, NOW, NOW + 30 * MINUTE],
  );
  signalId = signal.rows[0]?.id ?? '';

  // simulation_models is reference data seeded by migration, so truncateAll
  // deliberately leaves it alone -- which means a test that deprecates a model
  // would silently remove it for every test after. Restored explicitly.
  await context.database.query(
    `UPDATE simulation_models SET status = 'active' WHERE status <> 'active'`,
  );

  const models = await repositories.simulationModels.listSelectable();
  demoModel = models.find((model) => model.modelKey === 'demo_return')!;
});

async function openAndSettle(
  model: SimulationModel | null,
  result: 'win' | 'loss' | 'tie',
  options: { size?: number; actionKey?: string; account?: string } = {},
) {
  const { size = 10, actionKey = 'sim-action-1', account = accountId } = options;
  const position = await repositories.positions.open({
    accountId: account,
    signalId,
    size,
    actionKey,
    policyVersion: 1,
  });
  await repositories.positions.settle({
    positionId: position.id,
    settledAt: NOW + MINUTE,
    settlementPrice: result === 'win' ? 101 : result === 'loss' ? 99 : 100,
    result,
    dataOrigin: 'exchange',
    simulation: applySimulationModel({ model, exposure: size, result }),
  });
  return position;
}

// ----------------------------------------------------------- attribution --

describe('attribution', () => {
  it('refuses a simulated return that names no model', async () => {
    const position = await repositories.positions.open({
      accountId,
      signalId,
      size: 10,
      actionKey: 'attr-1',
      policyVersion: 1,
    });
    // The constraint that makes auditability structural rather than aspirational.
    await expect(
      context.database.query(
        `INSERT INTO paper_ledger_entries (account_id, type, amount, position_id, source)
         VALUES ($1, 'simulated_return', 4, $2, 'test')`,
        [accountId, position.id],
      ),
    ).rejects.toThrow(/simulation_attribution/);
  });

  it('refuses a model id with no version beside it', async () => {
    const position = await repositories.positions.open({
      accountId,
      signalId,
      size: 10,
      actionKey: 'attr-2',
      policyVersion: 1,
    });
    await expect(
      context.database.query(
        `INSERT INTO paper_ledger_entries
           (account_id, type, amount, position_id, source, simulation_model_id)
         VALUES ($1, 'simulated_return', 4, $2, 'test', $3)`,
        [accountId, position.id, demoModel.id],
      ),
    ).rejects.toThrow(/simulation_attribution/);
  });

  it('refuses an exposure entry that carries a model stamp', async () => {
    const position = await repositories.positions.open({
      accountId,
      signalId,
      size: 10,
      actionKey: 'attr-3',
      policyVersion: 1,
    });
    await expect(
      context.database.query(
        `INSERT INTO paper_ledger_entries
           (account_id, type, amount, position_id, source,
            simulation_model_id, simulation_model_version)
         VALUES ($1, 'exposure_released', 5, $2, 'test', $3, $4)`,
        [accountId, position.id, demoModel.id, demoModel.version],
      ),
    ).rejects.toThrow(/simulation_attribution/);
  });

  it('stamps the model and version on a settled position', async () => {
    const position = await openAndSettle(demoModel, 'win');
    const entry = await repositories.ledger.simulationForPosition(position.id, accountId);

    expect(entry?.amount).toBe(8);
    expect(entry?.simulationModelId).toBe(demoModel.id);
    expect(entry?.simulationModelVersion).toBe('1.0.0');
  });

  it('carries the disclosure onto the entry itself', async () => {
    const position = await openAndSettle(demoModel, 'win');
    const entry = await repositories.ledger.simulationForPosition(position.id, accountId);
    expect(String(entry?.metadata['disclosure'])).toMatch(/not broker terms/i);
  });
});

// ------------------------------------------------------------ settlement --

describe('settlement outcomes', () => {
  it('credits a win at the model rate', async () => {
    const position = await openAndSettle(demoModel, 'win');
    const entry = await repositories.ledger.simulationForPosition(position.id, accountId);
    expect(entry?.amount).toBe(8); // 10 units at 0.8
  });

  it('debits a loss by the whole exposure under forfeit_exposure', async () => {
    const position = await openAndSettle(demoModel, 'loss');
    const entry = await repositories.ledger.simulationForPosition(position.id, accountId);
    expect(entry?.amount).toBe(-10);
  });

  it('refunds part of a loss under a partial_refund model', async () => {
    const conservative = (await repositories.simulationModels.listSelectable()).find(
      (model) => model.modelKey === 'conservative_return',
    )!;
    const position = await openAndSettle(conservative, 'loss');
    const entry = await repositories.ledger.simulationForPosition(position.id, accountId);
    expect(entry?.amount).toBe(-9); // 10% of 10 returns
  });

  it('writes no entry for a refunded tie and never records it as a loss', async () => {
    const position = await openAndSettle(demoModel, 'tie');
    // The model ran and computed zero; a zero row adds nothing to the audit
    // trail, and the position's own result already records the tie.
    expect(await repositories.ledger.simulationForPosition(position.id, accountId)).toBeNull();
    expect(await repositories.ledger.simulatedDeltas(accountId)).toEqual([]);

    const settled = await repositories.positions.findById(position.id, accountId);
    expect(settled?.result).toBe('tie');
  });

  it('releases the exposure whether or not a model is selected', async () => {
    // Exposure accounting is a fact and must not depend on the simulation.
    const position = await openAndSettle(null, 'win');
    const entries = await repositories.ledger.list(accountId, 50);

    expect(entries.some((entry) => entry.type === 'exposure_released')).toBe(true);
    expect(entries.some((entry) => entry.type === 'simulated_return')).toBe(false);
    expect(await repositories.positions.findById(position.id, accountId)).not.toBeNull();
  });

  it('says on the release that no model was applied', async () => {
    await openAndSettle(null, 'win');
    const release = (await repositories.ledger.list(accountId, 50)).find(
      (entry) => entry.type === 'exposure_released',
    );
    expect(String(release?.metadata['note'])).toMatch(/no simulation model applied/i);
  });

  it('leaves the ledger balance untouched when no model is selected', async () => {
    await openAndSettle(null, 'win');
    expect(await repositories.ledger.balance(accountId)).toBe(100);
  });
});

// ----------------------------------------------------------- idempotency --

describe('idempotency', () => {
  it('a retried settlement writes no second simulated entry', async () => {
    const position = await repositories.positions.open({
      accountId,
      signalId,
      size: 10,
      actionKey: 'retry-1',
      policyVersion: 1,
    });
    const simulation = applySimulationModel({ model: demoModel, exposure: 10, result: 'win' });
    const settle = () =>
      repositories.positions.settle({
        positionId: position.id,
        settledAt: NOW + MINUTE,
        settlementPrice: 101,
        result: 'win',
        dataOrigin: 'exchange',
        simulation,
      });

    await settle();
    await settle();
    await settle();

    const entries = await repositories.ledger.list(accountId, 100);
    expect(entries.filter((entry) => entry.type === 'simulated_return')).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === 'exposure_released')).toHaveLength(1);
    expect(await repositories.ledger.simulatedDeltas(accountId)).toEqual([8]);
  });

  it('produces the identical figure and stamp on every application', async () => {
    const first = applySimulationModel({ model: demoModel, exposure: 7, result: 'win' });
    const second = applySimulationModel({ model: demoModel, exposure: 7, result: 'win' });
    expect(first.delta).toBe(second.delta);
    expect(first.modelVersion).toBe(second.modelVersion);
  });
});

// -------------------------------------------------------------- isolation --

describe('account isolation', () => {
  it('does not return another account’s simulated entry', async () => {
    const position = await openAndSettle(demoModel, 'win', {
      account: otherAccountId,
      actionKey: 'iso-1',
    });
    // Asking under the wrong account returns exactly what a nonexistent
    // position returns, so existence cannot be probed.
    expect(await repositories.ledger.simulationForPosition(position.id, accountId)).toBeNull();
    expect(
      await repositories.ledger.simulationForPosition(position.id, otherAccountId),
    ).not.toBeNull();
  });

  it('keeps simulated totals separate per account', async () => {
    await openAndSettle(demoModel, 'win', { account: otherAccountId, actionKey: 'iso-2' });
    expect(await repositories.ledger.simulatedDeltas(accountId)).toEqual([]);
    expect(await repositories.ledger.simulatedDeltas(otherAccountId)).toEqual([8]);
  });

  it('counts outcomes per account only', async () => {
    await openAndSettle(demoModel, 'win', { account: otherAccountId, actionKey: 'iso-3' });
    expect(await repositories.ledger.simulatedOutcomeCounts(accountId)).toEqual({
      wins: 0,
      losses: 0,
      ties: 0,
      positions: 0,
    });
    expect((await repositories.ledger.simulatedOutcomeCounts(otherAccountId)).wins).toBe(1);
  });
});

// ------------------------------------------------------------- separation --

describe('separation from other accounting', () => {
  it('excludes superseded simulated_payout entries from the model total', async () => {
    // Those came from the client-supplied rate this phase replaced. Summing
    // both regimes would produce a number that belongs to neither.
    const position = await repositories.positions.open({
      accountId,
      signalId,
      size: 10,
      actionKey: 'legacy-1',
      policyVersion: 1,
    });
    await context.database.query(
      `INSERT INTO paper_ledger_entries (account_id, type, amount, position_id, source)
       VALUES ($1, 'simulated_payout', 99, $2, 'legacy')`,
      [accountId, position.id],
    );

    expect(await repositories.ledger.simulatedDeltas(accountId)).toEqual([]);
    // ...and the historical entry is preserved, still readable.
    const entries = await repositories.ledger.list(accountId, 50);
    expect(entries.some((entry) => entry.type === 'simulated_payout')).toBe(true);
  });

  it('leaves exposure accounting untouched by the simulation', async () => {
    await openAndSettle(demoModel, 'win');
    // Committed then released nets to zero, regardless of the +8 simulated.
    expect(await repositories.ledger.committed(accountId)).toBe(0);
  });

  it('records no payout on the signal outcomes that calibration reads', async () => {
    // Calibration measures confidence against observed direction. A payout
    // reaching signal_outcomes would make calibration start measuring money.
    await openAndSettle(demoModel, 'win');
    const rows = await context.database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM signal_outcomes
        WHERE payout IS NOT NULL AND payout::text <> '{}'`,
    );
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(0);
  });

  it('keeps the simulated total apart from the exposure balance', async () => {
    await openAndSettle(demoModel, 'win');
    const deltas = await repositories.ledger.simulatedDeltas(accountId);
    const balance = await repositories.ledger.balance(accountId);
    // The ledger balance includes every entry; the simulated series is only
    // the model's. They are different questions and must not be one number.
    expect(deltas).toEqual([8]);
    expect(balance).not.toBe(deltas[0]);
  });
});

// ------------------------------------------------------------ append-only --

describe('append-only', () => {
  it('refuses UPDATE of a simulated entry', async () => {
    await openAndSettle(demoModel, 'win');
    await expect(
      context.database.query(`UPDATE paper_ledger_entries SET amount = 999 WHERE account_id = $1`, [
        accountId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses DELETE of a simulated entry', async () => {
    await openAndSettle(demoModel, 'win');
    await expect(
      context.database.query(`DELETE FROM paper_ledger_entries WHERE account_id = $1`, [accountId]),
    ).rejects.toThrow(/append-only/);
  });
});

// -------------------------------------------------------------- selection --

describe('model selection', () => {
  it('records the selection on the account', async () => {
    await repositories.accounts.selectSimulationModel(accountId, demoModel.id);
    const account = await repositories.accounts.findById(accountId);
    expect(account?.simulationModelId).toBe(demoModel.id);
  });

  it('turns simulation off with a null selection', async () => {
    await repositories.accounts.selectSimulationModel(accountId, demoModel.id);
    await repositories.accounts.selectSimulationModel(accountId, null);
    const account = await repositories.accounts.findById(accountId);
    // Null, not a zero-valued model: "off" and "zero" are different states.
    expect(account?.simulationModelId).toBeNull();
  });

  it('refuses a selection that names no catalogue row', async () => {
    await expect(
      repositories.accounts.selectSimulationModel(
        accountId,
        '00000000-0000-0000-0000-000000000000',
      ),
    ).rejects.toThrow();
  });

  it('refuses to remove a model an account still references', async () => {
    await repositories.accounts.selectSimulationModel(accountId, demoModel.id);
    await expect(
      context.database.query(`DELETE FROM simulation_models WHERE id = $1`, [demoModel.id]),
    ).rejects.toThrow();
  });
});
