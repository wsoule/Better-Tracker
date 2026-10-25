import { createEngineFromEnv, type Engine } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeLinear, isBearerRecord } from '../e2e/fake-linear';
import type { FakeOrgKey } from '../e2e/fake-linear-data';
import { E2E_OAUTH_CLIENT, OAUTH_TOKEN_PREFIX } from '../e2e/fake-linear-oauth';
import {
  answerAuthorize,
  DEFAULT_AUTHORIZE_BEHAVIOUR,
} from '../e2e/linear-authorize';

// The cross-workspace gate (owner decision 2026-10-25; architecture §11):
// the planner's real auth and API routes over a real OAuth-mode engine
// (PGlite) and the e2e's fake Linear with two organizations, Acme and
// Globex, in-process. One browser signs in to Acme and installs it,
// connects Globex and installs it, switches between them, and signs out of
// Globex; every token acts in its own workspace only, a stale tab gets 409,
// an Acme issue id is refused while Globex is active (and nothing reaches
// Acme), a guest in Globex is read-only, and no Linear token reaches the
// logs. next/server's after() becomes a queue the test drains, and
// next/headers' cookies() reads the browser the API call is made from.

const scheduled: (() => unknown)[] = [];
const realServer = await import('next/server');
void mock.module('next/server', () => ({
  ...realServer,
  after: (callback: () => unknown) => {
    scheduled.push(callback);
  },
}));

let currentJar = new Map<string, string>();
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = currentJar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { GET: start } = await import('../app/api/auth/linear/route');
const { GET: callback } = await import('../app/api/auth/linear/callback/route');
const { POST: switchPost } = await import('../app/api/auth/switch/route');
const { POST: logout } = await import('../app/api/auth/logout/route');
const { GET: paletteGet } = await import('../app/api/palette/route');
const { PATCH: issuePatch } = await import('../app/api/issues/[id]/route');

const APP = 'https://planner.example';
const SECRET = 's'.repeat(40);
const TODAY = new Date().toISOString().slice(0, 10);
const ACTIVE = '__Host-mp_session';
const STASH = '__Host-mp_sessions';

/** A browser: its cookies, as Set-Cookie headers leave them. */
class Browser {
  readonly jar = new Map<string, string>();

  apply(response: Response): Response {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/Max-Age=0\b/.test(header) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  header(): string {
    return [...this.jar].map(([n, v]) => `${n}=${v}`).join('; ');
  }

  get active(): string | undefined {
    return this.jar.get(ACTIVE);
  }

  get stash(): string[] {
    const value = this.jar.get(STASH);
    return value === undefined ? [] : value.split('.');
  }
}

const fake = createFakeLinear({ today: TODAY });
const logLines: string[] = [];
let engine: Engine;
let dir = '';

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'planner-oauth-workspaces-'));
  engine = await createEngineFromEnv(
    {
      APP_URL: APP,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      LINEAR_CLIENT_ID: E2E_OAUTH_CLIENT.clientId,
      LINEAR_CLIENT_SECRET: E2E_OAUTH_CLIENT.clientSecret,
      SESSION_SECRET: SECRET,
      LINEAR_WORKSPACES: 'acme,globex',
      PGLITE_DIR: join(dir, 'pglite'),
    },
    {
      fetch: fake.fetch,
      logger: createLogger({
        name: 'test',
        level: 'debug',
        sink: (_level, line) => logLines.push(line),
      }),
    }
  );
  holder.__milestonePlannerEngine = Promise.resolve(engine);
  process.env.SESSION_SECRET = SECRET;
});

