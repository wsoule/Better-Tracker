// The one place the planner chooses, reads and writes its auth cookies
// (architecture §8.1 "Session cookies"). Nothing else in the app names
// them: a test greps app/, lib/ and proxy.ts for the names and for
// readCookie() outside this file.
//
// Three cookies, named by the scheme (mode and http/https):
//
// - the active session: `__Host-mp_session` on an https APP_URL (Secure,
//   Path=/, no Domain, so a sibling subdomain cannot plant one), else
//   `mp_session`. It holds the opaque session token the store keeps only
//   the SHA-256 of. In OAuth and demo mode it expires with its session; in
//   api_key mode it has no Max-Age (a browser-session cookie, §7.4).
// - the stash (OAuth mode only, owner decision 2026-10-25): the browser's
//   other workspaces' session tokens, `.`-joined, most recently active
//   first, at most MAX_STASHED_SESSIONS (9). `__Host-mp_sessions` on
//   https, else `mp_sessions`. Never holds the active token; entries that
//   are not token-shaped are ignored when read. It expires with the latest
//   session it holds.
// - the OAuth state between GET /api/auth/linear and the callback:
//   `__Host-mp_oauth` on https (Path=/, because __Host- requires it), else
//   `mp_oauth` scoped to Path=/api/auth; signed and valid for 10 minutes.
//
// Every OAuth and demo auth response on https also expires the names the
// planner used before (a plain `mp_session` and `mp_oauth`), so nothing
// stale is left behind. Everything here is pure (or takes its inputs
// explicitly) so names and attributes are unit-tested without Next.

/** What the cookie names and attributes depend on. */
export interface CookieScheme {
  /** oauth (several workspaces, a stash), demo (one fictional workspace)
      or api_key (personal API keys, browser-session cookies). */
  mode: 'oauth' | 'demo' | 'api_key';
  /** APP_URL is https: __Host- names and Secure. */
  secure: boolean;
}

/** What cookieScheme reads from the engine. */
export interface CookieSchemeSource {
  mode: string;
  config: { appUrl: string; auth?: string };
}

/** The scheme for this engine: its mode and whether APP_URL is https. */
export function cookieScheme(engine: CookieSchemeSource): CookieScheme {
  const mode =
    engine.config.auth === 'api_key'
      ? 'api_key'
      : engine.mode === 'fixture'
        ? 'demo'
        : 'oauth';
  return { mode, secure: isSecureUrl(engine.config.appUrl) };
}

