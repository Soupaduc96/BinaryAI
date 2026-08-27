import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import type { Session, SessionResolution, User } from '@binaryai/types';

/**
 * Opaque server-side sessions.
 *
 * A session token is 32 bytes of CSPRNG output -- an unguessable random string
 * with no structure and no meaning outside the sessions table. That is the
 * whole point of choosing this over a self-contained JWT:
 *
 *  - **Revocation is immediate.** Logging out, or an admin disabling an
 *    account, takes effect on the very next request. A stateless JWT stays
 *    valid until it expires, which is exactly the wrong behaviour after a
 *    credential is compromised.
 *  - **Nothing sensitive travels.** The token carries no claims, so there is no
 *    payload to decode, no signature algorithm to confuse, and no `alg: none`
 *    class of bug to be exposed to.
 *
 * The cost is a database read per request, which is a single indexed lookup on
 * a primary-key-sized column. See docs/adr/0010-opaque-server-sessions.md.
 */

/** 32 bytes = 256 bits of entropy. Guessing is not a viable attack. */
const TOKEN_BYTES = 32;

/** Default session lifetime. Overridable through config. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How stale an activity stamp may get before it is rewritten. Without this,
 * every authenticated request issues a write purely to move a timestamp.
 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Generates a new session token. Base64url so it is cookie-safe unencoded. */
export function mintSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The value stored in the database.
 *
 * Plain SHA-256, not a password hash, and deliberately so: the input is already
 * 256 bits of uniform randomness, so there is nothing to brute-force and no
 * benefit to a slow KDF. Hashing at all is what stops a leaked database from
 * handing over live sessions.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Decides whether a session grants access, and says why when it does not.
 *
 * Kept as a pure function so the rules are testable without a database, and so
 * every caller applies exactly the same ones.
 */
export function resolveSession(
  session: Session | null,
  user: User | null,
  now: number,
): SessionResolution {
  if (!session) return { ok: false, reason: 'not_found' };
  // Revocation is checked before expiry: a session revoked after it lapsed is
  // still most accurately described as revoked.
  if (session.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (session.expiresAt <= now) return { ok: false, reason: 'expired' };
  // A deactivated user's sessions stop working immediately, without needing a
  // sweep to go and revoke each one.
  if (!user || !user.isActive) return { ok: false, reason: 'user_inactive' };
  return { ok: true, session, user };
}

/** True when the activity stamp is stale enough to be worth a write. */
export function shouldTouch(session: Session, now: number): boolean {
  return now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS;
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first and leaks, which is acceptable: token length is a
 * fixed public constant. Content comparison takes the same time regardless of
 * where the first mismatch is, so a token cannot be recovered byte by byte.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}
