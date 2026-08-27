/**
 * A bounded, cancellable, single-flight interval scheduler.
 *
 * Deliberately ~100 lines of `setTimeout` rather than a job framework. The
 * requirement is "run this async function on an interval, never concurrently,
 * and stop cleanly" — Kafka, BullMQ or a distributed queue would add operational
 * surface without addressing anything the database does not already guarantee.
 *
 * Three properties that matter more than they look:
 *
 *  1. **Single flight.** A tick that fires while the previous one is still
 *     running is skipped and counted, not queued. Queueing would let a slow
 *     provider build an unbounded backlog of stale work.
 *  2. **`setTimeout` re-armed after completion**, not `setInterval`. The gap
 *     between runs is measured from the END of the previous run, so a run that
 *     overruns the interval cannot cause a pile-up.
 *  3. **No orphan timers.** `stop()` clears the pending timer and awaits the
 *     in-flight run, so the process can exit.
 */

export interface SchedulerOptions {
  readonly name: string;
  readonly intervalMs: number;
  /** Run once immediately on start rather than waiting a full interval. */
  readonly runImmediately?: boolean;
  readonly onError?: (error: unknown, name: string) => void;
}

export interface SchedulerStats {
  readonly name: string;
  readonly running: boolean;
  readonly ticks: number;
  readonly skipped: number;
  readonly failures: number;
  readonly lastRunAt: number | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly inFlight: boolean;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** Runs the task now, respecting single-flight. Returns false if skipped. */
  runNow(): Promise<boolean>;
  stats(): SchedulerStats;
}

export function createScheduler(
  task: (signal: AbortSignal) => Promise<void>,
  options: SchedulerOptions,
): Scheduler {
  const { name, intervalMs, runImmediately = false, onError } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;

  let ticks = 0;
  let skipped = 0;
  let failures = 0;
  let lastRunAt: number | null = null;
  let lastDurationMs: number | null = null;
  let lastError: string | null = null;

  async function execute(): Promise<boolean> {
    if (inFlight !== null) {
      // Previous run still going: skip rather than queue.
      skipped += 1;
      return false;
    }

    const startedAt = Date.now();
    controller = new AbortController();
    const signal = controller.signal;

    const run = (async () => {
      try {
        await task(signal);
        lastError = null;
      } catch (error) {
        failures += 1;
        lastError = error instanceof Error ? error.message : String(error);
        // A worker must never take the process down. The failure is counted,
        // surfaced through stats, and the next tick still fires.
        onError?.(error, name);
      } finally {
        ticks += 1;
        lastRunAt = startedAt;
        lastDurationMs = Date.now() - startedAt;
        inFlight = null;
        controller = null;
      }
    })();

    inFlight = run;
    await run;
    return true;
  }

  function arm(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void execute().finally(arm);
    }, intervalMs);
    // Do not hold the event loop open on this timer alone.
    timer.unref?.();
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      if (runImmediately) {
        void execute().finally(arm);
      } else {
        arm();
      }
    },

    async stop(): Promise<void> {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      controller?.abort();
      // Let the in-flight run finish so it cannot write after shutdown.
      if (inFlight !== null) await inFlight.catch(() => undefined);
    },

    runNow(): Promise<boolean> {
      return execute();
    },

    stats(): SchedulerStats {
      return {
        name,
        running,
        ticks,
        skipped,
        failures,
        lastRunAt,
        lastDurationMs,
        lastError,
        inFlight: inFlight !== null,
      };
    },
  };
}
