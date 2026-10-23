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
  },
  // /tasks is the owner's word for the Issues page (owner request
  // 2026-10-22, "every issue in one list"): a real 307 to /issues, query
  // kept. A page-level redirect() under (app) would stream under its
  // loading.tsx as a client-side refresh with status 200 (architecture
  // §8.1).
  redirects() {
    return Promise.resolve([
      { source: '/tasks', destination: '/issues', permanent: false },
    ]);
  },
  // Security headers on every response (CSP, HSTS, framing, referrer;
  // lib/security-headers.ts). In api_key mode proxy.ts adds a stricter
  // nonce CSP to every page at request time; browsers enforce both, so
  // the stricter one binds.
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
