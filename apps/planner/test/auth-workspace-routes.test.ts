import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { verifyValue } from '../lib/signed-cookie';
import {
  APP,
  cookieHeader,
  cookieValue,
  type FakeEngineState,
  fakeEngine,
  freshState,
  SECRET,
  setCookie,
  stashOf,
  tok,
} from './auth-fake-engine';

// POST /api/auth/switch and POST /api/auth/logout in OAuth mode, where a
// browser holds a session per workspace (owner decision 2026-10-25;
// architecture §8.1): switching between the browser's own sessions (JSON
// for the switcher and the palette, a 303 for plain forms, a dead active
// session recovered from), and signing out of one workspace or all of
// them. As in auth-routes.test.ts, after() becomes a queue the tests
// drain.

const scheduled: (() => unknown)[] = [];
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: (callback: () => unknown) => {
    scheduled.push(callback);
  },
}));

const { POST: switchPost } = await import('../app/api/auth/switch/route');
const { POST: logout } = await import('../app/api/auth/logout/route');

const ACTIVE = '__Host-mp_session';
const STASH = '__Host-mp_sessions';

const ACME = tok('acme');
const GLOBEX = tok('globex');
const INITECH = tok('initech');

let state: FakeEngineState;

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

beforeEach(() => {
  state = freshState();
  for (const [token, id, name, user] of [
    [ACME, 'org-acme', 'Acme', 'user-ana'],
    [GLOBEX, 'org-globex', 'Globex', 'gx-user-ana'],
    [INITECH, 'org-initech', 'Initech', 'in-user-ana'],
  ] as const) {
    state.sessions.set(token, {
      workspaceId: id,
      workspaceName: name,
      userId: user,
      userName: 'Ana Moreno',
      live: true,
    });
  }
  // Ana is a guest in Globex: switching is not a write, so it is open.
  state.sessions.get(GLOBEX)!.readOnly = 'guest';
  scheduled.length = 0;
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine(state));
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

function post(
  path: string,
  fields: Record<string, string>,
  options: {
    cookies?: Record<string, string>;
    json?: boolean;
    origin?: string | null;
  } = {}
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.origin !== null) headers.origin = options.origin ?? APP;
  if (options.json === true) headers.accept = 'application/json';
  const cookie = cookieHeader(options.cookies ?? {});
  if (cookie !== '') headers.cookie = cookie;
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

async function drain(): Promise<void> {
  await Promise.all(scheduled.splice(0).map((run) => run()));
}

const HELD = { [ACTIVE]: ACME, [STASH]: `${GLOBEX}.${INITECH}` };

describe('POST /api/auth/switch', () => {
  test('JSON: 200 { location }, the target active, the previous one first in the stash', async () => {
    const response = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-initech' },
        { cookies: HELD, json: true }
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ location: '/week' });
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(INITECH);
    expect(stashOf(response, STASH)).toEqual([ACME, GLOBEX]);
    // Checked without syncing: checkSession, never authenticate.
    expect(state.calls.checked).toEqual([INITECH]);
  });

  test('a guest may switch (no requireWritable), and a form post gets a 303 to returnTo', async () => {
    const response = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-globex', returnTo: '/timeline?project=p1' },
        { cookies: HELD }
      )
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/timeline?project=p1');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(GLOBEX);
    const away = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-acme', returnTo: '//evil.example' },
        { cookies: { [ACTIVE]: GLOBEX, [STASH]: ACME } }
      )
    );
    expect(away.headers.get('location')).toBe('/week');
  });

  test('never goes to the Referer', async () => {
    const request = post(
      '/api/auth/switch',
      { workspace: 'org-globex' },
      { cookies: HELD }
    );
    request.headers.set('referer', `${APP}/runs`);
    const response = await switchPost(request);
    expect(response.headers.get('location')).toBe('/week');
  });

  test('a workspace this browser does not hold: 404 unknown_workspace, nothing changes', async () => {
    const json = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-umbrella' },
        { cookies: HELD, json: true }
      )
    );
    expect(json.status).toBe(404);
    const body = (await json.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('unknown_workspace');
    expect(body.error.message).toMatch(/not signed in to that workspace/);
    expect(cookieValue(setCookie(json, ACTIVE))).toBe(ACME);
    const form = await switchPost(
      post('/api/auth/switch', { workspace: 'org-umbrella' }, { cookies: HELD })
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe(
      '/week?switch_error=unknown_workspace'
    );
  });

  test('a stashed session that ended: 410 session_ended, pruned and signed out', async () => {
    state.sessions.get(INITECH)!.live = false;
    const response = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-initech' },
        { cookies: HELD, json: true }
      )
    );
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      'Your session for Initech ended. Connect Initech again from the workspace menu to switch to it.'
    );
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(ACME);
    expect(stashOf(response, STASH)).toEqual([GLOBEX]);
    await drain();
    expect(state.calls.signOut).toEqual([INITECH]);
  });

  test('dead-active recovery: the active cookie names no session, a stashed one takes over', async () => {
    const gone = tok('gone');
    const response = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-globex' },
        { cookies: { [ACTIVE]: gone, [STASH]: `${GLOBEX}.${INITECH}` } }
      )
    );
    expect(response.headers.get('location')).toBe('/week');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(GLOBEX);
    expect(stashOf(response, STASH)).toEqual([INITECH]);
    await drain();
    expect(state.calls.signOut).toEqual([gone]);
  });

  test('a failed form switch while signed out goes home', async () => {
    const response = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-umbrella' },
        { cookies: { [STASH]: GLOBEX } }
      )
    );
    expect(response.headers.get('location')).toBe(
      '/?switch_error=unknown_workspace'
    );
  });

  test('cross-origin posts are refused; a missing workspace is invalid_request', async () => {
    const evil = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-globex' },
        { cookies: HELD, origin: 'https://evil.example' }
      )
    );
    expect(evil.status).toBe(403);
    expect(setCookie(evil, ACTIVE)).toBeUndefined();
    const bare = await switchPost(
      post('/api/auth/switch', {}, { cookies: HELD, json: true })
    );
    expect(bare.status).toBe(400);
  });

  test('404 in demo mode and with personal API keys', async () => {
    for (const change of [{ mode: 'fixture' }, { auth: 'api_key' }] as const) {
      Object.assign(state, change);
      const response = await switchPost(
        post('/api/auth/switch', { workspace: 'org-acme' }, { cookies: HELD })
      );
      expect(response.status).toBe(404);
      expect(setCookie(response, ACTIVE)).toBeUndefined();
      state.mode = 'linear';
      state.auth = 'oauth';
    }
  });
});

