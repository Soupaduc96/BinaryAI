import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Runtime status through the real API.
 *
 * The point of these is narrow and important: status must describe what the
 * workers DID, never what configuration says they should do. A configured-but-
 * never-run worker must not look healthy.
 */

let context: TestDatabase;
let idle: FastifyInstance;
let enabled: FastifyInstance;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  // Several assertions here describe an instance that has analysed nothing, so
  // they need an empty database rather than merely a migrated one.
  //
  // Against PGlite that is automatic: every test file gets its own embedded
  // engine. Against one shared PostgreSQL server it is not — an earlier file
  // that ingested candles and stored a signal leaves those rows behind, and
  // "returns an empty list before anything is analysed" then fails on a signal
  // this file never created. Only a real server exposes the assumption.
  await truncateAll(context.database);

  idle = await buildApp(
    createAppContext({
      config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );

  enabled = await buildApp(
    createAppContext({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        LIVE_ANALYSIS_ENABLED: 'true',
        SETTLEMENT_WORKER_ENABLED: 'true',
        MARKET_DATA_WORKER_ENABLED: 'true',
      }),
      persistence: context.persistence,
      marketDataProvider: null,
    }),
  );
});

afterAll(async () => {
  await context?.close();
});

describe('workers default to disabled', () => {
  it('reports analysis and settlement as not configured', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/runtime/status' })).json();

    expect(body.runtime.analysis.enabled).toBe(false);
    expect(body.runtime.settlement.enabled).toBe(false);
    expect(body.runtime.ingestion.enabled).toBe(false);
    expect(body.runtime.analysis.running).toBe(false);
  });

  it('does not start a loop that could never do anything', async () => {
    // Ingestion is enabled here but there is no provider, so it must stay off.
    const body = (await enabled.inject({ method: 'GET', url: '/v1/runtime/status' })).json();
    expect(body.runtime.ingestion.enabled).toBe(false);
  });

  it('surfaces the worker rows in system status', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const byName = Object.fromEntries(
      body.components.map((c: { component: string; health: string }) => [c.component, c.health]),
    );

    expect(byName['analysis']).toBe('not_configured');
    expect(byName['settlement']).toBe('not_configured');
    expect(byName['broker']).toBe('not_configured');
  });
});

describe('analysis status', () => {
  it('reports zero activity before any cycle has run', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/analysis/status' })).json();

    expect(body.analysis.ticks).toBe(0);
    expect(body.analysis.lastAnalyzedCandleAt).toBeNull();
    expect(body.analysis.lastSignalKey).toBeNull();
    expect(body.analysis.signalsCreated).toBe(0);
  });

  it('states what it requires rather than implying it is ready', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/analysis/status' })).json();
    expect(body.requires.persistence).toBe(true);
    expect(body.requires.marketDataProvider).toBe(false);
  });

  it('never reports healthy purely because it is enabled', async () => {
    const body = (await enabled.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const analysis = body.components.find((c: { component: string }) => c.component === 'analysis');
    // Enabled, but nothing analysed yet: degraded, not ok.
    expect(analysis.health).toBe('degraded');
    expect(analysis.detail).toMatch(/nothing analysed yet/i);
  });
});

describe('settlement status', () => {
  it('states the settlement semantics explicitly', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/settlement/status' })).json();

    // Directional correctness from exchange data -- never a broker result and
    // never a profit figure.
    expect(body.semantics.payoutApplied).toBe(false);
    expect(body.semantics.rule).toMatch(/last bar ending at or before expiry/);
    expect(body.semantics.note).toMatch(/no broker terms/i);
  });

  it('counts pending expirations from the database', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/settlement/status' })).json();
    expect(body.settlement.pendingExpirations).toBe(0);
    expect(body.settlement.settledTotal).toBe(0);
  });
});

describe('latest signals', () => {
  it('returns an empty list before anything is analysed', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/signals/latest' })).json();
    expect(body.signals).toEqual([]);
  });

  it('explains itself when no database is configured', async () => {
    const stateless = await buildApp(
      createAppContext({
        config: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }),
        persistence: null,
        marketDataProvider: null,
      }),
    );
    const body = (await stateless.inject({ method: 'GET', url: '/v1/signals/latest' })).json();
    expect(body.signals).toEqual([]);
    expect(body.reason).toMatch(/no database/i);
  });
});

describe('calibration remains disabled', () => {
  it('reports implemented: false regardless of accumulated samples', async () => {
    const body = (await idle.inject({ method: 'GET', url: '/v1/calibration/status' })).json();
    // Settlement accumulating samples is a prerequisite for calibration, not
    // calibration itself, and this endpoint must never blur that.
    expect(body.implemented).toBe(false);
    expect(body.calibration).toBe('uncalibrated_heuristic');
  });
});
