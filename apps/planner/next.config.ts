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
  // lib/security-headers.ts).
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
