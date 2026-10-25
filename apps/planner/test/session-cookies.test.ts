import type { SessionDescription } from '@better-tracker/engine';
import { describe, expect, test } from 'bun:test';

import {
  activate,
  type HeldSessions,
  readHeldSessions,
  without,
} from '../lib/held-sessions';
import {
  activeCookieName,
  activeSessionToken,
  apiKeySessionCookie,
  clearApiKeySessionCookies,
  clearOauthStateCookie,
  clearSessionCookies,
  type CookieScheme,
  cookieScheme,
  isSecureUrl,
  legacyCookieClears,
  MAX_STASHED_SESSIONS,
  oauthStateCookie,
  parseStash,
  readCookie,
  readOauthState,
  serializeCookie,
  sessionCookies,
  stashCookieName,
  stashTokens,
} from '../lib/session-cookies';

// lib/session-cookies.ts, the one place auth cookie names are chosen,
// read and written (architecture §8.1 "Session cookies"), and the pure
// arrangements of lib/held-sessions.ts (owner decision 2026-10-25: a
// browser holds a session per workspace).

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const IN_A_WEEK = '2026-11-01T12:00:00.000Z';
const IN_A_DAY = '2026-10-26T12:00:00.000Z';

const OAUTH_HTTPS: CookieScheme = { mode: 'oauth', secure: true };
const OAUTH_HTTP: CookieScheme = { mode: 'oauth', secure: false };
const DEMO_HTTPS: CookieScheme = { mode: 'demo', secure: true };
const KEY_HTTPS: CookieScheme = { mode: 'api_key', secure: true };

/** A store-shaped token (43 base64url characters). */
function token(seed: string): string {
  return `${seed}${'x'.repeat(43)}`.slice(0, 43);
}

function request(cookie: string): Request {
  return new Request('https://planner.example.com/week', {
    headers: { cookie },
  });
}

function described(
  tok: string,
  workspaceId: string,
  extra: Partial<SessionDescription> = {}
): SessionDescription {
  return {
    token: tok,
    workspaceId,
    workspaceName: workspaceId.replace('org-', ''),
    workspaceUrlKey: workspaceId.replace('org-', ''),
    userId: 'user-ana',
    userName: 'Ana Moreno',
    expiresAt: IN_A_WEEK,
    guest: false,
    installed: true,
    revokedAt: null,
    revokedReason: null,
    ...extra,
  };
}

