import { describe, expect, it, vi } from 'vitest';
import type {
  Candle,
  CandleSeries,
  MarketDataProvider,
  ProviderFetchResult,
  Repositories,
} from '@binaryai/types';
import { COINBASE_CAPABILITIES } from './providers/coinbase.js';
import { ProviderError } from './provider-error.js';
import { planWindows, runHistoricalIngestion } from './ingestion.js';
import { buildMarketDataStatus, createIngestionTracker } from './observability.js';

const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

function candles(count: number, startMs = T0): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: startMs + index * MINUTE,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
    complete: true,
  }));
}

/** Provider stub: no network, fully scripted, so the worker is deterministic. */
function stubProvider(
  handler: (call: number) => ProviderFetchResult | Promise<ProviderFetchResult>,
  overrides: Partial<MarketDataProvider['capabilities']> = {},
): { provider: MarketDataProvider; calls: () => number } {
  let calls = 0;
  const provider: MarketDataProvider = {
    capabilities: { ...COINBASE_CAPABILITIES, maxCandlesPerRequest: 100, ...overrides },
    listAssets: async () => [],
    ping: async () => true,
    fetchCandles: async () => {
      calls += 1;
      return handler(calls);
    },
  };
  return { provider, calls: () => calls };
}

function fetchResult(list: Candle[]): ProviderFetchResult {
  return {
    symbol: 'BTCUSD',
    timeframe: '1m',
    source: 'historical_provider',
    origin: 'exchange',
    candles: list,
    meta: {
      providerId: 'coinbase',
      providerSymbol: 'BTC-USD',
      requestedAt: T0,
      receivedAt: T0 + 40,
      latencyMs: 40,
      candlesReturned: list.length,
      endpoint: '/products/BTC-USD/candles',
    },
  };
}

/** Repository stub capturing what would be persisted. */
function stubRepositories(): { repositories: Repositories; stored: CandleSeries[] } {
  const stored: CandleSeries[] = [];
  const repositories = {
    assets: {
      findBySymbol: async () => null,
      upsert: async (asset: unknown) => asset as never,
      list: async () => [],
    },
    candles: {
      upsertSeries: async (series: CandleSeries) => {
        stored.push(series);
        return series.candles.length;
      },
      findRange: async () => null,
      latest: async () => null,
      count: async () => 0,
    },
    systemEvents: { record: async () => undefined, list: async () => [] },
  } as unknown as Repositories;
  return { repositories, stored };
}

const noSleep = async (): Promise<void> => undefined;

describe('planWindows', () => {
  it('splits a range into provider-sized windows', () => {
    const windows = planWindows(T0, T0 + 250 * MINUTE, '1m', 100);
    expect(windows).toHaveLength(3);
    expect(windows[0]?.from).toBe(T0);
    expect(windows[1]?.from).toBe(T0 + 100 * MINUTE);
  });

  it('returns nothing for an empty or inverted range', () => {
    expect(planWindows(T0, T0, '1m', 100)).toEqual([]);
    expect(planWindows(T0 + MINUTE, T0, '1m', 100)).toEqual([]);
  });

  it('never produces a window larger than the request ceiling', () => {
    for (const window of planWindows(T0, T0 + 1000 * MINUTE, '1m', 300)) {
      expect((window.to - window.from) / MINUTE).toBeLessThanOrEqual(300);
    }
  });
});

