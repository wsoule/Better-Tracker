import type { OAuthIntent } from '@better-tracker/engine';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Cookies and redirects for the auth routes (architecture §8.1 Security):
//
// - `mp_session` holds the opaque session token (the store keeps only its
//   SHA-256): httpOnly, SameSite=Lax, Path=/, Max-Age from the session's
//   expiry, Secure when the app is served over https.
// - `mp_oauth` carries {state, codeVerifier, intent, returnTo} between
//   GET /api/auth/linear and the callback, HMAC-signed with SESSION_SECRET
//   (lib/signed-cookie.ts) and valid for 10 minutes. It is scoped to
//   /api/auth so no page request ever carries it.
//
// Everything here is pure (or takes its inputs explicitly) so the cookie
// attributes and the returnTo rules are unit-tested without Next.

/** Cookie holding the session token (re-exported by lib/session.ts users). */
export const SESSION_COOKIE = 'mp_session';
/** Short-lived cookie carrying OAuth state between start and callback. */
export const OAUTH_COOKIE = 'mp_oauth';
/** The OAuth cookie's lifetime: long enough to approve in Linear. */
export const OAUTH_COOKIE_TTL_MS = 10 * 60 * 1000;
/** The OAuth cookie only travels to the auth routes. */
export const OAUTH_COOKIE_PATH = '/api/auth';

/** Where a sign-in lands when no (valid) returnTo was given. */
export const DEFAULT_RETURN_TO = '/week';

const COOKIE_VALUE = /^[A-Za-z0-9._~-]*$/;
const PROBE_ORIGIN = 'https://planner.invalid';

/** True when cookies for this public URL must carry `Secure`. */
export function isSecureUrl(appUrl: string): boolean {
  try {
    return new URL(appUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CookieOptions {
  path: string;
  /** Seconds; 0 clears the cookie. Negative values are treated as 0. */
  maxAge: number;
  secure: boolean;
}

/**
 * One Set-Cookie header value. Every cookie this app sets is httpOnly and
 * SameSite=Lax (sent on top-level navigations such as the OAuth redirect
 * back from Linear, never on cross-site subrequests). Values are restricted
 * to URL-safe characters, which is what tokens and signed values use, so
 * nothing needs escaping.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions
): string {
  if (!COOKIE_VALUE.test(value)) {
    throw new Error(`Cookie ${name} has characters that need escaping.`);
  }
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** mp_session for a new session, expiring with it. */
export function sessionCookie(
  token: string,
  expiresAt: string,
  options: { secure: boolean; nowMs: number }
): string {
  const expiresMs = Date.parse(expiresAt);
  const maxAge = Number.isNaN(expiresMs)
    ? 0
    : (expiresMs - options.nowMs) / 1000;
  return serializeCookie(SESSION_COOKIE, token, {
    path: '/',
    maxAge,
    secure: options.secure,
  });
}

/** Expires mp_session (sign out). */
export function clearSessionCookie(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, '', { path: '/', maxAge: 0, secure });
}

/** mp_oauth with the signed state value, valid for 10 minutes. */
export function oauthCookie(signedValue: string, secure: boolean): string {
  return serializeCookie(OAUTH_COOKIE, signedValue, {
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_TTL_MS / 1000,
    secure,
  });
}

/** Expires mp_oauth; the callback sends this on every outcome. */
export function clearOauthCookie(secure: boolean): string {
  return serializeCookie(OAUTH_COOKIE, '', {
    path: OAUTH_COOKIE_PATH,
    maxAge: 0,
    secure,
  });
}

/** Reads one cookie from a request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null || header === '') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Control characters, spaces and DEL: URL parsers strip or fold them, so
 * "/\t/evil.example" becomes "//evil.example" in a browser.
 */
function hasUnsafeChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Percent-encodes every non-ASCII character (UTF-8), leaving ASCII as it
 * is. A Location header must be a byte string: "/timeline?q=週" would make
 * `new Headers()` throw after the sign-in already succeeded. Only
 * non-ASCII text changes, so the path's structure ("/", "?", "#", "%XX")
 * stays exactly what was checked. Throws URIError on a lone surrogate.
 */
function encodeNonAscii(value: string): string {
  let out = '';
  // for…of walks code points, so an emoji is encoded as one character.
  for (const char of value) {
    out += char.charCodeAt(0) > 0x7f ? encodeURIComponent(char) : char;
  }
  return out;
}

/**
 * The path a sign-in may return to. Only same-site relative paths pass:
 * one leading "/", never "//" or "/\" (protocol-relative URLs to another
 * host), no control characters or spaces (which browsers strip, turning
 * "/\t/x" into "//x"), and nothing that resolves to another origin.
 * Non-ASCII characters come back percent-encoded, so the result is always
 * a valid header value. Anything else falls back to `fallback`.
 */
export function sanitizeReturnTo(
  value: string | null | undefined,
  fallback: string = DEFAULT_RETURN_TO
): string {
  if (typeof value !== 'string' || value === '' || value.length > 2048) {
    return fallback;
  }
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (hasUnsafeChar(value)) return fallback;
  let encoded: string;
  try {
    encoded = encodeNonAscii(value);
    if (new URL(encoded, PROBE_ORIGIN).origin !== PROBE_ORIGIN) {
      return fallback;
    }
  } catch {
    return fallback;
  }
  return encoded.length > 2048 ? fallback : encoded;
}

/** The intent query parameter: absent means sign in; unknown is null. */
export function parseIntent(value: string | null): OAuthIntent | null {
  if (value === null || value === '') return 'signin';
  return value === 'signin' || value === 'install' || value === 'grant_write'
    ? value
    : null;
}

const oauthPayloadSchema = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  intent: z.enum(['signin', 'install', 'grant_write']),
  returnTo: z.string(),
});

