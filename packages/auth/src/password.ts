import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id at the OWASP-recommended parameters. The choice matters: a fast
 * hash (SHA-256, a single PBKDF2 round) is a liability rather than a
 * protection, because an attacker with the digests can try billions of
 * candidates per second. Argon2id is deliberately expensive in BOTH time and
 * memory, which is what defeats GPU and ASIC attacks.
 *
 * The parameters are recorded inside every digest, so raising them later does
 * not invalidate existing passwords -- `needsRehash` detects the older ones and
 * the login flow upgrades them transparently.
 */

/**
 * OWASP Password Storage Cheat Sheet, Argon2id: m=19456 KiB (19 MiB), t=2,
 * p=1. Do not lower these to speed up tests; use a smaller fixture set instead.
 */
export const ARGON2_PARAMETERS = {
  // Argon2id. The library exports this as an ambient const enum, which cannot
  // be imported under verbatimModuleSyntax, so the value is pinned here rather
  // than left to the library default -- and password.test.ts asserts the
  // resulting digest really is $argon2id$, which catches any drift.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Rejection reasons from {@link validatePasswordStrength}. */
export type PasswordWeakness =
  'too_short' | 'too_long' | 'no_variety' | 'common' | 'contains_email';

export interface PasswordCheck {
  readonly ok: boolean;
  readonly problems: readonly PasswordWeakness[];
  readonly message: string | null;
}

/** Minimum length. Length beats character-class rules for real-world strength. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Argon2 has no practical input limit, but an unbounded password is a denial-
 * of-service vector: hashing a 10 MB string is expensive by design.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * A deliberately short list of passwords that clear the length rule but are in
 * every breach corpus. This is NOT a substitute for a real breach-corpus check
 * (k-anonymity against Have I Been Pwned); it catches the obvious cases without
 * making an outbound network call during registration.
 */
const COMMON_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'administrator',
  'letmeinplease',
  'iloveyou1234',
  'welcome12345',
  'binaryaidemo',
  'trustno1trustno1',
]);

/**
 * Checks a password before it is hashed.
 *
 * Length-first, per current NIST guidance: long passphrases beat short strings
 * padded with symbols to satisfy a rule. The variety check only applies to
 * shorter passwords, so a genuinely long passphrase is not penalised for being
 * all lowercase.
 */
export function validatePasswordStrength(password: string, email?: string): PasswordCheck {
  const problems: PasswordWeakness[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) problems.push('too_short');
  if (password.length > MAX_PASSWORD_LENGTH) problems.push('too_long');

  const normalized = password.toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) problems.push('common');

  // A password built from the email is trivially guessable by anyone who knows
  // the account exists -- and the login form tells them that.
  if (email !== undefined) {
    const localPart = email.split('@')[0]?.toLowerCase() ?? '';
    if (localPart.length >= 3 && normalized.includes(localPart)) problems.push('contains_email');
  }

  // Only enforced below 16 characters; above that, length carries the entropy.
  if (password.length < 16 && password.length >= MIN_PASSWORD_LENGTH) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
      re.test(password),
    ).length;
    if (classes < 3) problems.push('no_variety');
  }

  return {
    ok: problems.length === 0,
    problems,
    message: problems.length === 0 ? null : describe(problems),
  };
}

function describe(problems: readonly PasswordWeakness[]): string {
  const parts = problems.map((problem) => {
    switch (problem) {
      case 'too_short':
        return `it must be at least ${MIN_PASSWORD_LENGTH} characters`;
      case 'too_long':
        return `it must be at most ${MAX_PASSWORD_LENGTH} characters`;
      case 'no_variety':
        return 'a password under 16 characters needs at least three of: lowercase, uppercase, digits, symbols';
      case 'common':
        return 'it is a commonly used password';
      case 'contains_email':
        return 'it must not contain your email address';
    }
  });
  return `Password rejected: ${parts.join('; ')}.`;
}

/** Hashes a password. The plaintext is never logged, stored or returned. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMETERS);
}

/**
 * Verifies a password against a stored digest.
 *
 * Returns false rather than throwing on a malformed digest: a corrupt row must
 * fail the login, not crash the endpoint and reveal that the row is unusual.
 */
export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, ARGON2_PARAMETERS);
  } catch {
    return false;
  }
}

/**
 * True when a digest was produced with weaker parameters than current policy.
 *
 * Called after a SUCCESSFUL login, when the plaintext is briefly available and
 * can be re-hashed at the current cost without asking the user to do anything.
 */
export function needsRehash(digest: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(digest);
  if (!match) return true; // Not Argon2id at all: definitely upgrade.

  const memory = Number(match[1]);
  const time = Number(match[2]);
  const parallelism = Number(match[3]);
  return (
    memory < ARGON2_PARAMETERS.memoryCost ||
    time < ARGON2_PARAMETERS.timeCost ||
    parallelism < ARGON2_PARAMETERS.parallelism
  );
}
