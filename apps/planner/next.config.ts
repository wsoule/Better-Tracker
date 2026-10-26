import type { NextConfig } from 'next';

import { securityHeaders } from './lib/security-headers';

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // Database drivers load native/WASM assets at runtime; keep them out of
  // the server bundle and require them from node_modules instead.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  // @better-tracker/ui ships TypeScript + CSS-module source (like Dispatch's
  // @dispatch/ui); Next compiles it with the app.
  transpilePackages: ['@better-tracker/ui'],
  // In `next dev`, fetch responses in Server Components are otherwise
  // cached across HMR refreshes, `cache: 'no-store'` ones included: no
  // dev session keeps a Linear response that went out with someone's
  // personal API key (LINEAR_AUTH=api_key; architecture §8).
  experimental: {
    serverComponentsHmrCache: false,
    // proxy.ts runs on every request, so Next buffers each request body
    // for it (Next 16 `proxyClientMaxBodySize`; default 10 MB, past which
    // the body is silently cut). 2 MB is above everything a route reads
    // (JSON bodies and webhooks at most 1 MiB, lib/http.ts readJson), so
    // no accepted body is ever cut, and a bigger upload buffers no more.
    proxyClientMaxBodySize: '2mb',
  },
  // No redirects here: they run before proxy.ts, so in api_key mode their
  // Location would echo a key held in the URL. /tasks → /issues is the
  // route handler app/tasks/route.ts (architecture §8.1).
  // Security headers on every response (CSP, HSTS, framing, referrer;
  // lib/security-headers.ts). On pages, in every mode, proxy.ts sets a
  // stricter nonce CSP at request time, which Next sends in place of this
  // one (the response header the Proxy set wins over the same name here);
  // API routes, static assets and prefetches keep this policy.
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: securityHeaders({
          development: process.env.NODE_ENV === 'development',
        }),
      },
    ]);
  },
};

export default nextConfig;
