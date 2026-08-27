import {
  hashPassword,
  hashSessionToken,
  isLocked,
  isValidEmail,
  lockRemainingSeconds,
  lockUntil,
  mintSessionToken,
  needsRehash,
  normalizeEmail,
  resolveSession,
  shouldTouch,
  timingSafeEqual,
  validatePasswordStrength,
  verifyPassword,
} from '@binaryai/auth';
import type { AppConfig } from '@binaryai/config';
import type {
  Account,
  IssuedSession,
  Principal,
  Repositories,
  Session,
  User,
} from '@binaryai/types';

/**
 * The authentication service.
 *
 * All identity decisions live here, so the routes stay thin and the rules can
 * be tested without HTTP. Three properties are deliberate and worth stating,
 * because each is easy to lose in a later refactor:
 *
 *  1. **Failures are values, not exceptions.** Login returns a discriminated
 *     result. An exception would tempt a caller into a `catch` that reports the
 *     wrong reason, and reasons here are security-relevant.
 *  2. **Login is constant-shape.** A missing user costs the same work and
 *     returns the same message as a wrong password, so the endpoint cannot be
 *     used to discover which email addresses have accounts.
 *  3. **Sessions are always new.** Logging in never reuses a session id, which
 *     removes session fixation as a class of attack.
 */

export type LoginFailure =
  | { readonly kind: 'invalid_credentials' }
  | { readonly kind: 'account_disabled' }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number };

export type LoginResult =
  | { readonly ok: true; readonly user: User; readonly issued: IssuedSession }
  | { readonly ok: false; readonly failure: LoginFailure };

export type RegisterFailure =
  | { readonly kind: 'registration_closed' }
  | { readonly kind: 'invalid_email' }
  | { readonly kind: 'weak_password'; readonly message: string }
  | { readonly kind: 'email_taken' };

export type RegisterResult =
  | {
      readonly ok: true;
      readonly user: User;
      readonly account: Account;
      readonly issued: IssuedSession;
    }
  | { readonly ok: false; readonly failure: RegisterFailure };

export interface RequestOrigin {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface RegisterInput extends RequestOrigin {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string | null;
}

export interface LoginInput extends RequestOrigin {
  readonly email: string;
  readonly password: string;
}

export interface ChangePasswordInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export type ChangePasswordResult =
  | { readonly ok: true; readonly sessionsRevoked: number }
  | {
      readonly ok: false;
      readonly reason: 'invalid_credentials' | 'weak_password';
      readonly message: string;
    };

/** A credential presented by a request. */
export type Credential =
  | { readonly kind: 'session'; readonly token: string }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'none' };

export interface AuthService {
  register(input: RegisterInput): Promise<RegisterResult>;
  login(input: LoginInput): Promise<LoginResult>;
  logout(sessionId: string): Promise<void>;
  logoutEverywhere(userId: string): Promise<number>;
  /** Resolves a raw credential to a principal. Never throws on a bad token. */
  resolve(credential: Credential): Promise<Principal>;
  listSessions(userId: string): Promise<readonly Session[]>;
  changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult>;
  /** True while the instance has no users and bootstrap is permitted. */
  isBootstrapOpen(): Promise<boolean>;
}

export interface AuthServiceDeps {
  readonly repositories: Repositories;
  readonly config: AppConfig;
  readonly now?: () => number;
}

const ANONYMOUS: Principal = { kind: 'anonymous' };

/**
 * Paper units allocated to a new account.
 *
 * Duplicated from paper-service rather than imported to keep the auth service
 * free of a dependency on the paper domain; the value is asserted equal in
 * tests so the two cannot drift.
 */
