import type { Engine } from '@better-tracker/engine';
import {
  FIRST_SYNC_RETRY_MAX_MS,
  FIRST_SYNC_RETRY_MIN_MS,
} from '@better-tracker/engine';
import { ToastProvider } from '@better-tracker/ui';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { revokedNotice } from '../lib/adapters/setup';
import { FIRST_SYNC_RETRY_SENTENCE } from '../lib/read-only';
import { signValue } from '../lib/signed-cookie';
import { weekWorkspaceNotices } from '../lib/workspace-copy';
import {
  type FakeEngineState,
  fakeEngine,
  freshState,
  SECRET,
  tok,
} from './auth-fake-engine';

// The pages of holding several workspaces (owner decision 2026-10-25;
// architecture §8.4): /setup/connect, the /open interstitial, the
// signed-out landing's "Continue in" list, /setup's per-reason revoked
// states and sign-out of all workspaces, and /week's notices. The pages
// are server components run here with a fake engine; next/headers' jar is
// the test's and redirect()/notFound() throw what they were given.

let jar: Record<string, string> = {};
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        jar[name] === undefined ? undefined : { name, value: jar[name] },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

class Redirect extends Error {}
const realNavigation = await import('next/navigation');
void mock.module('next/navigation', () => ({
  ...realNavigation,
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Redirect('not-found');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/week',
  useSearchParams: () => new URLSearchParams(''),
}));

const { default: ConnectPage } =
  await import('../app/(app)/setup/connect/page');
const { default: OpenPage } = await import('../app/(app)/open/page');
const { default: SetupPage } = await import('../app/(app)/setup/page');
const { default: HomePage } = await import('../app/(app)/page');
const { default: WorkspaceNotices } =
  await import('../app/(app)/components/workspace-notices');

const ACME = tok('acme');
const GLOBEX = tok('globex');

let state: FakeEngineState;
let installation: Record<string, unknown> | null = null;

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
const savedSecret = process.env.SESSION_SECRET;

function engineWithInstallation(): Engine {
  const engine = fakeEngine(state);
  return Object.assign(Object.create(engine) as Engine, {
    getInstallation: () => Promise.resolve(installation),
    listDemoUsers: () => Promise.resolve([]),
    listWorkspaceIds: () => Promise.resolve([]),
    load: () => Promise.reject(new Error('no mirror in this test')),
  });
}

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
  });
  installation = null;
  jar = { mp_session: ACME, mp_sessions: GLOBEX };
  holder.__milestonePlannerEngine = Promise.resolve(engineWithInstallation());
  process.env.SESSION_SECRET = SECRET;
});

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

function isAsync(
  type: unknown
): type is (props: unknown) => Promise<ReactNode> {
  return (
    typeof type === 'function' && type.constructor.name === 'AsyncFunction'
  );
}

/**
 * Resolves the async server components in a tree (react-dom's static
 * renderer runs only synchronous ones): each is awaited in place, then
 * its result resolved the same way, down every element-valued prop.
 */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (isAsync(element.type)) {
    return resolve(await element.type(element.props));
  }
  const props: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(element.props)) {
    if (isValidElement(value) || Array.isArray(value)) {
      props[key] = await resolve(value as ReactNode);
      changed = true;
    }
  }
  if (!changed) return element;
  const { children, ...rest } = props;
  return children === undefined
    ? cloneElement(element, rest)
    : cloneElement(element, rest, ...Children.toArray(children as ReactNode));
}

async function render(page: Promise<ReactNode>): Promise<string> {
  const tree = await resolve(await page);
  return renderToStaticMarkup(<ToastProvider>{tree}</ToastProvider>);
}

async function redirected(page: () => Promise<ReactNode>): Promise<string> {
  try {
    await render(page());
  } catch (error) {
    if (error instanceof Redirect) return error.message;
    throw error;
  }
  throw new Error('expected a redirect');
}

const params = (value: Record<string, string>) => Promise.resolve(value);

