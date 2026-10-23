// POST /api/auth/key's handler (lib/api-key-connect.ts) with a stub
// engine, an injected limiter and clock (architecture §8.1 "Security").
// Keys are obviously fake (TESTKEY); no response, header or log ever holds
// one.

import { LINEAR_GRAPHQL_ENDPOINT } from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';

import { type ConnectDeps, handleConnect } from '../lib/api-key-connect';
import {
  type ConnectLimiter,
  createConnectLimiter,
} from '../lib/connect-limit';

const KEY = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';
const OTHER = 'lin_api_TESTKEY_second_f2Jg8Qs4Wn7Xc1Zv5Bk9Mp';
const HTTP_APP = 'http://localhost:3360';
const HTTPS_APP = 'https://planner.example.com';

function namedError(name: string, code: string, extra: object = {}): Error {
  const error = new Error(`${name} ${code}`);
  error.name = name;
  return Object.assign(error, { code }, extra);
}

interface Stub {
  deps: ConnectDeps;
  connects: string[];
  signOuts: { token: string; options: unknown }[];
  scheduled: (() => Promise<unknown>)[];
  syncs: string[];
}

function stub(
  options: {
    appUrl?: string;
    auth?: string;
    endpoint?: string;
    fail?: Error;
    syncAfter?: boolean;
    limiter?: ConnectLimiter;
    clock?: { ms: number };
  } = {}
): Stub {
  const connects: string[] = [];
  const signOuts: { token: string; options: unknown }[] = [];
  const scheduled: (() => Promise<unknown>)[] = [];
  const syncs: string[] = [];
  const clock = options.clock ?? { ms: 1_000_000 };
  const engine = {
    config: {
      auth: options.auth ?? 'api_key',
      appUrl: options.appUrl ?? HTTP_APP,
      apiKey: { endpoint: options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT },
    },
    connectApiKey: (input: { apiKey: string }) => {
      connects.push(input.apiKey);
      if (options.fail !== undefined) return Promise.reject(options.fail);
      return Promise.resolve({
        sessionToken: 'newtoken_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcde',
        session: { workspaceId: 'org-acme' },
        needsInstall: false,
        syncAfter: options.syncAfter ?? false,
      });
    },
    signOut: (token: string, signOutOptions?: unknown) => {
      signOuts.push({ token, options: signOutOptions });
      return Promise.resolve();
    },
    fullSync: (workspaceId: string) => {
      syncs.push(workspaceId);
      return Promise.resolve({});
    },
  };
  return {
    deps: {
      engine: engine as unknown as ConnectDeps['engine'],
      limiter: options.limiter ?? createConnectLimiter({ now: () => clock.ms }),
      schedule: (task) => scheduled.push(task),
    },
    connects,
    signOuts,
    scheduled,
    syncs,
  };
}