describe('POST /api/auth/logout (OAuth mode)', () => {
  test('current: signing out of the active workspace promotes the most recent stashed one', async () => {
    const response = await logout(
      post(
        '/api/auth/logout',
        { scope: 'current', workspace: 'org-acme' },
        { cookies: HELD }
      )
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '', APP);
    expect(location.pathname).toBe('/week');
    expect(location.searchParams.get('signed_out')).toBe('1');
    // The notice names the workspace signed out, from a signed value.
    expect(
      verifyValue(location.searchParams.get('from') ?? '', SECRET, Date.now())
    ).toMatchObject({ signedOut: 'Acme' });
    expect(state.calls.signOut).toEqual([ACME]);
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(GLOBEX);
    expect(stashOf(response, STASH)).toEqual([INITECH]);
  });

  test('current: a stale tab signs out the workspace it showed, not the active one', async () => {
    const response = await logout(
      post(
        '/api/auth/logout',
        { scope: 'current', workspace: 'org-initech' },
        { cookies: HELD }
      )
    );
    expect(state.calls.signOut).toEqual([INITECH]);
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(ACME);
    expect(stashOf(response, STASH)).toEqual([GLOBEX]);
    expect(response.headers.get('location')).toStartWith('/week?signed_out=1');
  });

  test('current: a workspace the browser does not hold ends nothing and says so', async () => {
    const response = await logout(
      post(
        '/api/auth/logout',
        { scope: 'current', workspace: 'org-umbrella' },
        { cookies: HELD }
      )
    );
    expect(response.headers.get('location')).toBe('/week?signed_out=none');
    expect(state.calls.signOut).toEqual([]);
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(ACME);
  });

  test('current: the last session clears both cookies and goes home', async () => {
    const response = await logout(
      post(
        '/api/auth/logout',
        { scope: 'current', workspace: 'org-acme' },
        { cookies: { [ACTIVE]: ACME } }
      )
    );
    expect(response.headers.get('location')).toBe('/');
    expect(setCookie(response, ACTIVE)).toContain('Max-Age=0');
    expect(setCookie(response, STASH)).toContain('Max-Age=0');
    expect(state.calls.signOut).toEqual([ACME]);
  });

  test('all: every held session ends (each grant revoked), both cookies cleared', async () => {
    const response = await logout(
      post('/api/auth/logout', { scope: 'all' }, { cookies: HELD })
    );
    expect(response.headers.get('location')).toBe('/');
    expect([...state.calls.signOut].sort()).toEqual(
      [ACME, GLOBEX, INITECH].sort()
    );
    expect(setCookie(response, ACTIVE)).toContain('Max-Age=0');
    expect(setCookie(response, STASH)).toContain('Max-Age=0');
  });

  test('without fields it ends the active session', async () => {
    const response = await logout(
      post('/api/auth/logout', {}, { cookies: HELD })
    );
    expect(state.calls.signOut).toEqual([ACME]);
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(GLOBEX);
  });

  test('a cross-site form cannot sign anyone out', async () => {
    const response = await logout(
      post(
        '/api/auth/logout',
        { scope: 'all' },
        { cookies: HELD, origin: 'https://evil.example' }
      )
    );
    expect(response.status).toBe(403);
    expect(state.calls.signOut).toEqual([]);
  });
});