describe('/setup/connect', () => {
  test('the hint and a plain Continue to Linear link, signed in or out', async () => {
    for (const cookies of [jar, {}]) {
      jar = cookies;
      const html = await render(ConnectPage({ searchParams: params({}) }));
      expect(html).toContain(
        'Linear connects the workspace you have open at linear.app. Open the one you want to add there first.'
      );
      expect(html).toContain('href="/api/auth/linear?intent=add_workspace"');
      expect(html).toContain('Continue to Linear');
    }
  });

  test('carries a sanitised returnTo', async () => {
    const html = await render(
      ConnectPage({
        searchParams: params({ returnTo: '/timeline?milestone=m1' }),
      })
    );
    expect(html).toContain(
      'href="/api/auth/linear?intent=add_workspace&amp;returnTo=%2Ftimeline%3Fmilestone%3Dm1"'
    );
    const away = await render(
      ConnectPage({ searchParams: params({ returnTo: '//evil.example' }) })
    );
    expect(away).toContain('href="/api/auth/linear?intent=add_workspace"');
  });

  test('at ten workspaces it says to sign out of one first, with no link', async () => {
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
    jar = { mp_session: ACME, mp_sessions: many.join('.') };
    const html = await render(ConnectPage({ searchParams: params({}) }));
    expect(html).toContain('Sign out of a workspace first');
    expect(html).not.toContain('intent=add_workspace');
  });

  test('404 in demo mode and with personal API keys', async () => {
    for (const change of [{ mode: 'fixture' }, { auth: 'api_key' }] as const) {
      Object.assign(state, change);
      expect(
        await redirected(() => ConnectPage({ searchParams: params({}) }))
      ).toBe('not-found');
      state.mode = 'linear';
      state.auth = 'oauth';
    }
  });
});

describe('/open (the interstitial)', () => {
  test('the active workspace goes straight to the page', async () => {
    expect(
      await redirected(() =>
        OpenPage({
          searchParams: params({ ws: 'org-acme', to: '/issues/ENG-1' }),
        })
      )
    ).toBe('/issues/ENG-1');
    expect(
      await redirected(() =>
        OpenPage({
          searchParams: params({ ws: 'org-acme', to: '//evil.example' }),
        })
      )
    ).toBe('/week');
  });

  test('a held workspace: its name and a Switch form carrying the page', async () => {
    const html = await render(
      OpenPage({
        searchParams: params({
          ws: 'org-globex',
          to: '/timeline?milestone=m1',
        }),
      })
    );
    expect(html).toContain('This link is for Globex.');
    expect(html).toContain('action="/api/auth/switch"');
    expect(html).toContain('name="workspace" value="org-globex"');
    expect(html).toContain('name="returnTo" value="/timeline?milestone=m1"');
    expect(html).toContain('Switch to Globex');
  });

  test('a workspace the browser does not hold: never its value, a connect link', async () => {
    const html = await render(
      OpenPage({
        searchParams: params({ ws: 'org-not-held', to: '/timeline' }),
      })
    );
    expect(html).toContain(
      'This link is for a Linear workspace this browser is not signed in to.'
    );
    // The connect keeps the link's workspace in its returnTo, so it comes
    // back here and opens the page only if Linear connected that one; the
    // value is never shown as text.
    expect(html).toContain(
      'href="/setup/connect?returnTo=%2Ftimeline%3Fws%3Dorg-not-held"'
    );
    expect(html.replaceAll(/href="[^"]*"/g, '')).not.toContain('org-not-held');
    const odd = await render(
      OpenPage({
        searchParams: params({ ws: '<b>Acme</b>', to: '/week' }),
      })
    );
    expect(odd).not.toContain('<b>Acme');
    expect(odd).not.toContain('&lt;b&gt;');
    // An odd value matches nothing and goes into no link either.
    expect(odd).toContain('href="/setup/connect"');
  });

  test('the connect from a not-held link lands back on the link, not on its path', async () => {
    // A digest link for Acme's ENG-1 in a browser holding only Globex:
    // Linear may connect any workspace, and Globex has an ENG-1 too.
    jar = { mp_session: GLOBEX };
    const html = await render(
      OpenPage({
        searchParams: params({ ws: 'org-acme', to: '/issues/ENG-1' }),
      })
    );
    const connect = /href="(\/setup\/connect[^"]*)"/.exec(html)?.[1] ?? '';
    const returnTo = new URL(
      connect.replaceAll('&amp;', '&'),
      'http://localhost:3000'
    ).searchParams.get('returnTo');
    expect(returnTo).toBe('/issues/ENG-1?ws=org-acme');
  });

  test('demo mode holds one workspace: the link just opens', async () => {
    state.mode = 'fixture';
    expect(
      await redirected(() =>
        OpenPage({ searchParams: params({ ws: 'org-other', to: '/timeline' }) })
      )
    ).toBe('/timeline');
  });
});

