/**
 * Security headers for every response (next.config.ts headers()). The app
 * renders no third-party content: framing is denied, referrers are trimmed
 * to the origin, and the Content-Security-Policy keeps scripts, styles,
 * fonts, fetches and form posts on this origin (form posts may also reach
 * Linear, where OAuth goes), with no plugins and no <base> rewrites.
 *
 * script-src keeps 'unsafe-inline': Next streams the server-component
 * payload as inline scripts and the layouts inline the pre-paint theme and
 * sidebar scripts, and a nonce would need a proxy plus dynamic rendering of
 * every page (Next's CSP guide, "Without Nonces"). Development adds
 * 'unsafe-eval', which React needs there for its error overlays.
 * style-src keeps 'unsafe-inline' for React's style attributes (the
 * timeline positions every bar with them).
 *
 * Strict-Transport-Security is sent always: browsers ignore it on plain
 * HTTP (local development), and on HTTPS it stops a later visit from being
 * downgraded.
 */
export function securityHeaders(
  options: { development?: boolean } = {}
): { key: string; value: string }[] {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (options.development === true) scriptSrc.push("'unsafe-eval'");
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://linear.app",
    "frame-ancestors 'none'",
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp },
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=()',
    },
  ];
}

/**
 * Whether LINEAR_AUTH=api_key, read from the environment at request time
 * (the proxy must not import the engine, which would bundle the store
 * into it). Kept in step with the engine's linearAuthFromEnv by a test.
 */
export function isApiKeyAuthEnv(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env.LINEAR_AUTH?.trim().toLowerCase() === 'api_key';
}

/**
 * The nonce Content-Security-Policy of api_key mode (architecture §8,
 * security S9), which proxy.ts sends on every page: only scripts carrying
 * this request's nonce (and what they load, 'strict-dynamic') run, so an
 * injected inline script cannot draw a fake connect form and capture the
 * next key someone types. style-src keeps 'unsafe-inline' without a nonce
 * (a nonce would disable it, and the timeline positions bars with style
 * attributes); forms post only to this origin (there is no OAuth in this
 * mode); upgrade-insecure-requests only on https, where it cannot break a
 * loopback http run.
 */
export function contentSecurityPolicy(options: {
  nonce: string;
  development?: boolean;
  https?: boolean;
}): string {
  const scriptSrc = ["'self'", `'nonce-${options.nonce}'`, "'strict-dynamic'"];
  if (options.development === true) scriptSrc.push("'unsafe-eval'");
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'none'",
  ];
  if (options.https === true) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}
