import type { Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { shouldReload } from '../app/(app)/components/workspace-frame';
import {
  type FakeEngineState,
  fakeEngine,
  freshState,
  tok,
} from './auth-fake-engine';

// The guards against a tab left on one workspace after this browser
// switched to another in a second tab (owner decision 2026-10-25;
// architecture §8.1 "Stale tabs"): the API answers 409 workspace_changed
// to a request naming another workspace than the active one, and every
// page renders its own workspace id so the shell reloads a tab whose frame
// shows another. next/headers' cookies() only works inside a Next
// request, so it is replaced with a jar the tests fill.

let jar: Record<string, string> = {};
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        jar[name] === undefined ? undefined : { name, value: jar[name] },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { requireApiActor } = await import('../lib/http');

const APP_HTTP = 'http://localhost:3000';
const ACME = tok('acme');
const GLOBEX = tok('globex');

let state: FakeEngineState;
const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;

beforeEach(() => {
  state = freshState();
  state.appUrl = APP_HTTP;
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
    userId: 'gx-user-ana',
    userName: 'Ana Moreno',
    live: true,
  });
  jar = { mp_session: ACME, mp_sessions: GLOBEX };
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine(state));
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
});

function apiRequest(header?: string, method = 'GET'): Request {
  const headers: Record<string, string> = { origin: APP_HTTP };
  if (header !== undefined) headers['x-planner-workspace'] = header;
  return new Request(`${APP_HTTP}/api/palette`, { method, headers });
}

describe('the API guard: X-Planner-Workspace', () => {
  test('absent or the active workspace: allowed', async () => {
    for (const header of [undefined, 'org-acme']) {
      const result = await requireApiActor(apiRequest(header));
      expect(result instanceof Response).toBe(false);
    }
  });

  test('another workspace: 409 workspace_changed naming both, for reads and writes', async () => {
    for (const method of ['GET', 'PATCH']) {
      const result = await requireApiActor(apiRequest('org-globex', method));
      if (!(result instanceof Response)) throw new Error('expected a 409');
      expect(result.status).toBe(409);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.json()).toEqual({
        error: {
          code: 'workspace_changed',
          message:
            'This tab shows Globex, but this browser switched to Acme in another tab. Reload to continue in Acme, or switch back to Globex.',
        },
      });
    }
  });

  test('a workspace the browser no longer holds is not named (the header is never echoed)', async () => {
    const result = await requireApiActor(apiRequest('org-<script>'));
    if (!(result instanceof Response)) throw new Error('expected a 409');
    const body = (await result.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      'This tab shows another workspace, but this browser switched to Acme in another tab. Reload to continue in Acme.'
    );
  });

  test('signed out stays a 401, before the workspace check', async () => {
    jar = {};
    const result = await requireApiActor(apiRequest('org-globex'));
    if (!(result instanceof Response)) throw new Error('expected a 401');
    expect(result.status).toBe(401);
  });
});

describe('the navigation guard', () => {
  test('reloads only inside a signed-in frame that shows another workspace', () => {
    expect(shouldReload('org-acme', 'org-acme')).toBe(false);
    expect(shouldReload('org-acme', 'org-globex')).toBe(true);
    // Signed out since (the page read no session) inside a signed-in frame.
    expect(shouldReload('org-acme', null)).toBe(true);
    // The signed-out frame has nothing to guard.
    expect(shouldReload(undefined, 'org-acme')).toBe(false);
    expect(shouldReload(undefined, null)).toBe(false);
  });

  test('every (app) page and the not-found boundary render WorkspaceGuard', () => {
    const root = join(import.meta.dir, '..', 'app', '(app)');
    const pages: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === 'page.tsx') pages.push(path);
      }
    };
    walk(root);
    // The catch-all renders the not-found state only, which is guarded
    // itself: a page whose lookup misses calls notFound() before it
    // renders its own guard (a stale tab's Acme run looked up in Globex),
    // and the boundary replaces the page.
    const guarded = [
      ...pages.filter((p) => !p.includes('[...missing]')),
      join(root, 'not-found.tsx'),
    ];
    expect(guarded.length).toBeGreaterThanOrEqual(14);
    const missing = guarded
      .filter((p) => !readFileSync(p, 'utf8').includes('<WorkspaceGuard />'))
      .map((p) => relative(root, p));
    expect(missing).toEqual([]);
  });
});
