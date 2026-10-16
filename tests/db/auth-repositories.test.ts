import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, hashSessionToken, mintSessionToken } from '@binaryai/auth';
import type { Repositories } from '@binaryai/types';
import { createTestDatabase, migrate, truncateAll, type TestDatabase } from './harness.js';

/**
 * Users, sessions and accounts against a real PostgreSQL engine.
 *
 * The point of these is what the DATABASE refuses, not what the TypeScript
 * allows: unique emails, cascading session deletes, one default account per
 * user, and the demo-only CHECK. Those hold even if application code is wrong,
 * which is why they are worth asserting here rather than in a unit test with a
 * mocked repository.
 */

let context: TestDatabase;
let repositories: Repositories;

beforeAll(async () => {
  context = await createTestDatabase();
  await migrate(context.database);
  repositories = context.persistence.repositories;
});

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await truncateAll(context.database);
});

async function makeUser(email = 'trader@example.com') {
  return repositories.users.create({
    email,
    passwordHash: await hashPassword('correct-horse-battery-staple-7'),
    displayName: 'Test Trader',
  });
}

describe('users', () => {
  it('stores a user without ever exposing the digest on the safe read path', async () => {
    const created = await makeUser();
    const read = await repositories.users.findById(created.id);

    expect(read?.email).toBe('trader@example.com');
    // The safe projection must not carry credential material. If this ever
    // fails, every route returning a User has started leaking a hash.
    expect(Object.keys(read ?? {})).not.toContain('passwordHash');
    expect(JSON.stringify(read)).not.toContain('argon2');
  });

  it('returns the digest only through the credential lookup', async () => {
    await makeUser();
    const record = await repositories.users.findByEmailWithCredentials('trader@example.com');

    expect(record?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(record?.failedLogins).toBe(0);
    expect(record?.lockedUntil).toBeNull();
  });

  it('refuses a duplicate email at the database level', async () => {
    await makeUser();
    // The constraint is the authority. A check-then-insert in application code
    // would leave a race in which two concurrent registrations both pass.
    await expect(makeUser()).rejects.toThrow(/duplicate|unique/i);
  });

  it('defaults to the non-admin role', async () => {
    const created = await makeUser();
    expect(created.role).toBe('user');
    expect(created.isActive).toBe(true);
  });

  it('counts users, which is what gates bootstrap', async () => {
    expect(await repositories.users.count()).toBe(0);
    await makeUser('a@example.com');
    await makeUser('b@example.com');
    expect(await repositories.users.count()).toBe(2);
  });

  it('increments failures atomically and applies a lock', async () => {
    const user = await makeUser();

    expect(await repositories.users.recordLoginFailure(user.id, Date.now(), null)).toBe(1);
    expect(await repositories.users.recordLoginFailure(user.id, Date.now(), null)).toBe(2);

    const lockAt = Date.now() + 60_000;
    await repositories.users.recordLoginFailure(user.id, Date.now(), lockAt);
    const locked = await repositories.users.findByEmailWithCredentials(user.email);
    expect(locked?.failedLogins).toBe(3);
    expect(locked?.lockedUntil).not.toBeNull();
  });

  it('clears the failure history on a successful login', async () => {
    const user = await makeUser();
    await repositories.users.recordLoginFailure(user.id, Date.now(), Date.now() + 60_000);

    const at = Date.now();
    await repositories.users.recordLoginSuccess(user.id, at);

    const record = await repositories.users.findByEmailWithCredentials(user.email);
    expect(record?.failedLogins).toBe(0);
    expect(record?.lockedUntil).toBeNull();
    expect(record?.lastLoginAt).toBeCloseTo(at, -3);
  });
});

describe('sessions', () => {
  it('stores only the token digest', async () => {
    const user = await makeUser();
    const token = mintSessionToken();
    await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: Date.now() + 60_000,
    });

    // A database leak must not hand over live sessions.
    const raw = await context.database.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions',
    );
    expect(raw.rows[0]?.token_hash).not.toBe(token);
    expect(raw.rows[0]?.token_hash).toBe(hashSessionToken(token));
  });

  it('finds a session by digest and reports its state honestly', async () => {
    const user = await makeUser();
    const token = mintSessionToken();
    const created = await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: Date.now() + 60_000,
      userAgent: 'vitest',
      ipAddress: '127.0.0.1',
    });

    const found = await repositories.sessions.findByTokenHash(hashSessionToken(token));
    expect(found?.id).toBe(created.id);
    expect(found?.userAgent).toBe('vitest');
    expect(found?.revokedAt).toBeNull();
  });

  it('returns null for a token that was never issued', async () => {
    expect(await repositories.sessions.findByTokenHash(hashSessionToken('nope'))).toBeNull();
  });

  it('keeps the original revocation time when revoked twice', async () => {
    const user = await makeUser();
    const token = mintSessionToken();
    const created = await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: Date.now() + 60_000,
    });

    const first = Date.now();
    await repositories.sessions.revoke(created.id, first);
    await repositories.sessions.revoke(created.id, first + 10_000);

    const found = await repositories.sessions.findByTokenHash(hashSessionToken(token));
    // Logging out twice must not rewrite when the session actually ended.
    expect(found?.revokedAt).toBeCloseTo(first, -3);
  });

  it('revokes every live session for a user at once', async () => {
    const user = await makeUser();
    for (let i = 0; i < 3; i += 1) {
      await repositories.sessions.create({
        userId: user.id,
        tokenHash: hashSessionToken(mintSessionToken()),
        expiresAt: Date.now() + 60_000,
      });
    }

    expect(await repositories.sessions.revokeAllForUser(user.id, Date.now())).toBe(3);
    expect((await repositories.sessions.listActiveForUser(user.id, Date.now())).length).toBe(0);
    // Already revoked: nothing left to affect.
    expect(await repositories.sessions.revokeAllForUser(user.id, Date.now())).toBe(0);
  });

  it('omits expired and revoked sessions from the active list', async () => {
    const user = await makeUser();
    const now = Date.now();

    // Sessions are always created live -- the schema refuses one that is
    // already expired -- so elapsed time is simulated by asking the question
    // at a later instant rather than by back-dating a row.
    const longLived = await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken('long-lived'),
      expiresAt: now + 600_000,
    });
    await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken('short-lived'),
      expiresAt: now + 1_000,
    });
    const revoked = await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken('revoked'),
      expiresAt: now + 600_000,
    });
    await repositories.sessions.revoke(revoked.id, now);

    const active = await repositories.sessions.listActiveForUser(user.id, now + 60_000);
    expect(active.map((session) => session.id)).toEqual([longLived.id]);
  });

  it('refuses a session that expires before it was created', async () => {
    const user = await makeUser();
    // sessions_expiry_after_creation. A negative-lifetime session is a bug
    // wherever it comes from, and the schema says so.
    await expect(
      repositories.sessions.create({
        userId: user.id,
        tokenHash: hashSessionToken(mintSessionToken()),
        expiresAt: Date.now() - 60_000,
      }),
    ).rejects.toThrow();
  });

  it('deletes the sessions of a deleted user', async () => {
    const user = await makeUser();
    await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(mintSessionToken()),
      expiresAt: Date.now() + 60_000,
    });

    await context.database.query('DELETE FROM users WHERE id = $1', [user.id]);

    // ON DELETE CASCADE: a deleted user must not leave a usable session behind.
    const remaining = await context.database.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM sessions',
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });

  it('prunes expired rows only', async () => {
    const user = await makeUser();
    const now = Date.now();
    await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken('live'),
      expiresAt: now + 600_000,
    });
    await repositories.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken('short'),
      expiresAt: now + 1_000,
    });

    // Sweeping at a point after the short session lapsed but before the long
    // one does.
    expect(await repositories.sessions.deleteExpired(now + 60_000)).toBe(1);
    expect(await repositories.sessions.findByTokenHash(hashSessionToken('live'))).not.toBeNull();
    expect(await repositories.sessions.findByTokenHash(hashSessionToken('short'))).toBeNull();
  });
});

