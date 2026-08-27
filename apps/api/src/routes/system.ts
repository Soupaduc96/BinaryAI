import type { ComponentStatus, ServiceHealth, SystemStatus } from '@binaryai/types';
import type { RateLimiterStatus } from '@binaryai/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../lib/context.js';

/**
 * How the limiter's state maps to a health colour.
 *
 * The distinction that matters is between a limit that is weaker than the
 * operator thinks and one that is absent. Per-process counting is the former:
 * it works, but only for one instance. An unreachable shared store is the
 * latter, and it is actively refusing logins while it lasts.
 */
function rateLimiterHealth(limiter: RateLimiterStatus, nodeEnv: string): ServiceHealth {
  if (limiter.shared) return limiter.available ? 'ok' : 'unavailable';
  // Outside production, per-process is the intended default and nothing is
  // wrong. In production it is only reachable by explicit opt-in, and the
  // weaker guarantee should keep showing as weaker for as long as it is in use.
  return nodeEnv === 'production' ? 'degraded' : 'ok';
}

function rateLimiterDetail(limiter: RateLimiterStatus): string {
  const failures = limiter.failures > 0 ? ` ${limiter.failures} store failure(s) since boot.` : '';

  if (!limiter.shared) {
    return `Counted per process. Correct for a single instance; every additional instance multiplies the effective limit.${failures}`;
  }
  return limiter.available
    ? `Counted in a shared store and enforced across instances.${failures}`
    : `A shared store is configured but is not answering. Authentication is failing closed; other traffic is unmetered.${failures}`;
}

/**
 * Health and status.
 *
 * `/v1/system/status` reports what is actually wired up. Components that are
 * not configured say `not_configured` rather than `ok`, so the dashboard can
 * show honest empty states instead of implying a working integration.
 */
