/**
 * Values shared by server and client code.
 *
 * This module exists to stay on the RIGHT side of the server/client boundary.
 * `lib/api.ts` imports `next/headers` to forward the session cookie, which
 * makes it server-only; a client component importing anything from it would
 * drag `next/headers` into the browser bundle and fail the build. These two
 * constants are needed on both sides, so they live somewhere with no
 * server-only imports at all.
 */

/**
 * Note the hostname: `localhost`, matching the dashboard's own origin.
 *
 * This is not cosmetic. Cookies are keyed by HOST and ignore the port, so
 * `localhost:3000` and `localhost:4000` share a cookie jar while
 * `127.0.0.1:4000` does not -- the browser treats it as a different host and a
 * different site. Pointing this at 127.0.0.1 would store the session cookie
 * somewhere the dashboard can never read it, and SameSite=Lax would block it
 * on cross-site requests: sign-in would appear to succeed and then do nothing.
 */
export const apiBaseUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

/**
 * Must match AUTH_COOKIE_NAME on the API. The cookie's NAME, not its value, so
 * a public env var is the right home for it.
 */
export const SESSION_COOKIE = process.env['NEXT_PUBLIC_SESSION_COOKIE'] ?? 'binaryai_session';
