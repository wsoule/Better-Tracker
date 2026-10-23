import { type NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { KEY_TEXT_REFUSAL, urlWithoutKeys } from './lib/key-text';
import { contentSecurityPolicy, isApiKeyAuthEnv } from './lib/security-headers';

/* The planner's Proxy (Next 16; Node runtime by default). It does
   something only with personal API keys (LINEAR_AUTH=api_key, read at
   request time, so one build serves every mode):
   - a request whose URL holds a Linear credential (a key pasted into the
     address bar or a link) never reaches what would answer it: Next
     echoes the request URL in the RSC payload of every page it renders
     (a typo path, a prefetch and a missing static file render a page
     too), so the page would send the key back. A page or asset gets a
     303 to the same URL without it, an API route a 400; neither is
     cached (lib/key-text.ts urlWithoutKeys);
   - every page gets a fresh nonce and a nonce Content-Security-Policy
     (lib/security-headers.ts), on the forwarded request (Next reads the
     nonce there and puts it on its own scripts; the layouts read
     `x-nonce` for theirs) and on the response. API routes, static
     assets and prefetches keep the static policy, as Next's CSP guide
     recommends.
   OAuth and demo responses pass through untouched. */
export function proxy(request: NextRequest): NextResponse {
  if (!isApiKeyAuthEnv(process.env)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const clean = urlWithoutKeys(pathname, search);
  if (clean !== null) return refuseKeyInUrl(pathname, clean, request.url);
  if (!takesNonce(request)) return NextResponse.next();
  const nonce = randomBytes(16).toString('base64');
  const csp = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
    https: (process.env.APP_URL ?? '').trim().startsWith('https://'),
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

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// Whether a request is a page that gets the nonce CSP: not an API route,
// not a static asset (`/_next/static/…`, `/_next/image`, the icon files)
// and not a prefetch (Next's CSP guide skips all three). Matched by whole
// path segment, so a page such as `/apiary` is still a page.
function takesNonce(request: NextRequest): boolean {
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