export function registerSystemRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/health', () => ({ status: 'ok', service: 'binaryai-api' }));

  /**
   * Liveness: is this process alive?
   *
   * Deliberately answers nothing else. An orchestrator uses this to decide
   * whether to KILL the process, so every dependency it consults is a way for
   * an external outage to get a healthy instance restarted — which removes
   * capacity at the exact moment capacity matters. It also stays outside the
   * rate limiter for the same reason: a 429 here would look like death.
   */
  app.get('/health/live', () => ({ status: 'ok' }));

  /**
   * Readiness: can this instance safely serve authenticated application
   * traffic?
   *
   * A different question with a different answer, and conflating them is how a
   * market-data outage ends up looking like total application death.
   *
   * Counted as required: a database that was configured but does not answer
   * (authentication and every account-scoped route need it), and a shared rate
   * limiter that was configured but cannot be reached (credential traffic fails
   * closed without it, so this instance cannot serve a login).
   *
   * NOT counted: market data, workers, the AI provider. Every one of them is
   * optional by design and the API is fully usable without it. Reporting not
   * ready because an exchange is down would pull a working instance out of the
   * load balancer over a feature that degrades gracefully on its own.
   */
  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};

    // Not configured is a valid deployment: analysis is stateless.
    if (!context.persistence) {
      checks['database'] = 'not_configured';
    } else {
      checks['database'] = (await context.persistence.ping()) ? 'ok' : 'unavailable';
    }

    const limiter = await context.rateLimiter.status();
    checks['rate_limiter'] = !limiter.shared
      ? 'per_instance'
      : limiter.available
        ? 'ok'
        : 'unavailable';

    const ready = checks['database'] !== 'unavailable' && checks['rate_limiter'] !== 'unavailable';

    // 503 so an orchestrator does not need to parse the body to route traffic
    // away. Liveness still answers 200, so the instance is not restarted.
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'degraded', checks });
  });

  app.get('/v1/system/status', async (): Promise<SystemStatus> => {
    const databaseReachable = context.persistence ? await context.persistence.ping() : false;
    const marketData = await context.marketData.status();
    const runtime = await context.runtime.status();
    const limiter = await context.rateLimiter.status();
    const { config } = context;
    const components: ComponentStatus[] = [
      {
        component: 'api',
        health: 'ok',
        detail: 'Analysis, strategy and backtest endpoints are available.',
      },
      {
        component: 'database',
        // Keyed on the injected persistence layer, not on the config string:
        // the two can disagree, and what a caller needs to know is whether
        // storage actually works right now.
        health: !context.persistence ? 'not_configured' : databaseReachable ? 'ok' : 'unavailable',
        detail: !context.persistence
          ? 'No database configured. The API runs stateless; signals are not stored.'
          : databaseReachable
            ? 'Connected. Signals, outcomes and backtests are persisted.'
            : 'A database is configured but did not answer.',
      },
      {
        // Keyed on the limiter's own state, never on whether REDIS_URL is set.
        // A configured-but-unreachable store reported as "ok" is precisely the
        // failure this endpoint exists to prevent: credential traffic is being
        // refused, and the dashboard would show a green row above it.
        component: 'rate_limiter',
        health: rateLimiterHealth(limiter, config.nodeEnv),
        detail: rateLimiterDetail(limiter),
      },
      {
        component: 'market_data',
        // Keyed on the live status, not on configuration: a configured provider
        // with no data is not "ok", and reporting it as such would put a LIVE
        // badge above an empty chart.
        health:
          marketData.state === 'connected'
            ? 'ok'
            : marketData.state === 'not_configured'
              ? 'not_configured'
              : marketData.state === 'disconnected'
                ? 'unavailable'
                : 'degraded',
        detail: marketData.detail,
      },
      {
        // Worker state, never configuration: an enabled worker that has not
        // completed a cycle is 'degraded', so the dashboard cannot show a green
        // ANALYSIS row above a workspace that has analysed nothing.
        component: 'analysis',
        health: !runtime.analysis.enabled
          ? 'not_configured'
          : runtime.analysis.lastError !== null || runtime.analysis.ticks === 0
            ? 'degraded'
            : 'ok',
        detail: !runtime.analysis.enabled
          ? // Distinguish "switched off" from "cannot run": blaming the flag
            // when the real blocker is a missing database sends the operator
            // to fix the wrong thing.
            config.workers.analysis.enabled
            ? 'Live analysis is enabled but no database is configured; not started.'
            : 'Live analysis is disabled (LIVE_ANALYSIS_ENABLED=false).'
          : runtime.analysis.lastAnalyzedCandleAt !== null
            ? `Last candle ${new Date(runtime.analysis.lastAnalyzedCandleAt).toISOString()}; ` +
              `${runtime.analysis.signalsCreated} signal(s) created.`
            : `Running; nothing analysed yet${runtime.analysis.lastSkipReason ? ` (${runtime.analysis.lastSkipReason})` : ''}.`,
      },
      {
        component: 'settlement',
        health: !runtime.settlement.enabled
          ? 'not_configured'
          : runtime.settlement.lastError !== null || runtime.settlement.ticks === 0
            ? 'degraded'
            : 'ok',
        detail: !runtime.settlement.enabled
          ? config.workers.settlement.enabled
            ? 'Settlement is enabled but no database is configured; not started.'
            : 'Settlement is disabled (SETTLEMENT_WORKER_ENABLED=false).'
          : `${runtime.settlement.settledTotal} settled; ` +
            `${runtime.settlement.pendingExpirations ?? 0} awaiting a settlement candle.`,
      },
      {
        component: 'maintenance',
        // A sweep that has never run is NOT the same as one that ran and found
        // nothing, and the status must not collapse the two: the first means
        // session rows are accumulating unbounded.
        health: !runtime.maintenance.enabled
          ? 'not_configured'
          : runtime.maintenance.lastError !== null
            ? 'degraded'
            : 'ok',
        detail: !runtime.maintenance.enabled
          ? config.workers.maintenance.enabled
            ? 'Session retention is enabled but no database is configured; not started.'
            : 'Session retention is disabled (MAINTENANCE_WORKER_ENABLED=false).'
          : runtime.maintenance.lastSweepAt === null
            ? 'Scheduled; no sweep has run yet.'
            : `Last sweep ${new Date(runtime.maintenance.lastSweepAt).toISOString()}; ` +
              `${runtime.maintenance.sessionsDeleted ?? 0} expired session row(s) removed since boot.`,
      },
      {
        component: 'broker',
        health: 'not_configured',
        detail: 'No broker integration exists. BinaryAI cannot place orders.',
      },
      {
        component: 'ai',
        health: 'ok',
        detail: `Provider "${context.aiProvider.id}". Capabilities are reported at /v1/ai/capabilities.`,
      },
    ];

    return {
      service: 'binaryai-api',
      version: context.version,
      startedAt: context.startedAt,
      uptimeSeconds: Math.floor((Date.now() - context.startedAt) / 1000),
      executionMode: 'demo',
      liveTradingEnabled: false,
      components,
    };
  });

  app.get('/v1/ai/capabilities', () => ({
    provider: context.aiProvider.id,
    capabilities: context.aiProvider.capabilities(),
  }));

  /**
   * Assets still need a market-data provider. Rather than invent one, this
   * returns an empty result plus the reason. (Stored signals now live at
   * GET /v1/signals, served from the database when one is configured.)
   */
  app.get('/v1/assets', async () => {
    // Instruments BinaryAI actually holds data for -- not the provider's full
    // catalogue. An instrument with no stored candles cannot be analysed, so
    // listing it here would promise something the system cannot deliver.
    if (!context.persistence) {
      return {
        assets: [],
        provider: context.config.marketData.provider,
        reason: context.marketData.provider
          ? `No database is configured, so ingested candles are not stored. Set DATABASE_URL to persist ${context.marketData.provider.capabilities.displayName} data.`
          : 'No database is configured and no market-data provider is set. Configure both to populate this list.',
      };
    }

    const stored = await context.persistence.repositories.assets.list();
    if (stored.length === 0) {
      return {
        assets: [],
        provider: context.config.marketData.provider,
        reason: context.marketData.provider
          ? 'No instruments have been ingested yet. POST /v1/market-data/ingest to backfill candles.'
          : 'No market-data provider is configured, so there is nothing to ingest.',
      };
    }
    return { assets: stored, provider: context.config.marketData.provider };
  });
}