describe('cookie names per mode and scheme', () => {
  test('https: __Host- names, the OAuth state on Path=/', () => {
    expect(activeCookieName(OAUTH_HTTPS)).toBe('__Host-mp_session');
    expect(stashCookieName(OAUTH_HTTPS)).toBe('__Host-mp_sessions');
    expect(activeCookieName(DEMO_HTTPS)).toBe('__Host-mp_session');
    expect(activeCookieName(KEY_HTTPS)).toBe('__Host-mp_session');
    expect(oauthStateCookie('abc.def', OAUTH_HTTPS)).toBe(
      '__Host-mp_oauth=abc.def; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure'
    );
    expect(clearOauthStateCookie(OAUTH_HTTPS)).toBe(
      '__Host-mp_oauth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
    );
  });

  test('http (local): plain names, the OAuth state only on /api/auth', () => {
    expect(activeCookieName(OAUTH_HTTP)).toBe('mp_session');
    expect(stashCookieName(OAUTH_HTTP)).toBe('mp_sessions');
    expect(oauthStateCookie('abc.def', OAUTH_HTTP)).toBe(
      'mp_oauth=abc.def; Path=/api/auth; Max-Age=600; HttpOnly; SameSite=Lax'
    );
  });

  test('the scheme follows the engine: api_key, demo (fixture) or oauth', () => {
    expect(
      cookieScheme({ mode: 'linear', config: { appUrl: 'https://p.example' } })
    ).toEqual(OAUTH_HTTPS);
    expect(
      cookieScheme({
        mode: 'linear',
        config: { appUrl: 'https://p.example', auth: 'api_key' },
      })
    ).toEqual(KEY_HTTPS);
    expect(
      cookieScheme({ mode: 'fixture', config: { appUrl: 'http://x:3000' } })
    ).toEqual({ mode: 'demo', secure: false });
    expect(isSecureUrl('not a url')).toBe(false);
  });

  test('on https a plain mp_session or mp_oauth is never read', () => {
    const tossed = request('mp_session=tossed; mp_oauth=tossed.sig');
    expect(activeSessionToken(tossed, OAUTH_HTTPS)).toBeUndefined();
    expect(readOauthState(tossed, OAUTH_HTTPS)).toBeUndefined();
    const real = request(
      `mp_session=tossed; __Host-mp_session=${token('a')}; __Host-mp_oauth=v.s`
    );
    expect(activeSessionToken(real, OAUTH_HTTPS)).toBe(token('a'));
    expect(readOauthState(real, OAUTH_HTTPS)).toBe('v.s');
  });

  test('a page cookie jar reads the same way as a request', () => {
    const jar = {
      get: (name: string) =>
        name === '__Host-mp_session' ? { value: token('a') } : undefined,
    };
    expect(activeSessionToken(jar, OAUTH_HTTPS)).toBe(token('a'));
    expect(activeSessionToken(jar, OAUTH_HTTP)).toBeUndefined();
  });

  test('readCookie finds one cookie among several', () => {
    const req = new Request('http://localhost/x', {
      headers: { cookie: 'a=1; mp_session=tok; mp_oauth=x.y' },
    });
    expect(readCookie(req, 'mp_session')).toBe('tok');
    expect(readCookie(req, 'mp_oauth')).toBe('x.y');
    expect(readCookie(req, 'missing')).toBeUndefined();
    expect(readCookie(new Request('http://localhost/'), 'a')).toBeUndefined();
  });

  test('refuses values that would need escaping', () => {
    expect(() =>
      serializeCookie('x', 'a;b', { path: '/', maxAge: 1, secure: false })
    ).toThrow(/escaping/);
  });
});

