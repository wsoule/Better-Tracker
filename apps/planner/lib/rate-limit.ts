// The planner's rate limits (owner decision 2026-10-25, before strangers
// use it; architecture §8.1 "Rate limits"): in-memory sliding windows,
// called from route handlers (Next advises against relying on shared
// state in a Proxy), every number in RATE_LIMITS below. They are per web
// process: each replica counts on its own, and a restart forgets them.
//
// Two kinds of key:
// - the client IP, for the auth routes and refused webhook deliveries:
//   Railway's `X-Real-IP` only (`X-Forwarded-For` is never read, since a
//   client can set it). A request without a usable one is not limited by
//   IP at all (Railway always sets it; a local run and the browser suites
//   have none), so one shared "no IP" bucket can never lock everyone out;
// - the signed-in session's internal id (never the cookie value), for API
//   mutations, applied in requireApiActor (lib/http.ts) after the session
//   and the stale-tab check.
//
// Each limiter remembers at most RATE_LIMIT_MAX_KEYS keys (least recently
// used first out, expired ones pruned as it goes) and, per key, at most
// `limit` timestamps: the oldest of the last `limit` hits is all a sliding
// window needs. So memory stays bounded whatever arrives.
//
// The connect form's limits of api_key mode (lib/connect-limit.ts) keep
// their own rules (failures only, a global window); they read the client
// IP the same way.

import { redirectWithCookies } from './auth-cookies';
import { jsonError } from './origin';

/** Railway's client IP header (the only one read). */
export const CLIENT_IP_HEADER = 'x-real-ip';

/** What a client IP header may hold (IPv4 or IPv6 text). */
const IP_SHAPE = /^[0-9A-Fa-f:.]{1,45}$/;

/**
 * The request's client IP from `X-Real-IP`, or null when it has none
 * that looks like an address: then no IP limit applies to it.
 */
export function clientIp(request: Request): string | null {
  const raw = request.headers.get(CLIENT_IP_HEADER)?.trim() ?? '';
  return IP_SHAPE.test(raw) ? raw : null;
}

const MINUTE_MS = 60_000;

/** One limit: at most `limit` hits per `windowMs`, per key. */
export interface RateRule {
  /** A stable id (the process-wide limiter of each rule is kept by it). */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Every rate limit the planner applies, in one place (architecture §8.1
 * "Rate limits" has the table). Per web process.
 */
export const RATE_LIMITS = {
  /** GET /api/auth/linear, per client IP (OAuth mode). */
  oauthStart: { name: 'oauth_start', limit: 30, windowMs: 10 * MINUTE_MS },
  /** POST /api/auth/switch, per client IP. */
  switchWorkspace: {
    name: 'switch_workspace',
    limit: 60,
    windowMs: 10 * MINUTE_MS,
  },
  /** POST /api/auth/logout, per client IP (OAuth mode). */
  signOut: { name: 'sign_out', limit: 60, windowMs: 10 * MINUTE_MS },
  /** POST /api/runs, per session. */
  runs: { name: 'runs', limit: 6, windowMs: 10 * MINUTE_MS },
  /** POST /api/warnings/preview, per session. */
  warningsPreview: {
    name: 'warnings_preview',
    limit: 20,
    windowMs: 10 * MINUTE_MS,
  },
  /** Every other API mutation (PATCH, POST, DELETE), per session. */
  mutation: { name: 'mutation', limit: 300, windowMs: MINUTE_MS },
  /**
   * Refused webhook deliveries (missing or bad signature, oversize), per
   * client IP. A delivery with a valid signature is never counted or
   * refused by it.
   */
  webhookRefused: { name: 'webhook_refused', limit: 100, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateRule>;

/** The most keys one limiter remembers (least recently used dropped first). */
export const RATE_LIMIT_MAX_KEYS = 10_000;

/** A hit that may go ahead, or one refused with when to try again. */
export type RateVerdict =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  readonly rule: RateRule;
  /**
   * Counts a hit for `key` now, or refuses it (uncounted) when the key
   * already had `limit` hits in the window.
   */
  hit(key: string): RateVerdict;
  /** Keys remembered (tests). */
  size(): number;
}

export interface RateLimiterOptions {
  /** Epoch ms. */
  now: () => number;
  maxKeys?: number;
}

/** Builds a sliding-window limiter for one rule (see the file comment). */
export function createRateLimiter(
  rule: RateRule,
  options: RateLimiterOptions
): RateLimiter {
  const maxKeys = options.maxKeys ?? RATE_LIMIT_MAX_KEYS;
  // Hits per key, oldest first; Map order is least recently used first.
  const byKey = new Map<string, number[]>();

  // Drops a key's hits that left the window.
  function live(hits: number[], now: number): number[] {
    while (hits.length > 0 && now - (hits[0] ?? 0) >= rule.windowMs) {
      hits.shift();
    }
    return hits;
  }

  // Drops keys with no hit left in the window from the least recently
  // used end, stopping at the first that still has one (every key after
  // it was hit more recently).
  function prune(now: number): void {
    for (const [key, hits] of byKey) {
      if (live(hits, now).length > 0) break;
      byKey.delete(key);
    }
  }

  return {
    rule,
    hit(key) {
      const now = options.now();
      prune(now);
      const hits = live(byKey.get(key) ?? [], now);
      byKey.delete(key);
      byKey.set(key, hits);
      if (hits.length >= rule.limit) {
        const oldest = hits[0] ?? now;
        return {
          ok: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest + rule.windowMs - now) / 1000)
          ),
        };
      }
      hits.push(now);
      while (byKey.size > maxKeys) {
        const oldest = byKey.keys().next();
        if (oldest.done === true) break;
        byKey.delete(oldest.value);
      }
      return { ok: true };
    },
    size() {
      return byKey.size;
    },
  };
}

