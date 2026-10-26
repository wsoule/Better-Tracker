import { type NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { KEY_TEXT_REFUSAL, urlWithoutKeys } from './lib/key-text';
import {
  authModeFromEnv,
  contentSecurityPolicy,
  OAUTH_FORM_ACTION,
  SELF_FORM_ACTION,
} from './lib/security-headers';

/* The planner's Proxy (Next 16; Node runtime by default). The mode is
   read at request time (lib/security-headers.ts authModeFromEnv, without
   the engine), so one build serves every mode. In order:
   - api_key mode only (LINEAR_AUTH=api_key): a request whose URL holds a
     Linear credential (a key pasted into the address bar or a link) never
     reaches what would answer it: Next echoes the request URL in the RSC
     payload of every page it renders (a typo path, a prefetch and a
     missing static file render a page too), so the page would send the
     key back. A page or asset gets a 303 to the same URL without it, an
     API route a 400; neither is cached (lib/key-text.ts urlWithoutKeys);
   - OAuth and demo mode only (owner decision 2026-10-25, a browser holds
     several workspaces): a page request whose query carries `ws` (the org
     id a digest link names, architecture §7) gets a 307 to
     /open?ws=<it>&to=<the same path and query without ws>, the
     interstitial that opens the page in that workspace, offers the switch
     or says the browser is not signed in to it (§8.4 "Open"); /open
     itself, API routes, static assets and prefetches pass through;
   - every mode: every page gets a fresh nonce and the nonce
     Content-Security-Policy (lib/security-headers.ts; api_key mode since
     2026-10-23, OAuth and demo mode since 2026-10-25), on the forwarded
     request (Next reads the nonce there and puts it on its own scripts;
     the layouts read `x-nonce` for theirs) and on the response. Forms may
     also post to https://linear.app in OAuth mode, as the static policy
     allows. API routes, static assets and prefetches keep the static
     policy alone, as Next's CSP guide recommends. Every page is rendered
     per request (the layouts read cookies or await connection()), which
     a nonce needs. */
export function proxy(request: NextRequest): NextResponse {
  const mode = authModeFromEnv(process.env);
  if (mode === 'api_key') {
    const { pathname, search } = request.nextUrl;
    const clean = urlWithoutKeys(pathname, search);
    if (clean !== null) return refuseKeyInUrl(pathname, clean, request.url);
  } else {
    const redirect = workspaceLinkRedirect(request);
    if (redirect !== null) return redirect;
  }
  if (!isPageRequest(request)) return NextResponse.next();
  const nonce = randomBytes(16).toString('base64');
  const csp = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
    https: (process.env.APP_URL ?? '').trim().startsWith('https://'),
    formAction: mode === 'oauth' ? OAUTH_FORM_ACTION : SELF_FORM_ACTION,
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

// The answer to a request whose URL holds a key: an API route (`/api` or
// below) gets a 400 with the refusal sentence, so no route handler ever
// sees the key; anything else a 303 to `clean`, the same URL without it
// (Next turns a same-host Location into a relative one). `no-store`, so
// the browser keeps neither.
function refuseKeyInUrl(
  pathname: string,
  clean: string,
  requestUrl: string
): NextResponse {
  if (isApiPath(pathname)) {
    return NextResponse.json(
      { error: { code: 'key_in_url', message: KEY_TEXT_REFUSAL } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const response = NextResponse.redirect(new URL(clean, requestUrl), 303);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** The interstitial a `ws` link goes through (app/(app)/open). */
const OPEN_PATH = '/open';

// OAuth and demo mode: the 307 of a page request carrying `ws` to /open,
// or null for anything else. `ws` itself is passed on as it came (the
// page never renders it, only matches it against the browser's held
// sessions) and removed from `to`, which /open sanitises again.
function workspaceLinkRedirect(request: NextRequest): NextResponse | null {
  const { pathname, searchParams } = request.nextUrl;
  if (!searchParams.has('ws') || pathname === OPEN_PATH) return null;
  if (!isPageRequest(request)) return null;
  const rest = new URLSearchParams(searchParams);
  rest.delete('ws');
  const query = rest.toString();
  const to = query === '' ? pathname : `${pathname}?${query}`;
  const target = new URLSearchParams({
    ws: searchParams.get('ws') ?? '',
    to,
  });
  const response = NextResponse.redirect(
    new URL(`${OPEN_PATH}?${target.toString()}`, request.url),
    307
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// Whether a request is a page that gets the nonce CSP (or, in OAuth and
// demo mode, the `ws` redirect): not an API route, not a static asset
// (`/_next/static/…`, `/_next/image`, the icon files) and not a prefetch
// (Next's CSP guide skips all three). Matched by whole path segment, so a
// page such as `/apiary` is still a page.
function isPageRequest(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (isApiPath(pathname)) return false;
  if (
    pathname.startsWith('/_next/static/') ||
    pathname === '/_next/image' ||
    pathname === '/icon.svg' ||
    pathname === '/favicon.ico'
  ) {
    return false;
  }
  const { headers } = request;
  return (
    headers.get('next-router-prefetch') === null &&
    headers.get('purpose') !== 'prefetch'
  );
}

// No `config.matcher` on purpose: without one the Proxy runs on every
// request (static files and prefetches included), and the key check has
// to see whatever Next would render or answer. Next's own slash redirects
// run before it (architecture §8.1 "No key in a URL").
