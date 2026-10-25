import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { signValue, verifyValue } from '../lib/signed-cookie';
import {
  APP,
  cookieHeader,
  cookieValue,
  engineError,
  type FakeEngineState,
  fakeEngine,
  freshState,
  SECRET,
  setCookie,
  stashOf,
  tok,
} from './auth-fake-engine';

// The OAuth routes end to end against a fake engine (real mode, https app
// URL, so the cookies are the __Host- ones): the start route's signed
// state cookie is fed back to the callback the way a browser would.
// next/server's after() only works inside a Next request, so it is
// replaced with a queue the tests drain (the rest of next/server stays
// real: module mocks outlive this file). Several workspaces per browser
// (owner decision 2026-10-25): the callback's rules for a workspace the
// browser already holds, for the others it keeps, for grant_write and for
// an install by a stashed session.

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

const ACTIVE = '__Host-mp_session';
const STASH = '__Host-mp_sessions';
const OAUTH = '__Host-mp_oauth';

const ACME = tok('acme');
const GLOBEX = tok('globex');
const INITECH = tok('initech');
const GUEST = tok('guest');
const UNSYNCED = tok('unsynced');

let state: FakeEngineState;

function seed(): void {
  state.sessions.set(ACME, {
    workspaceId: 'org-acme',
    workspaceName: 'Acme',
    userId: 'user-ana',
    userName: 'Ana Moreno',
    live: true,
  });
  state.sessions.set(GLOBEX, {
    workspaceId: 'org-globex',
    workspaceName: 'Globex',
    userId: 'gx-user-gia',
    userName: 'Gia Ruiz',
    live: true,
  });
  state.sessions.set(INITECH, {
    workspaceId: 'org-initech',
    workspaceName: 'Initech',
    userId: 'in-user-ana',
    userName: 'Ana Moreno',
    live: true,
  });
  state.sessions.set(GUEST, {
    workspaceId: 'org-umbrella',
    workspaceName: 'Umbrella',
    userId: 'user-gus',
    userName: 'Gus Hart',
    live: true,
    readOnly: 'guest',
  });
  state.sessions.set(UNSYNCED, {
    workspaceId: 'org-fresh',
    workspaceName: 'Fresh',
    userId: 'user-fay',
    userName: 'Fay Lin',
    live: true,
    readOnly: 'not_synced',
  });
}

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

