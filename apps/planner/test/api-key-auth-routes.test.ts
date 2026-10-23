// The auth routes with personal API keys (LINEAR_AUTH=api_key,
// architecture §8.1): logout forgets the key on every device and clears
// both cookie names; the OAuth start and callback just go home.

import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: () => undefined,
}));

const { POST: logout } = await import('../app/api/auth/logout/route');
const { GET: oauthStart } = await import('../app/api/auth/linear/route');
const { GET: oauthCallback } =
  await import('../app/api/auth/linear/callback/route');

const APP = 'https://planner.example.com';

let signOuts: { token: string; options: unknown }[] = [];
let oauthStarts = 0;
// Whether the fake engine knows the token it is asked to sign out.
let knownTokens = new Set<string>();

function fakeEngine(): Engine {
  return {
    mode: 'linear',
    config: { auth: 'api_key', appUrl: APP, appName: 'Milestone Planner' },
    signOut: (token: string, options?: unknown) => {
      signOuts.push({ token, options });
      const known = knownTokens.has(token);
      return Promise.resolve({ known, keysForgotten: known ? 2 : 0 });
    },
    startOAuth: () => {
      oauthStarts += 1;
      throw new Error('OAuth is off');
    },
  } as unknown as Engine;
}

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;

beforeEach(() => {
  signOuts = [];
  oauthStarts = 0;
  knownTokens = new Set(['the-token']);
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine());
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
});

describe('api_key mode: POST /api/auth/logout', () => {
  test('forgets the key on every device, clears both cookies, says so', async () => {
    const response = await logout(
      new Request(`${APP}/api/auth/logout`, {
        method: 'POST',
        headers: {
          origin: APP,
          cookie: 'mp_session=ignored; __Host-mp_session=the-token',
        },
      })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/?signed_out=1');
    expect(signOuts).toEqual([
      { token: 'the-token', options: { everyDevice: true } },
    ]);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('mp_session=;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Host-mp_session=;'))).toBe(true);
  });

  test('a cookie the planner no longer knows, or none, never claims "every browser"', async () => {
    for (const cookie of ['__Host-mp_session=stale-token', null]) {
      const response = await logout(
        new Request(`${APP}/api/auth/logout`, {
          method: 'POST',
          headers: {
            origin: APP,
            ...(cookie === null ? {} : { cookie }),
          },
        })
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/?signed_out=ended');
      const cookies = response.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith('__Host-mp_session=;'))).toBe(
        true
      );
    }
    expect(signOuts).toEqual([
      { token: 'stale-token', options: { everyDevice: true } },
    ]);
  });

  test('a cross-site sign-out is refused', async () => {
    const response = await logout(
      new Request(`${APP}/api/auth/logout`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          cookie: '__Host-mp_session=t',
        },
      })
    );
    expect(response.status).toBe(403);
    expect(signOuts).toEqual([]);
  });
});

describe('api_key mode: OAuth routes', () => {
  test('start and callback go home without starting OAuth', async () => {
    const start = await oauthStart(
      new Request(`${APP}/api/auth/linear?intent=signin`)
    );
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe('/');
    const callback = await oauthCallback(
      new Request(`${APP}/api/auth/linear/callback?code=c&state=s`)
    );
    expect(callback.headers.get('location')).toBe('/');
    expect(oauthStarts).toBe(0);
  });
});