describe('the signed-out landing', () => {
  test('a dead active cookie with live stashed sessions offers Continue in <name> forms', async () => {
    jar = { mp_session: tok('gone'), mp_sessions: GLOBEX };
    const html = await render(HomePage({ searchParams: params({}) }));
    expect(html).toContain(
      'Your session for this workspace ended. This browser is still signed in to:'
    );
    expect(html).toContain('Continue in Globex');
    expect(html).toContain('action="/api/auth/switch"');
    expect(html).toContain('name="workspace" value="org-globex"');
    expect(html).toContain('href="/setup/connect"');
    expect(html).not.toContain(GLOBEX);
  });

  test('a failed switch says so; with nothing held there is no list', async () => {
    jar = {};
    const html = await render(
      HomePage({ searchParams: params({ switch_error: 'session_ended' }) })
    );
    expect(html).toContain('Not switched');
    expect(html).toContain('Your session for that workspace ended.');
    expect(html).not.toContain('Continue in');
  });
});

describe('the landing, signed in', () => {
  test("a stale tab's install or write grant: both workspaces named, a switch back to the tab's", async () => {
    // GET /api/auth/linear refused it: the tab showed Globex, this browser
    // had switched to Acme in another tab.
    const html = await render(
      HomePage({
        searchParams: params({
          auth_error: 'workspace_changed',
          workspace: 'org-globex',
          returnTo: '/issues/ENG-1',
        }),
      })
    );
    expect(html).toContain(
      'This tab showed Globex, but this browser had switched to Acme in another tab, so Linear was not asked. Switch back to Globex to try again there, or continue in Acme.'
    );
    expect(html).toContain('action="/api/auth/switch"');
    expect(html).toContain('name="workspace" value="org-globex"');
    expect(html).toContain('name="returnTo" value="/issues/ENG-1"');
    expect(html).toContain('Switch to Globex');
    expect(html).not.toContain('Linear did not finish.');
    // A workspace the browser does not hold is not named (nor echoed).
    const unknown = await render(
      HomePage({
        searchParams: params({
          auth_error: 'workspace_changed',
          workspace: 'org-not-held',
        }),
      })
    );
    expect(unknown).toContain(
      'This tab showed another workspace, but this browser had switched to Acme in another tab'
    );
    expect(unknown).not.toContain('org-not-held');
    expect(unknown).not.toContain('action="/api/auth/switch"');
  });
});

