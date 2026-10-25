import type { Actor, Engine } from '@better-tracker/engine';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  frameWorkspaces,
  PALETTE_SECTION_ORDER,
  PALETTE_SECTIONS,
  shellSignOut,
  workspacePaletteEntries,
} from '../lib/adapters/shell';
import {
  actorOf,
  type FakeEngineState,
  fakeEngine,
  freshState,
  tok,
} from './auth-fake-engine';

// The shell's held workspaces (owner decision 2026-10-25; architecture
// §8.3): the brand row's switcher, the palette's Workspaces section and
// the footer's sign-out, built from the browser's own sessions in OAuth
// mode and absent in api_key and demo mode. next/headers' cookies() is a
// jar the tests fill.

let jar: Record<string, string> = {};
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        jar[name] === undefined ? undefined : { name, value: jar[name] },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { loadShellFrame } = await import('../lib/load');

const ACME = tok('acme');
const GLOBEX = tok('globex');
const INITECH = tok('initech');

let state: FakeEngineState;
const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;

beforeEach(() => {
  state = freshState();
  state.appUrl = 'http://localhost:3000';
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
    readOnly: 'guest',
  });
  state.sessions.set(INITECH, {
    workspaceId: 'org-initech',
    workspaceName: 'Initech',
    userId: 'in-user-ana',
    userName: 'Ana Moreno',
    live: true,
    installed: false,
  });
  jar = { mp_session: ACME, mp_sessions: `${INITECH}.${GLOBEX}` };
  holder.__milestonePlannerEngine = Promise.resolve(fakeEngine(state));
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
});

function acmeActor(): Actor {
  return actorOf(ACME, state.sessions.get(ACME)!);
}

describe('the shell frame in OAuth mode', () => {
  test('lists the held workspaces by name, current marked, with their hints', async () => {
    const engine = fakeEngine(state);
    const frame = await loadShellFrame(engine, acmeActor());
    expect(frame.workspaceId).toBe('org-acme');
    expect(frame.workspaceName).toBe('Acme');
    expect(frame.workspaces).toEqual([
      { id: 'org-acme', name: 'Acme', hint: 'linear.app/acme', current: true },
      {
        id: 'org-initech',
        name: 'Initech',
        hint: 'Not installed',
        current: false,
      },
      { id: 'org-globex', name: 'Globex', hint: 'Guest', current: false },
    ]);
    expect(frame.connectHref).toBe('/setup/connect');
    // The frame goes to the browser: no session token in it.
    const json = JSON.stringify(frame);
    for (const token of [ACME, GLOBEX, INITECH]) {
      expect(json).not.toContain(token);
    }
  });

  test('the footer says which workspace it signs out of, and posts its id', async () => {
    const frame = await loadShellFrame(fakeEngine(state), acmeActor());
    expect(shellSignOut(frame)).toEqual({
      label: 'Sign out of Acme',
      fields: { scope: 'current', workspace: 'org-acme' },
    });
    jar = { mp_session: ACME };
    const alone = await loadShellFrame(fakeEngine(state), acmeActor());
    expect(alone.workspaces).toHaveLength(1);
    // One workspace: the plain "Sign out", still naming its workspace.
    expect(shellSignOut(alone)).toEqual({
      fields: { scope: 'current', workspace: 'org-acme' },
    });
  });

  test('the palette: Switch to <name> per other workspace by name, then Connect', async () => {
    const frame = await loadShellFrame(fakeEngine(state), acmeActor());
    expect(workspacePaletteEntries(frame)).toEqual([
      {
        id: 'workspace-org-globex',
        label: 'Switch to Globex',
        hint: 'Guest',
        switchTo: 'org-globex',
      },
      {
        id: 'workspace-org-initech',
        label: 'Switch to Initech',
        hint: 'Not installed',
        switchTo: 'org-initech',
      },
      {
        id: 'workspace-connect',
        label: 'Connect another workspace',
        hint: 'Sign in with Linear',
        href: '/setup/connect',
      },
    ]);
    expect(PALETTE_SECTION_ORDER).toEqual([
      PALETTE_SECTIONS.suggestions,
      'Workspaces',
      PALETTE_SECTIONS.jump,
      PALETTE_SECTIONS.navigation,
    ]);
  });
});

describe('api_key and demo mode hold one workspace: no switcher', () => {
  test('the frame has no workspaces, no connect row, a plain sign-out and no palette section', async () => {
    for (const change of [{ auth: 'api_key' }, { mode: 'fixture' }] as const) {
      Object.assign(state, change);
      const frame = await loadShellFrame(fakeEngine(state), acmeActor());
      expect(frame.workspaces).toBeNull();
      expect(frame.connectHref).toBeNull();
      expect(shellSignOut(frame)).toEqual({});
      expect(workspacePaletteEntries(frame)).toEqual([]);
      // Nothing was described: describeSessions is OAuth-only.
      expect(state.calls.describe).toEqual([]);
      state.auth = 'oauth';
      state.mode = 'linear';
    }
  });
});

describe('frameWorkspaces', () => {
  test('the frame workspace is always there and current, even if the held list missed it', () => {
    expect(
      frameWorkspaces({
        currentId: 'org-acme',
        currentName: 'Acme',
        held: [
          {
            workspaceId: 'org-globex',
            workspaceName: null,
            workspaceUrlKey: null,
            installed: true,
            revokedAt: '2026-10-01T00:00:00.000Z',
            guest: false,
          },
        ],
      })
    ).toEqual([
      { id: 'org-acme', name: 'Acme', current: true },
      {
        id: 'org-globex',
        name: 'Linear workspace',
        hint: 'Reinstall needed',
        current: false,
      },
    ]);
  });
});
