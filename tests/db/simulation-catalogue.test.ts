import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories, SimulationModel } from '@binaryai/types';
import { createTestDatabase, migrate, type TestDatabase } from './harness.js';

/**
 * The simulation-model CATALOGUE against a real PostgreSQL engine.
 *
 * These are the constraints that make a versioned model trustworthy: it cannot
 * be published incomplete, cannot be republished under the same version, and
 * cannot have its arithmetic edited afterwards. A constraint that lives only in
 * a migration nobody executed is not a guarantee, so each is provoked here
 * rather than assumed.
 *
 * No accounts or positions are seeded: the catalogue is reference data and
 * stands on its own.
 */

let context: TestDatabase;
let repositories: Repositories;
let demoModel: SimulationModel;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  // simulation_models is reference data seeded by migration and deliberately
  // survives truncateAll -- which means a test that deprecates a model would
  // silently remove it for every test after. Restored explicitly.
  await context.database.query(
    `UPDATE simulation_models SET status = 'active' WHERE status <> 'active'`,
  );
  const models = await repositories.simulationModels.listSelectable();
  demoModel = models.find((model) => model.modelKey === 'demo_return')!;
});

// ------------------------------------------------------------- catalogue --

describe('the model catalogue', () => {
  it('ships published, selectable models', async () => {
    const models = await repositories.simulationModels.listSelectable();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.status === 'active')).toBe(true);
  });

  it('names every parameter that materially affects a result', async () => {
    // If any were absent the arithmetic would fall back to an application
    // default, which is precisely the hidden assumption the schema forbids.
    expect(demoModel.parameters.simulatedReturnRate).toBeGreaterThan(0);
    expect(demoModel.parameters.tieRule).toBeTruthy();
    expect(demoModel.parameters.lossRule).toBeTruthy();
    expect(demoModel.parameters.settlementRule).toBeTruthy();
    expect(demoModel.parameters.roundingDecimals).toBeGreaterThanOrEqual(0);
  });

  it('refuses a model whose return rate is beyond the bound', async () => {
    await expect(
      context.database.query(
        `INSERT INTO simulation_models (model_key, version, name, description, parameters)
         VALUES ('wild','1.0.0','x','y', jsonb_build_object(
           'startingUnits',1,'simulatedReturnRate',9,'lossRule','forfeit_exposure',
           'tieRule','refund_exposure','roundingDecimals',2))`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a model that omits its tie rule', async () => {
    await expect(
      context.database.query(
        `INSERT INTO simulation_models (model_key, version, name, description, parameters)
         VALUES ('notie','1.0.0','x','y', jsonb_build_object(
           'startingUnits',1,'simulatedReturnRate',0.8,'lossRule','forfeit_exposure',
           'roundingDecimals',2))`,
      ),
    ).rejects.toThrow();
  });

  it('refuses re-publishing a key and version that already exist', async () => {
    // Parameters are valid here, so this exercises uniqueness rather than the
    // bounds: re-publishing would silently reinterpret every stamped entry.
    await expect(
      context.database.query(
        `INSERT INTO simulation_models (model_key, version, name, description, parameters)
         VALUES ('demo_return','1.0.0','other','other', jsonb_build_object(
           'startingUnits',1,'simulatedReturnRate',0.5,'lossRule','forfeit_exposure',
           'tieRule','refund_exposure','roundingDecimals',2,'settlementRule','x'))`,
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('refuses to change the arithmetic of a published model', async () => {
    await expect(
      context.database.query(
        `UPDATE simulation_models
            SET parameters = jsonb_set(parameters, '{simulatedReturnRate}', '2.0')
          WHERE model_key = 'demo_return'`,
      ),
    ).rejects.toThrow(/cannot change/i);
  });

  it('refuses to delete a published model', async () => {
    await expect(
      context.database.query(`DELETE FROM simulation_models WHERE model_key = 'demo_return'`),
    ).rejects.toThrow(/immutable/i);
  });

  it('keeps a deprecated model resolvable but no longer selectable', async () => {
    await context.database.query(
      `UPDATE simulation_models SET status = 'deprecated' WHERE model_key = 'demo_return'`,
    );
    // Still readable: a position settled under it must stay explainable.
    const found = await repositories.simulationModels.findById(demoModel.id);
    expect(found?.status).toBe('deprecated');

    const selectable = await repositories.simulationModels.listSelectable();
    expect(selectable.some((model) => model.id === demoModel.id)).toBe(false);
  });

  it('resolves a model by key and version, which is how a stamp is read back', async () => {
    const found = await repositories.simulationModels.findByKeyAndVersion('demo_return', '1.0.0');
    expect(found?.id).toBe(demoModel.id);
  });
});