describe('/setup', () => {
  const base = {
    workspaceId: 'org-acme',
    workspaceName: 'Acme',
    urlKey: 'acme',
    installedByUserId: 'user-ana',
    appUserId: 'app',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    tokens: {
      accessToken: '',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    },
  };

  test('not installed: the session names its workspace', async () => {
    jar = { mp_session: ACME };
    const html = await render(SetupPage());
    expect(html).toContain('Acme · not installed yet');
    expect(html).not.toContain('Sign out of all workspaces');
    // Install names the workspace this page shows, so a stale tab's click
    // is refused instead of installing for the browser's active one.
    expect(html).toContain(
      'href="/api/auth/linear?intent=install&amp;workspace=org-acme"'
    );
  });

  test('revoked: why, and when the data goes, per reason', async () => {
    for (const [reason, words] of [
      [
        'uninstalled',
        'An admin uninstalled the app in Linear on Oct 20, 2026.',
      ],
      [
        'removed',
        'The person who runs this planner removed Acme on Oct 20, 2026.',
      ],
      [
        'grant_dead',
        'Linear refused the app’s token for Acme on Oct 20, 2026.',
      ],
    ] as const) {
      installation = { ...base, revokedAt: '2026-10-20T12:00:00.000Z' };
      const acme = state.sessions.get(ACME)!;
      acme.revokedAt = '2026-10-20T12:00:00.000Z';
      acme.revokedReason = reason;
      const html = await render(SetupPage());
      expect(html).toContain(words);
      if (reason === 'grant_dead') {
        expect(html).not.toContain('Its data is deleted');
      } else {
        expect(html).toContain(
          'Its data is deleted on Nov 19, 2026 unless someone reinstalls.'
        );
      }
    }
  });

  test('two or more workspaces held: Sign out of all workspaces', async () => {
    const html = await render(SetupPage());
    expect(html).toContain('Sign out of all workspaces');
    expect(html).toContain('name="scope" value="all"');
  });

  test('the first-sync copy says when it is tried again, as the engine waits', () => {
    expect(FIRST_SYNC_RETRY_MIN_MS).toBe(60_000);
    expect(FIRST_SYNC_RETRY_SENTENCE).toContain('a minute after a failure');
    expect(FIRST_SYNC_RETRY_SENTENCE).toContain(
      `at most every ${FIRST_SYNC_RETRY_MAX_MS / 60_000} minutes`
    );
    expect(FIRST_SYNC_RETRY_SENTENCE).not.toContain('every page');
  });

  test('revokedNotice copy', () => {
    expect(
      revokedNotice({
        reason: null,
        revokedAt: '2026-10-20T12:00:00.000Z',
        workspaceName: 'Acme',
        timeZone: 'UTC',
        purgeAfterDays: 30,
      })
    ).toStartWith('Linear refused the app’s token for Acme on Oct 20, 2026.');
  });
});

describe("/week's workspace notices", () => {
  const noVerify = (): string | null => null;

  test('connect=same names the workspace Linear connected again', () => {
    expect(
      weekWorkspaceNotices({
        params: { connect: 'same' },
        workspaceName: 'Acme',
        verifiedName: noVerify,
      })
    ).toEqual([
      {
        id: 'connect_same',
        label: 'Already connected',
        tone: 'default',
        message:
          'Linear connected Acme again, which this browser already has. To add another workspace, open it at linear.app first, then choose Connect another workspace.',
        signOutAll: false,
      },
    ]);
  });

  test('signed_out names the workspace from a signed value only, with sign out of all', () => {
    const value = signValue(
      { signedOut: 'Globex' },
      SECRET,
      Date.now() + 60_000
    );
    const html = renderToStaticMarkup(
      <WorkspaceNotices
        params={{ signed_out: '1', from: value }}
        workspaceName="Acme"
      />
    );
    expect(html).toContain('Signed out of Globex. Still signed in to Acme.');
    expect(html).toContain('Sign out of all workspaces');
    const forged = renderToStaticMarkup(
      <WorkspaceNotices
        params={{ signed_out: '1', from: 'eyJzaWduZWRPdXQiOiJFdmlsIn0.forged' }}
        workspaceName="Acme"
      />
    );
    expect(forged).toContain('Signed out. Still signed in to Acme.');
    expect(forged).not.toContain('Evil');
  });

  test('switch errors and a sign-out of nothing; unknown values show nothing', () => {
    const notices = weekWorkspaceNotices({
      params: { signed_out: 'none', switch_error: 'unknown_workspace' },
      workspaceName: 'Acme',
      verifiedName: noVerify,
    });
    expect(notices.map((n) => [n.id, n.tone])).toEqual([
      ['signed_out_none', 'default'],
      ['switch_error', 'danger'],
    ]);
    expect(
      weekWorkspaceNotices({
        params: { connect: 'other', switch_error: '<script>' },
        workspaceName: 'Acme',
        verifiedName: noVerify,
      })
    ).toEqual([]);
  });
});
