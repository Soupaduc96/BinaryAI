import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Rules enforced here:
 *  - Nothing reads `process.env` outside this module.
 *  - Invalid configuration fails fast at boot with a readable message, rather
 *    than surfacing as a mystery 500 later.
 *  - Secrets are never returned by `describeConfig`, which is what gets logged.
 *  - Live execution cannot be switched on by configuration in this build.
 */

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
    .default(defaultValue)
    .transform((value) =>
      typeof value === 'boolean' ? value : value === 'true' || value === '1' || value === 'yes',
    );

const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal('').transform(() => undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  API_CORS_ORIGINS: z.string().default('http://localhost:3000'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(100).default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(120),

  /**
   * Where the rate-limit counters live.
   *
   * `memory` is correct for exactly one instance. Behind two, each keeps its
   * own counters, so the effective limit is double what the operator set — and
   * with N instances it is N times. That is not a limit anybody chose, so
   * production refuses `memory` unless an operator names it explicitly via the
   * escape hatch below. Development defaults to it because requiring a Redis to
   * run the API locally would be a worse trade.
   */
  RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),
  /**
   * Deliberate opt-in to per-instance limiting in production.
   *
   * Exists so a genuinely single-instance deployment is not forced to run a
   * Redis it has no other use for. It has to be typed out, it is reported in
   * the status endpoint, and it is logged at boot — the requirement is that the
   * weaker guarantee is CHOSEN, not that it is unreachable.
   */
  RATE_LIMIT_ALLOW_IN_MEMORY: booleanFromEnv(false),

  // Storage. Optional in this phase: the API runs stateless without them.
  DATABASE_URL: optionalString,
  DATABASE_SSL: booleanFromEnv(false),
  // Connection pool ceiling. Sized for a single API instance; lower it when
  // several instances share one server, or when pointing at an endpoint that
  // accepts only one connection.
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: optionalString,

  // Market data. 'none' stays the default: ingestion is opt-in.
  //   coinbase -> Coinbase Exchange public API, no credentials required.
  MARKET_DATA_PROVIDER: z.enum(['none', 'coinbase']).default('none'),
  // Unused by 'coinbase' (public endpoints); reserved for keyed providers.
  MARKET_DATA_API_KEY: optionalString,
  MARKET_DATA_WS_URL: optionalString,
  // Age beyond which stored candles are reported STALE rather than current.
  MARKET_DATA_STALENESS_SECONDS: z.coerce.number().int().min(10).max(86_400).default(300),

  // Broker. 'none' is the only supported value in this build.
  BROKER_PROVIDER: z.enum(['none']).default('none'),
  BROKER_API_KEY: optionalString,
  BROKER_API_SECRET: optionalString,

  // AI layer. 'rule_based' is local and honest about being rule-based.
  AI_PROVIDER: z.enum(['rule_based', 'http_service']).default('rule_based'),
  AI_SERVICE_URL: optionalString,
  AI_API_KEY: optionalString,

  AUTH_ENABLED: booleanFromEnv(false),
  // Shared machine token. Kept for CI and self-hosted scripting; it identifies
  // a machine, not a person, so it owns nothing and reads only shared data.
  AUTH_API_KEY: optionalString,

  // Sessions. AUTH_JWT_SECRET is deliberately absent: BinaryAI uses opaque
  // server-side sessions so that logout and account suspension take effect
  // immediately. See docs/adr/0010-opaque-server-sessions.md.
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
  AUTH_COOKIE_NAME: z.string().min(1).max(64).default('binaryai_session'),
  // Defaults to true; only an explicit opt-out allows a cookie over plain HTTP,
  // and production refuses that opt-out outright.
  AUTH_COOKIE_SECURE: booleanFromEnv(true),
  AUTH_COOKIE_DOMAIN: optionalString,

  // Open registration is OFF by default. An instance exposed to the internet
  // with signup enabled by accident is a worse failure than one that requires
  // an admin to create accounts.
  AUTH_ALLOW_REGISTRATION: booleanFromEnv(false),
  // Lets the very first account be created on an empty instance, so a fresh
  // deployment is reachable without hand-writing a row. Closes automatically
  // once any user exists.
  AUTH_BOOTSTRAP_ADMIN: booleanFromEnv(true),

  // Analytics evidence policy. The minimum is the gate below which no rate is
  // reported at all -- lowering it does not create evidence, it only lowers the
  // bar for publishing a figure, so the default is deliberately conservative.
  // See docs/adr/0012-calibration-methodology.md.
  ANALYTICS_MIN_SAMPLES: z.coerce.number().int().min(1).max(100_000).default(30),

  EXECUTION_MODE: z.enum(['demo', 'live']).default('demo'),
  ALLOW_LIVE_EXECUTION: booleanFromEnv(false),

  // Continuous workers. All default to FALSE: starting background loops that
  // hit an external provider must be an explicit choice, and development must
  // be able to run the API without them.
  MARKET_DATA_WORKER_ENABLED: booleanFromEnv(false),
  MARKET_DATA_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  LIVE_ANALYSIS_ENABLED: booleanFromEnv(false),
  LIVE_ANALYSIS_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
  LIVE_ANALYSIS_SYMBOL: z.string().min(1).max(32).default('BTCUSD'),
  LIVE_ANALYSIS_TIMEFRAME: z.enum(['1m', '5m', '15m', '1h', '1d']).default('1m'),
  LIVE_ANALYSIS_STRATEGY: z.string().min(1).max(64).default('trend-momentum'),
  SETTLEMENT_WORKER_ENABLED: booleanFromEnv(false),
  SETTLEMENT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),

  /**
   * Housekeeping: sweeping expired session rows.
   *
   * Hourly by default and floored at a minute. This is retention, not an
   * authorisation control — an expired session stops authenticating the moment
   * it expires, whether or not its row has been swept — so sweeping more often
   * buys nothing and only adds writes.
   */
  MAINTENANCE_WORKER_ENABLED: booleanFromEnv(true),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),

  MONITORING_ENABLED: booleanFromEnv(false),
  MONITORING_DSN: optionalString,
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly logLevel: Env['LOG_LEVEL'];
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly corsOrigins: readonly string[];
    readonly rateLimit: {
      readonly windowMs: number;
      readonly maxRequests: number;
      readonly store: Env['RATE_LIMIT_STORE'];
      /** True when an operator explicitly accepted per-instance limiting. */
      readonly allowInMemory: boolean;
    };
  };
  readonly database: {
    readonly url: string | undefined;
    readonly ssl: boolean;
    readonly maxConnections: number;
    readonly configured: boolean;
  };
  readonly redis: { readonly url: string | undefined; readonly configured: boolean };
  readonly marketData: {
    readonly provider: Env['MARKET_DATA_PROVIDER'];
    readonly apiKey: string | undefined;
    readonly websocketUrl: string | undefined;
    readonly configured: boolean;
    readonly stalenessThresholdSeconds: number;
  };
  readonly broker: {
    readonly provider: Env['BROKER_PROVIDER'];
    readonly apiKey: string | undefined;
    readonly apiSecret: string | undefined;
    readonly configured: boolean;
  };
  readonly ai: {
    readonly provider: Env['AI_PROVIDER'];
    readonly serviceUrl: string | undefined;
    readonly apiKey: string | undefined;
  };
  readonly auth: {
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly session: {
      readonly ttlMs: number;
      readonly cookieName: string;
      readonly secureCookie: boolean;
      readonly cookieDomain: string | undefined;
    };
    readonly allowRegistration: boolean;
    readonly bootstrapAdmin: boolean;
  };
  readonly analytics: { readonly minimumSamples: number };
  readonly execution: { readonly mode: 'demo' | 'live'; readonly allowLive: boolean };
  readonly workers: {
    readonly ingestion: { readonly enabled: boolean; readonly intervalMs: number };
    readonly analysis: {
      readonly enabled: boolean;
      readonly intervalMs: number;
      readonly symbol: string;
      readonly timeframe: Env['LIVE_ANALYSIS_TIMEFRAME'];
      readonly strategyId: string;
    };
    readonly settlement: { readonly enabled: boolean; readonly intervalMs: number };
    readonly maintenance: { readonly enabled: boolean; readonly intervalMs: number };
  };
  readonly monitoring: { readonly enabled: boolean; readonly dsn: string | undefined };
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Cross-field rules that a per-field schema cannot express.
 * Returns human-readable problems; an empty array means the config is coherent.
 */