describe('the stash', () => {
  test('parses most recent first, ignoring invalid entries, duplicates and the active token', () => {
    const [a, b, c] = [token('a'), token('b'), token('c')];
    expect(parseStash(`${b}.${c}`, a)).toEqual([b, c]);
    expect(parseStash(`${b}.not;valid.${b}.${a}.${c}..short`, a)).toEqual([
      b,
      c,
    ]);
    expect(parseStash(undefined)).toEqual([]);
    expect(parseStash('')).toEqual([]);
  });

  test('keeps at most nine', () => {
    const many = Array.from({ length: 12 }, (_, i) => token(`t${i}-`));
    expect(parseStash(many.join('.'))).toEqual(
      many.slice(0, MAX_STASHED_SESSIONS)
    );
  });

  test('round-trips through the cookie, never holding the active token', () => {
    const [a, b, c] = [token('a'), token('b'), token('c')];
    const cookies = sessionCookies(
      {
        active: { token: a, expiresAt: IN_A_WEEK },
        stash: [
          { token: b, expiresAt: IN_A_DAY },
          { token: a, expiresAt: IN_A_WEEK },
          { token: c, expiresAt: IN_A_WEEK },
        ],
      },
      OAUTH_HTTPS,
      NOW
    );
    expect(cookies[0]).toBe(
      `__Host-mp_session=${a}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure`
    );
    // The stash expires with the latest session it holds.
    expect(cookies[1]).toBe(
      `__Host-mp_sessions=${b}.${c}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure`
    );
    const header = cookies
      .slice(0, 2)
      .map((c) => c.split(';')[0])
      .join('; ');
    const back = request(header);
    expect(activeSessionToken(back, OAUTH_HTTPS)).toBe(a);
    expect(stashTokens(back, OAUTH_HTTPS)).toEqual([b, c]);
  });

  test('an empty stash is expired, and only OAuth mode has one', () => {
    const oauth = sessionCookies(
      { active: { token: token('a'), expiresAt: IN_A_WEEK }, stash: [] },
      OAUTH_HTTP,
      NOW
    );
    expect(oauth).toContain(
      'mp_sessions=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    );
    const demo = sessionCookies(
      {
        active: { token: token('a'), expiresAt: IN_A_WEEK },
        stash: [{ token: token('b'), expiresAt: IN_A_WEEK }],
      },
      { mode: 'demo', secure: false },
      NOW
    );
    expect(demo).toHaveLength(1);
    expect(demo[0]).toStartWith('mp_session=');
    const req = request(`mp_session=${token('a')}; mp_sessions=${token('b')}`);
    expect(stashTokens(req, { mode: 'demo', secure: false })).toEqual([]);
    expect(stashTokens(req, { mode: 'api_key', secure: false })).toEqual([]);
  });

  test('an expired or unparseable expiry never yields a negative Max-Age', () => {
    const [cookie] = sessionCookies(
      { active: { token: token('a'), expiresAt: 'soon' }, stash: [] },
      OAUTH_HTTP,
      NOW
    );
    expect(cookie).toContain('Max-Age=0;');
  });
});

describe('legacy names and clearing', () => {
  test('https responses expire the plain names used before the __Host- ones', () => {
    expect(legacyCookieClears(OAUTH_HTTPS)).toEqual([
      'mp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      'mp_oauth=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    ]);
    expect(legacyCookieClears(DEMO_HTTPS)).toHaveLength(2);
    expect(legacyCookieClears(OAUTH_HTTP)).toEqual([]);
    expect(legacyCookieClears(KEY_HTTPS)).toEqual([]);
    const cookies = sessionCookies(
      { active: { token: token('a'), expiresAt: IN_A_WEEK }, stash: [] },
      OAUTH_HTTPS,
      NOW
    );
    expect(cookies.slice(-2)).toEqual(legacyCookieClears(OAUTH_HTTPS));
  });

  test('clearSessionCookies expires the active cookie and the stash', () => {
    expect(clearSessionCookies(OAUTH_HTTP)).toEqual([
      'mp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'mp_sessions=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
    expect(clearSessionCookies(KEY_HTTPS)).toEqual(
      clearApiKeySessionCookies(true)
    );
  });
});

describe('api_key mode keeps its cookies exactly (§7.4)', () => {
  test('a browser-session cookie, Secure and __Host- on https', () => {
    expect(apiKeySessionCookie('tok_123', { secure: false })).toBe(
      'mp_session=tok_123; Path=/; HttpOnly; SameSite=Lax'
    );
    const secure = apiKeySessionCookie('tok_123', { secure: true });
    expect(secure).toBe(
      '__Host-mp_session=tok_123; Path=/; HttpOnly; SameSite=Lax; Secure'
    );
    expect(secure).not.toMatch(/Max-Age|Expires|Domain/i);
    expect(() => apiKeySessionCookie('a;b', { secure: false })).toThrow();
    expect(() =>
      sessionCookies({ active: null, stash: [] }, KEY_HTTPS, NOW)
    ).toThrow();
  });

  test('clearApiKeySessionCookies expires both session names and both stash names', () => {
    const cookies = clearApiKeySessionCookies(false);
    expect(cookies.map((c) => c.split('=')[0])).toEqual([
      'mp_session',
      '__Host-mp_session',
      'mp_sessions',
      '__Host-mp_sessions',
    ]);
    for (const cookie of cookies) expect(cookie).toContain('Max-Age=0');
    expect(cookies[1]).toContain('Secure');
    expect(cookies[3]).toContain('Secure');
  });
});

describe('held sessions', () => {
  const [a, b, c, dead] = [token('a'), token('b'), token('c'), token('d')];

  test('reads the active cookie and the stash, dropping what names no live session', async () => {
    const engine = {
      describeSessions: (tokens: readonly string[]) =>
        Promise.resolve(
          tokens.map((t) =>
            t === a
              ? described(a, 'org-acme')
              : t === b
                ? described(b, 'org-globex')
                : t === c
                  ? // A second session for Globex: dropped.
                    described(c, 'org-globex')
                  : null
          )
        ),
    };
    const held = await readHeldSessions(
      engine,
      request(`__Host-mp_session=${a}; __Host-mp_sessions=${b}.${dead}.${c}`),
      OAUTH_HTTPS
    );
    expect(held.activeToken).toBe(a);
    expect(held.active?.workspaceId).toBe('org-acme');
    expect(held.stash.map((s) => s.token)).toEqual([b]);
    expect(held.dropped).toEqual([dead, c]);
  });

  test('a dead active cookie reads as none, the stash still held', async () => {
    const held = await readHeldSessions(
      {
        describeSessions: (tokens) =>
          Promise.resolve(
            tokens.map((t) => (t === b ? described(b, 'org-globex') : null))
          ),
      },
      request(`__Host-mp_session=${dead}; __Host-mp_sessions=${b}`),
      OAUTH_HTTPS
    );
    expect(held.active).toBeNull();
    expect(held.stash.map((s) => s.workspaceId)).toEqual(['org-globex']);
    expect(held.dropped).toEqual([dead]);
  });

  test('outside OAuth mode only the active token is read, nothing described', async () => {
    let asked = false;
    const held = await readHeldSessions(
      {
        describeSessions: () => {
          asked = true;
          return Promise.resolve([]);
        },
      },
      request(`__Host-mp_session=${a}; __Host-mp_sessions=${b}`),
      DEMO_HTTPS
    );
    expect(asked).toBe(false);
    expect(held).toEqual({
      activeToken: a,
      active: null,
      stash: [],
      dropped: [],
    });
  });

  const held: HeldSessions = {
    activeToken: a,
    active: described(a, 'org-acme'),
    stash: [described(b, 'org-globex'), described(c, 'org-initech')],
    dropped: [dead],
  };

  test('activate: the new session first, the previous active one first in the stash', () => {
    const next = {
      token: token('n'),
      workspaceId: 'org-umbrella',
      expiresAt: IN_A_WEEK,
    };
    const result = activate(held, next);
    expect(result.active).toEqual(next);
    expect(result.stash.map((s) => s.workspaceId)).toEqual([
      'org-acme',
      'org-globex',
      'org-initech',
    ]);
    expect(result.signOut).toEqual([dead]);
  });

  test('activate: a sign-in again replaces the session held for its workspace', () => {
    const again = {
      token: token('n'),
      workspaceId: 'org-globex',
      expiresAt: IN_A_WEEK,
    };
    const result = activate(held, again);
    expect(result.stash.map((s) => s.workspaceId)).toEqual([
      'org-acme',
      'org-initech',
    ]);
    expect(result.signOut).toEqual([dead, b]);
  });

  test('activate: switching to a stashed session swaps it with the active one', () => {
    const result = activate(held, held.stash[1]);
    expect(result.active?.workspaceId).toBe('org-initech');
    expect(result.stash.map((s) => s.workspaceId)).toEqual([
      'org-acme',
      'org-globex',
    ]);
  });

  test('activate: past nine stashed, the oldest is signed out, not just dropped', () => {
    const full: HeldSessions = {
      activeToken: a,
      active: described(a, 'org-0'),
      stash: Array.from({ length: 9 }, (_, i) =>
        described(token(`s${i + 1}-`), `org-${i + 1}`)
      ),
      dropped: [],
    };
    const next = {
      token: token('n'),
      workspaceId: 'org-new',
      expiresAt: IN_A_WEEK,
    };
    const result = activate(full, next);
    expect(result.stash).toHaveLength(MAX_STASHED_SESSIONS);
    expect(result.stash[0]?.workspaceId).toBe('org-0');
    expect(result.signOut).toEqual([token('s9-')]);
  });

  test('without: ending the active session promotes the most recent stashed one', () => {
    const result = without(held, a);
    expect(result.active?.workspaceId).toBe('org-globex');
    expect(result.stash.map((s) => s.workspaceId)).toEqual(['org-initech']);
    expect(result.signOut).toEqual([dead]);
  });

  test('without: ending a stashed session keeps the active one', () => {
    const result = without(held, c);
    expect(result.active?.workspaceId).toBe('org-acme');
    expect(result.stash.map((s) => s.workspaceId)).toEqual(['org-globex']);
  });

  test('without: a dead active cookie stays empty (nothing is promoted)', () => {
    const result = without({ ...held, active: null }, c);
    expect(result.active).toBeNull();
    expect(result.stash.map((s) => s.workspaceId)).toEqual(['org-globex']);
  });
});
