import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * The simulation model API.
 *
 * These defend one sentence: THE MODEL BELONGS TO THE SERVER. A user may choose
 * among published, versioned models; a user may not describe one. Everything
 * else follows — simulation is off by default, a figure never appears without
 * the model that produced it, and no request body can change the arithmetic.
 *
 * This replaces the payout API suite, which tested the opposite arrangement.
 */

const PASSWORD = 'correct-horse-battery-staple-7';
const ORIGIN = { origin: 'http://localhost:3000' };

let context: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
  await context.database.query('TRUNCATE TABLE paper_ledger_entries, paper_positions CASCADE');
  await context.database.query(
    `UPDATE simulation_models SET status = 'active' WHERE status <> 'active'`,
  );
  app = await buildApp(
    createAppContext({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        AUTH_ALLOW_REGISTRATION: 'true',
        AUTH_COOKIE_SECURE: 'false',
      }),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );
});

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies[0];
  return cookie ? `${cookie.name}=${cookie.value}` : '';
}

const listModels = (cookie: string) =>
  app.inject({ method: 'GET', url: '/v1/simulation/models', headers: { cookie } });

const getSimulation = (cookie: string) =>
  app.inject({ method: 'GET', url: '/v1/accounts/me/simulation', headers: { cookie } });

const select = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: '/v1/accounts/me/simulation',
    headers: { cookie, ...ORIGIN },
    payload,
  });

async function firstModelId(cookie: string): Promise<string> {
  const response = await listModels(cookie);
  return response.json().models[0].id;
}

// -------------------------------------------------------------- catalogue --

