/**
 * Security headers for every response (next.config.ts headers()). The app
 * renders no third-party content: framing is denied, referrers are trimmed
 * to the origin, and the Content-Security-Policy keeps scripts, styles,
 * fonts, fetches and form posts on this origin (form posts may also reach
 * Linear, where OAuth goes), with no plugins and no <base> rewrites.
 *
 * script-src keeps 'unsafe-inline' in this static policy: API routes,
 * static assets and prefetches keep it (Next's CSP guide skips them), and
 * every page gets the stricter nonce policy below from proxy.ts instead
 * (Next sends the header the Proxy set in place of this one). Development
 * adds 'unsafe-eval', which React needs there for its error overlays.
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
 * How the planner reaches Linear, read from the environment at request
 * time without the engine (as isApiKeyAuthEnv): `api_key` when
 * LINEAR_AUTH says so, else `demo` when LINEAR_FIXTURE turns demo mode on
 * (`1`, `true` or `showcase`), else `oauth`. Kept in step with the
 * engine's linearAuthFromEnv by a test.
 */
export function authModeFromEnv(
  env: Readonly<Record<string, string | undefined>>
): 'api_key' | 'demo' | 'oauth' {
  if (isApiKeyAuthEnv(env)) return 'api_key';
  const fixture = env.LINEAR_FIXTURE?.trim().toLowerCase();
  return fixture === '1' || fixture === 'true' || fixture === 'showcase'
    ? 'demo'
    : 'oauth';
}

/** Where forms may post in OAuth mode: this origin and Linear's OAuth. */
export const OAUTH_FORM_ACTION: readonly string[] = [
  "'self'",
  'https://linear.app',
];

/** Where forms may post in demo and api_key mode: this origin only. */
export const SELF_FORM_ACTION: readonly string[] = ["'self'"];

/**
 * The nonce Content-Security-Policy proxy.ts sends on every page, in
 * every mode (api_key mode since 2026-10-23, security S9; OAuth and demo
 * mode since 2026-10-25, before strangers use the planner): only scripts
 * carrying this request's nonce (and what they load, 'strict-dynamic')
 * run, so an injected inline script cannot run at all (with personal API
 * keys: cannot draw a fake connect form and capture the next key someone
 * types). style-src keeps 'unsafe-inline' without a nonce (a nonce would
 * disable it, and the timeline positions bars with style attributes);
 * forms post to `formAction` (default this origin only; OAuth mode adds
 * https://linear.app, OAUTH_FORM_ACTION, as the static policy has it);
 * upgrade-insecure-requests only on https, where it cannot break a
 * loopback http run.
 */
export function contentSecurityPolicy(options: {
  nonce: string;
  development?: boolean;
  https?: boolean;
  formAction?: readonly string[];
}): string {
  const scriptSrc = ["'self'", `'nonce-${options.nonce}'`, "'strict-dynamic'"];
  if (options.development === true) scriptSrc.push("'unsafe-eval'");
  const formAction = options.formAction ?? SELF_FORM_ACTION;
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction.join(' ')}`,
    "frame-ancestors 'none'",
    "worker-src 'none'",
  ];
  if (options.https === true) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}
