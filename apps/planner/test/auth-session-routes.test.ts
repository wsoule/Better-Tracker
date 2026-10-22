import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// POST /api/auth/demo and POST /api/auth/logout against a fake engine:
// the CSRF guard runs before anything else, the session cookie's
// attributes, and a replaced session ending after the response. As in
// auth-routes.test.ts, next/server's after() becomes a queue the tests
// drain (it only works inside a Next request).

const scheduled: (() => unknown)[] = [];
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: (callback: () => unknown) => {
    scheduled.push(callback);
  },
}));

const { POST: demo } = await import('../app/api/auth/demo/route');
const { POST: logout } = await import('../app/api/auth/logout/route');

const APP = 'http://localhost:3000';

let mode: 'fixture' | 'linear' = 'fixture';
let signIns: string[] = [];
let signOuts: string[] = [];
let signInError: Error | null = null;

function engineError(name: string, code: string): Error {
  const error = new Error(`${name} ${code}`);
  error.name = name;
  return Object.assign(error, { code });
}

function fakeEngine(): Engine {
  const engine = {
    get mode() {
      return mode;
    },
    config: { appUrl: APP, appName: 'Milestone Planner' },
    devSignIn: (userId: string) => {
      signIns.push(userId);
      if (signInError !== null) return Promise.reject(signInError);
      return Promise.resolve({
        sessionToken: `token-${userId}`,
        session: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        needsInstall: false,
      });
    },
    signOut: (token: string) => {
      signOuts.push(token);
      return Promise.resolve();
    },
  };
  return engine as unknown as Engine;
}

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;

beforeEach(() => {
  mode = 'fixture';
  signIns = [];
  signOuts = [];
  signInError = null;
  scheduled.length = 0;
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine());
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
});

function post(
  path: string,
  options: { origin?: string; cookie?: string; body?: string } = {}
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers,
    body: options.body ?? '',
  });
}

function setCookie(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${name}=`));
}

describe('POST /api/auth/demo', () => {
  test('signs in, sets an httpOnly Lax session cookie and opens My week', async () => {
    const response = await demo(
      post('/api/auth/demo', { origin: APP, body: 'userId=user-ana' })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/week');
    expect(signIns).toEqual(['user-ana']);
    const cookie = setCookie(response, 'mp_session') ?? '';
    expect(cookie).toStartWith('mp_session=token-user-ana;');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // http app URL: no Secure flag (the browser would drop the cookie).
    expect(cookie).not.toContain('Secure');
  });

  test('refuses cross-origin and origin-less posts before signing in', async () => {
    for (const request of [
      post('/api/auth/demo', {
        origin: 'https://evil.example',
        body: 'userId=user-ana',
      }),
      post('/api/auth/demo', { origin: 'null', body: 'userId=user-ana' }),
      post('/api/auth/demo', { body: 'userId=user-ana' }),
    ]) {
      const response = await demo(request);
      expect(response.status).toBe(403);
      expect(setCookie(response, 'mp_session')).toBeUndefined();
    }
    expect(signIns).toEqual([]);
  });

  test('ends the session it replaces, after responding', async () => {
    const response = await demo(
      post('/api/auth/demo', {
        origin: APP,
        cookie: 'mp_session=old-token',
        body: 'userId=user-ben',
      })
    );
    expect(response.status).toBe(303);
    expect(signOuts).toEqual([]);
    await Promise.all(scheduled.map((run) => run()));
    expect(signOuts).toEqual(['old-token']);
  });

  test('a missing person or a malformed form goes back with a code', async () => {
    const empty = await demo(
      post('/api/auth/demo', { origin: APP, body: 'userId=' })
    );
    expect(empty.headers.get('location')).toBe('/?auth_error=invalid_request');
    signInError = engineError('EngineInputError', 'not_found');
    const missing = await demo(
      post('/api/auth/demo', { origin: APP, body: 'userId=user-nobody' })
    );
    expect(missing.headers.get('location')).toBe('/?auth_error=not_found');
  });

  test('opens the page the picker was reached from (returnTo), never another site', async () => {
    const back = await demo(
      post('/api/auth/demo', {
        origin: APP,
        body: `userId=user-ana&returnTo=${encodeURIComponent('/timeline?milestone=ms-harbor-1')}`,
      })
    );
    expect(back.headers.get('location')).toBe(
      '/timeline?milestone=ms-harbor-1'
    );
    const away = await demo(
      post('/api/auth/demo', {
        origin: APP,
        body: `userId=user-ana&returnTo=${encodeURIComponent('//evil.example/x')}`,
      })
    );
    expect(away.headers.get('location')).toBe('/week');
  });

  test('a deactivated person or the app user reads as demo_inactive', async () => {
    signInError = engineError('EngineInputError', 'invalid');
    const response = await demo(
      post('/api/auth/demo', { origin: APP, body: 'userId=user-hugo' })
    );
    expect(response.headers.get('location')).toBe('/?auth_error=demo_inactive');
    expect(setCookie(response, 'mp_session')).toBeUndefined();
  });

  test('is a 404 outside demo mode', async () => {
    mode = 'linear';
    const response = await demo(
      post('/api/auth/demo', { origin: APP, body: 'userId=user-ana' })
    );
    expect(response.status).toBe(404);
    expect(signIns).toEqual([]);
  });
});

describe('POST /api/auth/logout', () => {
  test('ends the session, expires the cookie and goes home', async () => {
    const response = await logout(
      post('/api/auth/logout', { origin: APP, cookie: 'mp_session=tok-1' })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(signOuts).toEqual(['tok-1']);
    expect(setCookie(response, 'mp_session')).toContain('Max-Age=0');
  });

  test('a cross-site form cannot sign someone out', async () => {
    const response = await logout(
      post('/api/auth/logout', {
        origin: 'https://evil.example',
        cookie: 'mp_session=tok-1',
      })
    );
    expect(response.status).toBe(403);
    expect(signOuts).toEqual([]);
    expect(setCookie(response, 'mp_session')).toBeUndefined();
  });

  test('without a session it still clears the cookie', async () => {
    const response = await logout(post('/api/auth/logout', { origin: APP }));
    expect(response.status).toBe(303);
    expect(signOuts).toEqual([]);
    expect(setCookie(response, 'mp_session')).toContain('Max-Age=0');
  });
});
