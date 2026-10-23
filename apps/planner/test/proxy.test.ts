// proxy.ts: a fresh nonce CSP on every page in api_key mode, nothing at
// all in the other modes (architecture §8 "Security").

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { config, proxy } from '../proxy';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ['LINEAR_AUTH', 'LINEAR_FIXTURE', 'APP_URL']) {
    saved[name] = process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function page(): NextRequest {
  return new NextRequest('http://localhost:3360/week');
}

describe('proxy', () => {
  test('api_key mode: two requests, two nonces, each in a strict-dynamic CSP', () => {
    process.env.LINEAR_AUTH = 'api_key';
    process.env.APP_URL = 'http://localhost:3360';
    const first = proxy(page()).headers.get('content-security-policy') ?? '';
    const second = proxy(page()).headers.get('content-security-policy') ?? '';
    const nonce = (csp: string): string =>
      /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
    expect(nonce(first)).not.toBe('');
    expect(nonce(first)).not.toBe(nonce(second));
    expect(first).toContain("'strict-dynamic'");
    expect(first).not.toContain('upgrade-insecure-requests');
    // The forwarded request carries the nonce for Next and the layouts.
    const forwarded = proxy(page()).headers.get('x-middleware-request-x-nonce');
    expect(forwarded ?? '').not.toBe('');
  });

  test('OAuth and demo mode: no CSP is set', () => {
    for (const env of [{}, { LINEAR_AUTH: 'oauth' }, { LINEAR_FIXTURE: '1' }]) {
      delete process.env.LINEAR_AUTH;
      delete process.env.LINEAR_FIXTURE;
      Object.assign(process.env, env);
      const response = proxy(page());
      expect(response.headers.get('content-security-policy')).toBeNull();
      expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
    }
  });

  test('api_key mode: a page URL holding a key is sent, before rendering, to the page without it', () => {
    process.env.LINEAR_AUTH = 'api_key';
    process.env.APP_URL = 'http://localhost:3360';
    const key = 'lin_api_TESTKEY_proxyurl_k4Rm8Wq2Zt6Yb1Nc';
    const cases: [string, string][] = [
      [`/issues?q=${key}&state=all`, '/issues?state=all'],
      [`/issues?q=${encodeURIComponent(`my key ${key}`)}`, '/issues'],
      [`/?returnTo=${encodeURIComponent(`/issues?q=${key}`)}`, '/'],
      [`/issues/${key}`, '/'],
    ];
    for (const [from, to] of cases) {
      const response = proxy(new NextRequest(`http://localhost:3360${from}`));
      expect(response.status).toBe(303);
      const location = response.headers.get('location') ?? '';
      expect(new URL(location, 'http://localhost:3360').pathname).toBe(
        to.split('?')[0]
      );
      expect(location.endsWith(to)).toBe(true);
      expect(location).not.toContain('TESTKEY');
      expect(response.headers.get('content-security-policy')).toBeNull();
    }
    // A URL without a key renders as usual.
    const plain = proxy(
      new NextRequest('http://localhost:3360/issues?q=lin_api_key')
    );
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-security-policy') ?? '').toContain(
      "'nonce-"
    );
  });

  test('OAuth and demo mode: a URL holding a key passes through', () => {
    delete process.env.LINEAR_AUTH;
    process.env.LINEAR_FIXTURE = '1';
    const response = proxy(
      new NextRequest(
        'http://localhost:3360/issues?q=lin_api_TESTKEY_proxyurl_k4Rm8Wq2Zt6Yb1Nc'
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  test('the matcher skips API routes, static assets and prefetches', () => {
    const [matcher] = config.matcher;
    expect(matcher?.source).toContain('(?!api|_next/static|_next/image');
    expect(matcher?.missing.map((m) => m.key)).toEqual([
      'next-router-prefetch',
      'purpose',
    ]);
  });
});
