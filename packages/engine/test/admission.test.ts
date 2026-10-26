// Several workspaces on one deployment (owner decision 2026-10-25):
// admission (LINEAR_WORKSPACES and the operator block list) on every
// sign-in, install, request, webhook and worker list; the add_workspace and
// grant_write intents; sessions in two workspaces at once; describeSessions
// and checkSession. ACME and OTHER are the two fake Linear workspaces.

import type { FetchLike, OAuthClientConfig } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { Installation, Store } from '@better-tracker/store';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import {
  ADMISSION_CACHE_MS,
  createEngine,
  createLinearProvider,
  type Engine,
  EngineAuthError,
  EngineInputError,
  newerSignInUrlKey,
  requireWritable,
  type WorkspaceAdmission,
} from '../src/index';
import {
  ACME,
  createFakeLinear,
  type FakeIdentity,
  type FakeLinear,
  OTHER,
  person,
} from './fake-linear';
import {
  createClock,
  createDemoHarness,
  openTestStore,
  recordingChannel,
  recordingLogger,
  rejection,
  START,
  storeWith,
  TEST_CONFIG,
  type TestClock,
} from './helpers';

// Each test opens one or more PGlite stores (1–2 s each); helpers.ts sets
// the same default, but only for the first file that imports it.
setDefaultTimeout(60_000);

const OAUTH: OAuthClientConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'https://planner.example/api/auth/linear/callback',
};

// Ana is a member of ACME and has a second Linear account in OTHER.
const ANA_ACME: FakeIdentity = {
  user: person('u-ana', 'Ana Ruiz'),
  workspace: ACME,
};
const ANA_OTHER: FakeIdentity = {
  user: person('u-ana-other', 'Ana Ruiz'),
  workspace: OTHER,
};
const ACME_APP: FakeIdentity = {
  user: person('u-acme-app', 'Planner app', { app: true }),
  workspace: ACME,
};

let clock: TestClock;
let store: Store;
let fake: FakeLinear;
let logger: Logger;
let lines: string[];

beforeEach(async () => {
  clock = createClock(START);
  store = await openTestStore(clock);
  fake = createFakeLinear();
  const logs = recordingLogger();
  logger = logs.logger;
  lines = logs.lines;
});
afterEach(async () => {
  // No log line may carry a Linear credential or a session token.
  const output = lines.join('\n');
  expect(output).not.toMatch(/lin_(access|refresh)_\d/);
  expect(output).not.toContain(OAUTH.clientSecret);
  await store.close();
});

/**
 * An OAuth-mode engine over the shared store with `workspaces` admission,
 * calling Linear through `fetch` (the fake by default).
 */
function oauthEngine(
  workspaces?: WorkspaceAdmission,
  over: Store = store,
  fetch: FetchLike = fake.fetch
): Engine {
  return createEngine({
    store: over,
    linear: createLinearProvider({
      store: over,
      oauth: OAUTH,
      logger,
      now: clock.now,
      fetch,
    }),
    channel: recordingChannel(),
    logger,
    config: {
      ...TEST_CONFIG,
      auth: 'oauth',
      oauth: OAUTH,
      ...(workspaces === undefined ? {} : { workspaces }),
    },
    now: clock.now,
    fetch,
  });
}

let codes = 0;
function finish(
  engine: Engine,
  identity: FakeIdentity,
  intent: 'signin' | 'grant_write' | 'add_workspace' = 'signin',
  expectWorkspaceId?: string
): ReturnType<Engine['finishSignIn']> {
  const code = `code-${++codes}`;
  fake.addCode(
    code,
    identity,
    intent === 'grant_write' ? 'read,write' : 'read'
  );
  return engine.finishSignIn({
    code,
    codeVerifier: 'v',
    intent,
    ...(expectWorkspaceId === undefined ? {} : { expectWorkspaceId }),
  });
}

/** An installation row as an earlier install would have left it. */
async function installed(
  workspace: FakeIdentity['workspace'],
  overrides: Partial<Installation> = {}
): Promise<void> {
  await store.saveInstallation({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    urlKey: workspace.urlKey,
    appUserId: `app-${workspace.id}`,
    installedByUserId: 'u-ana',
    revokedAt: null,
    tokens: {
      accessToken: `app-token-${workspace.id}`,
      refreshToken: null,
      expiresAt: null,
      scopes: ['read', 'write'],
    },
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
    ...overrides,
  });
}

/** A mirror of `workspaceId` holding `users`, as a landed sync leaves it. */
async function mirrored(
  workspaceId: string,
  users: FakeIdentity['user'][]
): Promise<void> {
  await store.replaceMirror(
    {
      workspaceId,
      users,
      teams: [],
      states: [],
      initiatives: [],
      projects: [],
      milestones: [],
      issues: [],
      relations: [],
    },
    clock.now().toISOString()
  );
}

async function sessionRows(): Promise<number> {
  return (await store.listWorkspaceStatus(clock.now().toISOString())).reduce(
    (sum, row) => sum + row.sessionCount,
    0
  );
}

/** Moves the clock past the admission cache window. */
function pastCache(): void {
  clock.set(
    new Date(clock.now().getTime() + ADMISSION_CACHE_MS + 1000).toISOString()
  );
}

