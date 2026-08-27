import { describe, expect, it } from 'vitest';
import type { Principal, User } from '@binaryai/types';
import { allScope, canRead, isAdmin, scopeForPrincipal } from './scope.js';

/**
 * Access scope.
 *
 * These tests are the written form of the ownership model: the shared analysis
 * stream is readable by everyone, account data is readable by its owner alone.
 * If one of these ever needs "fixing" to make a feature work, the feature is
 * asking to leak data.
 */

function user(role: User['role'] = 'user'): User {
  return {
    id: 'user-1',
    email: 'trader@example.com',
    displayName: null,
    role,
    isActive: true,
    createdAt: 0,
    lastLoginAt: null,
  };
}

const asUser = (accountId: string | null, role: User['role'] = 'user'): Principal => ({
  kind: 'user',
  user: user(role),
  sessionId: 'session-1',
  accountId,
});

describe('scopeForPrincipal', () => {
  it('gives a user their own account plus the shared stream', () => {
    expect(scopeForPrincipal(asUser('account-1'))).toEqual({
      kind: 'account',
      accountId: 'account-1',
      includeSystem: true,
    });
  });

  it('gives an admin their own scope, not a global one', () => {
    // Elevation is never implicit. An admin route that wants every row asks
    // for allScope() explicitly, so a broad read is visible at the call site.
    expect(scopeForPrincipal(asUser('account-1', 'admin'))).toEqual({
      kind: 'account',
      accountId: 'account-1',
      includeSystem: true,
    });
  });

  it('falls back to shared data for a user with no account', () => {
    expect(scopeForPrincipal(asUser(null))).toEqual({ kind: 'system' });
  });

  it('gives a service token shared data only', () => {
    // The machine token authenticates a machine, not a person. It must never
    // resolve to some default account's private rows.
    expect(scopeForPrincipal({ kind: 'service', label: 'api_key' })).toEqual({ kind: 'system' });
  });

  it('gives an anonymous caller shared data only', () => {
    expect(scopeForPrincipal({ kind: 'anonymous' })).toEqual({ kind: 'system' });
  });
});

describe('canRead', () => {
  const mine = { kind: 'account', accountId: 'account-1', includeSystem: true } as const;
  const mineOnly = { kind: 'account', accountId: 'account-1', includeSystem: false } as const;

  it('lets an account read its own rows', () => {
    expect(canRead(mine, 'account-1')).toBe(true);
  });

  it('refuses another account entirely', () => {
    expect(canRead(mine, 'account-2')).toBe(false);
    expect(canRead(mineOnly, 'account-2')).toBe(false);
  });

  it('honours includeSystem for unowned rows', () => {
    expect(canRead(mine, null)).toBe(true);
    expect(canRead(mineOnly, null)).toBe(false);
  });

  it('restricts the system scope to unowned rows', () => {
    expect(canRead({ kind: 'system' }, null)).toBe(true);
    expect(canRead({ kind: 'system' }, 'account-1')).toBe(false);
  });

  it('lets the explicit all-scope read anything', () => {
    expect(canRead(allScope(), 'account-9')).toBe(true);
    expect(canRead(allScope(), null)).toBe(true);
  });
});

describe('isAdmin', () => {
  it('is true only for an authenticated administrator', () => {
    expect(isAdmin(asUser('account-1', 'admin'))).toBe(true);
    expect(isAdmin(asUser('account-1'))).toBe(false);
    expect(isAdmin({ kind: 'service', label: 'api_key' })).toBe(false);
    expect(isAdmin({ kind: 'anonymous' })).toBe(false);
  });
});
