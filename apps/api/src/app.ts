import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './lib/context.js';
import { registerErrorHandling } from './plugins/errors.js';
import { registerAuth } from './plugins/auth.js';
import { registerIdentityRateLimit, registerSecurity } from './plugins/security.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBacktestRoutes } from './routes/backtest.js';
import { registerMarketDataRoutes } from './routes/market-data.js';
import { registerInstrumentRoutes } from './routes/instruments.js';
import { registerRuntimeRoutes } from './routes/runtime.js';
import { registerSignalRoutes } from './routes/signals.js';
import { registerStrategyRoutes } from './routes/strategies.js';
import { registerSystemRoutes } from './routes/system.js';

/**
 * Builds the API without starting it, so integration tests can drive it through
 * `app.inject()` with no port, no network and no database.
 */
export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: context.config.logLevel,
      // Never log these: the authorization header carries the machine token
      // and the cookie header carries a live session token. Request bodies are
      // not logged at all, which is what keeps passwords out of the log.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Candle payloads are large; 8 MB is roughly 50k candles of JSON.
    bodyLimit: 8 * 1024 * 1024,
  });

  // Order is load-bearing, in both directions:
  //
  //   registerSecurity          network-keyed limits. Before identity, so a
  //                             flood of unauthenticated requests is rejected
  //                             before it reaches an Argon2 hash.
  //   registerAuth              resolves the principal, checks CSRF, guards.
  //   registerIdentityRateLimit account-keyed limits on the expensive
  //                             endpoints. After identity, because there is no
  //                             account to key on until auth has run.
  //
  // Moving the third call above the second would silently disable it: the
  // principal would not exist yet, every request would look anonymous, and the
  // hook would skip.
  await registerSecurity(app, context);
  await registerAuth(app, context);
  registerIdentityRateLimit(app, context);
  registerErrorHandling(app, context);

  registerAuthRoutes(app, context);
  registerSystemRoutes(app, context);
  registerStrategyRoutes(app, context);
  registerAnalysisRoutes(app, context);
  registerSignalRoutes(app, context);
  registerAnalyticsRoutes(app, context);
  registerAccountRoutes(app, context);
  registerMarketDataRoutes(app, context);
  registerInstrumentRoutes(app, context);
  registerRuntimeRoutes(app, context);
  registerBacktestRoutes(app, context);

  return app;
}