function crossValidate(env: Env): string[] {
  const problems: string[] = [];

  if (env.ALLOW_LIVE_EXECUTION || env.EXECUTION_MODE === 'live') {
    problems.push(
      'ALLOW_LIVE_EXECUTION/EXECUTION_MODE=live are refused in this build. BinaryAI is demo-only ' +
        'until a reviewed live integration exists (see docs/adr/0004-demo-only-execution.md).',
    );
  }
  if (env.AI_PROVIDER === 'http_service' && !env.AI_SERVICE_URL) {
    problems.push('AI_PROVIDER=http_service requires AI_SERVICE_URL.');
  }
  if (env.AUTH_ENABLED && !env.AUTH_API_KEY && !env.DATABASE_URL) {
    // Auth needs somewhere to authenticate against: a users table, or failing
    // that the shared machine token. Enabled with neither would reject every
    // request with no way to ever succeed.
    problems.push(
      'AUTH_ENABLED=true requires DATABASE_URL (for user accounts) or AUTH_API_KEY ' +
        '(shared machine token).',
    );
  }
  if (env.NODE_ENV === 'production' && !env.AUTH_COOKIE_SECURE) {
    problems.push(
      'AUTH_COOKIE_SECURE=false is refused in production: a session cookie sent over plain ' +
        'HTTP can be read in transit.',
    );
  }
  if (env.NODE_ENV === 'production' && !env.AUTH_ENABLED) {
    problems.push('AUTH_ENABLED must be true in production.');
  }
  if (env.NODE_ENV === 'production' && env.API_CORS_ORIGINS.includes('*')) {
    problems.push('A wildcard CORS origin is not allowed in production.');
  }

  // Rate limiting fails closed at BOOT rather than at request time.
  //
  // The alternative — starting anyway and quietly counting in memory — is the
  // specific failure this rule exists to prevent: the API would serve traffic
  // while enforcing a limit N times looser than the one configured, and nothing
  // in the logs or the status endpoint would have been wrong enough to notice.
  // Refusing to start is loud, immediate, and fixable in one line of config.
  if (env.RATE_LIMIT_STORE === 'redis' && !env.REDIS_URL) {
    problems.push('RATE_LIMIT_STORE=redis requires REDIS_URL.');
  }
  if (
    env.NODE_ENV === 'production' &&
    env.RATE_LIMIT_STORE === 'memory' &&
    !env.RATE_LIMIT_ALLOW_IN_MEMORY
  ) {
    problems.push(
      'RATE_LIMIT_STORE=memory counts per process, so every additional instance multiplies the ' +
        'effective limit. Set RATE_LIMIT_STORE=redis with REDIS_URL, or accept per-instance ' +
        'limiting deliberately with RATE_LIMIT_ALLOW_IN_MEMORY=true.',
    );
  }

  return problems;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const problems = crossValidate(parsed.data);
  if (problems.length > 0) throw new ConfigError(problems);

  const env = parsed.data;
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    server: {
      host: env.API_HOST,
      port: env.API_PORT,
      corsOrigins: env.API_CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      rateLimit: {
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
        store: env.RATE_LIMIT_STORE,
        allowInMemory: env.RATE_LIMIT_ALLOW_IN_MEMORY,
      },
    },
    database: {
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL,
      maxConnections: env.DATABASE_MAX_CONNECTIONS,
      configured: Boolean(env.DATABASE_URL),
    },
    redis: { url: env.REDIS_URL, configured: Boolean(env.REDIS_URL) },
    marketData: {
      provider: env.MARKET_DATA_PROVIDER,
      apiKey: env.MARKET_DATA_API_KEY,
      websocketUrl: env.MARKET_DATA_WS_URL,
      configured: env.MARKET_DATA_PROVIDER !== 'none',
      stalenessThresholdSeconds: env.MARKET_DATA_STALENESS_SECONDS,
    },
    broker: {
      provider: env.BROKER_PROVIDER,
      apiKey: env.BROKER_API_KEY,
      apiSecret: env.BROKER_API_SECRET,
      configured: env.BROKER_PROVIDER !== 'none',
    },
    ai: { provider: env.AI_PROVIDER, serviceUrl: env.AI_SERVICE_URL, apiKey: env.AI_API_KEY },
    auth: {
      enabled: env.AUTH_ENABLED,
      apiKey: env.AUTH_API_KEY,
      session: {
        ttlMs: env.AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000,
        cookieName: env.AUTH_COOKIE_NAME,
        secureCookie: env.AUTH_COOKIE_SECURE,
        cookieDomain: env.AUTH_COOKIE_DOMAIN,
      },
      allowRegistration: env.AUTH_ALLOW_REGISTRATION,
      bootstrapAdmin: env.AUTH_BOOTSTRAP_ADMIN,
    },
    analytics: { minimumSamples: env.ANALYTICS_MIN_SAMPLES },
    execution: { mode: 'demo', allowLive: false },
    workers: {
      ingestion: {
        enabled: env.MARKET_DATA_WORKER_ENABLED,
        intervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
      },
      analysis: {
        enabled: env.LIVE_ANALYSIS_ENABLED,
        intervalMs: env.LIVE_ANALYSIS_INTERVAL_MS,
        symbol: env.LIVE_ANALYSIS_SYMBOL,
        timeframe: env.LIVE_ANALYSIS_TIMEFRAME,
        strategyId: env.LIVE_ANALYSIS_STRATEGY,
      },
      settlement: {
        enabled: env.SETTLEMENT_WORKER_ENABLED,
        intervalMs: env.SETTLEMENT_INTERVAL_MS,
      },
      maintenance: {
        enabled: env.MAINTENANCE_WORKER_ENABLED,
        intervalMs: env.MAINTENANCE_INTERVAL_MS,
      },
    },
    monitoring: { enabled: env.MONITORING_ENABLED, dsn: env.MONITORING_DSN },
  };
}

