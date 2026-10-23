// proxy.ts: in api_key mode, no key in any URL Next would render or
// answer, and a fresh nonce CSP on every page; nothing at all in the
// other modes (architecture §8.1 "No key in a URL", "Nonce CSP").

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import * as tasksModule from '../app/tasks/route';
import { KEY_TEXT_REFUSAL } from '../lib/key-text';
import nextConfig from '../next.config';
import * as proxyModule from '../proxy';

const { proxy } = proxyModule;

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

  test('api_key mode: what Next renders without a page sends no key back either', () => {
    process.env.LINEAR_AUTH = 'api_key';
    process.env.APP_URL = 'http://localhost:3360';
    const key = 'lin_api_TESTKEY_proxyurl_k4Rm8Wq2Zt6Yb1Nc';
    const prefetch = { 'next-router-prefetch': '1', rsc: '1' };
    // [url, request headers, where it goes]
    const cases: [string, Record<string, string>, string][] = [
      [`/apiary?q=${key}`, {}, '/apiary'],
      [`/apix/${key}`, {}, '/'],
      [`/_next/static/${key}`, {}, '/'],
      [`/_next/static/chunks/x.js?k=${key}`, {}, '/_next/static/chunks/x.js'],
      [`/_next/image?url=${key}&w=64`, {}, '/_next/image?w=64'],
      [`/favicon.ico/${key}`, {}, '/'],
      [`/favicon.ico?x=${key}`, {}, '/favicon.ico'],
      [`/icon.svg?x=${key}`, {}, '/icon.svg'],
      [`/issues?q=${key}`, { purpose: 'prefetch' }, '/issues'],
      [`/issues?q=${key}&_rsc=abc`, prefetch, '/issues?_rsc=abc'],
      [`/?returnTo=${encodeURIComponent(`/issues?q=${key}`)}`, prefetch, '/'],
      [`/tasks?q=${key}&project=p1`, {}, '/tasks?project=p1'],
    ];
    for (const [from, headers, to] of cases) {
      const response = proxy(
        new NextRequest(`http://localhost:3360${from}`, { headers })
      );
      expect(response.status).toBe(303);
      const location = response.headers.get('location') ?? '';
      expect(location.endsWith(to)).toBe(true);
      expect(location).not.toContain('TESTKEY');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('api_key mode: an API URL holding a key is refused before any route handler', async () => {
    process.env.LINEAR_AUTH = 'api_key';
    process.env.APP_URL = 'http://localhost:3360';
    const key = 'lin_api_TESTKEY_proxyurl_k4Rm8Wq2Zt6Yb1Nc';
    for (const [url, method] of [
      [`/api/issues/options?q=${key}`, 'GET'],
      [`/api/${key}`, 'GET'],
      [`/api/sync?x=${encodeURIComponent(key)}`, 'POST'],
      [`/api?x=${key}`, 'GET'],
    ] as const) {
      const response = proxy(
        new NextRequest(`http://localhost:3360${url}`, { method })
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).not.toContain('TESTKEY');
      expect(JSON.parse(text)).toEqual({
        error: { code: 'key_in_url', message: KEY_TEXT_REFUSAL },
      });
    }
  });

  test('api_key mode: the nonce CSP goes on pages only, matched by whole path segment', () => {
    process.env.LINEAR_AUTH = 'api_key';
    process.env.APP_URL = 'http://localhost:3360';
    const csp = (url: string, headers: Record<string, string> = {}) =>
      proxy(
        new NextRequest(`http://localhost:3360${url}`, { headers })
      ).headers.get('content-security-policy');
    for (const page of ['/', '/week', '/apiary', '/apix/y', '/favicon.ico/x']) {
      expect(csp(page) ?? '').toContain("'nonce-");
    }
    for (const skipped of [
      '/api',
      '/api/issues/options',
      '/_next/static/chunks/a.js',
      '/_next/image?url=%2Ficon.svg&w=64',
      '/icon.svg',
      '/favicon.ico',
    ]) {
      expect(csp(skipped)).toBeNull();
    }
    expect(
      csp('/issues', { 'next-router-prefetch': '1', rsc: '1' })
    ).toBeNull();
    expect(csp('/issues', { purpose: 'prefetch' })).toBeNull();
  });

  test('OAuth and demo mode: every URL passes through untouched', () => {
    const key = 'lin_api_TESTKEY_proxyurl_k4Rm8Wq2Zt6Yb1Nc';
    for (const env of [{}, { LINEAR_AUTH: 'oauth' }, { LINEAR_FIXTURE: '1' }]) {
      delete process.env.LINEAR_AUTH;
      delete process.env.LINEAR_FIXTURE;
      Object.assign(process.env, env);
      for (const url of [
        `/apiary?q=${key}`,
        `/_next/static/${key}`,
        `/api/issues/options?q=${key}`,
        '/_next/static/chunks/a.js',
      ]) {
        const response = proxy(new NextRequest(`http://localhost:3360${url}`));
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('content-security-policy')).toBeNull();
      }
    }
  });

  test('no matcher: the proxy runs on every request, and next.config has no redirects', () => {
    // Without `config.matcher` Next runs the Proxy on every request,
    // static files and prefetches included; next.config.ts redirects
    // would run before it and echo the URL.
    expect('config' in proxyModule).toBe(false);
    expect(nextConfig.redirects).toBeUndefined();
  });
});

describe('/tasks', () => {
  test('a 307 to /issues with a relative Location, query kept', () => {
    for (const [from, to] of [
      ['/tasks', '/issues'],
      [
        '/tasks?project=proj-atlas&state=all',
        '/issues?project=proj-atlas&state=all',
      ],
    ]) {
      const response = tasksModule.GET(
        new NextRequest(`http://localhost:3360${from}`)
      );
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(to);
    }
  });

  test('every method gets the same 307, as the redirect it replaced did', () => {
    // A next.config.ts redirect answers every method; a route handler
    // answers only the methods it exports (Next adds HEAD and OPTIONS,
    // and gives the rest 405).
    const methods = ['DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
    for (const method of methods) {
      const handler = (tasksModule as Record<string, unknown>)[method];
      expect(handler).toBe(tasksModule.GET);
    }
    const response = tasksModule.GET(
      new NextRequest('http://localhost:3360/tasks?state=all', {
        method: 'POST',
      })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/issues?state=all');
  });
});
