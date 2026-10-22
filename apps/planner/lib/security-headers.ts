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
