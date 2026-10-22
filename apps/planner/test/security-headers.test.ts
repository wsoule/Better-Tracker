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
