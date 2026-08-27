import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  validatePasswordStrength,
  verifyPassword,
} from './password.js';

/**
 * Password hashing.
 *
 * These are slower than the rest of the suite by design -- Argon2 is supposed
 * to be expensive. Lowering the parameters to speed them up would test a
 * configuration that is not the one shipped, so the fixture count is kept small
 * instead.
 */

const GOOD_PASSWORD = 'correct-horse-battery-staple-7';

describe('hashPassword', () => {
  it('produces an Argon2id digest at the configured parameters', async () => {
    const digest = await hashPassword(GOOD_PASSWORD);

    // The single most important assertion in this file. The algorithm is
    // pinned numerically because the library exports it as an ambient const
    // enum; this proves the number still means what it should.
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(digest).toContain('m=19456,t=2,p=1');
  });

  it('never stores the password itself', async () => {
    const digest = await hashPassword(GOOD_PASSWORD);
    expect(digest).not.toContain(GOOD_PASSWORD);
  });

  it('salts every hash, so identical passwords differ on disk', async () => {
    const [first, second] = await Promise.all([
      hashPassword(GOOD_PASSWORD),
      hashPassword(GOOD_PASSWORD),
    ]);

    // Without per-hash salt, a leaked table would reveal which users share a
    // password, and one cracked digest would open all of them.
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(second, GOOD_PASSWORD)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const digest = await hashPassword(GOOD_PASSWORD);

    expect(await verifyPassword(digest, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(digest, 'correct-horse-battery-staple-8')).toBe(false);
    expect(await verifyPassword(digest, '')).toBe(false);
  });

  it('returns false rather than throwing on a corrupt digest', async () => {
    // A malformed row must fail the login quietly. Throwing would surface a
    // 500 and tell an attacker this particular account is unusual.
    expect(await verifyPassword('not-a-digest', GOOD_PASSWORD)).toBe(false);
    expect(await verifyPassword('', GOOD_PASSWORD)).toBe(false);
    expect(await verifyPassword('$argon2id$v=19$garbage', GOOD_PASSWORD)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('leaves a current digest alone', async () => {
    expect(needsRehash(await hashPassword(GOOD_PASSWORD))).toBe(false);
  });

  it('flags weaker parameters for upgrade', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=1,p=1$abc$def')).toBe(true);
  });

  it('flags anything that is not Argon2id', () => {
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
    expect(needsRehash('$argon2i$v=19$m=19456,t=2,p=1$abc$def')).toBe(true);
    expect(needsRehash('plaintext')).toBe(true);
  });
});

describe('validatePasswordStrength', () => {
  it('accepts a long passphrase even without symbols', () => {
    // Length carries the entropy above 16 characters; penalising an all-
    // lowercase passphrase would push users toward shorter, worse passwords.
    expect(validatePasswordStrength('the quick brown fox jumps').ok).toBe(true);
  });

  it('rejects anything under the minimum length', () => {
    const check = validatePasswordStrength('Sh0rt!');
    expect(check.ok).toBe(false);
    expect(check.problems).toContain('too_short');
    expect(check.message).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('requires variety only from shorter passwords', () => {
    expect(validatePasswordStrength('alllowercase').problems).toContain('no_variety');
    expect(validatePasswordStrength('Alllowercase1').ok).toBe(true);
  });

  it('rejects a password built from the email address', () => {
    const check = validatePasswordStrength('alice.trader2024', 'alice.trader@example.com');
    expect(check.ok).toBe(false);
    expect(check.problems).toContain('contains_email');
  });

  it('rejects well-known passwords that pass the length rule', () => {
    expect(validatePasswordStrength('passwordpassword').problems).toContain('common');
  });

  it('rejects an unbounded password', () => {
    // Not a strength question: hashing a multi-megabyte string is a cheap way
    // to make the server do expensive work.
    const check = validatePasswordStrength('a'.repeat(5000));
    expect(check.ok).toBe(false);
    expect(check.problems).toContain('too_long');
  });

  it('explains every problem it found', () => {
    const check = validatePasswordStrength('abc');
    expect(check.ok).toBe(false);
    expect(check.message).toBeTruthy();
  });
});
