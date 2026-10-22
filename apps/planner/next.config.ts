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