describe('the model catalogue', () => {
  it('lists published models', async () => {
    const cookie = await signUp('cat@test.local');
    const response = await listModels(cookie);

    expect(response.statusCode).toBe(200);
    const { models } = response.json();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model: { status: string }) => model.status === 'active')).toBe(true);
  });

  it('states that these are not broker terms', async () => {
    const cookie = await signUp('cat2@test.local');
    await expect(listModels(cookie).then((r) => r.json().disclosure)).resolves.toMatch(
      /not broker terms/i,
    );
  });

  it('exposes every parameter that affects a result', async () => {
    const cookie = await signUp('cat3@test.local');
    const [model] = (await listModels(cookie)).json().models;

    // A model whose arithmetic a user cannot inspect is not auditable.
    expect(model.parameters).toMatchObject({
      simulatedReturnRate: expect.any(Number),
      lossRule: expect.any(String),
      tieRule: expect.any(String),
      roundingDecimals: expect.any(Number),
      startingUnits: expect.any(Number),
    });
  });

  it('names the rate as a simulated return, never a payout', async () => {
    const cookie = await signUp('cat4@test.local');
    const body = (await listModels(cookie)).body;
    expect(body).toContain('simulatedReturnRate');
    expect(body).not.toContain('payoutRate');
    expect(body).not.toContain('brokerPayout');
  });

  it('requires a session', async () => {
    expect((await listModels('')).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------- default state --

describe('default state', () => {
  it('ships with simulation off', async () => {
    const cookie = await signUp('def@test.local');
    const { simulation } = (await getSimulation(cookie)).json();

    expect(simulation.enabled).toBe(false);
    expect(simulation.model).toBeNull();
  });

  it('reports null figures rather than zeros when no model is selected', async () => {
    const cookie = await signUp('def2@test.local');
    const { simulation } = (await getSimulation(cookie)).json();

    // "No simulation" and "simulated zero" are different statements, and a
    // zero would render as the second one.
    expect(simulation.currentUnits).toBeNull();
    expect(simulation.startingUnits).toBeNull();
    expect(simulation.simulatedReturn).toBeNull();
    expect(simulation.returnFraction).toBeNull();
  });

  it('says why there is no value', async () => {
    const cookie = await signUp('def3@test.local');
    const { simulation } = (await getSimulation(cookie)).json();
    expect(simulation.disclosure).toMatch(/no simulation model is selected/i);
  });

  it('requires a session', async () => {
    expect((await getSimulation('')).statusCode).toBe(401);
  });
});

// ----------------------------------------------------------- selecting it --

describe('selecting a model', () => {
  it('records the selection and reports the model', async () => {
    const cookie = await signUp('sel@test.local');
    const modelId = await firstModelId(cookie);

    const response = await select(cookie, { modelId });
    expect(response.statusCode).toBe(200);

    const { simulation } = response.json();
    expect(simulation.enabled).toBe(true);
    expect(simulation.model.id).toBe(modelId);
    expect(simulation.model.version).toBeTruthy();
  });

  it('starts at the model’s stated starting units, not at zero', async () => {
    const cookie = await signUp('sel2@test.local');
    const modelId = await firstModelId(cookie);
    const { simulation } = (await select(cookie, { modelId })).json();

    expect(simulation.startingUnits).toBeGreaterThan(0);
    expect(simulation.currentUnits).toBe(simulation.startingUnits);
    // Nothing has settled, so the return is exactly zero — a computed zero,
    // which is different from the null of having no model at all.
    expect(simulation.simulatedReturn).toBe(0);
  });

  it('persists across requests', async () => {
    const cookie = await signUp('sel3@test.local');
    const modelId = await firstModelId(cookie);
    await select(cookie, { modelId });

    const { simulation } = (await getSimulation(cookie)).json();
    expect(simulation.model.id).toBe(modelId);
  });

  it('can be turned off again with a null id', async () => {
    const cookie = await signUp('sel4@test.local');
    const modelId = await firstModelId(cookie);
    await select(cookie, { modelId });

    const { simulation } = (await select(cookie, { modelId: null })).json();
    expect(simulation.enabled).toBe(false);
    expect(simulation.currentUnits).toBeNull();
  });

  it('carries the disclosure with the figures', async () => {
    const cookie = await signUp('sel5@test.local');
    const modelId = await firstModelId(cookie);
    const { simulation } = (await select(cookie, { modelId })).json();

    expect(simulation.disclosure).toMatch(/not broker results/i);
    expect(simulation.disclosure).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('records a risk event for the change', async () => {
    const cookie = await signUp('sel6@test.local');
    const modelId = await firstModelId(cookie);
    await select(cookie, { modelId });

    const events = await context.database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM risk_events WHERE code = 'limits_updated'`,
    );
    expect(Number(events.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('requires a session', async () => {
    expect((await select('', { modelId: null })).statusCode).toBe(401);
  });
});

// ------------------------------------------------- the client cannot author --

describe('a client cannot author the accounting model', () => {
  it('refuses a body carrying its own return rate', async () => {
    const cookie = await signUp('auth1@test.local');
    const modelId = await firstModelId(cookie);

    // The whole point of the phase. Silently ignoring the extra field would
    // leave the caller believing it set a rate.
    const response = await select(cookie, { modelId, simulatedReturnRate: 3 });
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['a payout rate', { payoutRate: 0.9 }],
    ['a win rate', { winPayoutRate: 0.9 }],
    ['a tie policy', { tieRule: 'treat_as_loss' }],
    ['starting units', { startingUnits: 999999 }],
    ['a loss refund', { lossRefundRate: 0.5 }],
  ])('refuses a body smuggling %s', async (_label, extra) => {
    const cookie = await signUp(`auth-${Object.keys(extra)[0]}@test.local`);
    const modelId = await firstModelId(cookie);
    expect((await select(cookie, { modelId, ...extra })).statusCode).toBe(400);
  });

  it('refuses an id that is not in the catalogue', async () => {
    const cookie = await signUp('auth2@test.local');
    const response = await select(cookie, {
      modelId: '00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('invalid_simulation_model');
  });

  it('refuses a malformed id rather than coercing it', async () => {
    const cookie = await signUp('auth3@test.local');
    expect((await select(cookie, { modelId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await select(cookie, { modelId: 12345 })).statusCode).toBe(400);
    expect((await select(cookie, {})).statusCode).toBe(400);
  });

  it('refuses a model that is published but not selectable', async () => {
    const cookie = await signUp('auth4@test.local');
    const modelId = await firstModelId(cookie);
    await context.database.query(
      `UPDATE simulation_models SET status = 'deprecated' WHERE id = $1`,
      [modelId],
    );

    // Deprecation stops new selection even though the row still exists.
    expect((await select(cookie, { modelId })).statusCode).toBe(422);
  });

  it('does not treat a SQL payload as anything but a string', async () => {
    const cookie = await signUp('auth5@test.local');
    const response = await select(cookie, {
      modelId: "'; DROP TABLE simulation_models; --",
    });
    expect(response.statusCode).toBe(400);

    // The catalogue is intact, which is what parameterised SQL guarantees.
    const models = (await listModels(cookie)).json().models;
    expect(models.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------- isolation --

describe('account isolation', () => {
  it('keeps one account’s selection out of another’s', async () => {
    const mine = await signUp('iso-a@test.local');
    const theirs = await signUp('iso-b@test.local');
    const modelId = await firstModelId(mine);
    await select(mine, { modelId });

    const { simulation } = (await getSimulation(theirs)).json();
    expect(simulation.enabled).toBe(false);
    expect(simulation.model).toBeNull();
  });

  it('does not expose another account by id', async () => {
    const mine = await signUp('iso-c@test.local');
    const theirs = await signUp('iso-d@test.local');
    const modelId = await firstModelId(theirs);
    await select(theirs, { modelId });

    // Their account id is not knowable here, but the ownership check is what
    // makes guessing one useless: a foreign id resolves to nothing.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts/00000000-0000-0000-0000-000000000000/simulation',
      headers: { cookie: mine },
    });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('reports 404 for a position that is not this account’s', async () => {
    const cookie = await signUp('iso-e@test.local');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/positions/00000000-0000-0000-0000-000000000000/simulation',
      headers: { cookie },
    });
    // Identical to a position that never existed, so existence cannot be probed.
    expect(response.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------- separation --

describe('separation from observed measurement', () => {
  it('does not report a simulated figure from the analytics endpoint', async () => {
    const cookie = await signUp('sep@test.local');
    const modelId = await firstModelId(cookie);
    await select(cookie, { modelId });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/analytics/performance',
      headers: { cookie },
    });
    const body = response.body;
    // Calibration and observed accuracy must never acquire a money-shaped
    // number, whatever model an account happens to have selected.
    expect(body).not.toContain('simulatedReturn');
    expect(body).not.toContain('currentUnits');
  });

  it('says the simulation is never used for calibration', async () => {
    const cookie = await signUp('sep2@test.local');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/accounts/me/performance',
      headers: { cookie },
    });
    expect(response.json().separation).toMatch(/never.*calibration/i);
  });
});
