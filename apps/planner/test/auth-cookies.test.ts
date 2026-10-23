import { describe, expect, test } from 'bun:test';

import {
  clearOauthCookie,
  clearSessionCookie,
  isSecureUrl,
  OAUTH_COOKIE,
  oauthCookie,
  parseIntent,
  parseOAuthPayload,
  readCookie,
  redirectWithCookies,
  resolveSessionSecret,
  sanitizeReturnTo,
  serializeCookie,
  sessionCookie,
  signInHref,
  signInLocation,
} from '../lib/auth-cookies';
import { signValue, verifyValue } from '../lib/signed-cookie';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const SECRET = 's'.repeat(32);

describe('sanitizeReturnTo', () => {
  test('keeps same-site relative paths, query and hash included', () => {
    for (const path of [
      '/week',
      '/timeline?milestone=ms-atlas-2',
      '/runs/run-1#entries',
      '/graph?project=p%2F1',
      '/',
    ]) {
      expect(sanitizeReturnTo(path)).toBe(path);
    }
  });

  test('refuses anything that could leave the site', () => {
    for (const value of [
      'https://evil.example/',
      '//evil.example',
      '///evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/ /evil.example',
      'javascript:alert(1)',
      'week',
      '\\\\evil.example',
      '',
    ]) {
      expect(sanitizeReturnTo(value)).toBe('/week');
    }
  });

  test('percent-encodes non-ASCII text so the redirect header stays valid', () => {
    expect(sanitizeReturnTo('/timeline?q=週')).toBe('/timeline?q=%E9%80%B1');
    expect(sanitizeReturnTo('/a?q=café#\u{1F600}')).toBe(
      '/a?q=caf%C3%A9#%F0%9F%98%80'
    );
    // Already-encoded and plain ASCII paths are left exactly as they were.
    expect(sanitizeReturnTo('/graph?project=p%2F1')).toBe(
      '/graph?project=p%2F1'
    );
    for (const value of ['/timeline?q=週', '/x#ÿ']) {
      expect(
        () => new Headers({ Location: sanitizeReturnTo(value) })
      ).not.toThrow();
    }
    // A lone surrogate cannot be encoded: fall back.
    expect(sanitizeReturnTo('/x\ud800')).toBe('/week');
    // Non-ASCII look-alikes of "/" or "\" stay inside the path.
    expect(sanitizeReturnTo('/∕evil.example')).toBe('/%E2%88%95evil.example');
  });

  test('falls back for a path that holds a Linear credential, however encoded', () => {
    // Every caller copies the result into a redirect's Location, and no
    // URL the planner answers carries a key (architecture §8.1).
    const key = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';
    for (const value of [
      `/week?x=${key}`,
      `/issues/${key}`,
      `/issues?q=${encodeURIComponent(key)}`,
      `/issues?q=${key.replaceAll('_', '%5F')}`,
      `/issues?q=${key.replaceAll('_', '%255F')}`,
      `/issues#${key}`,
      `/issues?q=lin_oauth_${key.slice('lin_api_'.length)}`,
    ]) {
      expect(sanitizeReturnTo(value)).toBe('/week');
      expect(sanitizeReturnTo(value, '/settings')).toBe('/settings');
    }
    // Words that only look like the prefix are not keys.
    expect(sanitizeReturnTo('/issues?q=lin_api_key')).toBe(
      '/issues?q=lin_api_key'
    );
  });

  test('falls back for missing or oversized values, to the given default', () => {
    expect(sanitizeReturnTo(null)).toBe('/week');
    expect(sanitizeReturnTo(undefined, '/settings')).toBe('/settings');
    expect(sanitizeReturnTo(`/${'a'.repeat(2048)}`)).toBe('/week');
  });
});