// One limiter per rule per server process, kept across Next dev's module
// reloads (route bundles each load this module; the map is shared).
const holder = globalThis as typeof globalThis & {
  __milestonePlannerRateLimiters?: Map<string, RateLimiter>;
};

/** The process-wide limiter of a rule. */
export function processRateLimiter(rule: RateRule): RateLimiter {
  holder.__milestonePlannerRateLimiters ??= new Map();
  let limiter = holder.__milestonePlannerRateLimiters.get(rule.name);
  if (limiter === undefined) {
    limiter = createRateLimiter(rule, { now: () => Date.now() });
    holder.__milestonePlannerRateLimiters.set(rule.name, limiter);
  }
  return limiter;
}

/** Forgets every process-wide limiter (tests). */
export function resetProcessRateLimiters(): void {
  holder.__milestonePlannerRateLimiters = new Map();
}

/**
 * Counts a request against an IP rule: null when it may go ahead (or has
 * no client IP, so no IP limit applies), else the refusal.
 */
export function limitByIp(
  request: Request,
  rule: RateRule,
  limiter: RateLimiter = processRateLimiter(rule)
): { retryAfterSeconds: number } | null {
  const ip = clientIp(request);
  if (ip === null) return null;
  const verdict = limiter.hit(ip);
  return verdict.ok ? null : { retryAfterSeconds: verdict.retryAfterSeconds };
}

/** "45 s" under a minute, else whole minutes rounded up ("3 min"). */
export function waitText(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

/** The sentence a rate-limited API request answers with, by rule. */
export function rateLimitedMessage(
  rule: RateRule,
  retryAfterSeconds: number
): string {
  const wait = `Try again in ${waitText(retryAfterSeconds)}.`;
  switch (rule.name) {
    case RATE_LIMITS.runs.name:
      return `Too many allocation runs from this session in the last 10 minutes. ${wait}`;
    case RATE_LIMITS.warningsPreview.name:
      return `Too many digest previews from this session in the last 10 minutes. ${wait}`;
    case RATE_LIMITS.switchWorkspace.name:
      return `Too many workspace switches from this network in the last 10 minutes. ${wait}`;
    default:
      return `Too many changes from this session in the last minute. ${wait}`;
  }
}

/**
 * 429 `rate_limited` for an API request, with Retry-After (seconds) and
 * no-store; the message says what was limited and when to try again.
 */
export function rateLimitedResponse(
  rule: RateRule,
  retryAfterSeconds: number
): Response {
  return jsonError(
    429,
    'rate_limited',
    rateLimitedMessage(rule, retryAfterSeconds),
    {},
    {
      'Retry-After': String(retryAfterSeconds),
      'Cache-Control': 'no-store',
    }
  );
}

/** Where an auth navigation that hit a limit lands (its sentence: landing.ts). */
export const AUTH_RATE_LIMITED_LOCATION = '/?auth_error=auth_rate_limited';

/**
 * The 303 an auth navigation (the OAuth start link, a switch or sign-out
 * form) answers when its IP limit refuses it: the landing page says why.
 * Retry-After rides along; `cookies` are the housekeeping cookies the
 * route would have sent anyway.
 */
export function rateLimitedRedirect(
  retryAfterSeconds: number,
  cookies: readonly string[] = []
): Response {
  const response = redirectWithCookies(AUTH_RATE_LIMITED_LOCATION, cookies);
  response.headers.set('Retry-After', String(retryAfterSeconds));
  return response;
}

/**
 * The per-session rule of an API request, by method and path: POST
 * /api/runs and POST /api/warnings/preview have their own, every other
 * PATCH, POST or DELETE shares `mutation`; reads (GET, HEAD) have none.
 */
export function apiRateRule(request: Request): RateRule | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return null;
  }
  const { pathname } = new URL(request.url);
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (method === 'POST' && path === '/api/runs') return RATE_LIMITS.runs;
  if (method === 'POST' && path === '/api/warnings/preview') {
    return RATE_LIMITS.warningsPreview;
  }
  return RATE_LIMITS.mutation;
}

/**
 * The per-session limit of an API mutation (requireApiActor, after the
 * session and the stale-tab check): null when it may go ahead, else the
 * 429. Keyed by the session's internal id, never its cookie value.
 */
export function limitApiRequest(
  request: Request,
  sessionId: string
): Response | null {
  const rule = apiRateRule(request);
  if (rule === null) return null;
  const verdict = processRateLimiter(rule).hit(sessionId);
  return verdict.ok
    ? null
    : rateLimitedResponse(rule, verdict.retryAfterSeconds);
}