describe('LINEAR_WORKSPACES', () => {
  test('unset is closed to new workspaces: only installed ones sign in', async () => {
    const engine = oauthEngine();
    expect(await rejection(finish(engine, ANA_ACME))).toMatchObject({
      name: 'EngineAuthError',
      code: 'workspace_not_allowed',
    });
    // The grant Linear issued is revoked and no session is written.
    expect(fake.revoked).toEqual([
      { token: 'lin_refresh_1', hint: 'refresh_token' },
    ]);
    expect(await sessionRows()).toBe(0);

    // An existing deployment keeps working: an installed workspace signs in,
    // and so does one whose installation is revoked (an admin reinstalls).
    await installed(ACME);
    await installed(OTHER, { revokedAt: clock.now().toISOString() });
    expect((await finish(engine, ANA_ACME)).session.workspaceId).toBe(
      'org-acme'
    );
    expect((await finish(engine, ANA_OTHER)).needsInstall).toBe(true);
    expect(await sessionRows()).toBe(2);
  });

  test('a list admits only what it names, by org id or URL key', async () => {
    const byId = oauthEngine({ mode: 'list', entries: ['org-acme'] });
    expect((await finish(byId, ANA_ACME)).session.workspaceId).toBe('org-acme');
    expect(await rejection(finish(byId, ANA_OTHER))).toMatchObject({
      code: 'workspace_not_allowed',
    });

    const byKey = oauthEngine({ mode: 'list', entries: ['other'] });
    expect((await finish(byKey, ANA_OTHER)).session.workspaceId).toBe(
      'org-other'
    );
    expect(await store.getAdmittedPin('other')).toBe('org-other');
    expect(await rejection(finish(byKey, ANA_ACME))).toMatchObject({
      code: 'workspace_not_allowed',
    });
    // Two refusals, two revoked grants, two sessions kept.
    expect(fake.revoked).toHaveLength(2);
    expect(await sessionRows()).toBe(2);
  });

  test('* admits every workspace', async () => {
    const engine = oauthEngine({ mode: 'any' });
    await finish(engine, ANA_ACME);
    await finish(engine, ANA_OTHER);
    expect(await sessionRows()).toBe(2);
    expect(fake.revoked).toEqual([]);
  });

  test('a URL key entry stays pinned to the org it first admitted, across a rename', async () => {
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    await finish(engine, ANA_ACME);
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');

    // ACME renames its URL key: still admitted through the pin.
    const renamed: FakeIdentity = {
      user: ANA_ACME.user,
      workspace: { ...ACME, urlKey: 'acme-labs' },
    };
    expect((await finish(engine, renamed)).workspaceUrlKey).toBe('acme-labs');

    // Another organization that takes the old URL key is not.
    const imposter: FakeIdentity = {
      user: person('u-imp', 'Imp'),
      workspace: { id: 'org-imposter', name: 'Imposter', urlKey: 'acme' },
    };
    expect(await rejection(finish(engine, imposter))).toMatchObject({
      code: 'workspace_not_allowed',
    });
  });

  test('a session admitted before a list names it by URL key pins on first use', async () => {
    // Signed in while LINEAR_WORKSPACES was unset (ACME installed) …
    await installed(ACME);
    await installed(OTHER);
    await mirrored('org-acme', [ANA_ACME.user]);
    await mirrored('org-other', [ANA_OTHER.user]);
    const before = oauthEngine();
    const acme = await finish(before, ANA_ACME);
    const other = await finish(before, ANA_OTHER);

    // … then the operator lists ACME by URL key only.
    const after = oauthEngine({ mode: 'list', entries: ['acme'] });
    expect(await after.authenticate(acme.sessionToken)).toMatchObject({
      session: { workspaceId: 'org-acme' },
    });
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
    expect(await after.authenticate(other.sessionToken)).toBeNull();
    // A refused session reads as signed out, but its row is kept: a list
    // refusal ends nothing, so re-admitting the workspace signs it back in.
    expect(
      await store.getSession(other.sessionToken, clock.now().toISOString())
    ).not.toBeNull();
  });
});

describe('the operator block list', () => {
  test('a block by id refuses the workspace whatever LINEAR_WORKSPACES says', async () => {
    const engine = oauthEngine({ mode: 'any' });
    await store.blockWorkspace(
      'ORG-OTHER',
      'id',
      'spam',
      clock.now().toISOString()
    );
    expect(await rejection(finish(engine, ANA_OTHER))).toMatchObject({
      name: 'EngineAuthError',
      code: 'workspace_blocked',
    });
    expect(fake.revoked).toHaveLength(1);
    expect(await sessionRows()).toBe(0);
    await finish(engine, ANA_ACME);
  });

  test('a block by URL key is pinned to the org it first matches, so a rename cannot dodge it', async () => {
    const engine = oauthEngine({ mode: 'any' });
    await store.blockWorkspace(
      'Acme',
      'url_key',
      null,
      clock.now().toISOString()
    );
    expect(await rejection(finish(engine, ANA_ACME))).toMatchObject({
      code: 'workspace_blocked',
    });
    expect(
      (await store.listBlockedWorkspaces()).map((b) => [b.key, b.kind])
    ).toEqual([['org-acme', 'id']]);
    const renamed: FakeIdentity = {
      user: ANA_ACME.user,
      workspace: { ...ACME, urlKey: 'acme-new' },
    };
    expect(await rejection(finish(engine, renamed))).toMatchObject({
      code: 'workspace_blocked',
    });
    expect(await sessionRows()).toBe(0);
  });
});

describe('blocks and pins over time', () => {
  test('unblock by URL key lifts a block pinned to its org at a sign-in attempt', async () => {
    const engine = oauthEngine({ mode: 'any' });
    expect(await engine.blockWorkspace('other')).toMatchObject({
      key: 'other',
      kind: 'url_key',
      workspaceId: null,
    });
    // OTHER's admin tries to sign in: refused, and the block now names
    // the org by id (no session or installation was written).
    expect(await rejection(finish(engine, ANA_OTHER))).toMatchObject({
      code: 'workspace_blocked',
    });
    expect(await store.listBlockedWorkspaces()).toEqual([
      expect.objectContaining({
        key: 'org-other',
        kind: 'id',
        urlKey: 'other',
      }),
    ]);
    expect(await engine.unblockWorkspace('other')).toBe(true);
    expect(await store.listBlockedWorkspaces()).toEqual([]);
    expect((await finish(engine, ANA_OTHER)).session.workspaceId).toBe(
      'org-other'
    );
  });

  test('a LINEAR_WORKSPACES URL-key pin outlives the purge of its workspace', async () => {
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    await installed(ACME);
    await finish(engine, ANA_ACME);
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
    await store.revokeInstallation(
      'org-acme',
      'uninstalled',
      clock.now().toISOString()
    );
    clock.set(new Date(clock.now().getTime() + 31 * 86_400_000).toISOString());
    expect((await engine.cleanup()).purgedWorkspaces).toBe(1);
    expect(await store.getInstallation('org-acme')).toBeNull();
    // Another organization that takes linear.app/acme is still refused.
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
    const stranger: FakeIdentity = {
      user: person('u-stranger', 'Stranger'),
      workspace: { id: 'org-stranger', name: 'Stranger', urlKey: 'acme' },
    };
    expect(await rejection(finish(engine, stranger))).toMatchObject({
      code: 'workspace_not_allowed',
    });
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
  });
});

