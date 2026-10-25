import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { signValue } from '../lib/signed-cookie';
import {
  APP,
  type FakeEngineState,
  fakeEngine,
  freshState,
  SECRET,
  tok,
} from './auth-fake-engine';

// Every auth route with an https APP_URL (architecture §8.1 "Session
// cookies"): the browser sends both the plain names and the __Host- ones,
// with different tokens, and only the __Host- tokens may reach the engine;
// every cookie a response sets is a __Host- one, and the plain names
// only ever come back expired (the legacy clears). A missed reader of a
// plain mp_session would sign everyone out on Railway, and the browser
// suites all run on http, so this is where it is caught.

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
const { POST: switchPost } = await import('../app/api/auth/switch/route');
const { POST: logout } = await import('../app/api/auth/logout/route');
const { POST: demo } = await import('../app/api/auth/demo/route');
const { POST: key } = await import('../app/api/auth/key/route');

const HOST_ACME = tok('acme');
const HOST_GLOBEX = tok('globex');
const PLAIN = tok('plain');
const PLAIN_STASH = tok('plainstash');

let state: FakeEngineState;
let seen: string[];

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

/** Wraps the fake so every token handed to the engine is recorded. */
function recording(engine: Engine): Engine {
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      for (const arg of args) {
        if (typeof arg === 'string') seen.push(arg);
        if (Array.isArray(arg)) {
          for (const item of arg) if (typeof item === 'string') seen.push(item);
        }
      }
      return fn(...args);
    };
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (
        typeof value === 'function' &&
        [
          'authenticate',
          'describeSessions',
          'checkSession',
          'signOut',
        ].includes(String(prop))
      ) {
        return wrap(value as (...args: unknown[]) => unknown);
      }
      return value;
    },
  });
}

