import { describe, expect, it, vi } from 'vitest';
import type { MarketAsset, MarketDataProvider, Repositories, Strategy } from '@binaryai/types';
import { createRuntime, type RuntimeEvent } from './runtime.js';

/**
 * Phase 11C — ingestion polls each instrument through ITS OWN provider.
 *
 * The defect this guards, found by running the app rather than reading it:
 * ingestion passed the single `provider` dependency to every configured
 * instrument, and that provider is resolved for the ANALYSED instrument. With
 * BTCUSD analysed it is Coinbase, so an ingestion plan of
 * `BTCUSD@1m,ETHUSD@1m,EURUSD@1h,AAPL@1d` asked a crypto exchange for a
 * currency pair and a US equity.
 *
 * What made it dangerous was the silence. The wrong provider returns nothing,
 * and nothing is not an error: the worker reported `failures: 0` while EUR/USD
 * sat four hours stale and AAPL five. A chart looked populated because old
 * candles were still there, and freshness was the only thing that knew.
 */

const assetFor = (symbol: string, assetClass: MarketAsset['assetClass']): MarketAsset => ({
  symbol,
  displayName: symbol,
  assetClass,
  pricePrecision: 2,
  isOtc: false,
});

/** Records which symbols it was asked for, and returns no candles. */
function recordingProvider(id: string, seen: string[]): MarketDataProvider {
  return {
    id,
    capabilities: {
      id,
      displayName: id,
      rateLimitPerSecond: 10,
      supportedTimeframes: ['1m', '1h', '1d'],
    },
    fetchCandles: vi.fn(async (request: { symbol: string }) => {
      seen.push(`${id}:${request.symbol}`);
      return { asset: request.symbol, timeframe: '1m', source: 'live_provider', candles: [] };
    }),
  } as unknown as MarketDataProvider;
}

function repositories(): Repositories {
  return {
    sessions: { deleteExpired: vi.fn(async () => 0) },
    candles: {
      latest: vi.fn(async () => null),
      findLatest: vi.fn(async () => null),
      findRange: vi.fn(async () => []),
      insertMany: vi.fn(async () => 0),
      upsertSeries: vi.fn(async () => 0),
    },
    signals: {
      findExpiredUnsettled: vi.fn(async () => []),
      findBySignalKey: vi.fn(async () => null),
    },
    positions: { findExpired: vi.fn(async () => []) },
    assets: { upsert: vi.fn(async () => ({ id: 'asset-1' })) },
  } as unknown as Repositories;
}

const config = {
  symbol: 'BTCUSD',
  timeframe: '1m' as const,
  ingestion: { enabled: true, intervalMs: 60_000 },
  analysis: { enabled: false, intervalMs: 60_000 },
  settlement: { enabled: false, intervalMs: 60_000 },
  maintenance: { enabled: false, intervalMs: 60_000 },
};

const plan = [
  { symbol: 'BTCUSD', timeframe: '1m' as const, asset: assetFor('BTCUSD', 'crypto') },
  { symbol: 'ETHUSD', timeframe: '1m' as const, asset: assetFor('ETHUSD', 'crypto') },
  { symbol: 'EURUSD', timeframe: '1h' as const, asset: assetFor('EURUSD', 'forex') },
  { symbol: 'AAPL', timeframe: '1d' as const, asset: assetFor('AAPL', 'stock') },
];

const strategy = { id: 'test-strategy' } as unknown as Strategy;

describe('ingestion provider routing', () => {
  it('polls each instrument through the provider for ITS asset class', async () => {
    const seen: string[] = [];
    const coinbase = recordingProvider('coinbase', seen);
    const yahoo = recordingProvider('yahoo', seen);

    const runtime = createRuntime(config, {
      provider: coinbase,
      repositories: repositories(),
      strategy,
      asset: assetFor('BTCUSD', 'crypto'),
      analysisInstruments: [plan[0]!],
      ingestionInstruments: plan,
      providerFor: (assetClass) => (assetClass === 'crypto' ? coinbase : yahoo),
    });

    runtime.start();
    await runtime.runOnce();
    await runtime.stop();

    // Before the fix every line here read `coinbase:`.
    expect(seen).toEqual(['coinbase:BTCUSD', 'coinbase:ETHUSD', 'yahoo:EURUSD', 'yahoo:AAPL']);
  });

  it('falls back to the single provider when no router is supplied', async () => {
    const seen: string[] = [];
    const only = recordingProvider('only', seen);

    const runtime = createRuntime(config, {
      provider: only,
      repositories: repositories(),
      strategy,
      asset: assetFor('BTCUSD', 'crypto'),
      analysisInstruments: [plan[0]!],
      ingestionInstruments: plan,
    });

    runtime.start();
    await runtime.runOnce();
    await runtime.stop();

    // A single-provider deployment, and every test that injects one provider,
    // must keep working exactly as before.
    expect(seen).toEqual(['only:BTCUSD', 'only:ETHUSD', 'only:EURUSD', 'only:AAPL']);
  });

  it('REPORTS an instrument whose asset class has no provider', async () => {
    const seen: string[] = [];
    const coinbase = recordingProvider('coinbase', seen);
    const events: RuntimeEvent[] = [];

    const runtime = createRuntime(config, {
      provider: coinbase,
      repositories: repositories(),
      strategy,
      asset: assetFor('BTCUSD', 'crypto'),
      analysisInstruments: [plan[0]!],
      ingestionInstruments: plan,
      // Crypto only. Forex and stocks have nowhere to go.
      providerFor: (assetClass) => (assetClass === 'crypto' ? coinbase : null),
      onEvent: (event) => events.push(event),
    });

    runtime.start();
    await runtime.runOnce();
    await runtime.stop();

    expect(seen).toEqual(['coinbase:BTCUSD', 'coinbase:ETHUSD']);

    // Silence is what let four stale instruments look healthy. An instrument
    // that cannot be ingested must SAY so, not simply produce no candles.
    const warnings = events.filter((event) => event.code === 'ingestion_no_provider');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.message).join(' ')).toContain('EURUSD');
    expect(warnings.map((w) => w.message).join(' ')).toContain('AAPL');
  });
});

