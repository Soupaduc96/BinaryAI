import { describe, expect, it } from 'vitest';
import type { Session, User } from '@binaryai/types';
import {
  SESSION_TOUCH_INTERVAL_MS,
  hashSessionToken,
  mintSessionToken,
  resolveSession,
  shouldTouch,
  timingSafeEqual,
} from './session.js';

const NOW = 1_800_000_000_000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    createdAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    lastSeenAt: NOW - 1000,
    revokedAt: null,
    userAgent: null,
    ipAddress: null,
    ...overrides,
  };
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'trader@example.com',
    displayName: null,
    role: 'user',
    isActive: true,
    createdAt: NOW - 100_000,
    lastLoginAt: null,
    ...overrides,
  };
}

describe('mintSessionToken', () => {
  it('produces a cookie-safe token with no repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintSessionToken()));

    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      // base64url: no +, / or = to be mangled in a Set-Cookie header.
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes of entropy encodes to 43 base64url characters.
      expect(token.length).toBe(43);
    }
  });
});

describe('hashSessionToken', () => {
  it('is deterministic and hides the token', () => {
    const token = mintSessionToken();
    const digest = hashSessionToken(token);

    expect(digest).toBe(hashSessionToken(token));
    expect(digest).not.toContain(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates tokens that differ by one character', () => {
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-b'));
  });
});

describe('resolveSession', () => {
  it('accepts a live session belonging to an active user', () => {
    const resolution = resolveSession(session(), user(), NOW);

    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.user.id).toBe('user-1');
  });

  it('rejects a missing session', () => {
    const resolution = resolveSession(null, user(), NOW);
    expect(resolution).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired session', () => {
    const resolution = resolveSession(session({ expiresAt: NOW - 1 }), user(), NOW);
    expect(resolution).toEqual({ ok: false, reason: 'expired' });
  });

  it('treats expiry as exclusive at the boundary', () => {
    // A session whose expiry is exactly now is over. Off-by-one in the other
    // direction would keep a session alive for one extra millisecond, which is
    // harmless -- but the rule should be stated, not accidental.
    expect(resolveSession(session({ expiresAt: NOW }), user(), NOW).ok).toBe(false);
    expect(resolveSession(session({ expiresAt: NOW + 1 }), user(), NOW).ok).toBe(true);
  });

  it('rejects a revoked session even before it expires', () => {
    // This is the entire reason for server-side sessions: logout takes effect
    // immediately rather than when the credential happens to expire.
    const resolution = resolveSession(
      session({ revokedAt: NOW - 1, expiresAt: NOW + 60_000 }),
      user(),
      NOW,
    );
    expect(resolution).toEqual({ ok: false, reason: 'revoked' });
  });

  it('reports revoked in preference to expired', () => {
    const resolution = resolveSession(
      session({ revokedAt: NOW - 5000, expiresAt: NOW - 1000 }),
      user(),
      NOW,
    );
    expect(resolution).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects a live session whose user was deactivated', () => {
    // Suspending an account must not require hunting down its sessions.
    const resolution = resolveSession(session(), user({ isActive: false }), NOW);
    expect(resolution).toEqual({ ok: false, reason: 'user_inactive' });
  });

  it('rejects a session whose user no longer exists', () => {
    const resolution = resolveSession(session(), null, NOW);
    expect(resolution).toEqual({ ok: false, reason: 'user_inactive' });
  });
});

describe('shouldTouch', () => {
  it('skips the write until the activity stamp is stale', () => {
    expect(shouldTouch(session({ lastSeenAt: NOW - 1000 }), NOW)).toBe(false);
    expect(shouldTouch(session({ lastSeenAt: NOW - SESSION_TOUCH_INTERVAL_MS }), NOW)).toBe(true);
  });
});

describe('timingSafeEqual', () => {
  it('compares by value', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for different lengths without throwing', () => {
    // node's timingSafeEqual throws on a length mismatch; token length is a
    // public constant, so short-circuiting here leaks nothing.
    expect(timingSafeEqual('short', 'much-longer-value')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});