afterAll(async () => {
  await engine.close();
  await rm(dir, { recursive: true, force: true });
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

async function drain(): Promise<void> {
  while (scheduled.length > 0) {
    await Promise.all(scheduled.splice(0).map((run) => run()));
  }
}

/**
 * One OAuth round trip as the browser makes it: the start route, Linear's
 * authorize page (the chooser picks `org` as `user`), the callback.
 * Returns the callback's answer and the authorize URL Linear was sent to.
 */
async function connect(
  browser: Browser,
  intent: 'signin' | 'install' | 'grant_write' | 'add_workspace',
  org: FakeOrgKey,
  user: string
): Promise<{ response: Response; authorizeUrl: string }> {
  const started = browser.apply(
    await start(
      new Request(`${APP}/api/auth/linear?intent=${intent}`, {
        headers: { cookie: browser.header() },
      })
    )
  );
  expect(started.status).toBe(302);
  const authorizeUrl = started.headers.get('location') ?? '';
  const form = new URLSearchParams({ workspace: org, [`as_${org}`]: user });
  const answer = await answerAuthorize(
    { url: authorizeUrl, method: 'POST', form },
    DEFAULT_AUTHORIZE_BEHAVIOUR,
    (input) => Promise.resolve(fake.mintCode(input))
  );
  const back = answer.headers['location'] ?? '';
  expect(back.startsWith(`${APP}/api/auth/linear/callback?`)).toBe(true);
  const response = browser.apply(
    await callback(new Request(back, { headers: { cookie: browser.header() } }))
  );
  await drain();
  return { response, authorizeUrl };
}

async function switchTo(
  browser: Browser,
  workspace: string
): Promise<Response> {
  const response = browser.apply(
    await switchPost(
      new Request(`${APP}/api/auth/switch`, {
        method: 'POST',
        headers: {
          origin: APP,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: browser.header(),
        },
        body: new URLSearchParams({ workspace }).toString(),
      })
    )
  );
  await drain();
  return response;
}

/** An API call from `browser`'s tab, which shows `tabWorkspace`. */
function api(browser: Browser, tabWorkspace?: string): HeadersInit {
  currentJar = new Map(browser.jar);
  return {
    origin: APP,
    'content-type': 'application/json',
    ...(tabWorkspace === undefined
      ? {}
      : { 'x-planner-workspace': tabWorkspace }),
  };
}

async function workspaceOf(token: string | undefined): Promise<string | null> {
  return (await engine.authenticate(token))?.session.workspaceId ?? null;
}

const ana = new Browser();

describe('one browser, two workspaces, over a real engine', () => {
  test('sign in to Acme and install it', async () => {
    const signedIn = await connect(ana, 'signin', 'acme', 'ana');
    expect(signedIn.response.headers.get('location')).toBe('/setup');
    const installed = await connect(ana, 'install', 'acme', 'ana');
    expect(installed.response.headers.get('location')).toBe('/timeline');
    expect(await workspaceOf(ana.active)).toBe('org-acme');
    expect(ana.stash).toEqual([]);
  });

  test('connect Globex (prompt=consent) as its admin and install it; Acme stays in the stash', async () => {
    const acmeToken = ana.active ?? '';
    const added = await connect(ana, 'add_workspace', 'globex', 'gia');
    expect(new URL(added.authorizeUrl).searchParams.get('prompt')).toBe(
      'consent'
    );
    expect(added.response.headers.get('location')).toBe('/setup');
    expect(ana.stash).toEqual([acmeToken]);
    const installed = await connect(ana, 'install', 'globex', 'gia');
    expect(installed.response.headers.get('location')).toBe('/timeline');
    // Each token authenticates to its own workspace only.
    expect(await workspaceOf(ana.active)).toBe('org-globex');
    expect(await workspaceOf(ana.stash[0])).toBe('org-acme');
  });

  test('switching changes the active workspace, both ways', async () => {
    const [globex, acme] = [ana.active ?? '', ana.stash[0]];
    const toAcme = await switchTo(ana, 'org-acme');
    expect(toAcme.status).toBe(200);
    expect(await toAcme.json()).toEqual({ location: '/week' });
    expect(ana.active).toBe(acme);
    expect(ana.stash).toEqual([globex]);
    await switchTo(ana, 'org-globex');
    expect(ana.active).toBe(globex);
    expect(ana.stash).toEqual([acme]);
  });

  test('a tab still showing Acme gets 409 workspace_changed', async () => {
    const stale = await paletteGet(
      new Request(`${APP}/api/palette`, { headers: api(ana, 'org-acme') })
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('workspace_changed');
    expect(body.error.message).toBe(
      'This tab shows Acme, but this browser switched to Globex in another tab. Reload to continue in Globex, or switch back to Acme.'
    );
    const fresh = await paletteGet(
      new Request(`${APP}/api/palette`, { headers: api(ana, 'org-globex') })
    );
    expect(fresh.status).toBe(200);
  });

  test('a write grant for Globex replaces its session; Acme stays', async () => {
    const [before, acme] = [ana.active, ana.stash[0]];
    const granted = await connect(ana, 'grant_write', 'globex', 'gia');
    expect(granted.response.headers.get('location')).toBe('/week');
    expect(ana.active).not.toBe(before);
    expect(ana.stash).toEqual([acme]);
    const actor = await engine.authenticate(ana.active);
    expect(actor?.session.workspaceId).toBe('org-globex');
    expect(actor?.canWriteLinear).toBe(true);
    // The replaced session was ended (its grant revoked) after the response.
    expect(await engine.authenticate(before)).toBeNull();
  });

  test('an Acme issue id is refused while Globex is active, and nothing reaches Acme', async () => {
    const from = fake.requests.length;
    const response = await issuePatch(
      new Request(`${APP}/api/issues/iss-eng-1`, {
        method: 'PATCH',
        headers: api(ana, 'org-globex'),
        body: JSON.stringify({ title: 'Renamed across workspaces' }),
      }),
      { params: Promise.resolve({ id: 'iss-eng-1' }) }
    );
    expect(response.status).toBe(404);
    const after = fake.requests.slice(from).filter(isBearerRecord);
    expect(after.filter((record) => record.org === 'acme')).toEqual([]);
    // Acme's issue is as it was.
    const acme = await engine.load('org-acme');
    expect(acme.snapshot.issues.get('iss-eng-1')?.title).toBe(
      'Ship the billing export'
    );
  });

  test('connecting a workspace this browser already holds keeps its session and write grant', async () => {
    const [globex, acme] = [ana.active ?? '', ana.stash[0]];
    const again = await connect(ana, 'add_workspace', 'globex', 'gia');
    expect(again.response.headers.get('location')).toBe('/week?connect=same');
    expect(ana.active).toBe(globex);
    expect(ana.stash).toEqual([acme]);
    expect((await engine.authenticate(globex))?.canWriteLinear).toBe(true);
  });

  test('a guest in Globex is read-only (403 read_only) while Acme stays editable for Ana', async () => {
    const guest = new Browser();
    const signedIn = await connect(guest, 'signin', 'globex', 'ana');
    expect(signedIn.response.headers.get('location')).toBe('/week');
    expect(await engine.authenticate(guest.active)).toMatchObject({
      readOnly: true,
      readOnlyReason: 'guest',
    });
    const refused = await issuePatch(
      new Request(`${APP}/api/issues/gx-iss-eng-1`, {
        method: 'PATCH',
        headers: api(guest, 'org-globex'),
        body: JSON.stringify({ title: 'A guest edit' }),
      }),
      { params: Promise.resolve({ id: 'gx-iss-eng-1' }) }
    );
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code
    ).toBe('read_only');
    // Ana's Acme session (a member there) is not read-only.
    expect((await engine.authenticate(ana.stash[0]))?.readOnly).toBe(false);
  });

  test('signing out of Globex keeps Acme and revokes only Globex’s token', async () => {
    const acme = ana.stash[0];
    const revokedBefore = fake.revocations.length;
    const response = ana.apply(
      await logout(
        new Request(`${APP}/api/auth/logout`, {
          method: 'POST',
          headers: {
            origin: APP,
            'content-type': 'application/x-www-form-urlencoded',
            cookie: ana.header(),
          },
          body: 'scope=current&workspace=org-globex',
        })
      )
    );
    await drain();
    expect(response.headers.get('location')).toStartWith('/week?signed_out=1');
    expect(ana.active).toBe(acme);
    expect(ana.stash).toEqual([]);
    expect(await workspaceOf(acme)).toBe('org-acme');
    const revoked = fake.revocations.slice(revokedBefore);
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked.every((r) => r.org === 'globex' && r.who === 'gia')).toBe(
      true
    );
  });

  test('no Linear token or session token reached the logs', () => {
    const log = logLines.join('\n');
    expect(log).not.toContain(OAUTH_TOKEN_PREFIX);
    for (const token of [...ana.jar.values()]) {
      expect(log).not.toContain(token);
    }
  });
});
