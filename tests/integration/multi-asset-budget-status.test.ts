import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@binaryai/config';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { createAppContext } from '../../apps/api/src/lib/context.js';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from '../db/harness.js';

/**
 * Phase 11A propagation — R15 (provider budget) and R7 (scoped market state).
 *
 * The audit found the worker had been given a set of instruments while the rest
 * of the system still read one value. These tests pin each propagation point,
 * and every one of them would have failed before the change.
 */

let context: TestDatabase;

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    MARKET_DATA_PROVIDER: 'coinbase',
    MARKET_DATA_EQUITY_PROVIDER: 'yahoo',
    LIVE_ANALYSIS_ENABLED: 'true',
    AUTH_ALLOW_REGISTRATION: 'true',
    AUTH_COOKIE_SECURE: 'false',
    ...extra,
  });

const build = async (extra: Record<string, string> = {}): Promise<FastifyInstance> =>
  buildApp(createAppContext({ config: config(extra), persistence: context.persistence }));

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  await truncateAll(context.database);

  // Stored coverage with DELIBERATELY different ages, so R7 has something real
  // to distinguish. Nothing here is fabricated market data: these are synthetic
  // fixtures in a test database, labelled `historical_file`.
  const { repositories } = context.persistence;
  const minute = 60_000;
  const day = 86_400_000;

  const seed = async (
    symbol: string,
    name: string,
    assetClass: 'crypto' | 'forex' | 'stock',
    precision: number,
    timeframe: '1m' | '1h' | '1d',
    stepMs: number,
    newestAgoMs: number,
  ): Promise<void> => {
    await repositories.assets.upsert({
      symbol,
      displayName: name,
      assetClass,
      pricePrecision: precision,
      isOtc: false,
    });
    const newest = Math.floor((Date.now() - newestAgoMs) / stepMs) * stepMs;
    await repositories.candles.upsertSeries({
      asset: symbol,
      timeframe,
      source: 'historical_file',
      candles: Array.from({ length: 10 }, (_unused, index) => ({
        timestamp: newest - (9 - index) * stepMs,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 10,
        complete: true,
      })),
    });
  };

  /*
   * Fresh versus stale, expressed in BARS rather than wall-clock seconds.
   *
   * Freshness is judged against the instrument's own timeframe: a daily bar
   * from yesterday is ONE bar behind, which is current, not stale. So the
   * stale fixtures are several bars behind — unambiguous at any timeframe.
   */
  await seed('BTCUSD', 'Bitcoin / US Dollar', 'crypto', 2, '1m', minute, 30_000);
  await seed('ETHUSD', 'Ethereum / US Dollar', 'crypto', 2, '1m', minute, 30_000);
  await seed('EURUSD', 'Euro / US Dollar', 'forex', 5, '1h', 3_600_000, 6 * 3_600_000);
  await seed('AAPL', 'Apple Inc.', 'stock', 2, '1d', day, 5 * day);
});

afterAll(async () => {
  await context?.close();
});

// ═════════════════════════════════════════════════════════════ R15 ══
describe('R15 — the request budget belongs to the provider', () => {
  /**
   * Before: throttling was a local `lastRequestAt` inside one run. Four Yahoo
   * instruments meant four runs each believing it held the whole allowance —
   * four times the configured budget, with nothing admitting it.
   *
   * The value enforced is BinaryAI's own conservative spacing, taken from
   * `capabilities.rateLimitPerSecond`. It is NOT a claim about any vendor's
   * real quota: Yahoo publishes none.
   */
  it('gives every equity class the SAME budget object', async () => {
    const { createProviderRouter } = await import('@binaryai/market-data');
    const router = createProviderRouter({ crypto: 'coinbase', equity: 'yahoo' });

    const forex = router.budgetFor('forex');
    const stock = router.budgetFor('stock');
    const index = router.budgetFor('index');
    const commodity = router.budgetFor('commodity');

    expect(forex).not.toBeNull();
    // One object, so four instruments cannot hold four allowances.
    expect(stock).toBe(forex);
    expect(index).toBe(forex);
    expect(commodity).toBe(forex);
  });

  it('gives a different provider its own budget', async () => {
    const { createProviderRouter } = await import('@binaryai/market-data');
    const router = createProviderRouter({ crypto: 'coinbase', equity: 'yahoo' });
    expect(router.budgetFor('crypto')).not.toBe(router.budgetFor('stock'));
  });

  it('returns null for a class with no provider', async () => {
    const { createProviderRouter } = await import('@binaryai/market-data');
    const router = createProviderRouter({ crypto: 'coinbase', equity: 'none' });
    expect(router.budgetFor('stock')).toBeNull();
  });

  it('serialises concurrent callers rather than letting them all through', async () => {
    const { createRateBudget } = await import('@binaryai/market-data');

    let clock = 0;
    const budget = createRateBudget(2, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    // Four callers arriving together, as four parallel ingestion runs would.
    const at: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      await budget.acquire();
      at.push(clock);
    }

    // 2/second means 500ms spacing. Without a shared budget all four fire at 0.
    expect(budget.minIntervalMs).toBe(500);
    expect(at).toEqual([0, 500, 1000, 1500]);
  });

  it('reserves the slot before the request, so parallel callers still queue', async () => {
    const { createRateBudget } = await import('@binaryai/market-data');
    let clock = 0;
    const budget = createRateBudget(1, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    // Acquired concurrently: each must land on its own slot. Measuring
    // afterwards rather than reserving up front is what let two callers both
    // decide they needed no wait.
    await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()]);
    expect(clock).toBeGreaterThanOrEqual(2000);
  });
});