describe('historical ingestion', () => {
  it('fetches, validates and reports a completed run', async () => {
    const { provider } = stubProvider(() => fetchResult(candles(60)));
    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 60 * MINUTE },
      { provider, now: () => T0 + 10 * 60 * MINUTE, sleep: noSleep },
    );

    expect(result.status).toBe('completed');
    expect(result.metrics.candlesReceived).toBe(60);
    expect(result.metrics.candlesAccepted).toBe(60);
    expect(result.metrics.candlesRejected).toBe(0);
    expect(result.coveredFrom).toBe(T0);
    expect(result.providerId).toBe('coinbase');
    expect(result.persisted).toBe(false);
  });

  it('refuses a timeframe the provider does not serve', async () => {
    const { provider, calls } = stubProvider(() => fetchResult(candles(1)));
    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '30m', from: T0, to: T0 + 60 * MINUTE },
      { provider, sleep: noSleep },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/does not serve 30m/);
    expect(calls()).toBe(0);
  });

  it('refuses an empty range rather than fetching everything', async () => {
    const { provider, calls } = stubProvider(() => fetchResult(candles(1)));
    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 },
      { provider, sleep: noSleep },
    );
    expect(result.status).toBe('failed');
    expect(calls()).toBe(0);
  });

  it('persists accepted candles idempotently through the repository', async () => {
    const { provider } = stubProvider(() => fetchResult(candles(30)));
    const { repositories, stored } = stubRepositories();

    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 30 * MINUTE },
      { provider, repositories, now: () => T0 + 10 * 60 * MINUTE, sleep: noSleep },
    );

    expect(result.metrics.candlesStored).toBe(30);
    expect(result.persisted).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.asset).toBe('BTCUSD');
    // Provenance survives into storage.
    expect(stored[0]?.source).toBe('historical_provider');
  });

  it('does not store candles the quality scan rejected', async () => {
    const bad = candles(5);
    bad[2] = { ...bad[2]!, high: 1 };
    const { provider } = stubProvider(() => fetchResult(bad));
    const { repositories, stored } = stubRepositories();

    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 5 * MINUTE },
      { provider, repositories, now: () => T0 + 10 * 60 * MINUTE, sleep: noSleep },
    );

    expect(result.metrics.candlesRejected).toBe(1);
    expect(result.metrics.candlesStored).toBe(4);
    expect(stored[0]?.candles).toHaveLength(4);
  });
});

describe('failure handling', () => {
  it('retries a retryable failure with bounded exponential backoff', async () => {
    const delays: number[] = [];
    const { provider, calls } = stubProvider((call) => {
      if (call < 3) throw new ProviderError('server_error', 'boom', { retryable: true });
      return fetchResult(candles(10));
    });

    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 10 * MINUTE },
      {
        provider,
        now: () => T0 + 10 * 60 * MINUTE,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      { baseBackoffMs: 100, maxBackoffMs: 1000 },
    );

    expect(result.status).toBe('completed');
    expect(calls()).toBe(3);
    expect(result.metrics.retries).toBe(2);
    expect(delays).toEqual([100, 200]);
  });

  it('caps backoff at the maximum', async () => {
    const delays: number[] = [];
    const { provider } = stubProvider(() => {
      throw new ProviderError('timeout', 'slow', { retryable: true });
    });

    await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 10 * MINUTE },
      {
        provider,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      { maxRetries: 5, baseBackoffMs: 1000, maxBackoffMs: 2000 },
    );

    expect(Math.max(...delays)).toBeLessThanOrEqual(2000);
    // Bounded, never an infinite retry loop.
    expect(delays).toHaveLength(5);
  });

  it('does not retry a non-retryable failure', async () => {
    const { provider, calls } = stubProvider(() => {
      throw new ProviderError('authentication', 'bad key');
    });

    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 10 * MINUTE },
      { provider, sleep: noSleep },
    );

    expect(result.status).toBe('failed');
    expect(calls()).toBe(1);
    expect(result.metrics.retries).toBe(0);
    expect(result.error).toMatch(/authentication/);
  });

  it('keeps partial data and reports partial rather than pretending success', async () => {
    const { provider } = stubProvider((call) => {
      if (call === 1) return fetchResult(candles(100));
      throw new ProviderError('not_found', 'gone');
    });
    const { repositories } = stubRepositories();

    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 300 * MINUTE },
      { provider, repositories, now: () => T0 + 10 * 60 * MINUTE, sleep: noSleep },
    );

    expect(result.status).toBe('partial');
    expect(result.metrics.candlesStored).toBe(100);
    expect(result.error).toBeDefined();
  });

  it('stops at the per-run candle ceiling and says so', async () => {
    const { provider } = stubProvider(() => fetchResult(candles(100)));
    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 1000 * MINUTE },
      { provider, now: () => T0 + 10_000 * MINUTE, sleep: noSleep },
      { maxCandles: 150 },
    );

    expect(result.status).toBe('partial');
    expect(result.warnings.join(' ')).toMatch(/ceiling/);
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = stubProvider(() => fetchResult(candles(10)));

    const result = await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 100 * MINUTE },
      { provider, sleep: noSleep },
      { signal: controller.signal },
    );

    expect(result.status).toBe('partial');
    expect(calls()).toBe(0);
  });

  it('spaces requests to respect the provider rate limit', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let clock = T0;
    const { provider } = stubProvider(() => fetchResult(candles(100)), {
      rateLimitPerSecond: 2,
      maxCandlesPerRequest: 100,
    });

    await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 300 * MINUTE },
      { provider, now: () => clock++, sleep },
    );

    // 2 req/s -> at least 500ms between requests.
    expect(sleep).toHaveBeenCalled();
    expect(sleep.mock.calls.every(([ms]) => ms <= 500)).toBe(true);
  });
});