describe('authenticate', () => {
  test('refuses a blocked workspace before any sync, and keeps the row', async () => {
    const engine = oauthEngine({ mode: 'any' });
    await installed(ACME);
    // Signed in (no sync: the mirror is still empty) …
    const { sessionToken } = await finish(engine, ANA_ACME);
    // … then blocked; past the cache window the session reads signed out.
    await store.blockWorkspace(
      'org-acme',
      'id',
      null,
      clock.now().toISOString()
    );
    pastCache();
    expect(await engine.authenticate(sessionToken)).toBeNull();
    // mirrorForPerson never ran: no sync was started with the app token.
    expect(fake.graphqlTokens).not.toContain('app-token-org-acme');
    expect(await store.getSyncState('org-acme')).toBeNull();
    expect(
      await store.getSession(sessionToken, clock.now().toISOString())
    ).not.toBeNull();
  });

  test('reuses a block list up to 30 s old, and the last good one when the store fails', async () => {
    let failing = false;
    const flaky = storeWith(store, {
      listBlockedWorkspaces: () =>
        failing
          ? Promise.reject(new Error('database down'))
          : store.listBlockedWorkspaces(),
    });
    const engine = oauthEngine({ mode: 'any' }, flaky);
    await installed(ACME);
    await mirrored('org-acme', [ANA_ACME.user]);
    const { sessionToken } = await finish(engine, ANA_ACME);
    expect(await engine.authenticate(sessionToken)).not.toBeNull();

    // A block added now is seen once the cached list is older than 30 s.
    await store.blockWorkspace(
      'org-acme',
      'id',
      null,
      clock.now().toISOString()
    );
    expect(await engine.authenticate(sessionToken)).not.toBeNull();
    pastCache();
    expect(await engine.authenticate(sessionToken)).toBeNull();

    // Unblocked and read again; then the store fails: the last good list
    // (no block) is used, and logged.
    await store.unblockWorkspace('org-acme');
    pastCache();
    expect(await engine.authenticate(sessionToken)).not.toBeNull();
    failing = true;
    pastCache();
    expect(await engine.authenticate(sessionToken)).not.toBeNull();
    expect(
      lines.some((l) => l.includes('could not read the workspace block list'))
    ).toBe(true);

    // A sign-in fails closed instead, and its new grant is revoked.
    const revokedBefore = fake.revoked.length;
    expect(await rejection(finish(engine, ANA_ACME))).toMatchObject({
      message: 'database down',
    });
    expect(fake.revoked).toHaveLength(revokedBefore + 1);
  });
});

describe('finishInstall', () => {
  test('an install for a workspace blocked since sign-in revokes the app token', async () => {
    const engine = oauthEngine({ mode: 'any' });
    const { sessionToken } = await finish(engine, ANA_ACME);
    const actor = await engine.authenticate(sessionToken);
    if (actor === null) throw new Error('not signed in');
    await store.blockWorkspace(
      'org-acme',
      'id',
      null,
      clock.now().toISOString()
    );
    fake.addCode('code-install', ACME_APP, 'read,write,initiative:read');
    expect(
      await rejection(
        engine.finishInstall({
          code: 'code-install',
          codeVerifier: 'v',
          actor,
          expectWorkspaceId: 'org-acme',
        })
      )
    ).toMatchObject({ code: 'workspace_blocked' });
    expect(await store.getInstallation('org-acme')).toBeNull();
    expect(fake.revoked.map((r) => r.hint)).toEqual(['refresh_token']);
  });

  test('the session finishing an install must be of the workspace it was started for', async () => {
    const engine = oauthEngine({ mode: 'any' });
    const { sessionToken } = await finish(engine, ANA_ACME);
    const actor = await engine.authenticate(sessionToken);
    if (actor === null) throw new Error('not signed in');
    fake.addCode('code-install', ACME_APP, 'read,write');
    const graphqlBefore = fake.graphqlTokens.length;
    expect(
      await rejection(
        engine.finishInstall({
          code: 'code-install',
          codeVerifier: 'v',
          actor,
          expectWorkspaceId: 'org-other',
        })
      )
    ).toMatchObject({ code: 'wrong_workspace' });
    // Refused before the code was exchanged: no grant to revoke.
    expect(fake.graphqlTokens).toHaveLength(graphqlBefore);
    expect(fake.revoked).toEqual([]);
    const installation = await engine.finishInstall({
      code: 'code-install',
      codeVerifier: 'v',
      actor,
      expectWorkspaceId: 'org-acme',
    });
    expect(installation.workspaceId).toBe('org-acme');
  });
});

describe('sign-in intents', () => {
  test('add_workspace asks for read with prompt=consent, and no app actor', () => {
    const engine = oauthEngine({ mode: 'any' });
    const params = new URL(engine.startOAuth('add_workspace').url).searchParams;
    expect(params.get('scope')).toBe('read');
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('actor')).toBeNull();
    // Plain sign-in still lets Linear skip its consent screen.
    expect(
      new URL(engine.startOAuth('signin').url).searchParams.get('prompt')
    ).toBeNull();
    expect(() =>
      engine.startOAuth('constructor' as Parameters<Engine['startOAuth']>[0])
    ).toThrow(EngineInputError);
  });

  test('add_workspace signs in like signin and keeps the workspace name and URL key', async () => {
    const engine = oauthEngine({ mode: 'any' });
    const result = await finish(engine, ANA_OTHER, 'add_workspace');
    expect(result).toMatchObject({
      needsInstall: true,
      workspaceName: 'Other Co',
      workspaceUrlKey: 'other',
      session: { workspaceId: 'org-other', tokens: { scopes: ['read'] } },
    });
    // Not installed, yet the session names its workspace.
    expect(await engine.describeSessions([result.sessionToken])).toEqual([
      expect.objectContaining({
        workspaceId: 'org-other',
        workspaceName: 'Other Co',
        workspaceUrlKey: 'other',
        installed: false,
      }),
    ]);
  });

  test('grant_write needs the workspace it is for, and a grant for another one is revoked', async () => {
    const engine = oauthEngine({ mode: 'any' });
    expect(
      await rejection(finish(engine, ANA_ACME, 'grant_write'))
    ).toBeInstanceOf(EngineInputError);
    // Refused before the exchange: Linear issued nothing.
    expect(fake.graphqlTokens).toEqual([]);

    // Ana asked for write access in ACME, but OTHER was open at linear.app.
    const wrong = await rejection(
      finish(engine, ANA_OTHER, 'grant_write', 'org-acme')
    );
    expect(wrong).toBeInstanceOf(EngineAuthError);
    expect(wrong).toMatchObject({ code: 'grant_wrong_workspace' });
    expect(fake.revoked).toHaveLength(1);
    expect(await sessionRows()).toBe(0);

    const right = await finish(engine, ANA_ACME, 'grant_write', 'org-acme');
    expect(right.session.tokens.scopes).toEqual(['read', 'write']);
  });
});