beforeEach(() => {
  state = freshState();
  seen = [];
  for (const [token, id] of [
    [HOST_ACME, 'org-acme'],
    [HOST_GLOBEX, 'org-globex'],
    [PLAIN, 'org-acme'],
    [PLAIN_STASH, 'org-initech'],
  ] as const) {
    state.sessions.set(token, {
      workspaceId: id,
      workspaceName: id,
      userId: 'user-ana',
      userName: 'Ana Moreno',
      live: true,
    });
  }
  scheduled.length = 0;
  holder.__milestonePlannerEngine = Promise.resolve(
    recording(fakeEngine(state))
  );
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

/** Plain names (a sibling subdomain could set them) beside the real ones. */
function bothNames(extra: Record<string, string> = {}): string {
  return Object.entries({
    mp_session: PLAIN,
    mp_sessions: PLAIN_STASH,
    '__Host-mp_session': HOST_ACME,
    '__Host-mp_sessions': HOST_GLOBEX,
    ...extra,
  })
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function request(
  method: 'GET' | 'POST',
  path: string,
  options: { cookie: string; body?: string; headers?: Record<string, string> }
): Request {
  return new Request(`${APP}${path}`, {
    method,
    headers: {
      cookie: options.cookie,
      origin: APP,
      'content-type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

/** Every cookie set is __Host-, or an expiry of a plain name. */
function expectOnlyHostCookies(response: Response): void {
  const set = response.headers.getSetCookie();
  for (const header of set) {
    const name = header.split('=')[0] ?? '';
    if (name.startsWith('__Host-')) {
      expect(header).toContain('Secure');
      expect(header).toContain('Path=/;');
      expect(header).not.toMatch(/Domain=/i);
      continue;
    }
    expect(header).toContain('Max-Age=0');
  }
}

function expectOnlyHostTokensRead(): void {
  expect(seen).not.toContain(PLAIN);
  expect(seen).not.toContain(PLAIN_STASH);
}

function oauthValue(intent: string, expectWorkspaceId?: string): string {
  return signValue(
    {
      state: `st-${intent}`,
      codeVerifier: `cv-${intent}`,
      intent,
      returnTo: '/week',
      ...(expectWorkspaceId === undefined ? {} : { expectWorkspaceId }),
    },
    SECRET,
    Date.now() + 60_000
  );
}

describe('every auth route on https reads and sets only __Host- cookies', () => {
  test('GET /api/auth/linear, every intent', async () => {
    for (const intent of [
      'signin',
      'install',
      'grant_write',
      'add_workspace',
    ]) {
      const response = await start(
        request('GET', `/api/auth/linear?intent=${intent}`, {
          cookie: bothNames({ mp_oauth: 'planted.value' }),
        })
      );
      expect(response.status).toBe(302);
      expectOnlyHostCookies(response);
      expect(
        response.headers
          .getSetCookie()
          .some((c) => c.startsWith('__Host-mp_oauth='))
      ).toBe(true);
    }
    expectOnlyHostTokensRead();
  });

  test('GET /api/auth/linear/callback: sign-in, add_workspace, grant_write and install', async () => {
    for (const [intent, expectId, next] of [
      ['signin', undefined, 'org-new'],
      ['add_workspace', undefined, 'org-globex'],
      ['grant_write', 'org-acme', 'org-acme'],
      ['install', 'org-acme', 'org-acme'],
    ] as const) {
      state.nextSignIn = { ...state.nextSignIn, workspaceId: next };
      const response = await callback(
        request('GET', `/api/auth/linear/callback?code=c&state=st-${intent}`, {
          cookie: bothNames({
            mp_oauth: 'planted.value',
            '__Host-mp_oauth': oauthValue(intent, expectId),
          }),
        })
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).not.toContain('auth_error');
      expectOnlyHostCookies(response);
    }
    await Promise.all(scheduled.splice(0).map((run) => run()));
    expectOnlyHostTokensRead();
  });

  test('POST /api/auth/switch', async () => {
    const response = await switchPost(
      request('POST', '/api/auth/switch', {
        cookie: bothNames(),
        body: 'workspace=org-globex',
      })
    );
    expect(response.status).toBe(303);
    expectOnlyHostCookies(response);
    // The plain stash's workspace is not held.
    const initech = await switchPost(
      request('POST', '/api/auth/switch', {
        cookie: bothNames(),
        body: 'workspace=org-initech',
      })
    );
    expect(initech.headers.get('location')).toBe(
      '/week?switch_error=unknown_workspace'
    );
    expectOnlyHostTokensRead();
  });

  test('POST /api/auth/logout, current and all', async () => {
    for (const body of ['scope=current&workspace=org-acme', 'scope=all']) {
      const response = await logout(
        request('POST', '/api/auth/logout', { cookie: bothNames(), body })
      );
      expect(response.status).toBe(303);
      expectOnlyHostCookies(response);
    }
    await Promise.all(scheduled.splice(0).map((run) => run()));
    expectOnlyHostTokensRead();
  });

  test('POST /api/auth/demo (demo mode on https)', async () => {
    state.mode = 'fixture';
    const devSignIn = (userId: string) =>
      Promise.resolve({
        sessionToken: tok(`demo-${userId}`),
        session: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        needsInstall: false,
      });
    holder.__milestonePlannerEngine = Promise.resolve(
      recording(
        Object.assign(Object.create(fakeEngine(state)) as Engine, { devSignIn })
      )
    );
    const response = await demo(
      request('POST', '/api/auth/demo', {
        cookie: bothNames(),
        body: 'userId=user-ana',
      })
    );
    expect(response.status).toBe(303);
    expectOnlyHostCookies(response);
    await Promise.all(scheduled.splice(0).map((run) => run()));
    // The replaced session is the __Host- one.
    expect(state.calls.signOut).toEqual([HOST_ACME]);
    expectOnlyHostTokensRead();
  });

  test('POST /api/auth/key (api_key mode on https)', async () => {
    const signOuts: string[] = [];
    holder.__milestonePlannerEngine = Promise.resolve({
      mode: 'linear',
      config: {
        auth: 'api_key',
        appUrl: APP,
        apiKey: { endpoint: 'https://api.linear.app/graphql' },
      },
      connectApiKey: () =>
        Promise.resolve({
          sessionToken: tok('keysession'),
          session: { workspaceId: 'org-acme' },
          needsInstall: false,
          syncAfter: false,
        }),
      signOut: (token: string) => {
        signOuts.push(token);
        return Promise.resolve({ known: true, keysForgotten: 1 });
      },
      fullSync: () => Promise.resolve({}),
    } as unknown as Engine);
    const response = await key(
      request('POST', '/api/auth/key', {
        cookie: bothNames(),
        body: 'apiKey=lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc',
        headers: { 'x-forwarded-proto': 'https' },
      })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/week');
    expectOnlyHostCookies(response);
    expect(signOuts).toEqual([HOST_ACME]);
  });
});