function post(
  body: string,
  options: {
    app?: string;
    origin?: string | null;
    type?: string;
    headers?: Record<string, string>;
    url?: string;
  } = {}
): Request {
  const app = options.app ?? HTTP_APP;
  const headers: Record<string, string> = {
    'content-type': options.type ?? 'application/x-www-form-urlencoded',
    ...options.headers,
  };
  if (options.origin !== null) headers.origin = options.origin ?? app;
  return new Request(options.url ?? `${app}/api/auth/key`, {
    method: 'POST',
    headers,
    body,
  });
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

// Everything a response shows: status, every header, and the body.
async function visible(response: Response): Promise<string> {
  const headers: string[] = [];
  response.headers.forEach((value, name) => headers.push(`${name}: ${value}`));
  return `${response.status}\n${headers.join('\n')}\n${await response.clone().text()}`;
}

async function expectNoKey(response: Response): Promise<void> {
  const text = await visible(response);
  expect(text).not.toContain('TESTKEY');
  expect(text).not.toContain(KEY.slice(-12));
}

describe('handleConnect: refusals before anything is read', () => {
  test('another mode → 404, body unread', async () => {
    const s = stub({ auth: 'oauth' });
    const request = post(form({ apiKey: KEY }));
    const response = await handleConnect(request, s.deps);
    expect(response.status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect(s.connects).toEqual([]);
    await expectNoKey(response);
  });

  test('a test endpoint answers loopback requests only', async () => {
    const s = stub({ endpoint: 'http://127.0.0.1:3361/graphql' });
    const response = await handleConnect(
      post(form({ apiKey: KEY }), {
        url: 'http://planner.example/api/auth/key',
        origin: 'http://planner.example',
      }),
      s.deps
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    const local = await handleConnect(post(form({ apiKey: KEY })), s.deps);
    expect(local.status).toBe(303);
  });

  test('cross-site posts, Origin null and non-form bodies are refused', async () => {
    const s = stub();
    for (const request of [
      post(form({ apiKey: KEY }), { origin: 'http://evil.example' }),
      post(form({ apiKey: KEY }), { origin: 'null' }),
      post(form({ apiKey: KEY }), {
        origin: null,
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    ]) {
      const response = await handleConnect(request, s.deps);
      expect(response.status).toBe(403);
      await expectNoKey(response);
    }
    for (const type of [
      'application/json',
      'multipart/form-data; boundary=x',
      'text/plain',
    ]) {
      const response = await handleConnect(
        post(JSON.stringify({ apiKey: KEY }), { type }),
        s.deps
      );
      expect(response.status).toBe(415);
      await expectNoKey(response);
    }
    expect(s.connects).toEqual([]);
  });

  test('a forwarded plain-HTTP request to an https planner is refused', async () => {
    const s = stub({ appUrl: HTTPS_APP });
    const response = await handleConnect(
      post(form({ apiKey: KEY }), {
        app: HTTPS_APP,
        headers: { 'x-forwarded-proto': 'http' },
      }),
      s.deps
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/?auth_error=insecure_transport'
    );
    expect(s.connects).toEqual([]);
  });

  test('a body over 4 KiB, a missing key and a bad shape never reach the engine', async () => {
    const s = stub();
    const big = await handleConnect(
      post(form({ apiKey: KEY, pad: 'x'.repeat(5 * 1024) })),
      s.deps
    );
    expect(big.headers.get('location')).toBe('/?auth_error=invalid_request');
    const missing = await handleConnect(post(form({ other: '1' })), s.deps);
    expect(missing.headers.get('location')).toBe(
      '/?auth_error=invalid_request'
    );
    const shape = await handleConnect(
      post(form({ apiKey: 'not-a-key' })),
      s.deps
    );
    expect(shape.headers.get('location')).toBe('/?auth_error=key_shape');
    expect(s.connects).toEqual([]);
    for (const response of [big, missing, shape]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expectNoKey(response);
    }
  });
});

describe('handleConnect: engine outcomes', () => {
  const cases: [Error, string][] = [
    [namedError('EngineInputError', 'invalid'), 'key_shape'],
    [namedError('EngineAuthError', 'key_rejected'), 'key_rejected'],
    [namedError('EngineAuthError', 'key_cannot_read'), 'key_cannot_read'],
    [namedError('EngineAuthError', 'wrong_workspace'), 'key_wrong_workspace'],
    [namedError('EngineAuthError', 'guest_cannot_bind'), 'guest_cannot_bind'],
    [namedError('EngineAuthError', 'not_signed_in'), 'not_signed_in'],
    [
      namedError('EngineInputError', 'rate_limited', { retryAt: null }),
      'linear_rate_limited',
    ],
    [namedError('EngineInputError', 'conflict'), 'key_capacity'],
    [
      Object.assign(namedError('LinearApiError', ''), { kind: 'network' }),
      'linear_unreachable',
    ],
    [
      Object.assign(namedError('LinearApiError', ''), { kind: 'server' }),
      'linear_unreachable',
    ],
    [new Error(`boom ${KEY}`), 'internal'],
  ];
  for (const [error, code] of cases) {
    const raw: unknown =
      (error as { code?: unknown }).code ?? (error as { kind?: unknown }).kind;
    const label = typeof raw === 'string' ? raw : '';
    test(`${error.name} ${label} → ${code}`, async () => {
      // Errors from another bundle copy: same name and code, other class.
      const s = stub({ fail: error });
      const response = await handleConnect(
        post(form({ apiKey: KEY, returnTo: '/timeline' })),
        s.deps
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        `/?auth_error=${code}&returnTo=%2Ftimeline`
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([]);
      await expectNoKey(response);
    });
  }
});

describe('handleConnect: success', () => {
  test('http: a browser-session mp_session cookie and the sanitized returnTo', async () => {
    const s = stub({ syncAfter: true });
    const response = await handleConnect(
      post(form({ apiKey: `  ${KEY}  `, returnTo: '/timeline?x=1' }), {
        headers: { cookie: 'mp_session=oldtoken' },
      }),
      s.deps
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/timeline?x=1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual([
      'mp_session=newtoken_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcde; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(s.connects).toEqual([KEY]);
    expect(s.signOuts).toEqual([{ token: 'oldtoken', options: undefined }]);
    expect(s.scheduled).toHaveLength(1);
    await s.scheduled[0]?.();
    expect(s.syncs).toEqual(['org-acme']);
    await expectNoKey(response);
  });

  test('https: __Host-mp_session, Secure; a plain mp_session is not the previous session', async () => {
    const s = stub({ appUrl: HTTPS_APP });
    const response = await handleConnect(
      post(form({ apiKey: KEY, returnTo: '//evil.example' }), {
        app: HTTPS_APP,
        headers: {
          cookie: 'mp_session=tossed; __Host-mp_session=previous',
          'x-forwarded-proto': 'https',
        },
      }),
      s.deps
    );
    expect(response.headers.get('location')).toBe('/week');
    const cookie = response.headers.getSetCookie()[0] ?? '';
    expect(cookie).toBe(
      '__Host-mp_session=newtoken_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcde; Path=/; HttpOnly; SameSite=Lax; Secure'
    );
    expect(cookie).not.toMatch(/Max-Age|Expires|Domain/i);
    expect(s.signOuts.map((entry) => entry.token)).toEqual(['previous']);
    expect(s.scheduled).toHaveLength(0);
  });
});

describe('handleConnect: rate limits', () => {
  test('the 11th failure from one X-Real-IP is limited, whatever X-Forwarded-For says', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(String(line));
    try {
      const s = stub();
      for (let i = 0; i < 20; i++) {
        const response = await handleConnect(
          post(form({ apiKey: 'bad' }), {
            headers: {
              'x-real-ip': '203.0.113.9',
              'x-forwarded-for': `198.51.100.${i}`,
            },
          }),
          s.deps
        );
        const location = response.headers.get('location');
        if (i < 10) {
          expect(location).toBe('/?auth_error=key_shape');
        } else {
          expect(location).toBe('/?auth_error=connect_rate_limited');
          expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(
            0
          );
        }
      }
      const limited = await handleConnect(
        post(form({ apiKey: KEY }), {
          headers: { 'x-real-ip': '203.0.113.9' },
        }),
        s.deps
      );
      expect(limited.headers.get('location')).toBe(
        '/?auth_error=connect_rate_limited'
      );
      expect(s.connects).toEqual([]);
      const logged = lines.join('\n');
      expect(logged).toContain('connect rate limited');
      expect(logged).not.toContain('203.0.113.9');
    } finally {
      console.error = original;
    }
  });

  test('shape failures never fill the global window; Linear-reaching ones do', async () => {
    const limiter = createConnectLimiter({ now: () => 0 });
    const shapes = stub({ limiter });
    for (let i = 0; i < 61; i++) {
      await handleConnect(
        post(form({ apiKey: 'bad' }), {
          headers: { 'x-real-ip': `10.0.0.${i}` },
        }),
        shapes.deps
      );
    }
    const ok = await handleConnect(
      post(form({ apiKey: KEY }), { headers: { 'x-real-ip': '10.0.1.1' } }),
      shapes.deps
    );
    expect(ok.headers.getSetCookie()).toHaveLength(1);

    const rejected = stub({
      limiter: createConnectLimiter({ now: () => 0 }),
      fail: namedError('EngineAuthError', 'key_rejected'),
    });
    for (let i = 0; i < 60; i++) {
      await handleConnect(
        post(form({ apiKey: OTHER }), {
          headers: { 'x-real-ip': `10.1.0.${i}` },
        }),
        rejected.deps
      );
    }
    // A source that already failed is refused by the full global window...
    const blocked = await handleConnect(
      post(form({ apiKey: OTHER }), { headers: { 'x-real-ip': '10.1.0.7' } }),
      rejected.deps
    );
    expect(blocked.headers.get('location')).toBe(
      '/?auth_error=connect_rate_limited'
    );
    expect(rejected.connects).toHaveLength(60);
    // ...but one with no failure of its own still gets its try, so the
    // sources that filled it cannot lock everyone else out; once it has
    // failed, it is refused too.
    const clean = await handleConnect(
      post(form({ apiKey: OTHER }), { headers: { 'x-real-ip': '10.1.1.1' } }),
      rejected.deps
    );
    expect(clean.headers.get('location')).toBe('/?auth_error=key_rejected');
    expect(rejected.connects).toHaveLength(61);
    const cleanAgain = await handleConnect(
      post(form({ apiKey: OTHER }), { headers: { 'x-real-ip': '10.1.1.1' } }),
      rejected.deps
    );
    expect(cleanAgain.headers.get('location')).toBe(
      '/?auth_error=connect_rate_limited'
    );
    expect(rejected.connects).toHaveLength(61);
  });

  test('concurrent posts are counted before Linear answers: at most 10 reach it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = stub();
    const reached: string[] = [];
    const engine = {
      ...(s.deps.engine as unknown as Record<string, unknown>),
      connectApiKey: async (input: { apiKey: string }) => {
        reached.push(input.apiKey);
        if (input.apiKey === KEY) {
          return {
            sessionToken: 'newtoken_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcde',
            session: { workspaceId: 'org-acme' },
            needsInstall: false,
            syncAfter: false,
          };
        }
        await gate;
        throw namedError('EngineAuthError', 'key_rejected');
      },
    };
    const deps: ConnectDeps = {
      ...s.deps,
      engine: engine as unknown as ConnectDeps['engine'],
    };
    const bad = (i: number): string =>
      `lin_api_TESTKEY_bad_${String(i).padStart(4, '0')}_AbCdEfGhIjKl`;
    // The 90 refusals each log a line; keep the test output quiet.
    const original = console.error;
    console.error = () => undefined;
    let locations: (string | null)[];
    try {
      const pending = Array.from({ length: 100 }, (_, i) =>
        handleConnect(
          post(form({ apiKey: bad(i) }), {
            headers: { 'x-real-ip': '198.51.100.8' },
          }),
          deps
        )
      );
      // Every post has begun (and most were refused) while Linear "thinks".
      await Bun.sleep(50);
      expect(reached).toHaveLength(10);
      release();
      locations = (await Promise.all(pending)).map((response) =>
        response.headers.get('location')
      );
    } finally {
      console.error = original;
    }
    expect(
      locations.filter((l) => l === '/?auth_error=key_rejected')
    ).toHaveLength(10);
    expect(
      locations.filter((l) => l === '/?auth_error=connect_rate_limited')
    ).toHaveLength(90);
    expect(reached).toHaveLength(10);

    // A person elsewhere still connects.
    const elsewhere = await handleConnect(
      post(form({ apiKey: KEY }), { headers: { 'x-real-ip': '192.0.2.99' } }),
      deps
    );
    expect(elsewhere.headers.getSetCookie()).toHaveLength(1);
  });

  test('a try that does not count is taken back: Linear unreachable, an internal error', async () => {
    const limiter = createConnectLimiter({ now: () => 0 });
    const down = stub({
      limiter,
      fail: Object.assign(new Error('fetch failed'), {
        name: 'LinearApiError',
        kind: 'network',
      }),
    });
    for (let i = 0; i < 15; i++) {
      const response = await handleConnect(
        post(form({ apiKey: KEY }), { headers: { 'x-real-ip': '192.0.2.5' } }),
        down.deps
      );
      expect(response.headers.get('location')).toBe(
        '/?auth_error=linear_unreachable'
      );
    }
    expect(down.connects).toHaveLength(15);
    expect(limiter.size()).toBe(0);
  });

  test('successes count toward neither window, and the map stays capped', async () => {
    const limiter = createConnectLimiter({ now: () => 0 });
    const s = stub({ limiter });
    for (let i = 0; i < 30; i++) {
      const response = await handleConnect(
        post(form({ apiKey: KEY }), { headers: { 'x-real-ip': '192.0.2.1' } }),
        s.deps
      );
      expect(response.headers.getSetCookie()).toHaveLength(1);
    }
    expect(limiter.size()).toBe(0);
    const capped = createConnectLimiter({ now: () => 0 });
    for (let i = 0; i < 20_000; i++) {
      const attempt = capped.begin(`ip-${i}`);
      if (attempt.ok) attempt.finish('key_shape');
    }
    expect(capped.size()).toBeLessThanOrEqual(10_000);
  });

  test('a malformed X-Real-IP shares the no-ip bucket', async () => {
    const limiter = createConnectLimiter({ now: () => 0 });
    const s = stub({ limiter });
    for (let i = 0; i < 10; i++) {
      await handleConnect(
        post(form({ apiKey: 'bad' }), {
          headers: { 'x-real-ip': `not an ip ${i}` },
        }),
        s.deps
      );
    }
    const next = await handleConnect(post(form({ apiKey: 'bad' })), s.deps);
    expect(next.headers.get('location')).toBe(
      '/?auth_error=connect_rate_limited'
    );
  });
});