export type OAuthCookiePayload = z.infer<typeof oauthPayloadSchema>;

/**
 * The verified mp_oauth payload, or null when it is missing, expired,
 * tampered (verifyValue already returned null) or not the expected shape.
 * returnTo is sanitised again: defence in depth for a value we signed.
 */
export function parseOAuthPayload(
  record: Record<string, unknown> | null
): OAuthCookiePayload | null {
  if (record === null) return null;
  const parsed = oauthPayloadSchema.safeParse(record);
  if (!parsed.success) return null;
  return { ...parsed.data, returnTo: sanitizeReturnTo(parsed.data.returnTo) };
}

const SECRET_MIN_LENGTH = 32;

/**
 * SESSION_SECRET signs the OAuth cookie. Real mode requires one of at least
 * 32 characters and fails with an error saying how to set it; demo mode
 * (no OAuth) falls back to `fallback()`, a per-process random secret.
 */
export function resolveSessionSecret(
  env: Readonly<Record<string, string | undefined>>,
  demo: boolean,
  fallback: () => string
): string {
  const value = env.SESSION_SECRET ?? '';
  if (value.length >= SECRET_MIN_LENGTH) return value;
  if (demo) return fallback();
  throw new Error(
    value === ''
      ? 'SESSION_SECRET is not set. Set it to a random string of at least 32 characters (it signs the OAuth cookie), for example the output of `openssl rand -base64 32`.'
      : `SESSION_SECRET is ${value.length} characters long; it must be at least 32. Generate one with \`openssl rand -base64 32\`.`
  );
}

// The demo-mode fallback lives on globalThis so Next dev's module reloads
// keep using the same secret within one server process.
const holder = globalThis as typeof globalThis & {
  __milestonePlannerDemoSecret?: string;
};

/** The secret for this process (see resolveSessionSecret). */
export function sessionSecret(demo: boolean): string {
  return resolveSessionSecret(process.env, demo, () => {
    holder.__milestonePlannerDemoSecret ??=
      randomBytes(32).toString('base64url');
    return holder.__milestonePlannerDemoSecret;
  });
}

/**
 * A redirect that also sets cookies. `Response.redirect()` returns
 * immutable headers, so this builds the response by hand. 303 turns a form
 * POST into a GET of the target; for GET requests it behaves like 302.
 * Locations are relative paths (resolved by the browser against the URL
 * it requested), or Linear's absolute authorize URL.
 */
export function redirectWithCookies(
  location: string,
  cookies: readonly string[] = [],
  status: 302 | 303 = 303
): Response {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

/** "/?auth_error=<code>": where every failed sign-in lands. */
export function authErrorLocation(code: string): string {
  return `/?auth_error=${encodeURIComponent(code)}`;
}

/**
 * The landing page for a signed-out visitor of `returnTo` (a page's own
 * path and query, e.g. a digest's /timeline?milestone=… link): "/" with
 * ?returnTo=, which the sign-in button and the demo picker pass on, so
 * signing in lands on that page instead of My week. Unsafe or default
 * targets give a plain "/".
 */
export function signInLocation(returnTo?: string): string {
  const safe = sanitizeReturnTo(returnTo, DEFAULT_RETURN_TO);
  return safe === DEFAULT_RETURN_TO
    ? '/'
    : `/?returnTo=${encodeURIComponent(safe)}`;
}

/** The "Sign in with Linear" link, carrying a sanitized returnTo. */
export function signInHref(returnTo?: string): string {
  const safe = sanitizeReturnTo(returnTo, DEFAULT_RETURN_TO);
  return safe === DEFAULT_RETURN_TO
    ? '/api/auth/linear?intent=signin'
    : `/api/auth/linear?intent=signin&returnTo=${encodeURIComponent(safe)}`;
}