// ══════════════════════════════════════════════════════════════ R7 ══
describe('R7 — market state is scoped to instrument AND timeframe', () => {
  /**
   * Before: one global state derived from the newest candle across every
   * instrument, dominated by whichever the worker polls. AAPL read LIVE beside
   * its own "last update 23h ago".
   */
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ ANALYSIS_INSTRUMENTS: 'BTCUSD@1m' });
  });
  afterAll(async () => {
    await app?.close();
  });

  const stateOf = async (symbol: string, timeframe: string) => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/instruments/${symbol}?timeframe=${timeframe}`,
    });
    return response.json().instrument.marketState;
  };

  it('reports each instrument its own freshness', async () => {
    const btc = await stateOf('BTCUSD', '1m');
    const aapl = await stateOf('AAPL', '1d');

    expect(btc.symbol).toBe('BTCUSD');
    expect(btc.timeframe).toBe('1m');
    expect(btc.state).toBe('live');

    // A day old, and it says so — while BTC beside it is live.
    expect(aapl.symbol).toBe('AAPL');
    expect(aapl.state).toBe('stale');
    expect(aapl.ageSeconds).toBeGreaterThan(3600);
    expect(aapl.barsBehind).toBeGreaterThan(1);
  });

  it('a fresh instrument never makes a stale one look live', async () => {
    const states = await Promise.all([
      stateOf('BTCUSD', '1m'),
      stateOf('EURUSD', '1h'),
      stateOf('AAPL', '1d'),
    ]);
    expect(states.map((entry) => entry.state)).toEqual(['live', 'stale', 'stale']);
  });

  it('distinguishes no_data from stale', async () => {
    // Never ingested versus ingested and gone cold: different causes, and the
    // operator's response differs.
    const never = await stateOf('SOLUSD', '1m');
    expect(never.state).toBe('no_data');
    expect(never.lastCandleAt).toBeNull();

    const cold = await stateOf('AAPL', '1d');
    expect(cold.state).toBe('stale');
    expect(cold.lastCandleAt).not.toBeNull();
  });

  it('reports the timeframe asked for, not another one that has data', async () => {
    // AAPL holds 1d and nothing else. Asking at 1m must not borrow the 1d row.
    const wrong = await stateOf('AAPL', '1m');
    expect(wrong.state).toBe('no_data');
    expect(wrong.detail).toContain('1d');
  });

  it('names the provider serving that instrument', async () => {
    expect((await stateOf('BTCUSD', '1m')).providerId).toBe('coinbase');
    expect((await stateOf('AAPL', '1d')).providerId).toBe('yahoo');
  });

  it('reports not_configured when the class has no provider', async () => {
    const cryptoOnly = await build({
      MARKET_DATA_EQUITY_PROVIDER: 'none',
      ANALYSIS_INSTRUMENTS: 'BTCUSD@1m',
    });
    const response = await cryptoOnly.inject({
      method: 'GET',
      url: '/v1/instruments/AAPL?timeframe=1d',
    });
    expect(response.json().instrument.marketState.state).toBe('not_configured');
    await cryptoOnly.close();
  });

  it('omits market state when no timeframe is named', async () => {
    // A catalogue listing has no timeframe, so it has no per-timeframe state.
    // Inventing one would be the same class of error R7 describes.
    const response = await app.inject({ method: 'GET', url: '/v1/instruments/BTCUSD' });
    expect(response.json().instrument.marketState).toBeUndefined();
  });
});
