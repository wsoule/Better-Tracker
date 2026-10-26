import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { RATE_LIMITS, resetProcessRateLimiters } from '../lib/rate-limit';
import {
  APP,
  cookieHeader,
  cookieValue,
  type FakeEngineState,
  fakeEngine,
  freshState,
  SECRET,
  setCookie,
  tok,
} from './auth-fake-engine';

// The rate limits in the routes (owner decision 2026-10-25, architecture
// §8.1 "Rate limits"), against the auth fake engine: the OAuth start,
// switch and sign-out by client IP (X-Real-IP), with the callback and the
// demo sign-in never limited, and API mutations by session in
// requireApiActor, after the session and the stale-tab check. next/server's
// after() and next/headers' cookies() only work inside a Next request, so
// they are replaced (the rest of next/server stays real).

const scheduled: (() => unknown)[] = [];
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: (callback: () => unknown) => {
    scheduled.push(callback);
  },
}));
let jar: Record<string, string> = {};
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        jar[name] === undefined ? undefined : { name, value: jar[name] },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { GET: start } = await import('../app/api/auth/linear/route');
const { GET: callback } = await import('../app/api/auth/linear/callback/route');
const { POST: switchPost } = await import('../app/api/auth/switch/route');
const { POST: logout } = await import('../app/api/auth/logout/route');
const { POST: demoSignIn } = await import('../app/api/auth/demo/route');
const { requireApiActor } = await import('../lib/http');

const ACTIVE = '__Host-mp_session';
const STASH = '__Host-mp_sessions';
const OAUTH = '__Host-mp_oauth';
const ACME = tok('acme');
const GLOBEX = tok('globex');
const LIMITED = '/?auth_error=auth_rate_limited';

let state: FakeEngineState;
const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

function useEngine(engine: Engine): void {
  holder.__milestonePlannerEngine = Promise.resolve(engine);
}