beforeEach(() => {
  state = freshState();
  seed();
  scheduled.length = 0;
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine(state));
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

function get(path: string, cookies: Record<string, string> = {}): Request {
  const cookie = cookieHeader(cookies);
  return new Request(`${APP}${path}`, {
    headers: cookie === '' ? {} : { cookie },
  });
}

async function drain(): Promise<void> {
  await Promise.all(scheduled.splice(0).map((run) => run()));
}

/** Runs the start route and returns the signed OAuth state value. */
async function begin(
  query: string,
  cookies: Record<string, string> = {}
): Promise<string> {
  const response = await start(get(`/api/auth/linear?${query}`, cookies));
  expect(response.status).toBe(302);
  return cookieValue(setCookie(response, OAUTH));
}

/** Runs the callback for `intent` with the given browser cookies. */
async function finish(
  intent: string,
  oauth: string,
  cookies: Record<string, string> = {},
  code = 'c-1'
): Promise<Response> {
  return callback(
    get(`/api/auth/linear/callback?code=${code}&state=st-${intent}`, {
      [OAUTH]: oauth,
      ...cookies,
    })
  );
}

describe('GET /api/auth/linear', () => {
  test('sends the browser to Linear with a signed __Host- state cookie on Path=/', async () => {
    const response = await start(
      get('/api/auth/linear?intent=signin&returnTo=/timeline')
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://linear.app/oauth/authorize?state=st-signin'
    );
    const header = setCookie(response, OAUTH) ?? '';
    expect(header).toContain('Path=/;');
    expect(header).toContain('Max-Age=600');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    // Signed, not readable as JSON, and carrying no plain verifier.
    expect(cookieValue(header)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // The names used before the __Host- ones are expired.
    expect(setCookie(response, 'mp_oauth')).toContain('Max-Age=0');
    expect(setCookie(response, 'mp_session')).toContain('Max-Age=0');
  });

  test('install and write grants need someone signed in, and sign the active workspace', async () => {
    for (const intent of ['install', 'grant_write']) {
      const response = await start(get(`/api/auth/linear?intent=${intent}`));
      expect(response.headers.get('location')).toBe(
        '/?auth_error=sign_in_first'
      );
    }
    // A plain mp_session is not read on https.
    const tossed = await start(
      get('/api/auth/linear?intent=install', { mp_session: ACME })
    );
    expect(tossed.headers.get('location')).toBe('/?auth_error=sign_in_first');
    for (const intent of ['install', 'grant_write']) {
      const oauth = await begin(`intent=${intent}`, {
        [ACTIVE]: GLOBEX,
        [STASH]: ACME,
      });
      expect(verifyValue(oauth, SECRET, Date.now())).toMatchObject({
        intent,
        expectWorkspaceId: 'org-globex',
      });
    }
  });

  test('add_workspace starts signed in or out; at 10 workspaces it is refused', async () => {
    const out = await begin('intent=add_workspace');
    expect(verifyValue(out, SECRET, Date.now())).toMatchObject({
      intent: 'add_workspace',
    });
    expect(verifyValue(out, SECRET, Date.now())?.expectWorkspaceId).toBe(
      undefined
    );
    await begin('intent=add_workspace&returnTo=%2Ftimeline', {
      [ACTIVE]: ACME,
    });

    const many = Array.from({ length: 9 }, (_, i) => tok(`ws${i}`));
    many.forEach((token, i) =>
      state.sessions.set(token, {
        workspaceId: `org-${i}`,
        workspaceName: `W${i}`,
        userId: 'user-ana',
        userName: 'Ana Moreno',
        live: true,
      })
    );
    const full = await start(
      get('/api/auth/linear?intent=add_workspace', {
        [ACTIVE]: ACME,
        [STASH]: many.join('.'),
      })
    );
    expect(full.status).toBe(303);
    expect(full.headers.get('location')).toBe(
      '/?auth_error=too_many_workspaces'
    );
    expect(setCookie(full, OAUTH)).toBeUndefined();
  });

  test('anyone signed in may grant write access (owner decisions 2026-10-21, 2026-10-22)', async () => {
    const returnTo = '/week?issue=ENG-24';
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-acme' };
    const oauth = await begin(
      `intent=grant_write&returnTo=${encodeURIComponent(returnTo)}`,
      { [ACTIVE]: ACME }
    );
    const done = await finish('grant_write', oauth, { [ACTIVE]: ACME }, 'c-w');
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(returnTo);
    expect(state.calls.signIn).toEqual([
      {
        code: 'c-w',
        codeVerifier: 'cv-grant_write',
        intent: 'grant_write',
        expectWorkspaceId: 'org-acme',
      },
    ]);
    expect(cookieValue(setCookie(done, ACTIVE))).toBe(tok('new1'));
  });

  test('a guest is offered no write grant and no install', async () => {
    for (const intent of ['install', 'grant_write']) {
      const response = await start(
        get(`/api/auth/linear?intent=${intent}&returnTo=%2Ftimeline`, {
          [ACTIVE]: GUEST,
        })
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/?auth_error=read_only');
      expect(setCookie(response, OAUTH)).toBeUndefined();
    }
    // Signing in (to read) and adding a workspace still work for a guest.
    await begin('intent=signin', { [ACTIVE]: GUEST });
    await begin('intent=add_workspace', { [ACTIVE]: GUEST });
  });

  test('before the first sync lands, an install may start but no write grant', async () => {
    await begin('intent=install', { [ACTIVE]: UNSYNCED });
    const grant = await start(
      get('/api/auth/linear?intent=grant_write', { [ACTIVE]: UNSYNCED })
    );
    expect(grant.headers.get('location')).toBe('/?auth_error=read_only');
  });

  test('refuses unknown intents and an unusable SESSION_SECRET', async () => {
    const bogus = await start(get('/api/auth/linear?intent=admin'));
    expect(bogus.headers.get('location')).toBe('/?auth_error=invalid_request');
    process.env.SESSION_SECRET = 'too-short';
    const short = await start(get('/api/auth/linear?intent=signin'));
    expect(short.headers.get('location')).toBe('/?auth_error=session_secret');
    expect(setCookie(short, OAUTH)).toBeUndefined();
  });
});

describe('GET /api/auth/linear/callback', () => {
  test('signs in, sets the active cookie and returns to returnTo', async () => {
    const oauth = await begin('intent=signin&returnTo=/timeline');
    const response = await finish('signin', oauth);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/timeline');
    expect(state.calls.signIn).toEqual([
      { code: 'c-1', codeVerifier: 'cv-signin', intent: 'signin' },
    ]);
    const session = setCookie(response, ACTIVE) ?? '';
    expect(cookieValue(session)).toBe(tok('new1'));
    expect(session).toContain('Path=/;');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toMatch(/Max-Age=60\d{4}/);
    // No other workspace held: the stash is expired.
    expect(setCookie(response, STASH)).toContain('Max-Age=0');
    expect(setCookie(response, OAUTH)).toContain('Max-Age=0');
    expect(setCookie(response, 'mp_session')).toContain('Max-Age=0');
  });

  test('a new workspace becomes active; the others stay in the stash, most recent first', async () => {
    state.nextSignIn = {
      ...state.nextSignIn,
      workspaceId: 'org-new',
      workspaceName: 'New',
    };
    const oauth = await begin('intent=add_workspace', { [ACTIVE]: ACME });
    const response = await finish('add_workspace', oauth, {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    expect(response.headers.get('location')).toBe('/week');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(tok('new1'));
    expect(stashOf(response, STASH)).toEqual([ACME, GLOBEX]);
    await drain();
    expect(state.calls.signOut).toEqual([]);
  });

  test('add_workspace back from a workspace the browser holds keeps that session and ends the new one', async () => {
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-globex' };
    const oauth = await begin('intent=add_workspace', { [ACTIVE]: ACME });
    const response = await finish('add_workspace', oauth, {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    expect(response.headers.get('location')).toBe('/week?connect=same');
    // The held session (and its grant) is kept and made active.
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(GLOBEX);
    expect(stashOf(response, STASH)).toEqual([ACME]);
    // The new grant was ended before the response.
    expect(state.calls.signOut).toEqual([tok('new1')]);
    expect(state.calls.checked).toEqual([GLOBEX]);
    await drain();
    expect(state.calls.signOut).toEqual([tok('new1')]);
  });

  test('a plain sign-in back from the active workspace keeps it too', async () => {
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-acme' };
    const oauth = await begin('intent=signin');
    const response = await finish('signin', oauth, { [ACTIVE]: ACME });
    expect(response.headers.get('location')).toBe('/week?connect=same');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(ACME);
    expect(state.calls.signOut).toEqual([tok('new1')]);
  });

  test('a held session whose grant died is replaced by the new sign-in', async () => {
    state.sessions.get(GLOBEX)!.live = false;
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-globex' };
    const oauth = await begin('intent=add_workspace', { [ACTIVE]: ACME });
    const response = await finish('add_workspace', oauth, {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    expect(response.headers.get('location')).toBe('/week');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(tok('new1'));
    expect(stashOf(response, STASH)).toEqual([ACME]);
    expect(state.calls.signOut).toEqual([]);
    await drain();
    expect(state.calls.signOut).toEqual([GLOBEX]);
  });

  test('grant_write replaces the held session of its workspace, after responding; others stay', async () => {
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-acme' };
    const oauth = await begin('intent=grant_write', {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    const response = await finish('grant_write', oauth, {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    expect(response.headers.get('location')).toBe('/week');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(tok('new1'));
    expect(stashOf(response, STASH)).toEqual([GLOBEX]);
    expect(state.calls.checked).toEqual([]);
    expect(state.calls.signOut).toEqual([]);
    await drain();
    expect(state.calls.signOut).toEqual([ACME]);
  });

  test('grant_write is for the workspace it started in, even after a switch in another tab', async () => {
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-acme' };
    const oauth = await begin('intent=grant_write', {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    // Meanwhile the browser switched to Globex.
    const response = await finish('grant_write', oauth, {
      [ACTIVE]: GLOBEX,
      [STASH]: ACME,
    });
    expect(state.calls.signIn[0]?.expectWorkspaceId).toBe('org-acme');
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(tok('new1'));
    expect(stashOf(response, STASH)).toEqual([GLOBEX]);
    await drain();
    expect(state.calls.signOut).toEqual([ACME]);
  });

  test("the engine's grant_wrong_workspace lands on the landing page with its code", async () => {
    state.nextSignIn = {
      ...state.nextSignIn,
      error: engineError('EngineAuthError', 'grant_wrong_workspace'),
    };
    const oauth = await begin('intent=grant_write', { [ACTIVE]: ACME });
    const response = await finish('grant_write', oauth, { [ACTIVE]: ACME });
    expect(response.headers.get('location')).toBe(
      '/?auth_error=grant_wrong_workspace'
    );
    expect(setCookie(response, ACTIVE)).toBeUndefined();
  });

  test('past ten workspaces a plain sign-in signs out the oldest stashed one', async () => {
    const many = Array.from({ length: 9 }, (_, i) => tok(`ws${i}`));
    many.forEach((token, i) =>
      state.sessions.set(token, {
        workspaceId: `org-${i}`,
        workspaceName: `W${i}`,
        userId: 'user-ana',
        userName: 'Ana Moreno',
        live: true,
      })
    );
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-eleven' };
    const oauth = await begin('intent=signin');
    const response = await finish('signin', oauth, {
      [ACTIVE]: ACME,
      [STASH]: many.join('.'),
    });
    expect(stashOf(response, STASH)).toEqual([ACME, ...many.slice(0, 8)]);
    await drain();
    expect(state.calls.signOut).toEqual([many[8]]);
  });

  test('a token that names no session any more is dropped and signed out', async () => {
    const gone = tok('gone');
    const oauth = await begin('intent=signin');
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-new' };
    const response = await finish('signin', oauth, {
      [ACTIVE]: gone,
      [STASH]: `${GLOBEX}.not-a-token!`,
    });
    expect(stashOf(response, STASH)).toEqual([GLOBEX]);
    await drain();
    expect(state.calls.signOut).toEqual([gone]);
  });

  test('a workspace without the app goes to /setup', async () => {
    state.nextSignIn = { ...state.nextSignIn, needsInstall: true };
    const oauth = await begin('intent=signin&returnTo=/graph');
    const response = await finish('signin', oauth);
    expect(response.headers.get('location')).toBe('/setup');
  });

  test('an off-site returnTo was already dropped when signing the cookie', async () => {
    const oauth = await begin('intent=signin&returnTo=//evil.example/x');
    const response = await finish('signin', oauth);
    expect(response.headers.get('location')).toBe('/week');
  });

  test('a non-ASCII returnTo comes back percent-encoded, not as a 500', async () => {
    const oauth = await begin(
      `intent=signin&returnTo=${encodeURIComponent('/timeline?q=週')}`
    );
    const response = await finish('signin', oauth);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/timeline?q=%E9%80%B1');
  });

  test('add_workspace from the open interstitial returns to its page', async () => {
    state.nextSignIn = { ...state.nextSignIn, workspaceId: 'org-new' };
    const oauth = await begin(
      `intent=add_workspace&returnTo=${encodeURIComponent('/timeline?milestone=m1')}`
    );
    const response = await finish('add_workspace', oauth);
    expect(response.headers.get('location')).toBe('/timeline?milestone=m1');
  });

  test('a state that does not match the cookie is refused', async () => {
    const oauth = await begin('intent=signin');
    const response = await callback(
      get('/api/auth/linear/callback?code=c&state=st-forged', {
        [OAUTH]: oauth,
      })
    );
    expect(response.headers.get('location')).toBe('/?auth_error=oauth_state');
    expect(state.calls.signIn).toEqual([]);
    expect(setCookie(response, OAUTH)).toContain('Max-Age=0');
  });

  test('a missing, tampered or plain-named cookie reads as expired', async () => {
    const missing = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin')
    );
    expect(missing.headers.get('location')).toBe('/?auth_error=oauth_expired');
    const oauth = await begin('intent=signin');
    const [body = '', sig = ''] = oauth.split('.');
    const tampered = await finish('signin', `${body}x.${sig}`);
    expect(tampered.headers.get('location')).toBe('/?auth_error=oauth_expired');
    // A sibling subdomain can set a plain mp_oauth, never __Host-mp_oauth.
    const planted = await callback(
      get('/api/auth/linear/callback?code=c&state=st-signin', {
        mp_oauth: oauth,
      })
    );
    expect(planted.headers.get('location')).toBe('/?auth_error=oauth_expired');
  });

  test('an install or write grant state without its workspace reads as expired', async () => {
    for (const intent of ['install', 'grant_write']) {
      const value = signValue(
        {
          state: `st-${intent}`,
          codeVerifier: 'cv',
          intent,
          returnTo: '/week',
        },
        SECRET,
        Date.now() + 60_000
      );
      const response = await finish(intent, value, { [ACTIVE]: ACME });
      expect(response.headers.get('location')).toBe(
        '/?auth_error=oauth_expired'
      );
    }
    expect(state.calls.signIn).toEqual([]);
    expect(state.calls.install).toEqual([]);
  });

  test('Linear errors and missing codes come back as auth_error', async () => {
    const oauth = await begin('intent=signin');
    const denied = await callback(
      get('/api/auth/linear/callback?error=access_denied&state=st-signin', {
        [OAUTH]: oauth,
      })
    );
    expect(denied.headers.get('location')).toBe('/?auth_error=access_denied');
    const noCode = await callback(
      get('/api/auth/linear/callback?state=st-signin', { [OAUTH]: oauth })
    );
    expect(noCode.headers.get('location')).toBe('/?auth_error=oauth_code');
  });

  test('engine refusals keep their code', async () => {
    for (const code of [
      'not_signed_in',
      'workspace_not_allowed',
      'workspace_blocked',
    ]) {
      state.nextSignIn = {
        ...state.nextSignIn,
        error: engineError('EngineAuthError', code),
      };
      const oauth = await begin('intent=signin');
      const response = await finish('signin', oauth);
      expect(response.headers.get('location')).toBe(`/?auth_error=${code}`);
      expect(setCookie(response, ACTIVE)).toBeUndefined();
    }
  });

  test('an install by the active session saves the grant, syncs after responding, opens the timeline', async () => {
    const oauth = await begin('intent=install', { [ACTIVE]: ACME });
    const response = await finish(
      'install',
      oauth,
      { [ACTIVE]: ACME, [STASH]: GLOBEX },
      'c-install'
    );
    expect(response.headers.get('location')).toBe('/timeline');
    expect(state.calls.install).toEqual([
      {
        code: 'c-install',
        actor: expect.objectContaining({
          session: expect.objectContaining({ workspaceId: 'org-acme' }),
        }),
        expectWorkspaceId: 'org-acme',
      },
    ]);
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(ACME);
    expect(stashOf(response, STASH)).toEqual([GLOBEX]);
    await drain();
    expect(state.calls.fullSync).toEqual(['org-acme']);
  });

  test('an install started in one workspace is finished by its session, even from the stash', async () => {
    const oauth = await begin('intent=install', {
      [ACTIVE]: GLOBEX,
      [STASH]: ACME,
    });
    // The browser switched to Acme in another tab meanwhile.
    const response = await finish('install', oauth, {
      [ACTIVE]: ACME,
      [STASH]: GLOBEX,
    });
    expect(response.headers.get('location')).toBe('/timeline');
    expect(state.calls.install[0]?.actor.session.workspaceId).toBe(
      'org-globex'
    );
    expect(state.calls.install[0]?.expectWorkspaceId).toBe('org-globex');
    // That session becomes active.
    expect(cookieValue(setCookie(response, ACTIVE))).toBe(GLOBEX);
    expect(stashOf(response, STASH)).toEqual([ACME]);
  });

  test('an install for a workspace the browser no longer holds is refused', async () => {
    const oauth = await begin('intent=install', { [ACTIVE]: GLOBEX });
    const response = await finish('install', oauth, { [ACTIVE]: ACME });
    expect(response.headers.get('location')).toBe('/?auth_error=sign_in_first');
    expect(state.calls.install).toEqual([]);
    const none = await finish('install', oauth);
    expect(none.headers.get('location')).toBe('/?auth_error=sign_in_first');
  });

  test("the engine's read_only refusal of a write grant lands on the landing page", async () => {
    state.nextSignIn = {
      ...state.nextSignIn,
      error: Object.assign(
        new Error('Guests in Linear can look but not change anything here.'),
        { name: 'EngineAuthError', code: 'read_only' }
      ),
    };
    const oauth = await begin('intent=grant_write', { [ACTIVE]: ACME });
    const response = await finish('grant_write', oauth, { [ACTIVE]: ACME });
    expect(response.headers.get('location')).toBe('/?auth_error=read_only');
    expect(setCookie(response, ACTIVE)).toBeUndefined();
    expect(state.calls.signOut).toEqual([]);
  });
});
