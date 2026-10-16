import type { Timeframe } from './market.js';
import type { RiskLimits } from './risk.js';
import type { InstrumentRiskLimits } from './paper.js';
/**
 * Identity, sessions and access scope.
 *
 * Phase 3 turns a single-tenant instance into a multi-user one. Three ideas
 * carry the whole design:
 *
 *  1. A **user** is who you are. A **session** is a revocable proof of that,
 *     held server-side. A **principal** is the resolved identity a request
 *     actually carries -- which may be a user, a machine, or nobody.
 *  2. A password hash NEVER appears on `User`. The digest exists only inside
 *     the repository layer, so no route can accidentally serialize it.
 *  3. Scope is a value, not a convention. Every ownership-sensitive query takes
 *     an `AccessScope`, which makes "I forgot to filter by user" a type error
 *     rather than a data leak.
 */

export type UserRole = 'user' | 'admin';

/**
 * A user as the application sees them. Deliberately free of credential
 * material: this shape is safe to serialize into an API response.
 */
export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
}

/**
 * A user plus the stored credential digest.
 *
 * Only the authentication flow may hold this, and it must never be returned
 * from a route. It is a separate type precisely so that returning it by
 * accident does not typecheck against `User`.
 */
export interface UserWithCredentials extends User {
  readonly passwordHash: string;
  /** Consecutive failed logins; drives lockout. */
  readonly failedLogins: number;
  /** Epoch ms. Login is refused while in the future. */
  readonly lockedUntil: number | null;
}

// -------------------------------------------------------------- sessions --

/**
 * A server-side session record.
 *
 * `tokenHash` is the SHA-256 of the token handed to the client; the raw token
 * is never stored. A database leak therefore yields no usable sessions, which
 * is the same reason passwords are hashed.
 */
export interface Session {
  readonly id: string;
  readonly userId: string;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

/**
 * The result of creating a session. The raw token appears here exactly once,
 * on its way to a Set-Cookie header, and is never persisted or logged.
 */
export interface IssuedSession {
  readonly session: Session;
  readonly token: string;
}

/** Why a session lookup did not produce a principal. */
export type SessionRejection = 'not_found' | 'expired' | 'revoked' | 'user_inactive';

export type SessionResolution =
  | { readonly ok: true; readonly session: Session; readonly user: User }
  | { readonly ok: false; readonly reason: SessionRejection };

// ------------------------------------------------------------ principals --

/**
 * Who a request is acting as.
 *
 * `service` is the pre-existing shared API key: a machine identity with no
 * user behind it. It is kept because self-hosted deployments and CI depend on
 * it, but it owns nothing, so user-scoped routes reject it rather than
 * silently returning another user's rows.
 */
export type Principal =
  | {
      readonly kind: 'user';
      readonly user: User;
      readonly sessionId: string;
      /** The user's default account; the owner recorded on anything they create. */
      readonly accountId: string | null;
    }
  | { readonly kind: 'service'; readonly label: string }
  | { readonly kind: 'anonymous' };

// ---------------------------------------------------------------- scope --

/**
 * The ownership filter applied to a query.
 *
 *  - `system`   -- unowned rows only (the shared analysis stream).
 *  - `account`  -- one account's rows, plus the shared stream when
 *                  `includeSystem` is set. This is what a logged-in user gets.
 *  - `all`      -- no filter. Admin and internal workers only.
 *
 * There is no default. A repository that takes a scope requires one, so the
 * decision is always made explicitly at the call site.
 */
export type AccessScope =
  | { readonly kind: 'system' }
  | { readonly kind: 'account'; readonly accountId: string; readonly includeSystem: boolean }
  | { readonly kind: 'all' };

// -------------------------------------------------------------- accounts --

/**
 * A user's demo account: the owner recorded on anything they create.
 *
 * `mode` is the literal 'demo' and the database enforces it with a CHECK. This
 * build has no broker integration and cannot hold a live account -- see
 * docs/risk-management.md.
 */
export interface Account {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly mode: 'demo';
  readonly currency: string;
  readonly balance: number;
  readonly dayStartBalance: number;
  readonly openExposure: number;
  readonly consecutiveLosses: number;
  readonly lastLossAt: number | null;
  readonly isDefault: boolean;
  /**
   * Per-account risk ceilings, overlaid on the engine defaults.
   *
   * Typed as `Partial<RiskLimits>` rather than `Record<string, number>`:
   * `maxRiskLevel` is a string, `allowedRegimes` an array and
   * `allowLiveExecution` a boolean, none of which the numeric map could hold.
   * That mismatch is why the column was stored but never read before Phase 5.
   */
  readonly riskLimits: Partial<RiskLimits>;
  /** Account-action policy. See AccountRiskPolicy. */
  readonly policyVersion: number;
  readonly policyUpdatedAt: number;
  readonly maxPositionSize: number;
  readonly maxDailyExposure: number;
  /** NULL = unrestricted. Empty array = allow none. Not interchangeable. */
  readonly allowedStrategies: readonly string[] | null;
  readonly allowedTimeframes: readonly Timeframe[] | null;
  readonly allowedAssets: readonly string[] | null;
  /**
   * OPTIONAL per-instrument limits, keyed by canonical catalogue symbol.
   *
   * NULL means no instrument-specific restriction — exactly the behaviour
   * every account had before this existed. Account limits remain the ceiling.
   */
  readonly perInstrument: Readonly<Record<string, InstrumentRiskLimits>> | null;
  /** Paper accounting units. Not currency and not money held by BinaryAI. */
  readonly allocatedUnits: number;
  /**
   * The account holder's OPTIONAL payout assumption. Disabled by default, in
   * which case settlement moves no units. BinaryAI asserts no rate; this is
   * the user's own premise. See AccountSimulationPayout.
   */
  /**
   * The server-defined simulation model this account has selected.
   *
   * NULL means no simulation, which is a real state and not a missing one: the
   * account keeps exposure-only accounting and has no simulated value at all.
   * Rendering that as a zero would state a result the account does not have.
   */
  readonly simulationModelId: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
}
