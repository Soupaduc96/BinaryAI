import { describe, expect, it } from 'vitest';
import { defaultRules, normalizeAddress, rateLimitKey } from './policy.js';

/**
 * Key design.
 *
 * The failure mode being tested for is not "wrong string" — it is a key that
 * either carries a secret or that an attacker can rotate at will. Both turn the
 * limiter into decoration while leaving it looking like it works.
 */

describe('rateLimitKey', () => {
  it('separates traffic classes so one budget cannot spend another', () => {
    const identity = { kind: 'user', userId: 'u1' } as const;
    expect(rateLimitKey('auth_attempt', identity)).not.toBe(rateLimitKey('api_request', identity));
  });

  it('separates identities within a class', () => {
    expect(rateLimitKey('api_request', { kind: 'user', userId: 'a' })).not.toBe(
      rateLimitKey('api_request', { kind: 'user', userId: 'b' }),
    );
  });

  it('does not collide a user id with an account id of the same value', () => {
    // Both are UUIDs from the same generator. Without the type prefix, a user
    // and an unrelated account could share a bucket.
    expect(rateLimitKey('api_request', { kind: 'user', userId: 'x' })).not.toBe(
      rateLimitKey('api_request', { kind: 'account', accountId: 'x' }),
    );
  });

  it('carries a version segment so a bad key shape can be abandoned wholesale', () => {
    expect(rateLimitKey('api_request', { kind: 'user', userId: 'u1' })).toMatch(/^v1:/);
  });

  it('is stable for the same inputs', () => {
    const first = rateLimitKey('paper_action', { kind: 'account', accountId: 'acc-1' });
    const second = rateLimitKey('paper_action', { kind: 'account', accountId: 'acc-1' });
    expect(first).toBe(second);
  });
});

describe('normalizeAddress', () => {
  it('keeps an IPv4 address whole', () => {
    // A /24 would put unrelated customers behind one carrier NAT into the same
    // login budget, so one of them could lock out the rest.
    expect(normalizeAddress('203.0.113.4')).toBe('203.0.113.4');
  });

  it('collapses an IPv6 address to its /64 network', () => {
    // The unit actually allocated to a subscriber. Keying on the full address
    // would give a single attacker 2^64 independent login budgets.
    expect(normalizeAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
  });

  it('gives every address in one /64 the same key', () => {
    const a = normalizeAddress('2001:db8:1:2:aaaa:0:0:1');
    const b = normalizeAddress('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
  });

  it('keeps different /64 networks apart', () => {
    expect(normalizeAddress('2001:db8:1:2::1')).not.toBe(normalizeAddress('2001:db8:1:3::1'));
  });

  it('expands a compressed address before truncating', () => {
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('unwraps an IPv4-mapped address so one client keeps one bucket', () => {
    // Dual-stack sockets report IPv4 clients this way; treating the two forms
    // as different identities would double the budget for anyone who can
    // choose their transport.
    expect(normalizeAddress('::ffff:203.0.113.4')).toBe('203.0.113.4');
  });

  it('is case-insensitive', () => {
    expect(normalizeAddress('2001:DB8:1:2::1')).toBe(normalizeAddress('2001:db8:1:2::1'));
  });

  it('does not throw on an unparseable address', () => {
    // A malformed value must produce a usable key, not a 500 on every request.
    expect(normalizeAddress('not-an-address')).toBe('not-an-address');
    expect(normalizeAddress('')).toBe('unknown');
  });
});

describe('defaultRules', () => {
  const rules = defaultRules({ generalLimit: 120, generalWindowMs: 60_000 });

  it('gives credential traffic a far tighter budget than general traffic', () => {
    // The general limit is sized for a polling dashboard. Applying it to login
    // would permit 120 password guesses a minute.
    expect(rules.auth_attempt.limit).toBeLessThan(rules.api_request.limit);
  });

  it('fails closed only for credential traffic', () => {
    // Everywhere else an unreachable counter would convert a cache outage into
    // a total outage.
    expect(rules.auth_attempt.onStoreFailure).toBe('fail_closed');
    for (const traffic of ['api_request', 'analytics', 'ingestion', 'paper_action'] as const) {
      expect(rules[traffic].onStoreFailure).toBe('fail_open');
    }
  });

  it('takes the general budget from configuration', () => {
    const tuned = defaultRules({ generalLimit: 7, generalWindowMs: 1_000 });
    expect(tuned.api_request).toMatchObject({ limit: 7, windowMs: 1_000 });
  });

  it('does not let configuration widen the credential budget', () => {
    // An operator raising RATE_LIMIT_MAX_REQUESTS is asking for more dashboard
    // headroom, not for more password attempts.
    const tuned = defaultRules({ generalLimit: 100_000, generalWindowMs: 60_000 });
    expect(tuned.auth_attempt.limit).toBe(rules.auth_attempt.limit);
  });

  it('bounds every class', () => {
    for (const rule of Object.values(rules)) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowMs).toBeGreaterThan(0);
    }
  });
});
