/**
 * @binaryai/auth -- identity primitives.
 *
 * Password hashing, session tokens, access scope and login throttling. Pure
 * policy: this package never touches a database, a request or process.env, so
 * every rule in it is testable in isolation and cannot drift between the API
 * and the workers that share it.
 */

export {
  ARGON2_PARAMETERS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  validatePasswordStrength,
  verifyPassword,
  type PasswordCheck,
  type PasswordWeakness,
} from './password.js';

export {
  DEFAULT_SESSION_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  hashSessionToken,
  mintSessionToken,
  resolveSession,
  shouldTouch,
  timingSafeEqual,
} from './session.js';

export { allScope, canRead, isAdmin, scopeForPrincipal } from './scope.js';

export {
  BASE_LOCK_MS,
  FAILURE_THRESHOLD,
  MAX_LOCK_MS,
  isLocked,
  lockRemainingSeconds,
  lockUntil,
} from './lockout.js';

export { MAX_EMAIL_LENGTH, isValidEmail, normalizeEmail } from './email.js';
