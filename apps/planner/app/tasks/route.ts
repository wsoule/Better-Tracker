import type { NextRequest } from 'next/server';

/* /tasks is the owner's word for the Issues page (owner request
   2026-10-22, "every issue in one list"): a real 307 to /issues, query
   kept. A route handler rather than a next.config.ts redirect, because
   next.config.ts redirects run before proxy.ts: in api_key mode the proxy
   has already sent a URL that holds a key to the same URL without it, so
   this Location can never carry one. A page-level redirect() under (app)
   would stream under its loading.tsx as a client-side refresh with status
   200 (architecture §8.1). The Location is relative, so it names no host. */
export function GET(request: NextRequest): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: `/issues${request.nextUrl.search}` },
  });
}
