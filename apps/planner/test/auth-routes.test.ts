import type { Actor, Engine, OAuthIntent } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// The OAuth routes end to end against a fake engine (real mode, https app
// URL): the start route's signed mp_oauth cookie is fed back to the
// callback the way a browser would. next/server's after() only works
// inside a Next request, so it is replaced with a queue the tests drain
// (the rest of next/server stays real: module mocks outlive this file).

const scheduled: (() => unknown)[] = [];
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: (callback: () => unknown) => {
    scheduled.push(callback);
  },
}));

const { GET: start } = await import('../app/api/auth/linear/route');
const { GET: callback } = await import('../app/api/auth/linear/callback/route');

const APP = 'https://planner.example.com';
const SECRET = 'k'.repeat(40);

const ACTOR: Actor = {
  session: {
    id: 'sess-old',
    workspaceId: 'org-1',
    userId: 'user-ana',
    userName: 'Ana Moreno',
    tokens: {
      accessToken: '',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
  },
  isPm: true,
  canWriteLinear: false,
};

/** A signed-in person who is not a PM, with a read-only Linear token. */
const MEMBER: Actor = {
  ...ACTOR,
  session: {
    ...ACTOR.session,
    id: 'sess-member',
    userId: 'user-chloe',
    userName: 'Chloe Diaz',
  },
  isPm: false,
  canWriteLinear: false,
};

interface Calls {
  signIn: { code: string; codeVerifier: string; intent: string }[];
  install: { code: string; actor: Actor }[];
  signOut: string[];
  fullSync: string[];
}

let calls: Calls;
let needsInstall = false;
let signInError: Error | null = null;

function fakeEngine(): Engine {
  const engine = {
    mode: 'linear',
    config: { appUrl: APP, appName: 'Milestone Planner' },
    startOAuth: (intent: OAuthIntent) => ({
      url: `https://linear.app/oauth/authorize?state=st-${intent}`,
      state: `st-${intent}`,
      codeVerifier: `cv-${intent}`,
    }),
    authenticate: (token: string | undefined) =>
      Promise.resolve(
        token === 'old-token' ? ACTOR : token === 'member-token' ? MEMBER : null
      ),
    finishSignIn: (input: Calls['signIn'][number]) => {
      calls.signIn.push(input);
      if (signInError !== null) return Promise.reject(signInError);
      return Promise.resolve({
        sessionToken: 'new-token',
        session: {
          ...ACTOR.session,
          id: 'sess-new',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        needsInstall,
      });
    },
    finishInstall: (input: { code: string; actor: Actor }) => {
      calls.install.push({ code: input.code, actor: input.actor });
      return Promise.resolve({ workspaceId: 'org-1', workspaceName: 'Org' });
    },
    fullSync: (workspaceId: string) => {
      calls.fullSync.push(workspaceId);
      return Promise.resolve({ ok: true });
    },
    signOut: (token: string) => {
      calls.signOut.push(token);
      return Promise.resolve();
    },
  };
  return engine as unknown as Engine;
}

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

beforeEach(() => {
  calls = { signIn: [], install: [], signOut: [], fullSync: [] };
  needsInstall = false;
  signInError = null;
  scheduled.length = 0;
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine());
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

function get(path: string, cookies: Record<string, string> = {}): Request {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return new Request(`${APP}${path}`, {
    headers: cookie === '' ? {} : { cookie },
  });
}

/** The value of a Set-Cookie named `name`, or undefined. */
function setCookie(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${name}=`));
}

function cookieValue(header: string | undefined): string {
  return header?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
}

/** Runs the start route and returns the signed mp_oauth value. */
async function begin(query: string, cookies = {}): Promise<string> {
  const response = await start(get(`/api/auth/linear?${query}`, cookies));
  expect(response.status).toBe(302);
  return cookieValue(setCookie(response, 'mp_oauth'));
}

describe('GET /api/auth/linear', () => {
  test('sends the browser to Linear with a signed, scoped state cookie', async () => {
    const response = await start(
      get('/api/auth/linear?intent=signin&returnTo=/timeline')
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://linear.app/oauth/authorize?state=st-signin'
    );
    const header = setCookie(response, 'mp_oauth') ?? '';
    expect(header).toContain('Path=/api/auth');
    expect(header).toContain('Max-Age=600');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    // Signed, not readable as JSON, and carrying no plain verifier.
    expect(cookieValue(header)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('install and write grants need someone signed in', async () => {
    for (const intent of ['install', 'grant_write']) {
      const response = await start(get(`/api/auth/linear?intent=${intent}`));
      expect(response.headers.get('location')).toBe(
        '/?auth_error=sign_in_first'
      );
    }
    const signedIn = await start(
      get('/api/auth/linear?intent=install', { mp_session: 'old-token' })
    );
    expect(signedIn.status).toBe(302);
  });

  test('anyone signed in may grant write access, PM or not (owner decision 2026-10-21)', async () => {
    const returnTo = '/week?issue=ENG-24';
    const response = await start(
      get(
        `/api/auth/linear?intent=grant_write&returnTo=${encodeURIComponent(returnTo)}`,
        { mp_session: 'member-token' }
      )
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://linear.app/oauth/authorize?state=st-grant_write'
    );
    // The member comes back to the issue they were on, drawer open.
    const oauth = cookieValue(setCookie(response, 'mp_oauth'));
    const done = await callback(
      get('/api/auth/linear/callback?code=c-w&state=st-grant_write', {
        mp_oauth: oauth,
        mp_session: 'member-token',
      })
    );
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(returnTo);
    expect(calls.signIn).toEqual([
      { code: 'c-w', codeVerifier: 'cv-grant_write', intent: 'grant_write' },
    ]);
    expect(cookieValue(setCookie(done, 'mp_session'))).toBe('new-token');
  });

  test('refuses unknown intents and an unusable SESSION_SECRET', async () => {
    const bogus = await start(get('/api/auth/linear?intent=admin'));
    expect(bogus.headers.get('location')).toBe('/?auth_error=invalid_request');
    process.env.SESSION_SECRET = 'too-short';
    const short = await start(get('/api/auth/linear?intent=signin'));
    expect(short.headers.get('location')).toBe('/?auth_error=session_secret');
    expect(setCookie(short, 'mp_oauth')).toBeUndefined();
  });
});

describe('GET /api/auth/linear/callback', () => {
  test('signs in, sets mp_session and returns to returnTo', async () => {
    const oauth = await begin('intent=signin&returnTo=/timeline');
    const response = await callback(
      get('/api/auth/linear/callback?code=c-1&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/timeline');
    expect(calls.signIn).toEqual([
      { code: 'c-1', codeVerifier: 'cv-signin', intent: 'signin' },
    ]);
    const session = setCookie(response, 'mp_session') ?? '';
    expect(cookieValue(session)).toBe('new-token');
    expect(session).toContain('Path=/');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(setCookie(response, 'mp_oauth')).toContain('Max-Age=0');
  });

  test('ends the session the sign-in replaces, after responding', async () => {
    const oauth = await begin('intent=grant_write', {
      mp_session: 'old-token',
    });
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-grant_write', {
        mp_oauth: oauth,
        mp_session: 'old-token',
      })
    );
    expect(response.headers.get('location')).toBe('/week');
    expect(calls.signOut).toEqual([]);
    await Promise.all(scheduled.map((run) => run()));
    expect(calls.signOut).toEqual(['old-token']);
  });

  test('a workspace without the app goes to /setup', async () => {
    needsInstall = true;
    const oauth = await begin('intent=signin&returnTo=/graph');
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(response.headers.get('location')).toBe('/setup');
  });

  test('an off-site returnTo was already dropped when signing the cookie', async () => {
    const oauth = await begin('intent=signin&returnTo=//evil.example/x');
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(response.headers.get('location')).toBe('/week');
  });

  test('a non-ASCII returnTo comes back percent-encoded, not as a 500', async () => {
    const oauth = await begin(
      `intent=signin&returnTo=${encodeURIComponent('/timeline?q=週')}`
    );
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/timeline?q=%E9%80%B1');
    expect(cookieValue(setCookie(response, 'mp_session'))).toBe('new-token');
  });

  test('a state that does not match the cookie is refused', async () => {
    const oauth = await begin('intent=signin');
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-forged', {
        mp_oauth: oauth,
      })
    );
    expect(response.headers.get('location')).toBe('/?auth_error=oauth_state');
    expect(calls.signIn).toEqual([]);
    expect(setCookie(response, 'mp_oauth')).toContain('Max-Age=0');
  });

  test('a missing or tampered cookie reads as expired', async () => {
    const missing = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin')
    );
    expect(missing.headers.get('location')).toBe('/?auth_error=oauth_expired');
    const oauth = await begin('intent=signin');
    const [body = '', sig = ''] = oauth.split('.');
    const tampered = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin', {
        mp_oauth: `${body}x.${sig}`,
      })
    );
    expect(tampered.headers.get('location')).toBe('/?auth_error=oauth_expired');
  });

  test('Linear errors and missing codes come back as auth_error', async () => {
    const oauth = await begin('intent=signin');
    const denied = await callback(
      get('/api/auth/linear/callback?error=access_denied&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(denied.headers.get('location')).toBe('/?auth_error=access_denied');
    const noCode = await callback(
      get('/api/auth/linear/callback?state=st-signin', { mp_oauth: oauth })
    );
    expect(noCode.headers.get('location')).toBe('/?auth_error=oauth_code');
  });

  test('engine refusals keep their code', async () => {
    const refused = new Error('Your Linear account is deactivated.');
    refused.name = 'EngineAuthError';
    Object.assign(refused, { code: 'not_signed_in' });
    signInError = refused;
    const oauth = await begin('intent=signin');
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(response.headers.get('location')).toBe('/?auth_error=not_signed_in');
    expect(setCookie(response, 'mp_session')).toBeUndefined();
  });

  test('an install saves the grant, syncs after responding, opens the timeline', async () => {
    const oauth = await begin('intent=install', { mp_session: 'old-token' });
    const response = await callback(
      get('/api/auth/linear/callback?code=c-install&state=st-install', {
        mp_oauth: oauth,
        mp_session: 'old-token',
      })
    );
    expect(response.headers.get('location')).toBe('/timeline');
    expect(calls.install).toEqual([{ code: 'c-install', actor: ACTOR }]);
    expect(setCookie(response, 'mp_session')).toBeUndefined();
    await Promise.all(scheduled.map((run) => run()));
    expect(calls.fullSync).toEqual(['org-1']);
  });

  test('an install callback without a session is refused', async () => {
    const oauth = await begin('intent=install', { mp_session: 'old-token' });
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-install', {
        mp_oauth: oauth,
      })
    );
    expect(response.headers.get('location')).toBe('/?auth_error=sign_in_first');
    expect(calls.install).toEqual([]);
  });
});