/** True when cookies for this public URL must carry `Secure`. */
export function isSecureUrl(appUrl: string): boolean {
  try {
    return new URL(appUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

const HOST_PREFIX = '__Host-';
const ACTIVE = 'mp_session';
const STASH = 'mp_sessions';
const OAUTH = 'mp_oauth';
/** Where the plain (http) OAuth cookie travels: the auth routes only. */
const OAUTH_PLAIN_PATH = '/api/auth';

/** How many other workspaces' sessions the stash holds. */
export const MAX_STASHED_SESSIONS = 9;
/** How many workspaces one browser holds (the active one and the stash). */
export const MAX_HELD_WORKSPACES = MAX_STASHED_SESSIONS + 1;
/** The OAuth state cookie's lifetime: long enough to approve in Linear. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** The active session cookie's name. */
export function activeCookieName(scheme: CookieScheme): string {
  return scheme.secure ? `${HOST_PREFIX}${ACTIVE}` : ACTIVE;
}

/** The stash cookie's name (OAuth mode only). */
export function stashCookieName(scheme: CookieScheme): string {
  return scheme.secure ? `${HOST_PREFIX}${STASH}` : STASH;
}

/** The OAuth state cookie's name and path. */
export function oauthCookieName(scheme: CookieScheme): string {
  return scheme.secure ? `${HOST_PREFIX}${OAUTH}` : OAUTH;
}

function oauthCookiePath(scheme: CookieScheme): string {
  return scheme.secure ? '/' : OAUTH_PLAIN_PATH;
}

/** Next's request cookie jar (cookies()), or anything with its get(). */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
}

/** A route's Request or a page's cookie jar. */
export type CookieSource = Request | CookieJar;

/** Reads one cookie from a request's Cookie header (the first match). */
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

function read(source: CookieSource, name: string): string | undefined {
  const value =
    source instanceof Request
      ? readCookie(source, name)
      : source.get(name)?.value;
  return value === undefined || value === '' ? undefined : value;
}

/** The active session's token, if the browser sent one. */
export function activeSessionToken(
  source: CookieSource,
  scheme: CookieScheme
): string | undefined {
  return read(source, activeCookieName(scheme));
}

/** What a stash entry must look like (store tokens are 43 base64url
    characters; anything else cannot name a session). */
const STASH_TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

/**
 * The stash cookie's tokens, most recently active first: entries that are
 * not token-shaped are ignored, duplicates and the active token are
 * removed, and at most MAX_STASHED_SESSIONS are kept.
 */
export function parseStash(
  value: string | undefined,
  activeToken?: string
): string[] {
  if (value === undefined || value === '') return [];
  const out: string[] = [];
  for (const entry of value.split('.')) {
    if (out.length >= MAX_STASHED_SESSIONS) break;
    if (!STASH_TOKEN.test(entry)) continue;
    if (entry === activeToken || out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/** The stash's tokens (none outside OAuth mode). */
export function stashTokens(
  source: CookieSource,
  scheme: CookieScheme
): string[] {
  if (scheme.mode !== 'oauth') return [];
  return parseStash(
    read(source, stashCookieName(scheme)),
    activeSessionToken(source, scheme)
  );
}

export interface CookieOptions {
  path: string;
  /** Seconds; 0 clears the cookie. Negative values are treated as 0. */
  maxAge: number;
  secure: boolean;
}

const COOKIE_VALUE = /^[A-Za-z0-9._~-]*$/;

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

/** A session the cookies hold: its token and when it expires. */
export interface HeldCookie {
  token: string;
  expiresAt: string;
}

function secondsUntil(expiresAt: string, nowMs: number): number {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? 0 : (at - nowMs) / 1000;
}

function expire(name: string, path: string, secure: boolean): string {
  return serializeCookie(name, '', { path, maxAge: 0, secure });
}

/**
 * On https, expiries for the plain names the planner used before the
 * __Host- ones (OAuth and demo mode; a one-time sign-in again for whoever
 * held them). None on http, where the plain names are the current ones.
 */
export function legacyCookieClears(scheme: CookieScheme): string[] {
  if (!scheme.secure || scheme.mode === 'api_key') return [];
  return [expire(ACTIVE, '/', true), expire(OAUTH, OAUTH_PLAIN_PATH, true)];
}

/**
 * The Set-Cookie headers for the browser's sessions after a sign-in,
 * switch or sign-out (OAuth and demo mode): the active cookie (or its
 * expiry when there is none), the stash (OAuth mode: written when it holds
 * a session, else expired; at most MAX_STASHED_SESSIONS, the active token
 * never in it), and the legacy expiries on https. The caller decides the
 * order (most recently active first) and signs out what it leaves out.
 */
export function sessionCookies(
  input: { active: HeldCookie | null; stash: readonly HeldCookie[] },
  scheme: CookieScheme,
  nowMs: number
): string[] {
  if (scheme.mode === 'api_key') {
    throw new Error('api_key mode uses apiKeySessionCookie.');
  }
  const { secure } = scheme;
  const out: string[] = [];
  out.push(
    input.active === null
      ? expire(activeCookieName(scheme), '/', secure)
      : serializeCookie(activeCookieName(scheme), input.active.token, {
          path: '/',
          maxAge: secondsUntil(input.active.expiresAt, nowMs),
          secure,
        })
  );
  if (scheme.mode === 'oauth') {
    const activeToken = input.active?.token;
    const stash = input.stash
      .filter((held) => held.token !== activeToken)
      .slice(0, MAX_STASHED_SESSIONS);
    if (stash.length === 0) {
      out.push(expire(stashCookieName(scheme), '/', secure));
    } else {
      const latest = Math.max(
        ...stash.map((held) => secondsUntil(held.expiresAt, nowMs))
      );
      out.push(
        serializeCookie(
          stashCookieName(scheme),
          stash.map((held) => held.token).join('.'),
          { path: '/', maxAge: latest, secure }
        )
      );
    }
  }
  out.push(...legacyCookieClears(scheme));
  return out;
}

/** Expires the active session and the stash (and the legacy names). */
export function clearSessionCookies(scheme: CookieScheme): string[] {
  if (scheme.mode === 'api_key') {
    return clearApiKeySessionCookies(scheme.secure);
  }
  return sessionCookies({ active: null, stash: [] }, scheme, 0);
}

/** The OAuth state cookie with its signed value, valid for 10 minutes. */
export function oauthStateCookie(
  signedValue: string,
  scheme: CookieScheme
): string {
  return serializeCookie(oauthCookieName(scheme), signedValue, {
    path: oauthCookiePath(scheme),
    maxAge: OAUTH_STATE_TTL_MS / 1000,
    secure: scheme.secure,
  });
}

/** Expires the OAuth state cookie; the callback sends this every time. */
export function clearOauthStateCookie(scheme: CookieScheme): string {
  return expire(
    oauthCookieName(scheme),
    oauthCookiePath(scheme),
    scheme.secure
  );
}

/** The signed OAuth state value the browser sent, if any. */
export function readOauthState(
  source: CookieSource,
  scheme: CookieScheme
): string | undefined {
  return read(source, oauthCookieName(scheme));
}

/**
 * The api_key-mode session cookie (§7.4, unchanged): HttpOnly,
 * SameSite=Lax, Path=/, Secure on https (named `__Host-mp_session` there),
 * no Domain and no Max-Age or Expires, so it ends with the browser
 * session.
 */
export function apiKeySessionCookie(
  token: string,
  options: { secure: boolean }
): string {
  if (!COOKIE_VALUE.test(token) || token === '') {
    throw new Error('The session token has characters that need escaping.');
  }
  const name = options.secure ? `${HOST_PREFIX}${ACTIVE}` : ACTIVE;
  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Expires both session cookie names (sign-out in api_key mode, and any
 * leftover from another mode), and both stash names, which api_key mode
 * never sets but a browser may still hold from OAuth mode. The `__Host-`
 * ones must carry Secure to be accepted at all.
 */
export function clearApiKeySessionCookies(secure: boolean): string[] {
  return [
    expire(ACTIVE, '/', secure),
    expire(`${HOST_PREFIX}${ACTIVE}`, '/', true),
    expire(STASH, '/', secure),
    expire(`${HOST_PREFIX}${STASH}`, '/', true),
  ];
}