beforeEach(() => {
  resetProcessRateLimiters();
  state = freshState();
  for (const [token, id, name] of [
    [ACME, 'org-acme', 'Acme'],
    [GLOBEX, 'org-globex', 'Globex'],
  ] as const) {
    state.sessions.set(token, {
      workspaceId: id,
      workspaceName: name,
      userId: `${id}-ana`,
      userName: 'Ana Moreno',
      live: true,
    });
  }
  scheduled.length = 0;
  jar = {};
  useEngine(fakeEngine(state));
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
  resetProcessRateLimiters();
});

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${APP}${path}`, { headers });
}

function post(
  path: string,
  fields: Record<string, string>,
  options: {
    ip?: string;
    json?: boolean;
    cookies?: Record<string, string>;
  } = {}
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
  };
  if (options.ip !== undefined) headers['x-real-ip'] = options.ip;
  if (options.json === true) headers.accept = 'application/json';
  const cookie = cookieHeader(options.cookies ?? {});
  if (cookie !== '') headers.cookie = cookie;
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

describe('GET /api/auth/linear: 120 per 10 minutes per client IP', () => {
  test('the 121st start from one IP lands on the landing page with Retry-After; another IP and no IP go on', async () => {
    const ip = { 'x-real-ip': '203.0.113.9' };
    for (let i = 0; i < RATE_LIMITS.oauthStart.limit; i += 1) {
      const ok = await start(get('/api/auth/linear?intent=signin', ip));
      expect(ok.status).toBe(302);
    }
    const refused = await start(get('/api/auth/linear?intent=signin', ip));
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toBe(LIMITED);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // No OAuth state is set for a refused start; the legacy names are
    // still expired as on every auth response.
    expect(setCookie(refused, OAUTH)).toBeUndefined();
    expect(setCookie(refused, 'mp_session')).toContain('Max-Age=0');

    const other = await start(
      get('/api/auth/linear?intent=signin', { 'x-real-ip': '203.0.113.10' })
    );
    expect(other.status).toBe(302);
    // Without X-Real-IP (local runs, the browser suites) no IP limit applies.
    for (let i = 0; i < RATE_LIMITS.oauthStart.limit + 10; i += 1) {
      const local = await start(get('/api/auth/linear?intent=signin'));
      expect(local.status).toBe(302);
    }
  });

  test('the callback is never limited, even from an IP over the start limit', async () => {
    const ip = { 'x-real-ip': '203.0.113.20' };
    const begun = await start(get('/api/auth/linear?intent=signin', ip));
    const oauth = cookieValue(setCookie(begun, OAUTH));
    for (let i = 1; i < RATE_LIMITS.oauthStart.limit + 5; i += 1) {
      await start(get('/api/auth/linear?intent=signin', ip));
    }
    const finished = await callback(
      get('/api/auth/linear/callback?code=c-1&state=st-signin', {
        ...ip,
        cookie: cookieHeader({ [OAUTH]: oauth }),
      })
    );
    expect(finished.headers.get('location')).not.toBe(LIMITED);
    expect(finished.headers.get('location')).toBe('/week');
    expect(state.calls.signIn).toHaveLength(1);
    // Many callbacks from that IP: none is ever refused by a limit.
    for (let i = 0; i < 100; i += 1) {
      const again = await callback(
        get('/api/auth/linear/callback?code=c-2&state=st-signin', ip)
      );
      expect(again.headers.get('location')).not.toBe(LIMITED);
    }
  });
});

describe('POST /api/auth/switch: 60 per 10 minutes per client IP', () => {
  const HELD = { [ACTIVE]: ACME, [STASH]: GLOBEX };

  test('JSON gets 429 rate_limited with Retry-After; a form post the landing redirect', async () => {
    for (let i = 0; i < RATE_LIMITS.switchWorkspace.limit; i += 1) {
      const ok = await switchPost(
        post(
          '/api/auth/switch',
          { workspace: 'org-globex' },
          { ip: '198.51.100.4', json: true, cookies: HELD }
        )
      );
      expect(ok.status).toBe(200);
    }
    const json = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-globex' },
        { ip: '198.51.100.4', json: true, cookies: HELD }
      )
    );
    expect(json.status).toBe(429);
    expect(Number(json.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(json.headers.get('cache-control')).toBe('no-store');
    const body = (await json.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toContain('Too many workspace switches');
    // Nothing changed: no cookie is set on a refusal.
    expect(json.headers.getSetCookie()).toEqual([]);

    const form = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-globex' },
        { ip: '198.51.100.4', cookies: HELD }
      )
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe(LIMITED);
  });

  test('a cross-origin post is refused before it counts', async () => {
    for (let i = 0; i < 70; i += 1) {
      const request = new Request(`${APP}/api/auth/switch`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'x-real-ip': '198.51.100.5',
        },
      });
      expect((await switchPost(request)).status).toBe(403);
    }
    const ok = await switchPost(
      post(
        '/api/auth/switch',
        { workspace: 'org-globex' },
        { ip: '198.51.100.5', json: true, cookies: HELD }
      )
    );
    expect(ok.status).toBe(200);
  });
});

describe('POST /api/auth/logout: never limited', () => {
  test('OAuth mode: sign-outs flooding from one IP never stop a real one ending its sessions', async () => {
    // Someone on the same office, campus or carrier IP sends session-less
    // sign-outs with the planner's Origin, as curl can.
    for (let i = 0; i < 200; i += 1) {
      const flood = await logout(
        post('/api/auth/logout', { scope: 'all' }, { ip: '192.0.2.1' })
      );
      expect(flood.headers.get('location')).toBe('/');
    }
    // A person behind that IP signs out of everything on a shared
    // computer: both sessions end and both cookies are cleared.
    const real = await logout(
      post(
        '/api/auth/logout',
        { scope: 'all' },
        { ip: '192.0.2.1', cookies: { [ACTIVE]: ACME, [STASH]: GLOBEX } }
      )
    );
    expect(real.status).toBe(303);
    expect(real.headers.get('location')).toBe('/');
    expect(state.calls.signOut.sort()).toEqual([ACME, GLOBEX].sort());
    expect(setCookie(real, ACTIVE)).toContain('Max-Age=0');
    expect(setCookie(real, STASH)).toContain('Max-Age=0');
  });

  test('demo and api_key mode are never limited either', async () => {
    for (const mode of ['demo', 'api_key'] as const) {
      resetProcessRateLimiters();
      state = freshState();
      if (mode === 'demo') state.mode = 'fixture';
      else state.auth = 'api_key';
      useEngine(fakeEngine(state));
      for (let i = 0; i < 80; i += 1) {
        const response = await logout(
          post('/api/auth/logout', {}, { ip: '192.0.2.2' })
        );
        expect(response.headers.get('location')).not.toBe(LIMITED);
      }
    }
  });
});

describe('POST /api/auth/demo', () => {
  test('is never limited (the showcase and the browser suite share addresses)', async () => {
    state.mode = 'fixture';
    let signIns = 0;
    useEngine({
      ...fakeEngine(state),
      mode: 'fixture',
      config: fakeEngine(state).config,
      devSignIn: () => {
        signIns += 1;
        return Promise.resolve({
          sessionToken: tok(`demo${signIns}`),
          session: { expiresAt: '2099-01-01T00:00:00.000Z' },
        });
      },
    } as unknown as Engine);
    for (let i = 0; i < 100; i += 1) {
      const response = await demoSignIn(
        post('/api/auth/demo', { userId: 'user-chloe' }, { ip: '192.0.2.3' })
      );
      expect(response.headers.get('location')).toBe('/week');
    }
    expect(signIns).toBe(100);
  });
});

describe('requireApiActor: API mutations per session', () => {
  function api(
    path: string,
    method: string,
    headers: Record<string, string> = {}
  ): Request {
    return new Request(`${APP}${path}`, {
      method,
      headers: { origin: APP, ...headers },
    });
  }

  async function status(request: Request): Promise<number> {
    const result = await requireApiActor(request);
    return result instanceof Response ? result.status : 200;
  }

  test('POST /api/runs: 6 per 10 minutes for a session, then 429 with Retry-After; another session is apart', async () => {
    jar = { [ACTIVE]: ACME };
    for (let i = 0; i < RATE_LIMITS.runs.limit; i += 1) {
      expect(await status(api('/api/runs', 'POST'))).toBe(200);
    }
    const refused = await requireApiActor(api('/api/runs', 'POST'));
    if (!(refused instanceof Response)) throw new Error('expected a 429');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({
      error: { code: 'rate_limited' },
    });
    // Reads are not limited; other writes have their own window.
    expect(await status(api('/api/runs', 'GET'))).toBe(200);
    expect(await status(api('/api/sync', 'POST'))).toBe(200);
    // Another session of the same browser counts on its own.
    jar = { [ACTIVE]: GLOBEX };
    expect(await status(api('/api/runs', 'POST'))).toBe(200);
  });

  test('POST /api/warnings/preview: 20 per 10 minutes', async () => {
    jar = { [ACTIVE]: ACME };
    for (let i = 0; i < RATE_LIMITS.warningsPreview.limit; i += 1) {
      expect(await status(api('/api/warnings/preview', 'POST'))).toBe(200);
    }
    expect(await status(api('/api/warnings/preview', 'POST'))).toBe(429);
  });

  test('every other mutation: 300 a minute, shared across routes and methods', async () => {
    jar = { [ACTIVE]: ACME };
    const routes = [
      ['/api/issues/iss-1', 'PATCH'],
      ['/api/settings', 'PATCH'],
      ['/api/relations/rel-1', 'DELETE'],
    ] as const;
    for (let i = 0; i < RATE_LIMITS.mutation.limit; i += 1) {
      const [path, method] = routes[i % routes.length] ?? routes[0];
      expect(await status(api(path, method))).toBe(200);
    }
    expect(await status(api('/api/milestones/m-1', 'PATCH'))).toBe(429);
    for (let i = 0; i < 20; i += 1) {
      expect(await status(api('/api/palette', 'GET'))).toBe(200);
    }
  });

  test('a signed-out, cross-origin or stale-tab request is answered first and never counts', async () => {
    jar = {};
    for (let i = 0; i < 10; i += 1) {
      expect(await status(api('/api/runs', 'POST'))).toBe(401);
    }
    jar = { [ACTIVE]: ACME };
    for (let i = 0; i < 10; i += 1) {
      expect(
        await status(
          api('/api/runs', 'POST', { 'x-planner-workspace': 'org-globex' })
        )
      ).toBe(409);
      expect(
        await status(
          api('/api/runs', 'POST', { origin: 'https://evil.example' })
        )
      ).toBe(403);
    }
    expect(await status(api('/api/runs', 'POST'))).toBe(200);
  });
});