describe('observability', () => {
  it('tracks successes, failures and totals', async () => {
    const tracker = createIngestionTracker();
    const { provider } = stubProvider(() => fetchResult(candles(10)));
    const { repositories } = stubRepositories();

    await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 10 * MINUTE },
      { provider, repositories, tracker, now: () => T0 + 10 * 60 * MINUTE, sleep: noSleep },
    );

    const snapshot = tracker.snapshot();
    expect(snapshot.runs).toBe(1);
    expect(snapshot.candlesStoredTotal).toBe(10);
    expect(snapshot.lastSuccessAt).not.toBeNull();
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.lastLatencyMs).toBe(40);
  });

  it('records the error from a failed run', async () => {
    const tracker = createIngestionTracker();
    const { provider } = stubProvider(() => {
      throw new ProviderError('authentication', 'nope');
    });

    await runHistoricalIngestion(
      { symbol: 'BTCUSD', timeframe: '1m', from: T0, to: T0 + 10 * MINUTE },
      { provider, tracker, sleep: noSleep },
    );

    expect(tracker.snapshot().lastError).toMatch(/authentication/);
    expect(tracker.snapshot().lastFailureAt).not.toBeNull();
  });
});

describe('market data status', () => {
  it('reports not_configured with no provider', async () => {
    const status = await buildMarketDataStatus({ provider: null, tracker: null });
    expect(status.state).toBe('not_configured');
    expect(status.reachable).toBe(false);
  });

  it('reports disconnected when the provider does not answer', async () => {
    const { provider } = stubProvider(() => fetchResult([]));
    const status = await buildMarketDataStatus({
      provider: { ...provider, ping: async () => false },
      tracker: null,
      lastCandleAt: T0,
    });
    expect(status.state).toBe('disconnected');
    expect(status.detail).toMatch(/not reachable/i);
  });

  it('reports degraded when reachable but nothing has been ingested', async () => {
    const { provider } = stubProvider(() => fetchResult([]));
    const status = await buildMarketDataStatus({ provider, tracker: null, lastCandleAt: null });
    expect(status.state).toBe('degraded');
  });

  it('reports stale rather than presenting old data as current', async () => {
    const { provider } = stubProvider(() => fetchResult([]));
    const status = await buildMarketDataStatus({
      provider,
      tracker: null,
      lastCandleAt: T0,
      now: T0 + 3600_000,
      stalenessThresholdSeconds: 300,
    });
    expect(status.state).toBe('stale');
    expect(status.stalenessSeconds).toBe(3600);
    expect(status.detail).toMatch(/not current/i);
  });

  it('reports connected for fresh data', async () => {
    const { provider } = stubProvider(() => fetchResult([]));
    const status = await buildMarketDataStatus({
      provider,
      tracker: null,
      lastCandleAt: T0,
      now: T0 + 30_000,
      stalenessThresholdSeconds: 300,
    });
    expect(status.state).toBe('connected');
    expect(status.origin).toBe('exchange');
  });
});
