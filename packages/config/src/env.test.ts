import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './env.js';

describe('loadConfig', () => {
  it('applies safe defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.server.port).toBe(4000);
    expect(config.database.configured).toBe(false);
    expect(config.marketData.provider).toBe('none');
    expect(config.broker.provider).toBe('none');
    expect(config.ai.provider).toBe('rule_based');
  });

  it('always reports demo execution, whatever the environment says', () => {
    expect(loadConfig({}).execution).toEqual({ mode: 'demo', allowLive: false });
  });

  it('refuses to enable live execution', () => {
    expect(() => loadConfig({ ALLOW_LIVE_EXECUTION: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ EXECUTION_MODE: 'live' })).toThrow(/demo-only/);
  });

  it('parses the CORS origin list', () => {
    const config = loadConfig({ API_CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(config.server.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects an out-of-range port with a readable message', () => {
    expect(() => loadConfig({ API_PORT: '99999' })).toThrow(/API_PORT/);
  });

  it('requires a service URL when the AI provider is remote', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'http_service' })).toThrow(/AI_SERVICE_URL/);
  });

  it('requires a credential when auth is enabled', () => {
    expect(() => loadConfig({ AUTH_ENABLED: 'true' })).toThrow(/AUTH_API_KEY/);
    expect(() => loadConfig({ AUTH_ENABLED: 'true', AUTH_API_KEY: 'secret' })).not.toThrow();
  });

  it('requires auth and a non-wildcard CORS origin in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_ENABLED must be true/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_ENABLED: 'true',
        AUTH_API_KEY: 'k',
        API_CORS_ORIGINS: '*',
      }),
    ).toThrow(/wildcard CORS/);
  });

  /**
   * Rate limiting fails closed at boot.
   *
   * The failure being prevented is silent: a multi-instance production
   * deployment counting in memory enforces a limit N times looser than the one
   * configured, and nothing at runtime is wrong enough to notice. Refusing to
   * start is the only signal loud enough.
   */
  it('refuses an in-memory rate limiter in production unless it was chosen', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', AUTH_ENABLED: 'true', AUTH_API_KEY: 'k' }),
    ).toThrow(/RATE_LIMIT_STORE=memory/);
  });

  it('allows per-instance limiting in production when an operator opts in by name', () => {
    // A genuinely single-instance deployment should not be forced to run a
    // Redis it has no other use for. The requirement is that the weaker
    // guarantee is chosen, not that it is unreachable.
    const config = loadConfig({
      NODE_ENV: 'production',
      AUTH_ENABLED: 'true',
      AUTH_API_KEY: 'k',
      RATE_LIMIT_ALLOW_IN_MEMORY: 'true',
    });
    expect(config.server.rateLimit).toMatchObject({ store: 'memory', allowInMemory: true });
  });

  it('refuses a Redis limiter with no Redis to talk to', () => {
    // Starting anyway would mean every request failing the credential check
    // and every other request running unmetered.
    expect(() => loadConfig({ RATE_LIMIT_STORE: 'redis' })).toThrow(/requires REDIS_URL/);
    expect(() =>
      loadConfig({ RATE_LIMIT_STORE: 'redis', REDIS_URL: 'redis://localhost:6379' }),
    ).not.toThrow();
  });

  it('accepts a Redis limiter in production without the opt-out', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      AUTH_ENABLED: 'true',
      AUTH_API_KEY: 'k',
      RATE_LIMIT_STORE: 'redis',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config.server.rateLimit.store).toBe('redis');
  });

  it('defaults to the in-memory store outside production', () => {
    // Requiring a Redis to run the API locally would be a worse trade.
    expect(loadConfig({}).server.rateLimit).toMatchObject({
      store: 'memory',
      allowInMemory: false,
    });
  });

  it('accepts several boolean spellings', () => {
    expect(loadConfig({ AUTH_ENABLED: '1', AUTH_API_KEY: 'k' }).auth.enabled).toBe(true);
    expect(loadConfig({ AUTH_ENABLED: 'no' }).auth.enabled).toBe(false);
  });
});

describe('describeConfig', () => {
  it('never includes secret values', () => {
    const config = loadConfig({
      AUTH_ENABLED: 'true',
      AUTH_API_KEY: 'super-secret-value',
      MARKET_DATA_API_KEY: 'another-secret',
      DATABASE_URL: 'postgres://user:password@localhost:5432/binaryai',
    });
    const serialized = JSON.stringify(describeConfig(config));
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).not.toContain('password');
    expect(serialized).toContain('"apiKeySet":true');
  });
});