/**
 * Safe-to-log view of the configuration. Secrets are reported as present or
 * absent and never by value.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    server: {
      host: config.server.host,
      port: config.server.port,
      corsOrigins: config.server.corsOrigins,
      rateLimit: {
        store: config.server.rateLimit.store,
        // Surfaced at boot so a deployment that accepted per-instance limiting
        // says so in its own startup log, not only in whoever's memory set it.
        allowInMemory: config.server.rateLimit.allowInMemory,
        maxRequests: config.server.rateLimit.maxRequests,
        windowMs: config.server.rateLimit.windowMs,
      },
    },
    database: { configured: config.database.configured, ssl: config.database.ssl },
    redis: { configured: config.redis.configured },
    marketData: {
      provider: config.marketData.provider,
      apiKeySet: Boolean(config.marketData.apiKey),
    },
    broker: { provider: config.broker.provider, credentialsSet: Boolean(config.broker.apiKey) },
    ai: { provider: config.ai.provider, serviceUrlSet: Boolean(config.ai.serviceUrl) },
    auth: {
      enabled: config.auth.enabled,
      apiKeySet: Boolean(config.auth.apiKey),
      sessionTtlHours: config.auth.session.ttlMs / 3_600_000,
      cookieName: config.auth.session.cookieName,
      secureCookie: config.auth.session.secureCookie,
      allowRegistration: config.auth.allowRegistration,
      bootstrapAdmin: config.auth.bootstrapAdmin,
    },
    analytics: config.analytics,
    execution: config.execution,
    monitoring: { enabled: config.monitoring.enabled },
  };
}
