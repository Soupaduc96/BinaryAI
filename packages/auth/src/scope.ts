import type { AccessScope, Principal } from '@binaryai/types';

/**
 * Access scope: who may see which rows.
 *
 * BinaryAI has two kinds of data and they are governed differently.
 *
 *  - The **analysis stream** is a shared intelligence product. One runtime
 *    worker analyses public exchange candles and writes signals with no owner
 *    (`account_id IS NULL`). Every authenticated user reads the same stream.
 *    Duplicating identical analysis per user would multiply the work without
 *    changing a single output value.
 *  - **Account data** -- trades, balances, risk events, and any signal a user
 *    generated for themselves -- belongs to exactly one account and is private
 *    to it.
 *
 * This is why `signals.account_id` is nullable while `trades.account_id` is NOT
 * NULL: the schema encoded this distinction from the start. See
 * docs/adr/0011-ownership-model.md.
 */

/**
 * The scope a principal reads with.
 *
 * Note that an admin gets their OWN scope here, not a global one. Elevation is
 * deliberately not implicit: an admin route that needs every row asks for
 * {@link allScope} explicitly, so a broad read is always visible at the call
 * site rather than being a silent property of who is logged in.
 */
export function scopeForPrincipal(principal: Principal): AccessScope {
  if (principal.kind === 'user') {
    return principal.accountId === null
      ? { kind: 'system' }
      : { kind: 'account', accountId: principal.accountId, includeSystem: true };
  }
  // A service token authenticates a machine, not a person. It owns nothing, so
  // it sees the shared stream and never another user's rows.
  return { kind: 'system' };
}

/** Unrestricted scope. Callers must check `role === 'admin'` first. */
export function allScope(): AccessScope {
  return { kind: 'all' };
}

/**
 * Whether a scope permits reading one specific row.
 *
 * Used for single-record fetches, where there is no WHERE clause to rely on.
 * A `findById` that skips this check is the classic IDOR bug: a valid id from
 * another user returns their data.
 */
export function canRead(scope: AccessScope, ownerAccountId: string | null): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'system':
      return ownerAccountId === null;
    case 'account':
      if (ownerAccountId === null) return scope.includeSystem;
      return ownerAccountId === scope.accountId;
  }
}

/** True when the principal is an authenticated administrator. */
export function isAdmin(principal: Principal): boolean {
  return principal.kind === 'user' && principal.user.role === 'admin';
}
