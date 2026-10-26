import type { OAuthIntent } from '@better-tracker/engine';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { holdsLinearCredential } from './key-text';

// Redirects and the OAuth state's contents for the auth routes
// (architecture §8.1 Security). The cookies themselves (their names per
// mode and scheme, reading and writing them) live in lib/session-cookies.ts
// alone; this file holds what goes into them and where a sign-in lands:
//
// - the OAuth state cookie carries {state, codeVerifier, intent, returnTo,
//   expectWorkspaceId?} between GET /api/auth/linear and the callback,
//   HMAC-signed with SESSION_SECRET (lib/signed-cookie.ts) and valid for 10
//   minutes; install and grant_write name the workspace they were started
//   for (owner decision 2026-10-25: a browser holds several);
// - `returnTo` is sanitised at every hop (sanitizeReturnTo).
//
// Everything here is pure (or takes its inputs explicitly) so the returnTo
// rules are unit-tested without Next.

export { isSecureUrl } from './session-cookies';

/** Where a sign-in lands when no (valid) returnTo was given. */
export const DEFAULT_RETURN_TO = '/week';

const PROBE_ORIGIN = 'https://planner.invalid';

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
 * "/\t/x" into "//x"), nothing that resolves to another origin or whose
 * normalised path starts with "//" (dot segments: "/.//x", "/%2e//x" and
 * "/a/..//x" all normalise to "//x", which Next's client router hard-
 * navigates to after a page-level redirect(), leaving the site), and
 * nothing that holds a Linear credential, even percent-encoded (every
 * caller copies the result into a redirect's Location, and no URL the
 * planner answers carries a key, architecture §8.1 "No key in a URL").
 * The result is the normalised path, query and hash, never the raw
 * value, so what a caller redirects to is exactly what was checked.
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
  if (holdsLinearCredential(value)) return fallback;
  let normalised: string;
  try {
    const url = new URL(encodeNonAscii(value), PROBE_ORIGIN);
    // The URL parser turns "\" into "/" for http(s), so this also covers
    // "/./\x".
    if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith('//')) {
      return fallback;
    }
    normalised = `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
  if (normalised.length > 2048 || holdsLinearCredential(normalised)) {
    return fallback;
  }
  return normalised;
}

const INTENTS: readonly OAuthIntent[] = [
  'signin',
  'install',
  'grant_write',
  'add_workspace',
];

/** The intent query parameter: absent means sign in; unknown is null. */
export function parseIntent(value: string | null): OAuthIntent | null {
  if (value === null || value === '') return 'signin';
  return INTENTS.find((intent) => intent === value) ?? null;
}

/** An org id as the engine stores it (never shown; at most 100 chars). */
const WORKSPACE_ID = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

const oauthPayloadSchema = z
  .object({
    state: z.string().min(1),
    codeVerifier: z.string().min(1),
    intent: z.enum(['signin', 'install', 'grant_write', 'add_workspace']),
    returnTo: z.string(),
    /**
     * install and grant_write: the workspace of the session that started
     * them (the active one then), so a switch in another tab during the
     * consent screen cannot change which workspace they act for.
     */
    expectWorkspaceId: WORKSPACE_ID.optional(),
  })
  .refine(
    (payload) =>
      (payload.intent !== 'install' && payload.intent !== 'grant_write') ||
      payload.expectWorkspaceId !== undefined,
    { message: 'install and grant_write name their workspace' }
  );

export type OAuthCookiePayload = z.infer<typeof oauthPayloadSchema>;

/**
 * The verified OAuth state payload, or null when it is missing, expired,
 * tampered (verifyValue already returned null) or not the expected shape
 * (an install or write grant without its workspace included). returnTo is
 * sanitised again: defence in depth for a value we signed.
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
 * SESSION_SECRET signs the OAuth state cookie (and the sign-out notice's
 * workspace name). Real mode requires one of at least
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

/** Where a sign-in or add_workspace that came back with a workspace the
    browser already holds lands (/week's notice says what happened). */
export const CONNECT_SAME_LOCATION = '/week?connect=same';

/** "/?auth_error=<code>": where every failed sign-in lands. */
export function authErrorLocation(code: string): string {
  return `/?auth_error=${encodeURIComponent(code)}`;
}

/** What a `workspace` value can be (an org id); anything else is dropped. */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * "/?auth_error=workspace_changed": an install or write grant started
 * from a tab that shows another workspace than this browser's active one
 * (it switched in another tab). The tab's workspace id (an org id, else
 * dropped) lets the landing name it from the browser's own sessions and
 * offer the switch back; `returnTo` (sanitised) is where that switch
 * lands, the page the tab showed.
 */
export function workspaceChangedLocation(
  tabWorkspaceId: string,
  returnTo: string
): string {
  const params = new URLSearchParams({ auth_error: 'workspace_changed' });
  if (WORKSPACE_ID_PATTERN.test(tabWorkspaceId)) {
    params.set('workspace', tabWorkspaceId);
  }
  const safe = sanitizeReturnTo(returnTo, DEFAULT_RETURN_TO);
  if (safe !== DEFAULT_RETURN_TO) params.set('returnTo', safe);
  return `/?${params.toString()}`;
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

/** The page that adds another workspace (OAuth mode, owner decision
    2026-10-25): the menu, the palette, the interstitial and the landing
    link here, carrying a sanitized returnTo when one is given. */
export const CONNECT_PATH = '/setup/connect';

/** /setup/connect, with ?returnTo= for a page other than My week. */
export function connectHref(returnTo?: string): string {
  const safe = sanitizeReturnTo(returnTo, DEFAULT_RETURN_TO);
  return safe === DEFAULT_RETURN_TO
    ? CONNECT_PATH
    : `${CONNECT_PATH}?returnTo=${encodeURIComponent(safe)}`;
}

/** The connect page's "Continue to Linear" link (intent=add_workspace). */
export function addWorkspaceHref(returnTo?: string): string {
  const safe = sanitizeReturnTo(returnTo, DEFAULT_RETURN_TO);
  return safe === DEFAULT_RETURN_TO
    ? '/api/auth/linear?intent=add_workspace'
    : `/api/auth/linear?intent=add_workspace&returnTo=${encodeURIComponent(safe)}`;
}
