import { describe, expect, test } from 'bun:test';

import {
  addWorkspaceHref,
  connectHref,
  parseIntent,
  parseOAuthPayload,
  redirectWithCookies,
  resolveSessionSecret,
  sanitizeReturnTo,
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

  test('refuses dot segments that normalise to a protocol-relative path', () => {
    // The origin of "/.//evil.example" against the planner stays the
    // planner's, but its normalised path is "//evil.example": Next's
    // client router hard-navigates to that path for a page-level
    // redirect(), and the browser reads it as another host.
    for (const value of [
      '/.//evil.example',
      '/..//evil.example',
      '/%2e//evil.example',
      '/%2E%2E//evil.example',
      '/a/..//evil.example',
      '/./\\evil.example',
      '/.//evil.example/login?x=1#y',
    ]) {
      expect(sanitizeReturnTo(value)).toBe('/week');
      expect(sanitizeReturnTo(value, '/settings')).toBe('/settings');
    }
  });

  test('returns the normalised path, never the raw value', () => {
    // What the caller redirects to is exactly what was checked.
    expect(sanitizeReturnTo('/./timeline')).toBe('/timeline');
    expect(sanitizeReturnTo('/a/../issues?x=1#y')).toBe('/issues?x=1#y');
    expect(sanitizeReturnTo('/%2e/week')).toBe('/week');
    expect(sanitizeReturnTo('/x//y')).toBe('/x//y');
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

describe('redirectWithCookies', () => {
  test('keeps every Set-Cookie header, never cached', () => {
    const response = redirectWithCookies('/week', [
      'a=1; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'b=2; Path=/; Max-Age=60; HttpOnly; SameSite=Lax',
    ]);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/week');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
});

describe('OAuth state', () => {
  test('intent defaults to sign-in and rejects unknown values', () => {
    expect(parseIntent(null)).toBe('signin');
    expect(parseIntent('install')).toBe('install');
    expect(parseIntent('grant_write')).toBe('grant_write');
    expect(parseIntent('add_workspace')).toBe('add_workspace');
    expect(parseIntent('admin')).toBeNull();
    expect(parseIntent('toString')).toBeNull();
  });

  test('install and grant_write carry the workspace they were started for', () => {
    const base = { state: 'st', codeVerifier: 'cv', returnTo: '/week' };
    for (const intent of ['install', 'grant_write']) {
      // Without it the payload is refused (it reads as expired).
      expect(parseOAuthPayload({ ...base, intent })).toBeNull();
      const payload: unknown = parseOAuthPayload({
        ...base,
        intent,
        expectWorkspaceId: 'org-acme',
      });
      expect(payload).toEqual({
        ...base,
        intent,
        expectWorkspaceId: 'org-acme',
      });
      // Only an id's characters.
      expect(
        parseOAuthPayload({ ...base, intent, expectWorkspaceId: 'a b' })
      ).toBeNull();
    }
    for (const intent of ['signin', 'add_workspace']) {
      const payload: unknown = parseOAuthPayload({ ...base, intent });
      expect(payload).toEqual({ ...base, intent });
    }
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
        expectWorkspaceId: 'org-acme',
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

describe('connect another workspace (owner decision 2026-10-25)', () => {
  test('the connect page and its Linear link carry a sanitized returnTo', () => {
    expect(connectHref()).toBe('/setup/connect');
    expect(connectHref('/week')).toBe('/setup/connect');
    expect(connectHref('/timeline?milestone=m1')).toBe(
      '/setup/connect?returnTo=%2Ftimeline%3Fmilestone%3Dm1'
    );
    expect(connectHref('//evil.example')).toBe('/setup/connect');
    expect(addWorkspaceHref()).toBe('/api/auth/linear?intent=add_workspace');
    expect(addWorkspaceHref('/issues/ENG-1')).toBe(
      '/api/auth/linear?intent=add_workspace&returnTo=%2Fissues%2FENG-1'
    );
    expect(addWorkspaceHref('https://evil.example')).toBe(
      '/api/auth/linear?intent=add_workspace'
    );
  });
});
