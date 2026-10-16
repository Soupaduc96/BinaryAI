import { ConfigError, describeConfig, loadConfig } from '@binaryai/config';
import { buildApp } from './app.js';
import { createAppContext } from './lib/context.js';
import { createPersistenceFromConfig, describePersistence } from './lib/persistence.js';
import { createRateLimitStoreFromConfig } from './lib/rate-limit-store.js';

/**
 * Process entry point: load configuration, build the app, start the continuous
 * workers, listen, and shut down cleanly. Configuration problems abort the boot
 * with a readable message rather than starting a half-working server.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const persistence = createPersistenceFromConfig(config);

  // Built before the app so worker events can be logged through Fastify's
  // logger once it exists; buffered until then.
  const buffered: Array<{ level: string; message: string; context?: unknown }> = [];
  let logEvent: (level: string, message: string, context?: unknown) => void = (
    level,
    message,
    context,
  ) => buffered.push({ level, message, ...(context === undefined ? {} : { context }) });

  const rateLimit = createRateLimitStoreFromConfig(config);

  const context = createAppContext({
    config,
    persistence,
    rateLimitStore: rateLimit.store,
    onRuntimeEvent: (event) =>
      logEvent(event.level, `[${event.worker}] ${event.message}`, event.context),
  });

  const app = await buildApp(context);
  logEvent = (level, message, ctx) => {
    if (level === 'error') app.log.error(ctx ?? {}, message);
    else if (level === 'warning') app.log.warn(ctx ?? {}, message);
    else app.log.info(ctx ?? {}, message);
  };
  for (const entry of buffered) logEvent(entry.level, entry.message, entry.context);

  app.log.info(describeConfig(config), 'binaryai-api configuration');

  if (persistence) {
    const description = describePersistence(config);
    if (await persistence.ping()) {
      app.log.info(description, 'database connected');
    } else {
      // Not fatal: analysis is stateless and still works. Starting anyway with
      // a loud warning beats refusing to serve requests that need no database.
      app.log.error(description, 'DATABASE_URL is set but the database did not answer');
    }
  } else {
    app.log.info('No DATABASE_URL configured; running stateless. Signals will not be stored.');
  }
  app.log.warn('Execution mode is DEMO. No broker is connected and no real order can be placed.');

  // Stated at boot, every boot. A deployment running per-process limits should
  // not have to read its own configuration to discover it -- that is exactly
  // the kind of fact that goes unnoticed until an incident.
  const limiter = await context.rateLimiter.status();
  if (limiter.shared && !limiter.available) {
    // Not fatal. Credential traffic fails closed on its own, and refusing to
    // boot would turn a cache outage into a full outage.
    app.log.error(`${rateLimit.description} The store is NOT reachable right now.`);
  } else if (limiter.shared) {
    app.log.info(rateLimit.description);
  } else {
    app.log.warn(rateLimit.description);
  }

  // Workers are opt-in. Each reports why it is inactive rather than starting
  // a loop that can never do anything useful.
  const workers = config.workers;
  app.log.info(
    {
      ingestion: workers.ingestion.enabled,
      analysis: workers.analysis.enabled,
      settlement: workers.settlement.enabled,
      // EVERY analysed instrument, not just the first. This line said
      // `symbol: 'BTCUSD'` on a four-instrument plan — the same class of
      // false statement R6 removed from the API, left behind in the boot log,
      // where it is the first thing an operator reads and the last thing
      // anyone thinks to check.
      analysisSymbols: workers.analysis.symbols,
      // The PLAN, not a single timeframe. `workers.analysis.timeframe` is only
      // the default applied to entries that name none, so logging it beside a
      // four-instrument plan said "1m" for a plan containing EURUSD@1h and
      // AAPL@1d. The configured text carries each instrument's own timeframe.
      analysisPlan:
        workers.analysis.configured === ''
          ? `${workers.analysis.symbol}@${workers.analysis.timeframe}`
          : workers.analysis.configured,
      ingestionPlan:
        workers.ingestion.configured === '' ? `(follows analysis)` : workers.ingestion.configured,
    },
    'continuous workers',
  );
  if (workers.ingestion.enabled && !context.marketData.provider) {
    app.log.warn('MARKET_DATA_WORKER_ENABLED is set but no provider is configured; not starting.');
  }
  if ((workers.analysis.enabled || workers.settlement.enabled) && !persistence) {
    app.log.warn('Analysis/settlement are enabled but no DATABASE_URL is set; not starting.');
  }
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    // Order matters: stop scheduling first so no new work begins, then close
    // the HTTP server so in-flight requests finish, then drain the pool. The
    // reverse order can abort a worker query mid-transaction.
    void context.runtime
      .stop()
      .then(() => app.close())
      .then(() => context.rateLimiter.close())
      .then(() => persistence?.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'error during shutdown');
          process.exit(1);
        },
      );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.server.host, port: config.server.port });

  /*
   * Workers start only AFTER the port is bound.
   *
   * They used to start first, which meant a failed bind — a second instance
   * launched against an already-running one — spent the gap before
   * `process.exit(1)` analysing and ingesting into the SAME database as the
   * instance already serving. Brief, but it is a second writer nobody asked
   * for, and `exit(1)` never drains it: whatever was in flight is abandoned
   * rather than stopped. Binding first makes a doomed process do no work at
   * all, which is the only safe amount for a process that is about to die.
   */
  context.runtime.start();
}

main().catch((error: unknown) => {
  console.error('failed to start binaryai-api', error);
  process.exit(1);
});
