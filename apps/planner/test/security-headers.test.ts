import { describe, expect, test } from 'bun:test';

import { securityHeaders } from '../lib/security-headers';

// The headers next.config.ts sends on every response.

function header(name: string, development = false): string | undefined {
  return securityHeaders({ development }).find((h) => h.key === name)?.value;
}

describe('security headers', () => {
  test('a Content-Security-Policy keeps everything on this origin', () => {
    const csp = header('Content-Security-Policy') ?? '';
    const directives = new Map(
      csp.split('; ').map((d) => {
        const [name, ...values] = d.split(' ');
        return [name, values.join(' ')] as const;
      })
    );
    expect(directives.get('default-src')).toBe("'self'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('connect-src')).toBe("'self'");
    expect(directives.get('form-action')).toBe("'self' https://linear.app");
    // No eval outside development.
    expect(directives.get('script-src')).not.toContain('unsafe-eval');
    expect(header('Content-Security-Policy', true)).toContain("'unsafe-eval'");
  });

  test('HSTS, framing and sniffing headers are set', () => {
    expect(header('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    );
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('the api_key-mode nonce policy', () => {
  test('holds the nonce, strict-dynamic, worker-src none and form-action self', async () => {
    const { contentSecurityPolicy } = await import('../lib/security-headers');
    const csp = contentSecurityPolicy({ nonce: 'abc123==' });
    expect(csp).toContain(
      "script-src 'self' 'nonce-abc123==' 'strict-dynamic'"
    );
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('linear.app');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
    expect(contentSecurityPolicy({ nonce: 'n', https: true })).toContain(
      'upgrade-insecure-requests'
    );
    expect(contentSecurityPolicy({ nonce: 'n', development: true })).toContain(
      "'unsafe-eval'"
    );
  });

  test("isApiKeyAuthEnv matches the engine's linearAuthFromEnv", async () => {
    const { isApiKeyAuthEnv } = await import('../lib/security-headers');
    const { linearAuthFromEnv } = await import('@better-tracker/engine');
    const fixtures = [undefined, '1', 'true', 'showcase', '0', 'false'];
    const auths = [undefined, '', 'oauth', 'api_key', ' API_KEY ', 'token'];
    for (const LINEAR_FIXTURE of fixtures) {
      for (const LINEAR_AUTH of auths) {
        const env = { LINEAR_FIXTURE, LINEAR_AUTH };
        expect(isApiKeyAuthEnv(env)).toBe(linearAuthFromEnv(env) === 'api_key');
      }
    }
  });
});
