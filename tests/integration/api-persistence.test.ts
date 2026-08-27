import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import { syntheticUptrend } from '@binaryai/fixtures';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * The API against a real database, and against no database at all.
 *
 * Both paths matter. Persistence is additive: the Phase 1 contract must keep
 * working untouched when DATABASE_URL is unset, and every persistence-backed
 * route must degrade to a stated reason rather than an error.
 */

const series = syntheticUptrend(300);
const evaluateBody = { series, strategyId: 'trend-momentum', persist: true };

let context: TestDatabase;
let app: FastifyInstance;
let statelessApp: FastifyInstance;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);

  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
  app = await buildApp(createAppContext({ config, persistence: context.persistence }));
  statelessApp = await buildApp(createAppContext({ config, persistence: null }));
});

beforeEach(async () => {
  await truncateAll(context.database);
});

afterAll(async () => {
  await context?.close();
});

describe('without a database (Phase 1 behaviour is unchanged)', () => {
  it('still evaluates signals', async () => {
    const response = await statelessApp.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: { series, strategyId: 'trend-momentum' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().signal.direction).toBe('call');
  });

  it('says why nothing was stored when persistence is requested', async () => {
    const response = await statelessApp.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().persistence).toEqual({
      stored: false,
      reason: 'No database configured (DATABASE_URL is unset).',
    });
  });

  it('returns an empty signal list with the reason', async () => {
    const body = (await statelessApp.inject({ method: 'GET', url: '/v1/signals' })).json();
    expect(body.signals).toEqual([]);
    expect(body.reason).toMatch(/No database is configured/);
  });

  it('reports the database as not_configured', async () => {
    const body = (await statelessApp.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const database = body.components.find(
      (component: { component: string }) => component.component === 'database',
    );
    expect(database.health).toBe('not_configured');
  });

  it('is still ready', async () => {
    const response = await statelessApp.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('refuses to record an outcome, with a 503 and a reason', async () => {
    const response = await statelessApp.inject({
      method: 'POST',
      url: '/v1/signals/sig_whatever/outcome',
      payload: { settlementPrice: 1.5, result: 'win' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('persistence_disabled');
  });
});

describe('with a database', () => {
  it('reports the database as connected', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const database = body.components.find(
      (component: { component: string }) => component.component === 'database',
    );
    expect(database.health).toBe('ok');
    expect(database.detail).toMatch(/persisted/i);
  });

  it('does not store a signal unless asked', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: { series, strategyId: 'trend-momentum' },
    });
    expect(response.json().persistence.stored).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/v1/signals' })).json().total).toBe(0);
  });

  it('stores a signal with its features when asked', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });

    expect(response.statusCode).toBe(200);
    const { persistence, signal } = response.json();
    expect(persistence.stored).toBe(true);
    expect(persistence.featureCount).toBeGreaterThan(0);

    const list = (await app.inject({ method: 'GET', url: '/v1/signals' })).json();
    expect(list.total).toBe(1);
    expect(list.signals[0].id).toBe(persistence.id);
    expect(list.signals[0].direction).toBe(signal.direction);
  });

  it('records the synthetic provenance rather than implying live data', async () => {
    await app.inject({ method: 'POST', url: '/v1/signals/evaluate', payload: evaluateBody });
    const list = (await app.inject({ method: 'GET', url: '/v1/signals' })).json();
    expect(list.signals[0].dataSource).toBe('synthetic');
  });

  it('replays a stored signal by its engine id', async () => {
    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });
    const original = evaluated.json().signal;

    const fetched = await app.inject({ method: 'GET', url: `/v1/signals/${original.id}` });
    expect(fetched.statusCode).toBe(200);

    const persisted = fetched.json();
    expect(persisted.signal).toStrictEqual(original);
    expect(persisted.features.length).toBeGreaterThan(0);
    expect(persisted.outcome).toBeNull();
  });

  it('404s an unknown signal', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/signals/sig_nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('signal_not_found');
  });

  it('records an outcome and links it to the signal', async () => {
    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });
    const signal = evaluated.json().signal;

    const recorded = await app.inject({
      method: 'POST',
      url: `/v1/signals/${signal.id}/outcome`,
      payload: {
        settlementPrice: signal.price + 0.4,
        result: 'win',
        settledAt: signal.expiration.expiresAt,
        payout: { winPayoutRate: 0.8 },
        metadata: { settledBy: 'integration-test' },
      },
    });

    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().outcome.result).toBe('win');
    expect(recorded.json().outcome.priceDelta).toBeCloseTo(0.4, 5);

    const fetched = (await app.inject({ method: 'GET', url: `/v1/signals/${signal.id}` })).json();
    expect(fetched.outcome.result).toBe('win');
  });

  it('treats outcomes as immutable', async () => {
    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });
    const signal = evaluated.json().signal;
    const payload = { settlementPrice: signal.price + 1, result: 'win' };

    await app.inject({ method: 'POST', url: `/v1/signals/${signal.id}/outcome`, payload });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/signals/${signal.id}/outcome`,
      payload,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('outcome_exists');
  });

  it('404s an outcome for a signal that was never stored', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/sig_missing/outcome',
      payload: { settlementPrice: 1.5, result: 'win' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('validates the outcome body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/anything/outcome',
      payload: { settlementPrice: -5, result: 'jackpot' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
  });

  it('filters stored signals', async () => {
    await app.inject({ method: 'POST', url: '/v1/signals/evaluate', payload: evaluateBody });

    const matching = (
      await app.inject({ method: 'GET', url: '/v1/signals?direction=call' })
    ).json();
    const other = (await app.inject({ method: 'GET', url: '/v1/signals?direction=put' })).json();
    expect(matching.total).toBe(1);
    expect(other.total).toBe(0);
  });

  it('stores backtest runs on request and lists them', async () => {
    const run = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      payload: { series, strategyId: 'trend-momentum', warmupBars: 60, persist: true },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().persistence.stored).toBe(true);

    const runs = (await app.inject({ method: 'GET', url: '/v1/backtest/runs' })).json();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0].resultType).toBe('historical_simulation');
    expect(runs.runs[0].datasetSource).toBe('synthetic');
  });

  it('reports calibration as not implemented, whatever the sample count', async () => {
    const before = (await app.inject({ method: 'GET', url: '/v1/calibration/status' })).json();
    expect(before.implemented).toBe(false);
    expect(before.calibration).toBe('uncalibrated_heuristic');
    expect(before.settledOutcomes).toBe(0);

    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });
    const signal = evaluated.json().signal;
    await app.inject({
      method: 'POST',
      url: `/v1/signals/${signal.id}/outcome`,
      payload: { settlementPrice: signal.price + 1, result: 'win' },
    });

    const after = (await app.inject({ method: 'GET', url: '/v1/calibration/status' })).json();
    expect(after.settledOutcomes).toBe(1);
    // Collecting ground truth is not the same as having calibrated anything.
    expect(after.implemented).toBe(false);
    expect(after.calibration).toBe('uncalibrated_heuristic');
  });

  it('keeps the stored confidence labelled uncalibrated', async () => {
    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: evaluateBody,
    });
    const stored = (
      await app.inject({ method: 'GET', url: `/v1/signals/${evaluated.json().signal.id}` })
    ).json();
    expect(stored.signal.confidence.calibration).toBe('uncalibrated_heuristic');
    expect(stored.signal.confidence.sampleSize).toBeNull();
  });
});
