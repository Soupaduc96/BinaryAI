import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from './scheduler.js';

/**
 * Scheduler behaviour, on fake timers so the suite is deterministic and fast.
 * A test that waits on real intervals is a test that flakes in CI.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createScheduler', () => {
  it('does not run before start', async () => {
    const task = vi.fn(async () => undefined);
    const scheduler = createScheduler(task, { name: 'test', intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);
    expect(task).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('runs on the interval after start', async () => {
    const task = vi.fn(async () => undefined);
    const scheduler = createScheduler(task, { name: 'test', intervalMs: 1000 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(task).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it('can run immediately on start', async () => {
    const task = vi.fn(async () => undefined);
    const scheduler = createScheduler(task, {
      name: 'test',
      intervalMs: 1000,
      runImmediately: true,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('is single-flight: a tick during a running cycle is skipped, not queued', async () => {
    let resolveTask: (() => void) | null = null;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
    );
    const scheduler = createScheduler(task, { name: 'test', intervalMs: 100 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);

    // While the first run is still in flight, force more attempts.
    await scheduler.runNow();
    await scheduler.runNow();
    expect(task).toHaveBeenCalledTimes(1);
    expect(scheduler.stats().skipped).toBe(2);

    // Assigned inside the promise executor; TS cannot see that narrowing.
    (resolveTask as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
  });

  it('measures the gap from the end of the previous run, preventing pile-up', async () => {
    const task = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    const scheduler = createScheduler(task, { name: 'slow', intervalMs: 100 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);

    // Each cycle costs ~1000ms (100 wait + 900 work), so ~3 runs in 3s -- not
    // the 30 that a naive setInterval would have queued.
    expect(task.mock.calls.length).toBeLessThanOrEqual(4);
    await scheduler.stop();
  });

  it('stops cleanly and runs nothing afterwards', async () => {
    const task = vi.fn(async () => undefined);
    const scheduler = createScheduler(task, { name: 'test', intervalMs: 100 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(250);
    const before = task.mock.calls.length;

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(task.mock.calls.length).toBe(before);
    expect(scheduler.stats().running).toBe(false);
  });

  it('awaits the in-flight run during stop, so nothing writes after shutdown', async () => {
    let finished = false;
    const scheduler = createScheduler(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        finished = true;
      },
      { name: 'test', intervalMs: 100 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100);

    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;

    expect(finished).toBe(true);
  });

  it('survives a failing task and keeps scheduling', async () => {
    const onError = vi.fn();
    let calls = 0;
    const scheduler = createScheduler(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
      },
      { name: 'test', intervalMs: 100, onError },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(350);

    // A worker failure must never take the process down or stop the loop.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBeGreaterThan(1);
    expect(scheduler.stats().failures).toBe(1);
    expect(scheduler.stats().lastError).toBeNull();
    await scheduler.stop();
  });

  it('reports stats that reflect what happened', async () => {
    const scheduler = createScheduler(async () => undefined, { name: 'metrics', intervalMs: 100 });

    expect(scheduler.stats()).toMatchObject({ name: 'metrics', running: false, ticks: 0 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(250);

    const stats = scheduler.stats();
    expect(stats.running).toBe(true);
    expect(stats.ticks).toBe(2);
    expect(stats.lastRunAt).not.toBeNull();
    expect(stats.lastDurationMs).not.toBeNull();
    await scheduler.stop();
  });

  it('passes an abort signal that is aborted on stop', async () => {
    let observed: AbortSignal | null = null;
    const scheduler = createScheduler(
      async (signal) => {
        observed = signal;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      },
      { name: 'test', intervalMs: 50 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(observed).not.toBeNull();
    expect((observed as unknown as AbortSignal).aborted).toBe(false);

    const stopping = scheduler.stop();
    expect((observed as unknown as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
  });
});