describe('several workspaces at once', () => {
  test('one person holds sessions in ACME and OTHER; signing out of one keeps the other', async () => {
    const engine = oauthEngine({ mode: 'any' });
    const acme = await finish(engine, ANA_ACME);
    const other = await finish(engine, ANA_OTHER, 'add_workspace');
    expect(
      (await engine.authenticate(acme.sessionToken))?.session.workspaceId
    ).toBe('org-acme');
    expect(
      (await engine.authenticate(other.sessionToken))?.session.workspaceId
    ).toBe('org-other');

    const acmeRow = await store.getSession(
      acme.sessionToken,
      clock.now().toISOString()
    );
    await engine.signOut(acme.sessionToken);
    expect(await engine.authenticate(acme.sessionToken)).toBeNull();
    expect(
      (await engine.authenticate(other.sessionToken))?.session.workspaceId
    ).toBe('org-other');
    // Only ACME's grant was revoked.
    expect(fake.revoked).toEqual([
      {
        token: acmeRow?.tokens.refreshToken ?? 'missing',
        hint: 'refresh_token',
      },
    ]);
  });

  test('a guest in OTHER is read-only while the same person may write in ACME', async () => {
    const engine = oauthEngine({ mode: 'any' });
    await installed(ACME);
    await installed(OTHER);
    await mirrored('org-acme', [ANA_ACME.user]);
    await mirrored('org-other', [{ ...ANA_OTHER.user, guest: true }]);
    const acme = await finish(engine, ANA_ACME, 'grant_write', 'org-acme');
    const other = await finish(engine, ANA_OTHER, 'add_workspace');

    const writer = await engine.authenticate(acme.sessionToken);
    expect(writer).toMatchObject({ readOnly: false, canWriteLinear: true });
    const guest = await engine.authenticate(other.sessionToken);
    expect(guest).toMatchObject({
      readOnly: true,
      readOnlyReason: 'guest',
      canWriteLinear: false,
    });
    if (guest === null) throw new Error('not signed in');
    expect(() => requireWritable(guest)).toThrow(EngineAuthError);
    // No write grant is taken for the guest in OTHER.
    expect(
      await rejection(finish(engine, ANA_OTHER, 'grant_write', 'org-other'))
    ).toMatchObject({ code: 'read_only' });
    expect(
      (
        await engine.describeSessions([acme.sessionToken, other.sessionToken])
      ).map((d) => d?.guest)
    ).toEqual([false, true]);
  });
});