describe('cookie attributes', () => {
  test('mp_session is httpOnly, Lax, Path=/ and expires with the session', () => {
    const header = sessionCookie('tok_123', '2026-10-28T12:00:00.000Z', {
      secure: false,
      nowMs: NOW,
    });
    expect(header).toBe(
      'mp_session=tok_123; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax'
    );
  });

  test('Secure is added only when the app is served over https', () => {
    const https = sessionCookie('t', '2026-10-22T12:00:00.000Z', {
      secure: isSecureUrl('https://planner.example.com'),
      nowMs: NOW,
    });
    const http = sessionCookie('t', '2026-10-22T12:00:00.000Z', {
      secure: isSecureUrl('http://localhost:3000'),
      nowMs: NOW,
    });
    expect(https.split('; ')).toContain('Secure');
    expect(http.split('; ')).not.toContain('Secure');
    expect(isSecureUrl('not a url')).toBe(false);
  });

  test('mp_oauth lives 10 minutes and only travels to /api/auth', () => {
    const header = oauthCookie('abc.def', true);
    expect(header).toBe(
      'mp_oauth=abc.def; Path=/api/auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure'
    );
  });

  test('clearing uses the same path and Max-Age=0', () => {
    expect(clearSessionCookie(false)).toBe(
      'mp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    );
    expect(clearOauthCookie(true)).toBe(
      'mp_oauth=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
    );
  });

  test('an expired or unparseable expiry never yields a negative Max-Age', () => {
    expect(
      sessionCookie('t', '2026-10-20T00:00:00.000Z', {
        secure: false,
        nowMs: NOW,
      })
    ).toContain('Max-Age=0;');
    expect(sessionCookie('t', 'soon', { secure: false, nowMs: NOW })).toContain(
      'Max-Age=0;'
    );
  });

  test('refuses values that would need escaping', () => {
    expect(() =>
      serializeCookie('x', 'a;b', { path: '/', maxAge: 1, secure: false })
    ).toThrow(/escaping/);
  });

  test('redirects keep every Set-Cookie header', () => {
    const response = redirectWithCookies('/week', [
      clearOauthCookie(false),
      sessionCookie('t', '2026-10-22T12:00:00.000Z', {
        secure: false,
        nowMs: NOW,
      }),
    ]);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/week');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
});

describe('readCookie', () => {
  test('finds one cookie among several', () => {
    const request = new Request('http://localhost/x', {
      headers: { cookie: 'a=1; mp_session=tok; mp_oauth=x.y' },
    });
    expect(readCookie(request, 'mp_session')).toBe('tok');
    expect(readCookie(request, OAUTH_COOKIE)).toBe('x.y');
    expect(readCookie(request, 'missing')).toBeUndefined();
    expect(readCookie(new Request('http://localhost/'), 'a')).toBeUndefined();
  });
});

describe('OAuth state', () => {
  test('intent defaults to sign-in and rejects unknown values', () => {
    expect(parseIntent(null)).toBe('signin');
    expect(parseIntent('install')).toBe('install');
    expect(parseIntent('grant_write')).toBe('grant_write');
    expect(parseIntent('admin')).toBeNull();
  });

  test('the signed cookie round-trips into a payload', () => {
    const value = signValue(
      {
        state: 'st',
        codeVerifier: 'cv',
        intent: 'signin',
        returnTo: '/timeline',
      },
      SECRET,
      NOW + 600_000
    );
    expect(parseOAuthPayload(verifyValue(value, SECRET, NOW))).toEqual({
      state: 'st',
      codeVerifier: 'cv',
      intent: 'signin',
      returnTo: '/timeline',
    });
    // Ten minutes later it is gone.
    expect(
      parseOAuthPayload(verifyValue(value, SECRET, NOW + 600_000))
    ).toBeNull();
  });

  test('payloads of the wrong shape are refused, returnTo re-sanitised', () => {
    expect(parseOAuthPayload(null)).toBeNull();
    expect(
      parseOAuthPayload({ state: 'st', codeVerifier: 'cv', intent: 'root' })
    ).toBeNull();
    expect(
      parseOAuthPayload({
        state: 'st',
        codeVerifier: 'cv',
        intent: 'install',
        returnTo: '//evil.example',
      })?.returnTo
    ).toBe('/week');
  });
});

describe('resolveSessionSecret', () => {
  const random = () => 'r'.repeat(43);

  test('uses a long enough secret as is', () => {
    expect(
      resolveSessionSecret({ SESSION_SECRET: SECRET }, false, random)
    ).toBe(SECRET);
  });

  test('real mode fails clearly when it is missing or short', () => {
    expect(() => resolveSessionSecret({}, false, random)).toThrow(
      /SESSION_SECRET is not set/
    );
    expect(() =>
      resolveSessionSecret({ SESSION_SECRET: 'short' }, false, random)
    ).toThrow(/at least 32/);
  });

  test('demo mode falls back to the per-process secret', () => {
    expect(resolveSessionSecret({}, true, random)).toBe('r'.repeat(43));
    expect(resolveSessionSecret({ SESSION_SECRET: 'x' }, true, random)).toBe(
      'r'.repeat(43)
    );
  });
});

describe('signInLocation and signInHref (a deep link opened signed out)', () => {
  test('carry the page back through the landing page and OAuth', () => {
    expect(signInLocation('/timeline?milestone=ms-harbor-1')).toBe(
      '/?returnTo=%2Ftimeline%3Fmilestone%3Dms-harbor-1'
    );
    expect(signInHref('/issues/ENG-24')).toBe(
      '/api/auth/linear?intent=signin&returnTo=%2Fissues%2FENG-24'
    );
  });

  test('the default page and unsafe targets give the plain forms', () => {
    expect(signInLocation()).toBe('/');
    expect(signInLocation('/week')).toBe('/');
    expect(signInLocation('//evil.example')).toBe('/');
    expect(signInHref(undefined)).toBe('/api/auth/linear?intent=signin');
    expect(signInHref('https://evil.example')).toBe(
      '/api/auth/linear?intent=signin'
    );
  });
});

describe('api_key-mode session cookies', () => {
  const KEYMODE_HTTPS = {
    auth: 'api_key',
    appUrl: 'https://planner.example.com',
  };
  const KEYMODE_HTTP = { auth: 'api_key', appUrl: 'http://localhost:3360' };

  test('sessionCookieName: __Host- only in api_key mode on https', async () => {
    const { sessionCookieName } = await import('../lib/auth-cookies');
    expect(sessionCookieName(KEYMODE_HTTPS)).toBe('__Host-mp_session');
    expect(sessionCookieName(KEYMODE_HTTP)).toBe('mp_session');
    expect(
      sessionCookieName({ auth: 'oauth', appUrl: 'https://p.example' })
    ).toBe('mp_session');
    expect(sessionCookieName({ appUrl: 'https://p.example' })).toBe(
      'mp_session'
    );
  });

  test('apiKeySessionCookie: a browser-session cookie, Secure and __Host- on https', async () => {
    const { apiKeySessionCookie } = await import('../lib/auth-cookies');
    expect(apiKeySessionCookie('tok_123', { secure: false })).toBe(
      'mp_session=tok_123; Path=/; HttpOnly; SameSite=Lax'
    );
    const secure = apiKeySessionCookie('tok_123', { secure: true });
    expect(secure).toBe(
      '__Host-mp_session=tok_123; Path=/; HttpOnly; SameSite=Lax; Secure'
    );
    expect(secure).not.toMatch(/Max-Age|Expires|Domain/i);
    expect(() => apiKeySessionCookie('a;b', { secure: false })).toThrow();
  });

  test('clearApiKeySessionCookies expires both names', async () => {
    const { clearApiKeySessionCookies } = await import('../lib/auth-cookies');
    const cookies = clearApiKeySessionCookies(false);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toStartWith('mp_session=;');
    expect(cookies[1]).toStartWith('__Host-mp_session=;');
    for (const cookie of cookies) expect(cookie).toContain('Max-Age=0');
    expect(cookies[1]).toContain('Secure');
  });

  test('on https, a request carrying only mp_session reads no session', async () => {
    const { readCookie, sessionCookieName } =
      await import('../lib/auth-cookies');
    const request = new Request('https://planner.example.com/', {
      headers: { cookie: 'mp_session=tossed-by-a-sibling' },
    });
    expect(
      readCookie(request, sessionCookieName(KEYMODE_HTTPS))
    ).toBeUndefined();
  });
});
