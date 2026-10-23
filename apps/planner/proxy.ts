import { type NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';

import { urlWithoutKeys } from './lib/key-text';
import { contentSecurityPolicy, isApiKeyAuthEnv } from './lib/security-headers';

/* The planner's Proxy (Next 16; Node runtime by default). It does
   something only with personal API keys (LINEAR_AUTH=api_key, read at
   request time, so one build serves every mode):
   - a page URL that holds a Linear credential (a key pasted into the
     address bar or a link) is sent with a 303 to the same page without
     it, before anything renders: Next echoes the request URL in every
     page's RSC payload, so the page would send the key back
     (lib/key-text.ts urlWithoutKeys);
   - every other page gets a fresh nonce and a nonce
     Content-Security-Policy (lib/security-headers.ts), on the forwarded
     request (Next reads the nonce there and puts it on its own scripts;
     the layouts read `x-nonce` for theirs) and on the response.
   OAuth and demo responses pass through untouched. API routes, static
   assets and prefetches are skipped, as Next's CSP guide recommends. */
export function proxy(request: NextRequest): NextResponse {
  if (!isApiKeyAuthEnv(process.env)) return NextResponse.next();
  const clean = urlWithoutKeys(
    request.nextUrl.pathname,
    request.nextUrl.search
  );
  if (clean !== null) {
    // Next turns a same-host Location into a relative one.
    return NextResponse.redirect(new URL(clean, request.url), 303);
  }
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

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|icon.svg|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