describe('describeSessions', () => {
  test('answers from one store query, in input order, leaving out refused workspaces', async () => {
    await installed(ACME);
    await mirrored('org-acme', [ANA_ACME.user]);
    const calls: string[] = [];
    const watched = new Proxy(store, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const engine = oauthEngine({ mode: 'any' }, watched);
    const acme = await finish(engine, ANA_ACME);
    const other = await finish(engine, ANA_OTHER, 'add_workspace');
    await store.blockWorkspace(
      'org-other',
      'id',
      null,
      clock.now().toISOString()
    );
    pastCache();

    calls.length = 0;
    const graphql = fake.graphqlTokens.length;
    const described = await engine.describeSessions([
      other.sessionToken,
      'not-a-session',
      acme.sessionToken,
    ]);
    expect(described).toEqual([
      null,
      null,
      {
        token: acme.sessionToken,
        workspaceId: 'org-acme',
        workspaceName: 'Acme',
        workspaceUrlKey: 'acme',
        signInUrlKey: 'acme',
        // The sign-in read the key and signed in at the same instant.
        signedInAt: START,
        urlKeyReadAt: START,
        userId: 'u-ana',
        userName: 'Ana Ruiz',
        expiresAt: '2026-11-20T15:00:00.000Z',
        guest: false,
        installed: true,
        revokedAt: null,
        revokedReason: null,
      },
    ]);
    // No Linear call, no mirror or installation read, no credential.
    expect(fake.graphqlTokens).toHaveLength(graphql);
    expect(fake.refreshCalls).toEqual([]);
    expect(calls).toEqual(['describeSessions', 'listBlockedWorkspaces']);
    expect(JSON.stringify(described)).not.toMatch(/lin_(access|refresh)_/);
  });

  test('is empty in demo and api_key modes', async () => {
    const demo = await createDemoHarness();
    try {
      const { sessionToken } = await demo.engine.devSignIn('user-ana');
      expect(await demo.engine.describeSessions([sessionToken])).toEqual([]);
      expect(await demo.engine.checkSession(sessionToken)).toEqual({
        workspaceId: demo.fixture.data.workspaceId,
      });
    } finally {
      await demo.close();
    }
    const keyed = createEngine({
      store,
      linear: createLinearProvider({ store, oauth: OAUTH, logger }),
      channel: recordingChannel(),
      logger,
      config: { ...TEST_CONFIG, auth: 'api_key' },
    });
    expect(await keyed.describeSessions(['anything'])).toEqual([]);
    expect(await keyed.checkSession('anything')).toBeNull();
  });
});

describe('checkSession', () => {
  test('refreshes a token near expiry and never syncs', async () => {
    const engine = oauthEngine({ mode: 'any' });
    await installed(ACME);
    fake.addRefreshToken('r-old', ANA_ACME);
    const { token } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-ana',
      userName: 'Ana Ruiz',
      tokens: {
        accessToken: 'a-old',
        refreshToken: 'r-old',
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
        scopes: ['read'],
      },
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(await engine.checkSession(token)).toEqual({
      workspaceId: 'org-acme',
    });
    expect(fake.refreshCalls).toEqual(['r-old']);
    const stored = await store.getSession(token, clock.now().toISOString());
    expect(stored?.tokens.refreshToken).toMatch(/^lin_refresh_/);
    // ACME is installed and has no mirror: authenticate would have synced.
    expect(await store.getSyncState('org-acme')).toBeNull();
    expect(fake.graphqlTokens).toEqual([]);

    expect(await engine.checkSession('nobody')).toBeNull();
    expect(await engine.checkSession(undefined)).toBeNull();
  });

  test('a dead grant ends the session; a refused workspace is no live session', async () => {
    const engine = oauthEngine({ mode: 'list', entries: ['org-acme'] });
    fake.addRefreshToken('r-dead', ANA_ACME, { invalid: true });
    const dead = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-ana',
      userName: 'Ana Ruiz',
      tokens: {
        accessToken: 'a-dead',
        refreshToken: 'r-dead',
        expiresAt: new Date(clock.now().getTime() - 1000).toISOString(),
        scopes: ['read'],
      },
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(await engine.checkSession(dead.token)).toBeNull();
    expect(
      await store.getSession(dead.token, clock.now().toISOString())
    ).toBeNull();

    const refused = await store.createSession({
      workspaceId: 'org-other',
      userId: 'u-ana-other',
      userName: 'Ana Ruiz',
      tokens: {
        accessToken: 'a-other',
        refreshToken: null,
        expiresAt: null,
        scopes: ['read'],
      },
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(await engine.checkSession(refused.token)).toBeNull();
    // Left for cleanup, like authenticate leaves it.
    expect(
      await store.getSession(refused.token, clock.now().toISOString())
    ).not.toBeNull();
  });
});

describe('webhooks', () => {
  let deliveries = 0;
  function event(
    workspaceId: string,
    type = 'Issue',
    action = 'update'
  ): Parameters<Engine['handleWebhook']>[0] {
    return {
      deliveryId: `delivery-${++deliveries}`,
      workspaceId,
      type,
      action,
      entityId: type === 'OAuthApp' ? null : 'iss-1',
      updatedFrom: null,
    };
  }
  // Whether the delivery left a row (a second record would be a duplicate).
  async function recorded(
    delivery: Parameters<Engine['handleWebhook']>[0]
  ): Promise<boolean> {
    return !(await store.recordWebhookDelivery({
      deliveryId: delivery.deliveryId ?? '',
      workspaceId: delivery.workspaceId,
      type: delivery.type,
      action: delivery.action,
      entityId: delivery.entityId,
      receivedAt: clock.now().toISOString(),
    }));
  }

  test('a delivery for an organization with no installation writes nothing', async () => {
    const engine = oauthEngine({ mode: 'any' });
    for (const delivery of [
      event('org-unknown'),
      event('org-unknown', 'OAuthApp', 'revoked'),
    ]) {
      expect(await engine.handleWebhook(delivery)).toBe('ignored');
      expect(await recorded(delivery)).toBe(false);
    }
    expect(await store.getSyncState('org-unknown')).toBeNull();
    expect(await store.listWorkspaceStatus()).toEqual([]);
  });

  test('a refused workspace writes nothing, but its uninstall still applies', async () => {
    const engine = oauthEngine({ mode: 'list', entries: ['org-acme'] });
    await installed(ACME);
    await installed(OTHER);

    const refused = event('org-other');
    expect(await engine.handleWebhook(refused)).toBe('ignored');
    expect(await store.getSyncState('org-other')).toBeNull();
    expect(await recorded(refused)).toBe(false);

    // An admitted workspace's delivery is recorded (deduped) first.
    const admitted = event('org-acme');
    await engine.handleWebhook(admitted);
    expect(await recorded(admitted)).toBe(true);

    // Admission never suppresses an uninstall.
    expect(
      await engine.handleWebhook(event('org-other', 'OAuthApp', 'revoked'))
    ).toBe('processed');
    expect(
      (await store.getInstallation('org-other'))?.revokedAt
    ).not.toBeNull();
  });
});

describe('the worker list and cleanup', () => {
  test('listWorkspaceIds lists active installations admission admits', async () => {
    const engine = oauthEngine({
      mode: 'list',
      entries: ['org-acme', 'other', 'org-gone', 'org-session-only'],
    });
    await installed(ACME);
    await installed(OTHER);
    await installed(
      { id: 'org-gone', name: 'Gone', urlKey: 'gone' },
      { revokedAt: clock.now().toISOString() }
    );
    await installed({
      id: 'org-unlisted',
      name: 'Unlisted',
      urlKey: 'unlisted',
    });
    await store.createSession({
      workspaceId: 'org-session-only',
      userId: 'u-x',
      userName: 'X',
      tokens: {
        accessToken: 'a',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      },
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect((await engine.listWorkspaceIds()).sort()).toEqual([
      'org-acme',
      'org-other',
    ]);
    expect(
      lines.some(
        (l) =>
          l.includes('workspace skipped: admission refuses it') &&
          l.includes('org-unlisted')
      )
    ).toBe(true);
  });

  test('listWorkspaceStatus carries admission verdicts without revoking anything', async () => {
    const engine = oauthEngine({
      mode: 'list',
      entries: ['org-acme', 'other', 'org-gone'],
    });
    await installed(ACME);
    await installed(OTHER);
    await installed(
      { id: 'org-gone', name: 'Gone', urlKey: 'gone' },
      { revokedAt: clock.now().toISOString() }
    );
    await installed({
      id: 'org-unlisted',
      name: 'Unlisted',
      urlKey: 'unlisted',
    });
    await store.blockWorkspace(
      'org-other',
      'id',
      null,
      clock.now().toISOString()
    );
    const listed = await engine.listWorkspaceStatus();
    expect(
      Object.fromEntries(listed.map((row) => [row.workspaceId, row.admission]))
    ).toEqual({
      'org-acme': 'ok',
      'org-other': 'blocked',
      'org-gone': 'ok',
      'org-unlisted': 'not_allowed',
    });
    // Reporting refuses nothing by itself: cleanup revokes refused ones.
    expect(
      listed.find((row) => row.workspaceId === 'org-unlisted')?.installation
        ?.revokedAt
    ).toBeNull();
    // Outside OAuth mode admission does not apply.
    const demo = createEngine({
      store,
      linear: createLinearProvider({ store, oauth: OAUTH, logger }),
      channel: recordingChannel(),
      logger,
      config: TEST_CONFIG,
      now: clock.now,
    });
    expect(
      (await demo.listWorkspaceStatus()).every((row) => row.admission === 'ok')
    ).toBe(true);
  });

  test('cleanup removes blocked installations, and only warns about ones LINEAR_WORKSPACES leaves out', async () => {
    // A list refusal is a soft gate (design doc §12, 2026-10-25): OTHER is
    // not served but keeps its installation, app token and sessions.
    await installed(ACME);
    await installed(OTHER);
    await mirrored('org-other', [ANA_OTHER.user]);
    const other = await finish(oauthEngine(), ANA_OTHER);
    const engine = oauthEngine({ mode: 'list', entries: ['org-acme'] });
    await store.blockWorkspace(
      'acme',
      'url_key',
      'no',
      clock.now().toISOString()
    );
    const cleaned = await engine.cleanup();

    const statuses = await store.listWorkspaceStatus();
    const reason = (id: string): string | null | undefined =>
      statuses.find((s) => s.workspaceId === id)?.installation?.revokedReason;
    // Blocked (by URL key, now pinned to its id): a hard gate, removed.
    expect(reason('org-acme')).toBe('removed');
    expect(
      (await store.listBlockedWorkspaces()).map((b) => [b.key, b.kind])
    ).toEqual([['org-acme', 'id']]);
    expect(
      lines.filter((l) =>
        l.includes('removed a blocked workspace; its app token is wiped')
      )
    ).toHaveLength(1);
    // Not listed: left exactly as it was, and warned about with the fix.
    expect(reason('org-other')).toBeNull();
    expect((await store.getInstallation('org-other'))?.tokens.accessToken).toBe(
      'app-token-org-other'
    );
    expect(cleaned).toMatchObject({
      endedWorkspaceSessions: 0,
      notServedWorkspaces: 1,
    });
    expect(fake.revoked).toEqual([]);
    const notServed = (): string[] =>
      lines.filter(
        (l) =>
          l.includes('org-other is installed but LINEAR_WORKSPACES') &&
          l.includes("run 'remove --workspace org-other'")
      );
    expect(notServed()).toHaveLength(1);
    expect(await engine.listWorkspaceIds()).toEqual([]);
    expect(await engine.authenticate(other.sessionToken)).toBeNull();

    // Every pass warns again, and still changes nothing.
    await engine.cleanup();
    expect(notServed()).toHaveLength(2);
    expect(
      lines.filter((l) =>
        l.includes('removed a blocked workspace; its app token is wiped')
      )
    ).toHaveLength(1);

    // Putting it back on the list restores it as it was: served again,
    // and its session signs in without a new sign-in.
    const readmitted = oauthEngine({
      mode: 'list',
      entries: ['org-acme', 'org-other'],
    });
    expect(await readmitted.listWorkspaceIds()).toEqual(['org-other']);
    expect(await readmitted.authenticate(other.sessionToken)).toMatchObject({
      session: { workspaceId: 'org-other' },
    });
  });

  test('a list refusal ends no session: they read as signed out until re-admission or expiry', async () => {
    // OTHER was only signed in to (never installed), then left off the list.
    const open = oauthEngine({
      mode: 'list',
      entries: ['org-acme', 'org-other'],
    });
    const other = await finish(open, ANA_OTHER);
    const narrowed = oauthEngine({ mode: 'list', entries: ['org-acme'] });
    expect(await narrowed.authenticate(other.sessionToken)).toBeNull();
    expect(await narrowed.cleanup()).toMatchObject({
      endedWorkspaceSessions: 0,
      expiredSessions: 0,
    });
    expect(await sessionRows()).toBe(1);
    expect(fake.revoked).toEqual([]);

    // Expiry ends it as it ends any session: its grant is revoked then.
    clock.set(
      new Date(
        clock.now().getTime() + (TEST_CONFIG.sessionDays + 1) * 86_400_000
      ).toISOString()
    );
    expect(await narrowed.cleanup()).toMatchObject({
      expiredSessions: 1,
      revokedTokens: 1,
    });
    expect(await sessionRows()).toBe(0);
  });

  test('a renamed workspace listed by its new URL key is not removed before anyone signs in', async () => {
    // Installed as linear.app/acme-old, renamed to acme in Linear since; the
    // operator lists the current key. Until a sign-in or a sync tells the
    // planner the new key, the entry does not match, and nothing is lost.
    await installed(ACME, { urlKey: 'acme-old' });
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    await engine.cleanup();
    const installation = await store.getInstallation('org-acme');
    expect(installation?.revokedAt).toBeNull();
    expect(installation?.tokens.accessToken).toBe('app-token-org-acme');
    expect(await store.getAdmittedPin('acme')).toBeNull();
    // The next sign-in reads the current key from Linear: the entry pins,
    // and the installation row takes the current name and key.
    await finish(engine, ANA_ACME);
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
    expect(await store.getInstallation('org-acme')).toMatchObject({
      urlKey: 'acme',
      workspaceName: ACME.name,
      tokens: { accessToken: 'app-token-org-acme' },
    });
    expect(await engine.listWorkspaceIds()).toEqual(['org-acme']);
  });

  test("a sign-in keeps an installed workspace's name and URL key current, and sessions show them", async () => {
    await installed(ACME, { urlKey: 'acme-old', workspaceName: 'Acme Old' });
    const engine = oauthEngine({ mode: 'any' });
    const before = await store.getInstallation('org-acme');
    const ana = await finish(engine, ANA_ACME);
    expect(await store.getInstallation('org-acme')).toMatchObject({
      urlKey: 'acme',
      workspaceName: ACME.name,
      updatedAt: before?.updatedAt,
    });
    expect(await engine.describeSessions([ana.sessionToken])).toMatchObject([
      { workspaceName: ACME.name, workspaceUrlKey: 'acme' },
    ]);
    // A workspace nobody installed gets no row from a sign-in.
    await finish(engine, ANA_OTHER);
    expect(await store.getInstallation('org-other')).toBeNull();
  });

  test('cleanup leaves admitted workspaces and other modes alone', async () => {
    await installed(ACME);
    await oauthEngine({ mode: 'any' }).cleanup();
    await oauthEngine().cleanup();
    const demo = createEngine({
      store,
      linear: createLinearProvider({ store, oauth: OAUTH, logger }),
      channel: recordingChannel(),
      logger,
      config: {
        ...TEST_CONFIG,
        oauth: OAUTH,
        workspaces: { mode: 'list', entries: [] },
      },
    });
    await demo.cleanup();
    expect((await store.getInstallation('org-acme'))?.revokedAt).toBeNull();
  });
});

describe('a stale installation URL key', () => {
  // ACME was installed as linear.app/acme-old and renamed to acme in Linear
  // since; no sync has seen the rename yet.
  async function sessionSignedInAs(
    workspaceId: string,
    urlKey: string
  ): Promise<string> {
    const { token } = await store.createSession({
      workspaceId,
      userId: 'u-ana',
      userName: 'Ana Ruiz',
      tokens: {
        accessToken: `a-${workspaceId}`,
        refreshToken: null,
        expiresAt: null,
        scopes: ['read'],
      },
      expiresAt: '2026-12-01T00:00:00.000Z',
      workspaceName: 'Acme',
      workspaceUrlKey: urlKey,
    });
    return token;
  }

  /** Moves the clock on by `ms`. */
  function later(ms = 60_000): void {
    clock.set(new Date(clock.now().getTime() + ms).toISOString());
  }

  test("the installation's URL key is tried first, then a later sign-in's", async () => {
    await installed(ACME, { urlKey: 'acme-old' });
    await mirrored('org-acme', [ANA_ACME.user]);
    // Signed in after the installation's key was read from Linear.
    later();
    const token = await sessionSignedInAs('org-acme', 'acme');
    // Both keys are listed: the installation's one is pinned.
    const engine = oauthEngine({
      mode: 'list',
      entries: ['acme', 'acme-old'],
    });
    // The installation's key still names the workspace in the switcher.
    expect(await engine.describeSessions([token])).toMatchObject([
      { workspaceUrlKey: 'acme-old', signInUrlKey: 'acme' },
    ]);
    expect(await store.getAdmittedPin('acme-old')).toBe('org-acme');
    expect(await store.getAdmittedPin('acme')).toBeNull();
    expect((await engine.authenticate(token))?.session.userId).toBe('u-ana');
  });

  test('a session that signed in after the installation key was read still pins an entry only its key matches', async () => {
    await installed(ACME, { urlKey: 'acme-old' });
    await mirrored('org-acme', [ANA_ACME.user]);
    later();
    const token = await sessionSignedInAs('org-acme', 'acme');
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    expect((await engine.authenticate(token))?.session.userId).toBe('u-ana');
    expect(await engine.checkSession(token)).toEqual({
      workspaceId: 'org-acme',
    });
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
  });

  test("an old session's sign-in key never pins an entry another org took since", async () => {
    // ACME was linear.app/acme when Ana signed in. It was renamed to
    // acme-old since, which a sync read from Linear; OTHER took acme, and
    // the list's acme means OTHER.
    await installed(ACME);
    await mirrored('org-acme', [ANA_ACME.user]);
    later();
    const token = await sessionSignedInAs('org-acme', 'acme');
    later();
    expect(
      await store.updateInstallationIdentity(
        'org-acme',
        { workspaceName: 'Acme', urlKey: 'acme-old' },
        { readAt: clock.now().toISOString() }
      )
    ).toBe(true);
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    expect(await engine.authenticate(token)).toBeNull();
    expect(await engine.checkSession(token)).toBeNull();
    expect(await engine.describeSessions([token])).toEqual([null]);
    expect(await store.getAdmittedPin('acme')).toBeNull();

    // OTHER signs in under acme: the entry is pinned to it, and ACME's old
    // session stays refused.
    const yan: FakeIdentity = {
      user: person('u-yan', 'Yan Other'),
      workspace: { ...OTHER, urlKey: 'acme' },
    };
    await finish(engine, yan);
    expect(await store.getAdmittedPin('acme')).toBe('org-other');
    pastCache();
    expect(await engine.authenticate(token)).toBeNull();
    expect(await engine.describeSessions([token])).toEqual([null]);
  });

  test('a sign-in key counts only when the session signed in after the installation key was read', () => {
    const base = {
      signInUrlKey: 'acme',
      signedInAt: '2026-10-21T10:00:00.000Z',
      installed: true,
    };
    expect(
      newerSignInUrlKey({ ...base, urlKeyReadAt: '2026-10-21T09:59:59.999Z' })
    ).toBe('acme');
    // Read at the same instant or later: the installation's is as new.
    for (const urlKeyReadAt of [
      '2026-10-21T10:00:00.000Z',
      '2026-10-21T10:00:00.001Z',
    ]) {
      expect(newerSignInUrlKey({ ...base, urlKeyReadAt })).toBeNull();
    }
    // Never read since migration 8: nothing says which one is newer.
    expect(newerSignInUrlKey({ ...base, urlKeyReadAt: null })).toBeNull();
    expect(
      newerSignInUrlKey({ ...base, signedInAt: undefined, urlKeyReadAt: null })
    ).toBeNull();
    // No installation: the description's key is the session's own anyway.
    expect(
      newerSignInUrlKey({ ...base, installed: false, urlKeyReadAt: null })
    ).toBe('acme');
    expect(
      newerSignInUrlKey({
        ...base,
        signInUrlKey: null,
        urlKeyReadAt: '2026-10-21T09:00:00.000Z',
      })
    ).toBeNull();
  });

  test("a session's own key never pins an entry already pinned to another org", async () => {
    await installed(ACME, { urlKey: 'acme-old' });
    await mirrored('org-acme', [ANA_ACME.user]);
    await store.pinAdmitted('acme', 'org-other', clock.now().toISOString());
    const token = await sessionSignedInAs('org-acme', 'acme');
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    expect(await engine.authenticate(token)).toBeNull();
    expect(await engine.describeSessions([token])).toEqual([null]);
    expect(await store.getAdmittedPin('acme')).toBe('org-other');
  });

  test("cleanup reads a refused installation's URL key from Linear, and the list admits it again", async () => {
    await installed(ACME, { urlKey: 'acme-old', workspaceName: 'Acme Old' });
    fake.addAccessToken('app-token-org-acme', ACME_APP);
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    expect(await engine.listWorkspaceIds()).toEqual([]);

    const result = await engine.cleanup();
    expect(result).toMatchObject({
      notServedWorkspaces: 0,
      reAdmittedWorkspaces: 1,
      deferred: [],
    });
    // One read with the app token; nothing revoked or ended.
    expect(fake.graphqlTokens).toEqual(['app-token-org-acme']);
    expect(fake.revoked).toEqual([]);
    expect(await store.getInstallation('org-acme')).toMatchObject({
      urlKey: 'acme',
      workspaceName: ACME.name,
      revokedAt: null,
      tokens: { accessToken: 'app-token-org-acme' },
    });
    expect(await store.getAdmittedPin('acme')).toBe('org-acme');
    expect(await engine.listWorkspaceIds()).toEqual(['org-acme']);
    // Admitted now: the next pass reads nothing.
    expect(await engine.cleanup()).toMatchObject({ reAdmittedWorkspaces: 0 });
    expect(fake.graphqlTokens).toHaveLength(1);
  });

  test('the identity read is skipped without an unpinned entry or time, and a failed one only warns', async () => {
    await installed(ACME, { urlKey: 'acme-old' });
    fake.addAccessToken('app-token-org-acme', ACME_APP);
    // Every URL key entry is pinned elsewhere: no read can help.
    await store.pinAdmitted('globex', 'org-globex', clock.now().toISOString());
    const pinned = oauthEngine({ mode: 'list', entries: ['globex'] });
    expect(await pinned.cleanup()).toMatchObject({ notServedWorkspaces: 1 });
    expect(fake.graphqlTokens).toEqual([]);

    // No time left: left for the next pass (as is any expired session),
    // still warned about.
    const listed = oauthEngine({ mode: 'list', entries: ['acme'] });
    expect(
      await listed.cleanup({ deadline: new Date(clock.now().getTime()) })
    ).toMatchObject({
      notServedWorkspaces: 1,
      reAdmittedWorkspaces: 0,
      deferred: ['expired_sessions', 'identity_reads'],
    });
    expect(fake.graphqlTokens).toEqual([]);

    // Linear refuses the app token: warned, nothing changed.
    await installed(ACME, {
      urlKey: 'acme-old',
      tokens: {
        accessToken: 'app-token-unknown',
        refreshToken: null,
        expiresAt: null,
        scopes: ['read', 'write'],
      },
    });
    const failedRead = (level: string): number =>
      lines.filter(
        (l) =>
          l.includes(
            "could not read a refused workspace's URL key from Linear"
          ) && l.includes(`"level":"${level}"`)
      ).length;
    expect(await listed.cleanup()).toMatchObject({
      notServedWorkspaces: 1,
      reAdmittedWorkspaces: 0,
    });
    expect(failedRead('warn')).toBe(1);
    expect(await store.getInstallation('org-acme')).toMatchObject({
      urlKey: 'acme-old',
      revokedAt: null,
    });
    expect(await store.getAdmittedPin('acme')).toBeNull();
    // The same failure on the next ticks: tried again, logged at info.
    for (let tick = 0; tick < 2; tick += 1) {
      pastCache();
      expect(await listed.cleanup()).toMatchObject({ notServedWorkspaces: 1 });
    }
    expect(failedRead('warn')).toBe(1);
    expect(failedRead('info')).toBe(2);
    expect(fake.graphqlTokens).toEqual([
      'app-token-unknown',
      'app-token-unknown',
      'app-token-unknown',
    ]);
  });

  test('identity reads wait for the revocations and purges, so a slow one cannot use their time', async () => {
    await installed(ACME, { urlKey: 'acme-old' });
    fake.addAccessToken('app-token-org-acme', ACME_APP);
    await store.createSession({
      workspaceId: 'org-other',
      userId: 'u-gone',
      userName: 'Gone',
      tokens: {
        accessToken: 'a-gone',
        refreshToken: 'r-gone',
        expiresAt: null,
        scopes: ['read'],
      },
      expiresAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    });
    // Linear answers the identity read only after 110 s: what the 2-minute
    // pass leaves after it is too little to revoke even one grant.
    const slowIdentity: FetchLike = async (input, init) => {
      const header = new Headers(init?.headers).get('Authorization') ?? '';
      if (
        String(input) === 'https://api.linear.app/graphql' &&
        header === 'Bearer app-token-org-acme'
      ) {
        clock.set(new Date(clock.now().getTime() + 110_000).toISOString());
      }
      return fake.fetch(String(input), init ?? {});
    };
    const engine = oauthEngine(
      { mode: 'list', entries: ['acme'] },
      store,
      slowIdentity
    );
    const result = await engine.cleanup({
      deadline: new Date(clock.now().getTime() + 120_000),
    });
    // The expired session's grant was revoked before the read started.
    expect(fake.revoked).toEqual([{ token: 'r-gone', hint: 'refresh_token' }]);
    expect(result).toMatchObject({
      expiredSessions: 1,
      revokedTokens: 1,
      reAdmittedWorkspaces: 1,
      deferred: [],
    });
  });

  test('at most 5 identity reads per pass, the ones checked longest ago first', async () => {
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    for (const id of ids) {
      const workspace = { id: `org-${id}`, name: id, urlKey: id };
      await installed(workspace);
      fake.addAccessToken(`app-token-org-${id}`, {
        user: person(`u-app-${id}`, 'Planner app', { app: true }),
        workspace,
      });
    }
    // The list's acme matches none of them, so every read leaves it
    // refused and unpinned.
    const engine = oauthEngine({ mode: 'list', entries: ['acme'] });
    const read = (): string[] =>
      fake.graphqlTokens.map((token) => token.replace('app-token-org-', ''));

    expect(await engine.cleanup()).toMatchObject({
      notServedWorkspaces: 7,
      deferred: ['identity_reads'],
    });
    expect(read()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    pastCache();
    await engine.cleanup();
    // The two never read, then the three read longest ago.
    expect(read().slice(5)).toEqual(['r6', 'r7', 'r1', 'r2', 'r3']);
    // Nothing was revoked or ended, and nothing was pinned.
    expect(fake.revoked).toEqual([]);
    expect(await store.getAdmittedPin('acme')).toBeNull();
    for (const id of ids) {
      expect((await store.getInstallation(`org-${id}`))?.revokedAt).toBeNull();
    }
  });

  test('a read Linear does not answer is given up after 10 s', async () => {
    await installed(ACME, { urlKey: 'acme-old' });
    fake.addAccessToken('app-token-org-acme', ACME_APP);
    const silent: FetchLike = (input, init) =>
      String(input) === 'https://api.linear.app/graphql'
        ? new Promise<Response>(() => undefined)
        : fake.fetch(String(input), init ?? {});
    const engine = oauthEngine(
      { mode: 'list', entries: ['acme'] },
      store,
      silent
    );
    const started = Date.now();
    // No deadline at all: the read is still cut off.
    expect(await engine.cleanup()).toMatchObject({
      notServedWorkspaces: 1,
      reAdmittedWorkspaces: 0,
      deferred: [],
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(20_000);
    expect(
      lines.some(
        (l) =>
          l.includes(
            "could not read a refused workspace's URL key from Linear"
          ) && l.includes('"level":"warn"')
      )
    ).toBe(true);
    expect(await store.getInstallation('org-acme')).toMatchObject({
      urlKey: 'acme-old',
      revokedAt: null,
    });
  });
});

describe('ping', () => {
  test('is the store probe', async () => {
    const engine = oauthEngine({ mode: 'any' });
    expect(await engine.ping()).toBe(true);
    const down = oauthEngine(
      { mode: 'any' },
      storeWith(store, { ping: () => Promise.resolve(false) })
    );
    expect(await down.ping()).toBe(false);
  });
});