const PAPER_ALLOCATION = 100;

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { repositories, config, now = Date.now } = deps;
  const ttlMs = config.auth.session.ttlMs;

  /**
   * Records a security-relevant event.
   *
   * Two rules, both load-bearing:
   *
   * 1. **Nothing secret reaches this function.** No password, no session token,
   *    no Argon2 digest, no authorization header. An audit trail that carries
   *    credentials is a second copy of the thing it was meant to protect, and
   *    it is usually the copy with the weakest access controls. Callers pass
   *    IDs — which are not secrets — and reasons.
   *
   *    The attacker-submitted email on a failed login is deliberately NOT
   *    recorded either. It is an arbitrary string from an unauthenticated
   *    caller: it may be some third party's real address typed by mistake, and
   *    storing it turns the audit table into a place where unvalidated input
   *    accumulates. `userId` is recorded when the account exists, which answers
   *    the same operational question — who is being attacked — without that.
   *
   * 2. **A failure to record never fails the request.** Auditing is
   *    observability, not authorisation. If it threw, an unreachable database
   *    would stop people logging OUT, which is the opposite of safe.
   */
  async function audit(
    level: 'info' | 'warning',
    code: string,
    message: string,
    context: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    try {
      await repositories.systemEvents.record({
        level,
        category: 'auth',
        code,
        message,
        executionMode: 'demo',
        context,
      });
    } catch {
      // Deliberately swallowed. See rule 2 above.
    }
  }

  /**
   * A throwaway digest used to equalize timing when no user matches.
   *
   * Without it, "no such user" returns in microseconds while a real user costs
   * a full Argon2 verification -- a difference an attacker can measure to
   * enumerate accounts. Computed once, lazily, so startup is not delayed.
   */
  let decoyDigest: Promise<string> | null = null;
  const decoy = (): Promise<string> => {
    decoyDigest ??= hashPassword(mintSessionToken());
    return decoyDigest;
  };

  async function issueSession(userId: string, origin: RequestOrigin): Promise<IssuedSession> {
    const token = mintSessionToken();
    const session = await repositories.sessions.create({
      userId,
      // Only the digest is stored; `token` is returned once and then lives
      // exclusively in the client's cookie.
      tokenHash: hashSessionToken(token),
      expiresAt: now() + ttlMs,
      userAgent: origin.userAgent ?? null,
      ipAddress: origin.ipAddress ?? null,
    });
    return { session, token };
  }

  async function bootstrapOpen(): Promise<boolean> {
    if (!config.auth.bootstrapAdmin) return false;
    return (await repositories.users.count()) === 0;
  }

  return {
    isBootstrapOpen: bootstrapOpen,

    async register(input: RegisterInput): Promise<RegisterResult> {
      const isFirstUser = await bootstrapOpen();
      // Open signup stays closed unless configured. The single exception is the
      // very first account on an empty instance, which is what makes a fresh
      // deployment reachable without editing the database by hand.
      if (!config.auth.allowRegistration && !isFirstUser) {
        return { ok: false, failure: { kind: 'registration_closed' } };
      }

      const email = normalizeEmail(input.email);
      if (!isValidEmail(email)) {
        return { ok: false, failure: { kind: 'invalid_email' } };
      }

      const strength = validatePasswordStrength(input.password, email);
      if (!strength.ok) {
        return {
          ok: false,
          failure: { kind: 'weak_password', message: strength.message ?? 'Password rejected.' },
        };
      }

      const passwordHash = await hashPassword(input.password);

      try {
        // User, account and session in one transaction: a user without an
        // account would own nothing and could never be attributed a signal.
        const created = await repositories.transaction(async (tx) => {
          const user = await tx.users.create({
            email,
            passwordHash,
            displayName: input.displayName ?? null,
            // The first account administers the instance. Everyone after is a
            // plain user until an admin says otherwise.
            role: isFirstUser ? 'admin' : 'user',
          });
          const account = await tx.accounts.create({
            userId: user.id,
            name: 'Paper account',
            isDefault: true,
          });
          // Allocate paper units in the same transaction. An account with no
          // allocation has no accounting model and could not open a position,
          // so a user would register successfully into an unusable state.
          await tx.accounts.allocateUnits(account.id, PAPER_ALLOCATION, 'account_created');
          await tx.systemEvents.record({
            level: 'info',
            category: 'auth',
            code: 'user_registered',
            message: `User registered (${user.role})`,
            executionMode: 'demo',
            // The email is an identifier, not a secret, but the password and
            // its digest never appear in an event.
            context: { userId: user.id, accountId: account.id, bootstrap: isFirstUser },
          });
          return { user, account };
        });

        const issued = await issueSession(created.user.id, input);
        return { ok: true, user: created.user, account: created.account, issued };
      } catch (error) {
        // The unique index on email is the authority. Checking first and then
        // inserting would leave a race in which two requests both pass the
        // check; letting the constraint decide cannot.
        if (isUniqueViolation(error)) {
          return { ok: false, failure: { kind: 'email_taken' } };
        }
        throw error;
      }
    },

    async login(input: LoginInput): Promise<LoginResult> {
      const at = now();
      const email = normalizeEmail(input.email);
      const record = await repositories.users.findByEmailWithCredentials(email);

      if (!record) {
        // Verify against a decoy so an unknown address costs the same as a
        // known one. The result is discarded; only the elapsed time matters.
        await verifyPassword(await decoy(), input.password);
        await audit('warning', 'login_failed', 'Login failed', {
          reason: 'unknown_account',
          userId: null,
        });
        return { ok: false, failure: { kind: 'invalid_credentials' } };
      }

      if (isLocked(record.lockedUntil, at)) {
        await audit('warning', 'login_blocked', 'Login refused: account is locked', {
          reason: 'locked',
          userId: record.id,
        });
        return {
          ok: false,
          failure: {
            kind: 'locked',
            retryAfterSeconds: lockRemainingSeconds(record.lockedUntil, at),
          },
        };
      }

      const passwordOk = await verifyPassword(record.passwordHash, input.password);

      if (!passwordOk) {
        const failures = await repositories.users.recordLoginFailure(record.id, at, null);
        const until = lockUntil(failures, at);
        if (until !== null) {
          await repositories.users.recordLoginFailure(record.id, at, until);
          await audit('warning', 'account_locked', 'Account locked after repeated failures', {
            userId: record.id,
            failures,
          });
        }
        await audit('warning', 'login_failed', 'Login failed', {
          reason: 'bad_password',
          userId: record.id,
          failures,
        });
        return { ok: false, failure: { kind: 'invalid_credentials' } };
      }

      // Checked AFTER the password, deliberately: telling an unauthenticated
      // caller that an account is disabled would confirm the account exists.
      if (!record.isActive) {
        await audit('warning', 'login_blocked', 'Login refused: account is disabled', {
          reason: 'disabled',
          userId: record.id,
        });
        return { ok: false, failure: { kind: 'account_disabled' } };
      }

      // The plaintext is available exactly here, so this is the only moment a
      // digest can be upgraded without troubling the user.
      if (needsRehash(record.passwordHash)) {
        await repositories.users.setPasswordHash(record.id, await hashPassword(input.password));
      }

      await repositories.users.recordLoginSuccess(record.id, at);
      const issued = await issueSession(record.id, input);
      await audit('info', 'login_succeeded', 'Login succeeded', { userId: record.id });

      // Rebuilt field by field rather than spread-and-delete, so adding a
      // credential column to UserWithCredentials cannot silently start
      // returning it from the login endpoint.
      const user: User = {
        id: record.id,
        email: record.email,
        displayName: record.displayName,
        role: record.role,
        isActive: record.isActive,
        createdAt: record.createdAt,
        lastLoginAt: at,
      };
      return { ok: true, user, issued };
    },

    async logout(sessionId: string): Promise<void> {
      await repositories.sessions.revoke(sessionId, now());
      // The session ID is a database row identifier, not the token. The token
      // itself is never stored (only its digest is) and never logged.
      await audit('info', 'session_revoked', 'Session revoked by logout', { sessionId });
    },

    async logoutEverywhere(userId: string): Promise<number> {
      const revoked = await repositories.sessions.revokeAllForUser(userId, now());
      await audit('info', 'sessions_revoked_all', 'All sessions revoked', { userId, revoked });
      return revoked;
    },

    async resolve(credential: Credential): Promise<Principal> {
      if (credential.kind === 'none') return ANONYMOUS;

      if (credential.kind === 'bearer') {
        const expected = config.auth.apiKey;
        if (!expected || !timingSafeEqual(credential.token, expected)) return ANONYMOUS;
        return { kind: 'service', label: 'api_key' };
      }

      const at = now();
      const session = await repositories.sessions.findByTokenHash(
        hashSessionToken(credential.token),
      );
      const user = session ? await repositories.users.findById(session.userId) : null;
      const resolution = resolveSession(session, user, at);
      if (!resolution.ok) return ANONYMOUS;

      // Written at most once per touch interval, so an active session does not
      // turn every read into a write.
      if (shouldTouch(resolution.session, at)) {
        await repositories.sessions.touch(resolution.session.id, at);
      }

      const account = await repositories.accounts.findDefaultForUser(resolution.user.id);
      return {
        kind: 'user',
        user: resolution.user,
        sessionId: resolution.session.id,
        accountId: account?.id ?? null,
      };
    },

    async listSessions(userId: string): Promise<readonly Session[]> {
      return repositories.sessions.listActiveForUser(userId, now());
    },

    async changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult> {
      const user = await repositories.users.findById(input.userId);
      if (!user) {
        return { ok: false, reason: 'invalid_credentials', message: 'Current password is wrong.' };
      }
      const record = await repositories.users.findByEmailWithCredentials(user.email);
      if (!record || !(await verifyPassword(record.passwordHash, input.currentPassword))) {
        // Worth recording: a wrong CURRENT password on an authenticated session
        // is a different signal from a failed login. It is what a hijacked
        // session looks like when someone tries to take the account over.
        await audit('warning', 'password_change_failed', 'Password change refused', {
          userId: user.id,
          reason: 'invalid_current_password',
        });
        return { ok: false, reason: 'invalid_credentials', message: 'Current password is wrong.' };
      }

      const strength = validatePasswordStrength(input.newPassword, user.email);
      if (!strength.ok) {
        return {
          ok: false,
          reason: 'weak_password',
          message: strength.message ?? 'Password rejected.',
        };
      }

      await repositories.users.setPasswordHash(user.id, await hashPassword(input.newPassword));
      // Every existing session dies with the old password. If the change was
      // prompted by a compromise, leaving other sessions alive would defeat
      // the point of changing it.
      const revoked = await repositories.sessions.revokeAllForUser(user.id, now());
      await audit('warning', 'password_changed', 'Password changed; all sessions revoked', {
        userId: user.id,
        sessionsRevoked: revoked,
      });
      return { ok: true, sessionsRevoked: revoked };
    },
  };
}

/** Recognises a unique-constraint violation without importing the driver. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : '';
  return /duplicate key|unique constraint/i.test(message);
}
