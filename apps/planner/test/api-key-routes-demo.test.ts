// The real route files against a real api_key engine (LINEAR_AUTH=api_key,
// architecture §8.1), whose gateway talks to the e2e's fake Linear
// in-process (e2e/fake-linear.ts): connecting through the handler, an
// edit going out with the person's own key, a replayed cookie after
// sign-out, a read-only key, and a guest alone with nobody to read Linear.
// next/headers' cookies() only works inside a Next request, so it is
// replaced with a jar holding whichever session the test acts as.

import { createEngineFromEnv, type Engine } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeLinear } from '../e2e/fake-linear';
import { E2E_KEYS, needlesIn } from '../e2e/leak-needles';
import { handleConnect } from '../lib/api-key-connect';
import { createConnectLimiter } from '../lib/connect-limit';

let sessionToken: string | null = null;
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'mp_session' && sessionToken !== null
          ? { name, value: sessionToken }
          : undefined,
    }),
  headers: () => Promise.resolve(new Headers()),
}));
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: () => undefined,
}));

const { PATCH: issuePatch } = await import('../app/api/issues/[id]/route');
const { GET: optionsGet } = await import('../app/api/issues/options/route');
const { POST: syncPost } = await import('../app/api/sync/route');
const { POST: logout } = await import('../app/api/auth/logout/route');

const APP = 'http://localhost:3399';
const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const dirs: string[] = [];
const engines: Engine[] = [];
const logLines: string[] = [];

async function apiKeyEngine(
  fake: ReturnType<typeof createFakeLinear>,
  extra: Record<string, string> = {}
): Promise<Engine> {
  const dir = await mkdtemp(join(tmpdir(), 'planner-apikey-'));
  dirs.push(dir);
  const engine = await createEngineFromEnv(
    {
      LINEAR_AUTH: 'api_key',
      APP_URL: APP,
      LINEAR_API_URL: 'http://127.0.0.1:9/graphql',
      PGLITE_DIR: join(dir, 'pglite'),
      ...extra,
    },
    {
      fetch: fake.fetch,
      execArgv: [],
      logger: createLogger({
        name: 'test',
        level: 'debug',
        sink: (_level, line) => logLines.push(line),
      }),
    }
  );
  engines.push(engine);
  return engine;
}

async function connect(engine: Engine, apiKey: string): Promise<string> {
  const response = await handleConnect(
    new Request(`${APP}/api/auth/key`, {
      method: 'POST',
      headers: {
        origin: APP,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ apiKey }).toString(),
    }),
    {
      engine,
      limiter: createConnectLimiter({ now: () => Date.now() }),
      schedule: () => undefined,
    }
  );
  expect(response.status).toBe(303);
  const cookie = response.headers.getSetCookie()[0] ?? '';
  const token = /^mp_session=([^;]+);/.exec(cookie)?.[1];
  if (token === undefined) {
    throw new Error(`no session cookie (${response.headers.get('location')})`);
  }
  return token;
}

function json(method: string, body: unknown): Request {
  return new Request(`${APP}/api/x`, {
    method,
    headers: { origin: APP, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function code(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { code?: unknown } }).error
    ?.code;
}

beforeAll(() => {
  sessionToken = null;
});

afterAll(async () => {
  holder.__milestonePlannerEngine = savedEngine;
  sessionToken = null;
  for (const engine of engines) await engine.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  expect(needlesIn(logLines.join('\n'))).toEqual([]);
});

describe('api_key routes over a real engine', () => {
  test('an edit goes out with the member key; a replayed cookie after sign-out is 401', async () => {
    const fake = createFakeLinear({
      today: new Date().toISOString().slice(0, 10),
    });
    const engine = await apiKeyEngine(fake);
    holder.__milestonePlannerEngine = Promise.resolve(engine);
    const token = await connect(engine, E2E_KEYS.member);
    sessionToken = token;
    const saved = await issuePatch(
      json('PATCH', { title: 'Ship the billing export (v2)' }),
      params('iss-eng-1')
    );
    expect(saved.status).toBe(200);
    const updates = fake.requests.filter((r) => r.operation === 'IssueUpdate');
    expect(updates).toEqual([
      {
        operation: 'IssueUpdate',
        auth: 'raw',
        who: 'member',
        keyInBodyOrUrl: false,
      },
    ]);
    expect(fake.requests.every((r) => r.auth === 'raw')).toBe(true);

    const out = await logout(
      new Request(`${APP}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: APP, cookie: `mp_session=${token}` },
      })
    );
    expect(out.headers.get('location')).toBe('/?signed_out=1');
    // The same cookie again: the planner no longer knows whose it was.
    const twice = await logout(
      new Request(`${APP}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: APP, cookie: `mp_session=${token}` },
      })
    );
    expect(twice.headers.get('location')).toBe('/?signed_out=ended');
    const replay = await issuePatch(
      json('PATCH', { title: 'Too late' }),
      params('iss-eng-1')
    );
    expect(replay.status).toBe(401);
    expect(await code(replay)).toBe('not_signed_in');
  });

  test('a read-only key: refused by Linear once, then by the planner', async () => {
    const fake = createFakeLinear({
      today: new Date().toISOString().slice(0, 10),
    });
    const engine = await apiKeyEngine(fake);
    holder.__milestonePlannerEngine = Promise.resolve(engine);
    await connect(engine, E2E_KEYS.member);
    sessionToken = await connect(engine, E2E_KEYS.readonly);
    const first = await issuePatch(
      json('PATCH', { title: 'Nope' }),
      params('iss-eng-2')
    );
    expect(first.status).toBe(403);
    expect(await code(first)).toBe('read_only');
    const second = await issuePatch(
      json('PATCH', { title: 'Nope' }),
      params('iss-eng-2')
    );
    expect(second.status).toBe(403);
    expect(await code(second)).toBe('read_only');
    expect(
      fake.requests.filter(
        (r) => r.operation === 'IssueUpdate' && r.who === 'readonly'
      )
    ).toHaveLength(1);
  });

  test('a guest alone: nothing can read Linear (503 no_reader), and no resync', async () => {
    const fake = createFakeLinear({
      today: new Date().toISOString().slice(0, 10),
    });
    const engine = await apiKeyEngine(fake, { LINEAR_WORKSPACE: 'acme' });
    holder.__milestonePlannerEngine = Promise.resolve(engine);
    sessionToken = await connect(engine, E2E_KEYS.guest);
    const options = await optionsGet(new Request(`${APP}/api/issues/options`));
    expect(options.status).toBe(503);
    expect(await code(options)).toBe('no_reader');
    // A guest is read-only: the one guard refuses the resync first.
    const sync = await syncPost(json('POST', {}));
    expect(sync.status).toBe(403);
    expect(await code(sync)).toBe('read_only');
    const syncOps = [
      'Users',
      'Teams',
      'WorkflowStates',
      'ProjectIssues',
      'TeamMemberships',
    ];
    expect(
      fake.requests.filter(
        (r) => r.who === 'guest' && syncOps.includes(r.operation)
      )
    ).toEqual([]);
  });
});
