import { describe, expect, it, vi } from 'vitest';
import type { MarketDataProvider, Repositories, Strategy, MarketAsset } from '@binaryai/types';
import { createRuntime, type RuntimeEvent } from './runtime.js';

/**
 * Worker independence.
 *
 * scheduler.test.ts proves ONE scheduler behaves: single-flight, clean stop, it
 * survives a throwing task. This proves the four workers do not interfere —
 * which is a different claim, and the one that matters operationally.
 *
 * The failure mode: a provider outage stops ingestion, and because the workers
 * share a lifecycle, settlement stops with it. Positions that already expired
 * then never settle, and the system reports itself broken in full rather than
 * degraded in one place. Every test here is about that shape of coupling.
 */

const asset: MarketAsset = {
  symbol: 'SYNTH',
  displayName: 'SYNTH',
  assetClass: 'crypto',
  pricePrecision: 2,
  isOtc: false,
};

const strategy = { id: 'test-strategy' } as unknown as Strategy;

/** A provider that always fails, standing in for an exchange outage. */
function failingProvider(): MarketDataProvider {
  return {
    id: 'failing',
    capabilities: { displayName: 'Failing', rateLimitPerSecond: 1 },
    fetchCandles: () => Promise.reject(new Error('provider is down')),
  } as unknown as MarketDataProvider;
}

/**
 * Repositories that answer just enough for a cycle, and let one method be
 * replaced so a single worker can be made to fail on demand.
 */
function repositories(overrides: Record<string, unknown> = {}): Repositories {
  return {
    sessions: { deleteExpired: vi.fn(async () => 0) },
    candles: {
      findLatest: vi.fn(async () => null),
      findRange: vi.fn(async () => []),
      insertMany: vi.fn(async () => 0),
    },
    signals: {
      findExpiredUnsettled: vi.fn(async () => []),
      findBySignalKey: vi.fn(async () => null),
    },
    positions: { findExpired: vi.fn(async () => []) },
    assets: { upsert: vi.fn(async () => ({ id: 'asset-1' })) },
    ...overrides,
  } as unknown as Repositories;
}

const config = {
  symbol: 'SYNTH',
  timeframe: '1m' as const,
  ingestion: { enabled: true, intervalMs: 60_000 },
  analysis: { enabled: true, intervalMs: 60_000 },
  settlement: { enabled: true, intervalMs: 60_000 },
  maintenance: { enabled: true, intervalMs: 60_000 },
};

describe('worker isolation', () => {
  it('keeps settlement and maintenance running when the market-data provider is down', async () => {
    // The canonical outage. Ingestion cannot work; everything downstream of
    // data already IN the database still can, and must.
    const sessions = { deleteExpired: vi.fn(async () => 3) };
    const events: RuntimeEvent[] = [];

    const runtime = createRuntime(config, {
      provider: failingProvider(),
      repositories: repositories({ sessions }),
      strategy,
      asset,
      onEvent: (event) => events.push(event),
    });

    await runtime.runOnce();

    expect(sessions.deleteExpired).toHaveBeenCalled();
    const status = await runtime.status();
    expect(status.ingestion.failures).toBeGreaterThan(0);
    expect(status.maintenance.failures).toBe(0);
    expect(status.settlement.failures).toBe(0);
  });

  it('does not let a failing maintenance sweep stop settlement', async () => {
    // Retention is the least important of the four. A database hiccup during a
    // sweep must not take down the worker that resolves expired positions.
    const runtime = createRuntime(config, {
      provider: null,
      repositories: repositories({
        sessions: {
          deleteExpired: vi.fn(async () => {
            throw new Error('connection lost');
          }),
        },
      }),
      strategy,
      asset,
    });

    await runtime.runOnce();
    const status = await runtime.status();

    expect(status.maintenance.failures).toBeGreaterThan(0);
    expect(status.settlement.failures).toBe(0);
  });

  it('reports each worker separately, so one failure is not the whole system', async () => {
    const runtime = createRuntime(config, {
      provider: failingProvider(),
      repositories: repositories(),
      strategy,
      asset,
    });

    await runtime.runOnce();
    const status = await runtime.status();

    // Four independent verdicts, not one aggregate. An aggregate would make a
    // provider outage indistinguishable from a database outage.
    expect(Object.keys(status)).toEqual(
      expect.arrayContaining(['ingestion', 'analysis', 'settlement', 'maintenance']),
    );
    expect(status.ingestion.lastError).not.toBeNull();
    expect(status.settlement.lastError).toBeNull();
    expect(status.maintenance.lastError).toBeNull();
  });

  it('reports a never-run sweep as null rather than as zero', async () => {
    // Zero would claim a sweep ran and found nothing. Never-run means session
    // rows are accumulating unbounded — a different fact with a different fix.
    const runtime = createRuntime(config, {
      provider: null,
      repositories: repositories(),
      strategy,
      asset,
    });

    expect((await runtime.status()).maintenance.sessionsDeleted).toBeNull();

    await runtime.runOnce();
    expect((await runtime.status()).maintenance.sessionsDeleted).toBe(0);
  });

  it('does not start a worker whose dependency is missing', async () => {
    // Enabled-but-impossible must not report as running. An operator would
    // otherwise see a green worker that can never do anything.
    const runtime = createRuntime(config, {
      provider: null, // ingestion cannot work
      repositories: null, // nor can anything else
      strategy,
      asset,
    });

    const status = await runtime.status();
    expect(status.ingestion.enabled).toBe(false);
    expect(status.analysis.enabled).toBe(false);
    expect(status.settlement.enabled).toBe(false);
    expect(status.maintenance.enabled).toBe(false);
  });

  it('leaves no timer behind after stop', async () => {
    // An orphan timer keeps the process alive after shutdown, so a container
    // that should exit in a second hangs until it is killed.
    const runtime = createRuntime(config, {
      provider: null,
      repositories: repositories(),
      strategy,
      asset,
    });

    runtime.start();
    await runtime.stop();

    const status = await runtime.status();
    expect(status.startedAt).toBeNull();
    for (const worker of [status.analysis, status.settlement, status.maintenance]) {
      expect(worker.running).toBe(false);
      expect(worker.inFlight).toBe(false);
    }
  });

  it('stops cleanly even when a worker is failing every cycle', async () => {
    // Shutdown must not depend on the workers being healthy.
    const runtime = createRuntime(config, {
      provider: failingProvider(),
      repositories: repositories({
        sessions: {
          deleteExpired: vi.fn(async () => {
            throw new Error('still broken');
          }),
        },
      }),
      strategy,
      asset,
    });

    runtime.start();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('is safe to stop twice', async () => {
    // Two signals arriving together (SIGINT then SIGTERM) must not throw.
    const runtime = createRuntime(config, {
      provider: null,
      repositories: repositories(),
      strategy,
      asset,
    });

    runtime.start();
    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
