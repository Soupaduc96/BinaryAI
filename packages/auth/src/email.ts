/**
 * Email handling for identity.
 *
 * Normalization exists so that `Alice@Example.com` and `alice@example.com`
 * cannot become two accounts. The domain is lowercased because DNS is
 * case-insensitive; the local part is lowercased too, which is technically
 * stricter than RFC 5321 (where it may be case-sensitive) but matches what
 * every mail provider does in practice and prevents confusable duplicates.
 *
 * Provider-specific tricks -- stripping dots, cutting at `+` -- are NOT applied.
 * Those rules are Gmail's, not the internet's, and applying them universally
 * would merge genuinely distinct addresses on other hosts.
 */

/** Deliberately permissive. Delivery is the real proof an address exists. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const MAX_EMAIL_LENGTH = 254; // RFC 5321 path limit.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}
