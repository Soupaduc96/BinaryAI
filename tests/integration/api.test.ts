import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import { syntheticUptrend } from '@binaryai/fixtures';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';

/**
 * Integration tests: the real Fastify app, the real engine, the real strategy
 * registry. Only the network is skipped -- `inject()` drives the same request
 * lifecycle, so routing, validation, auth and error handling are all exercised.
 */

async function makeApp(env: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...env });
  return buildApp(createAppContext({ config, startedAt: Date.now() }));
}

const series = syntheticUptrend(300);

describe('health and status', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('serves a health check', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports demo mode with live trading disabled', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/system/status' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.executionMode).toBe('demo');
    expect(body.liveTradingEnabled).toBe(false);
  });

  it('reports unconfigured integrations honestly', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/system/status' })).json();
    const components = Object.fromEntries(
      body.components.map((component: { component: string; health: string }) => [
        component.component,
        component.health,
      ]),
    );
    expect(components['market_data']).toBe('not_configured');
    expect(components['broker']).toBe('not_configured');
    expect(components['database']).toBe('not_configured');
  });

  it('returns no assets and no signals, with the reason', async () => {
    const assets = (await app.inject({ method: 'GET', url: '/v1/assets' })).json();
    expect(assets.assets).toEqual([]);
    // The endpoint lists instruments BinaryAI holds data for; with neither a
    // database nor a provider configured, both caveats must survive.
    expect(assets.reason).toMatch(/market-data provider/i);
    expect(assets.reason).toMatch(/no database is configured/i);

    const signals = (await app.inject({ method: 'GET', url: '/v1/signals' })).json();
    expect(signals.signals).toEqual([]);
    // Both caveats must survive: nothing stored, and nothing generated.
    expect(signals.reason).toMatch(/without real market data/i);
    expect(signals.reason).toMatch(/no database is configured/i);
  });

  it('reports AI capabilities without overclaiming', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/ai/capabilities' })).json();
    const byName = Object.fromEntries(
      body.capabilities.map((item: { capability: string; implementation: string }) => [
        item.capability,
        item.implementation,
      ]),
    );
    expect(byName['explanation']).toBe('rule_based');
    expect(byName['signal_ranking']).toBe('not_implemented');
  });

  it('returns a structured 404 for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});

describe('strategy discovery', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('lists registered strategies with their parameter specs', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/strategies' })).json();
    const ids = body.strategies.map((strategy: { id: string }) => strategy.id);
    expect(ids).toContain('trend-momentum');
    expect(ids).toContain('mean-reversion');
    expect(body.strategies[0].parameters.length).toBeGreaterThan(0);
  });

  it('404s an unknown strategy', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/strategies/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('strategy_not_found');
  });
});

describe('analysis', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('analyses a supplied series', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/analysis', payload: { series } });
    expect(response.statusCode).toBe(200);
    const { analysis } = response.json();
    expect(analysis.regime.regime).toBe('trend_up');
    expect(analysis.dataQuality.usable).toBe(true);
  });

  it('rejects a malformed body with per-field issues', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/analysis',
      payload: { series: { asset: 'X', timeframe: 'nope', source: 'unknown', candles: [] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    expect(response.json().error.issues.join(' ')).toMatch(/timeframe/);
  });

  it('reports bad candles through the data-quality report rather than crashing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/analysis',
      payload: {
        series: {
          asset: 'X',
          timeframe: '1m',
          source: 'historical_file',
          candles: [{ timestamp: 1000, open: 100, high: 90, low: 110, close: 100 }],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const { analysis } = response.json();
    expect(analysis.dataQuality.usable).toBe(false);
    expect(analysis.dataQuality.issues.map((i: { code: string }) => i.code)).toContain(
      'invalid_ohlc_range',
    );
  });
});

describe('signal evaluation', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('returns a signal with its risk assessment and reasoning', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: { series, strategyId: 'trend-momentum' },
    });
    expect(response.statusCode).toBe(200);
    const { signal, risk } = response.json();
    expect(signal.direction).toBe('call');
    expect(signal.executionMode).toBe('demo');
    expect(signal.confidence.calibration).toBe('uncalibrated_heuristic');
    expect(signal.reasoning.generatedBy).toBe('rule_engine');
    expect(Array.isArray(risk.checks)).toBe(true);
  });

  it('cannot be asked to evaluate in live mode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: { series, strategyId: 'trend-momentum', executionMode: 'live' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().signal.executionMode).toBe('demo');
  });

  it('404s an unknown strategy', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: { series, strategyId: 'ghost' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects unknown strategy parameters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/evaluate',
      payload: { series, strategyId: 'trend-momentum', parameters: { notAParam: 5 } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_parameters');
  });

  it('explains a signal it derived itself', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/signals/explain',
      payload: { series, strategyId: 'trend-momentum' },
    });
    expect(response.statusCode).toBe(200);
    const { explanation } = response.json();
    expect(explanation.implementation).toBe('rule_based');
    expect(explanation.text.length).toBeGreaterThan(0);
  });
});

describe('backtesting', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });

  it('runs a backtest and labels it as historical simulation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      payload: { series, strategyId: 'trend-momentum', expirationSeconds: 180, warmupBars: 60 },
    });
    expect(response.statusCode).toBe(200);
    const { result } = response.json();
    expect(result.resultType).toBe('historical_simulation');
    expect(result.disclaimer).toMatch(/not real trading performance/i);
    expect(result.dataset.source).toBe('synthetic');
    expect(result.warnings.join(' ')).toMatch(/SYNTHETIC/);
  });

  it('validates the backtest configuration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/backtest/run',
      payload: { series, strategyId: 'trend-momentum', expirationSeconds: 1 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('security', () => {
  it('rejects unauthenticated requests when auth is enabled, but keeps /health public', async () => {
    const app = await makeApp({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'test-key' });

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/strategies' })).statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/v1/strategies',
      headers: { authorization: 'Bearer test-key' },
    });
    expect(authorized.statusCode).toBe(200);

    const wrongKey = await app.inject({
      method: 'GET',
      url: '/v1/strategies',
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(wrongKey.statusCode).toBe(401);
  });

  it('rate limits repeated requests', async () => {
    const app = await makeApp({ RATE_LIMIT_MAX_REQUESTS: '3', RATE_LIMIT_WINDOW_MS: '60000' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
    }
    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
  });
});