describe('accounts', () => {
  it('creates a demo account with the engine defaults', async () => {
    const user = await makeUser();
    const account = await repositories.accounts.create({ userId: user.id });

    expect(account.mode).toBe('demo');
    expect(account.isDefault).toBe(true);
    expect(account.riskLimits).toEqual({});
    expect(account.currency).toBe('USD');
  });

  it('cannot create a live account, whatever the caller wants', async () => {
    const user = await makeUser();
    // The repository takes no `mode` parameter, so this has to go around it --
    // and the CHECK still refuses. This is the layer an application bug cannot
    // bypass. See docs/risk-management.md.
    await expect(
      context.database.query('INSERT INTO accounts (user_id, mode) VALUES ($1, $2)', [
        user.id,
        'live',
      ]),
    ).rejects.toThrow();
  });

  it('permits only one default account per user', async () => {
    const user = await makeUser();
    await repositories.accounts.create({ userId: user.id });

    await expect(repositories.accounts.create({ userId: user.id })).rejects.toThrow(
      /duplicate|unique/i,
    );
  });

  it('allows additional non-default accounts', async () => {
    const user = await makeUser();
    await repositories.accounts.create({ userId: user.id, name: 'Primary' });
    await repositories.accounts.create({ userId: user.id, name: 'Experiment', isDefault: false });

    const accounts = await repositories.accounts.listForUser(user.id);
    expect(accounts.length).toBe(2);
    expect(accounts.filter((account) => account.isDefault).length).toBe(1);
  });

  it('finds the default account, which is what owns new signals', async () => {
    const user = await makeUser();
    const created = await repositories.accounts.create({ userId: user.id });

    const found = await repositories.accounts.findDefaultForUser(user.id);
    expect(found?.id).toBe(created.id);
  });

  it('round-trips a whole risk policy and bumps its version', async () => {
    const user = await makeUser();
    const account = await repositories.accounts.create({ userId: user.id });

    // Phase 5 replaced updateRiskLimits(Record<string, number>) with a whole
    // policy write. The old signature could not hold maxRiskLevel (a string),
    // allowedRegimes (an array) or allowLiveExecution (a boolean), which is why
    // the column was stored but never read.
    await repositories.accounts.updatePolicy(account.id, {
      accountId: account.id,
      version: 2,
      updatedAt: Date.now(),
      limits: {
        minConfidence: 0.75,
        maxRiskLevel: 'low',
        allowedRegimes: ['trend_up'],
        maxOpenPositions: 2,
        maxExposureFraction: 0.01,
        maxDailyLossFraction: 0.02,
        maxConsecutiveLosses: 2,
        cooldownSecondsAfterLoss: 600,
        maxVolatilityAtrPercent: 1,
        minDataQualityScore: 0.9,
        allowLiveExecution: false,
      },
      maxPositionSize: 4,
      maxDailyExposure: 40,
      allowedStrategies: ['trend-momentum'],
      allowedTimeframes: ['5m'],
      allowedAssets: null,
      // Null: no instrument-specific limits, which is what every account had
      // before per-instrument limits existed.
      perInstrument: null,
    });

    const updated = await repositories.accounts.findById(account.id);
    expect(updated?.policyVersion).toBe(2);
    expect(updated?.riskLimits.maxRiskLevel).toBe('low');
    expect(updated?.riskLimits.allowedRegimes).toEqual(['trend_up']);
    expect(updated?.maxPositionSize).toBe(4);
    expect(updated?.allowedStrategies).toEqual(['trend-momentum']);
    // Null stays null (unrestricted); it must not become an empty array.
    expect(updated?.allowedAssets).toBeNull();
  });

  it('refuses a negative balance', async () => {
    const user = await makeUser();
    await expect(repositories.accounts.create({ userId: user.id, balance: -1 })).rejects.toThrow();
  });
});