/**
 * Phase 11C — a truncated first ingest must be repairable.
 *
 * The normal window is `newest - overlap`, which only extends forward. That is
 * right in steady state and wrong exactly once: if the first ingest for an
 * instrument was cut short, the missing history is never revisited.
 *
 * Observed live: AAPL held 31 daily bars covering one month while Yahoo served
 * 206 for the same window BinaryAI had already asked for. Nothing looked
 * wrong — freshness read `live, 0 bars behind` because the NEWEST bar was
 * current — so a daily instrument sat permanently below the history its
 * strategy needs and silently produced nothing.
 */
describe('deep-start backfill', () => {
  const DAY = 86_400_000;

  /** Records the requested window for each fetch. */
  function windowRecordingProvider(windows: { from: number; to: number }[]): MarketDataProvider {
    return {
      id: 'recorder',
      capabilities: {
        id: 'recorder',
        displayName: 'recorder',
        rateLimitPerSecond: 10,
        maxCandlesPerRequest: 300,
        supportedTimeframes: ['1d'],
      },
      fetchCandles: vi.fn(async (request: { from: number; to: number; symbol: string }) => {
        windows.push({ from: request.from, to: request.to });
        return {
          asset: request.symbol,
          timeframe: '1d',
          source: 'live_provider',
          candles: [],
          meta: { latencyMs: 1 },
        };
      }),
    } as unknown as MarketDataProvider;
  }

  /** Repositories reporting ONE stored bar from yesterday: a short history. */
  function shallowRepositories(): Repositories {
    const newest = Date.now() - DAY;
    return {
      sessions: { deleteExpired: vi.fn(async () => 0) },
      candles: {
        latest: vi.fn(async () => ({
          asset: 'AAPL',
          timeframe: '1d',
          source: 'live_provider',
          candles: [
            {
              timestamp: newest,
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              complete: true,
            },
          ],
        })),
        findRange: vi.fn(async () => []),
        insertMany: vi.fn(async () => 0),
        upsertSeries: vi.fn(async () => 0),
      },
      signals: {
        findExpiredUnsettled: vi.fn(async () => []),
        findBySignalKey: vi.fn(async () => null),
      },
      positions: { findExpired: vi.fn(async () => []) },
      assets: { upsert: vi.fn(async () => ({ id: 'asset-1' })) },
    } as unknown as Repositories;
  }

  const dailyConfig = {
    ...config,
    symbol: 'AAPL',
    timeframe: '1d' as const,
  };
  const dailyPlan = [
    { symbol: 'AAPL', timeframe: '1d' as const, asset: assetFor('AAPL', 'stock') },
  ];

  it('asks for the FULL cold-start window on the first cycle, despite stored candles', async () => {
    const windows: { from: number; to: number }[] = [];
    const provider = windowRecordingProvider(windows);

    const runtime = createRuntime(dailyConfig, {
      provider,
      repositories: shallowRepositories(),
      strategy,
      asset: assetFor('AAPL', 'stock'),
      analysisInstruments: dailyPlan,
      ingestionInstruments: dailyPlan,
    });

    runtime.start();
    await runtime.runOnce();
    await runtime.stop();

    expect(windows).toHaveLength(1);
    // Before the fix this window started one bar behind the newest stored
    // candle — about a day wide — and the missing months were never requested.
    const spanDays = (windows[0]!.to - windows[0]!.from) / DAY;
    expect(spanDays).toBeGreaterThan(200);
  });

  it('reverts to the narrow overlap window on later cycles', async () => {
    const windows: { from: number; to: number }[] = [];
    const provider = windowRecordingProvider(windows);

    const runtime = createRuntime(dailyConfig, {
      provider,
      repositories: shallowRepositories(),
      strategy,
      asset: assetFor('AAPL', 'stock'),
      analysisInstruments: dailyPlan,
      ingestionInstruments: dailyPlan,
    });

    runtime.start();
    await runtime.runOnce();
    await runtime.runOnce();
    await runtime.runOnce();
    await runtime.stop();

    // The scheduler is single-flight, so three runOnce() calls need not
    // produce three fetches. Two is enough to prove the property: the first
    // window is deep, every one after it is narrow.
    expect(windows.length).toBeGreaterThanOrEqual(2);
    // ONE deep window per instrument per process. Repeating it every cycle
    // would re-fetch the same bars forever whenever a provider genuinely has
    // no deeper history — the uncontrolled amplification the rate budget
    // exists to prevent.
    expect((windows[0]!.to - windows[0]!.from) / DAY).toBeGreaterThan(200);
    for (const window of windows.slice(1)) {
      expect((window.to - window.from) / DAY).toBeLessThan(10);
    }
  });
});
