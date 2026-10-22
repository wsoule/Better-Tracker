import type { OAuthClientConfig } from '@better-tracker/linear';
import type { Store } from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  type Actor,
  createEngine,
  createLinearProvider,
  type Engine,
  EngineAuthError,
  requireCanInstall,
  requireWritable,
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
  openTestStore,
  recordingChannel,
  recordingLogger,
  START,
  TEST_CONFIG,
  type TestClock,
  rejection,
} from './helpers';

const OAUTH: OAuthClientConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'https://planner.example/api/auth/linear/callback',
};

const PAT: FakeIdentity = { user: person('u-pat', 'Pat Lee'), workspace: ACME };
const SAM: FakeIdentity = { user: person('u-sam', 'Sam Kim'), workspace: ACME };
const ACME_APP: FakeIdentity = {
  user: person('u-acme-app', 'Planner app', { app: true }),
  workspace: ACME,
};
const OTHER_APP: FakeIdentity = {
  user: person('u-other-app', 'Planner app', { app: true }),
  workspace: OTHER,
};

/** Linear's expires_in (86,399 s) counted from START. */
const TOKEN_EXPIRY = '2026-10-22T14:59:59.000Z';

let clock: TestClock;
let store: Store;
let engine: Engine;
let fake: FakeLinear;
let lines: string[];

beforeEach(async () => {
  // A fixed clock: token expiries are counted from the engine's clock.
  clock = createClock(START);
  store = await openTestStore(clock);
  fake = createFakeLinear();
  const logs = recordingLogger();
  lines = logs.lines;
  engine = createEngine({
    store,
    linear: createLinearProvider({
      store,
      oauth: OAUTH,
      logger: logs.logger,
      now: clock.now,
      fetch: fake.fetch,
    }),
    channel: recordingChannel(),
    logger: logs.logger,
    config: { ...TEST_CONFIG, oauth: OAUTH },
    now: clock.now,
    fetch: fake.fetch,
  });
});
afterEach(async () => {
  // No log line may carry a Linear credential.
  const output = lines.join('\n');
  expect(output).not.toMatch(/lin_(access|refresh)_\d/);
  expect(output).not.toContain(OAUTH.clientSecret);
  await engine.close();
});

/**
 * A mirror of Acme with the given people (enough for auth decisions), as
 * a landed full sync would leave it: the fake Linear serves no workspace
 * reads, so a test that needs people placed mirrors them itself.
 */
async function mirrorPeople(users: FakeIdentity['user'][]): Promise<void> {
  await store.replaceMirror(
    {
      workspaceId: 'org-acme',
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

function at(offsetMs: number): string {
  return new Date(clock.now().getTime() + offsetMs).toISOString();
}

async function signIn(
  identity: FakeIdentity,
  intent: 'signin' | 'grant_write' = 'signin'
): Promise<{ token: string; actor: Actor }> {
  const code = `code-${identity.user.id}-${intent}-${Math.random()}`;
  fake.addCode(code, identity, intent === 'signin' ? 'read' : 'read,write');
  const result = await engine.finishSignIn({ code, codeVerifier: 'v', intent });
  const actor = await engine.authenticate(result.sessionToken);
  if (actor === null) throw new Error('not signed in');
  return { token: result.sessionToken, actor };
}

describe('startOAuth', () => {
  test('builds PKCE authorize URLs with the scopes per intent', () => {
    const cases = [
      { intent: 'signin', scope: 'read', actor: null, prompt: null },
      { intent: 'grant_write', scope: 'read,write', actor: null, prompt: null },
      {
        // initiative:read: an actor=app user sees initiatives only with it.
        intent: 'install',
        scope: 'read,write,initiative:read',
        actor: 'app',
        prompt: 'consent',
      },
    ] as const;
    for (const c of cases) {
      const start = engine.startOAuth(c.intent);
      const url = new URL(start.url);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://linear.app/oauth/authorize'
      );
      const params = url.searchParams;
      expect(params.get('client_id')).toBe('client-123');
      expect(params.get('redirect_uri')).toBe(OAUTH.redirectUri);
      expect(params.get('response_type')).toBe('code');
      expect(params.get('scope')).toBe(c.scope);
      expect(params.get('state')).toBe(start.state);
      expect(params.get('code_challenge_method')).toBe('S256');
      expect(params.get('code_challenge')).toBe(
        createHash('sha256').update(start.codeVerifier).digest('base64url')
      );
      expect(params.get('actor')).toBe(c.actor);
      expect(params.get('prompt')).toBe(c.prompt);
    }
    expect(engine.startOAuth('signin').state).not.toBe(
      engine.startOAuth('signin').state
    );
  });
});

describe('finishSignIn', () => {
  test('creates a read-only session and reports a missing install', async () => {
    const code = 'code-pat';
    fake.addCode(code, PAT, 'read');
    const result = await engine.finishSignIn({
      code,
      codeVerifier: 'verifier',
      intent: 'signin',
    });
    expect(result.needsInstall).toBe(true);
    expect(result.session).toMatchObject({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat Lee',
    });
    // Handed-out sessions never carry credentials.
    expect(result.session.tokens.accessToken).toBe('');
    expect(result.session.tokens.refreshToken).toBeNull();
    expect(result.session.tokens.scopes).toEqual(['read']);
    expect(result.session.expiresAt).toBe('2026-11-20T15:00:00.000Z');
    // The Linear token's expiry is counted from the engine's clock.
    expect(result.session.tokens.expiresAt).toBe(TOKEN_EXPIRY);

    const actor = await engine.authenticate(result.sessionToken);
    // No roles: an actor is the session and whether it may write Linear.
    expect(actor).not.toHaveProperty('isPm');
    expect(actor?.canWriteLinear).toBe(false);
    expect(actor?.session.tokens.accessToken).toBe('');
    // The real tokens are stored (encrypted) for the person's own edits.
    const stored = await store.getSession(
      result.sessionToken,
      clock.now().toISOString()
    );
    expect(stored?.tokens.accessToken).toMatch(/^lin_access_/);
  });

  test('grant_write yields a session that may write to Linear', async () => {
    const { actor } = await signIn(PAT, 'grant_write');
    expect(actor.canWriteLinear).toBe(true);
    expect(actor.session.tokens.scopes).toEqual(['read', 'write']);
  });

  test('rejects app users and revokes the token they got', async () => {
    fake.addCode('code-app', ACME_APP, 'read');
    let caught: unknown;
    try {
      await engine.finishSignIn({
        code: 'code-app',
        codeVerifier: 'v',
        intent: 'signin',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineAuthError);
    expect((caught as EngineAuthError).code).toBe('not_signed_in');
    expect(fake.revoked).toEqual([
      { token: 'lin_refresh_1', hint: 'refresh_token' },
    ]);
    expect(await store.deleteExpiredSessions('9999-01-01T00:00:00.000Z')).toBe(
      0
    );
  });

  test('a bad code fails without creating a session', async () => {
    expect(
      await rejection(
        engine.finishSignIn({
          code: 'unknown',
          codeVerifier: 'v',
          intent: 'signin',
        })
      )
    ).toMatchObject({ name: 'OAuthError', code: 'invalid_grant' });
    expect(await store.deleteExpiredSessions('9999-01-01T00:00:00.000Z')).toBe(
      0
    );
  });
});

describe('finishInstall', () => {
  test('rejects an install for another workspace or without actor=app', async () => {
    const { actor } = await signIn(PAT);
    fake.addCode('code-other', OTHER_APP, 'read,write');
    expect(
      await rejection(
        engine.finishInstall({ code: 'code-other', codeVerifier: 'v', actor })
      )
    ).toMatchObject({
      name: 'EngineAuthError',
      code: 'wrong_workspace',
    });
    fake.addCode('code-human', SAM, 'read,write');
    expect(
      await rejection(
        engine.finishInstall({ code: 'code-human', codeVerifier: 'v', actor })
      )
    ).toMatchObject({ code: 'wrong_workspace' });
    expect(await store.getInstallation('org-acme')).toBeNull();
    expect(await store.getInstallation('org-other')).toBeNull();
    expect(fake.revoked.map((r) => r.hint)).toEqual([
      'refresh_token',
      'refresh_token',
    ]);
  });

  test('saves the installation; anyone signed in may reinstall', async () => {
    const { token, actor } = await signIn(PAT);
    fake.addCode('code-install', ACME_APP, 'read,write');
    const installation = await engine.finishInstall({
      code: 'code-install',
      codeVerifier: 'v',
      actor,
    });
    expect(installation).toMatchObject({
      workspaceId: 'org-acme',
      workspaceName: 'Acme',
      urlKey: 'acme',
      appUserId: 'u-acme-app',
      installedByUserId: 'u-pat',
      revokedAt: null,
    });
    expect(installation.tokens.accessToken).toBe('');
    expect(installation.tokens.scopes).toEqual(['read', 'write']);
    const saved = await store.getInstallation('org-acme');
    expect(saved?.tokens.accessToken).toMatch(/^lin_access_/);
    expect(saved?.tokens.refreshToken).toMatch(/^lin_refresh_/);
    expect((await engine.getInstallation('org-acme'))?.tokens.accessToken).toBe(
      ''
    );

    // Installing makes nobody special: settings are left to the first
    // full sync, which makes the installer the first watcher unless
    // WATCHER_EMAILS names someone (sync.test.ts).
    expect(await store.getSettings('org-acme')).toBeNull();
    expect(await engine.authenticate(token)).not.toBeNull();
    expect(await engine.listWorkspaceIds()).toEqual(['org-acme']);

    // Sam signs in afterwards: no install needed.
    fake.addCode('code-sam', SAM, 'read');
    const sam = await engine.finishSignIn({
      code: 'code-sam',
      codeVerifier: 'v',
      intent: 'signin',
    });
    expect(sam.needsInstall).toBe(false);

    // There is no PM role (owner decision 2026-10-22): once the first
    // sync has placed him, Sam may reinstall over the active installation.
    // Only a Linear admin can grant actor=app, which is what keeps
    // installs to admins.
    await mirrorPeople([PAT.user, SAM.user, ACME_APP.user]);
    const samActor = await engine.authenticate(sam.sessionToken);
    expect(samActor).toMatchObject({ readOnly: false });
    fake.addCode('code-reinstall', ACME_APP, 'read,write');
    const reinstalled = await engine.finishInstall({
      code: 'code-reinstall',
      codeVerifier: 'v',
      actor: samActor as Actor,
    });
    expect(reinstalled).toMatchObject({
      workspaceId: 'org-acme',
      installedByUserId: 'u-sam',
      revokedAt: null,
      createdAt: installation.createdAt,
    });
    expect(await store.getSettings('org-acme')).toBeNull();
  });

  // Right after an install the first sync may fail (here the fake Linear
  // serves no workspace reads). Nobody can be placed then, so everyone is
  // read-only, but as `not_synced`, not as a guest, and a reinstall stays
  // open: it is how an admin fixes a grant that makes the sync fail.
  test('while the first sync has not landed, a reinstall is still allowed', async () => {
    const { actor } = await signIn(PAT);
    fake.addCode('code-install', ACME_APP, 'read,write');
    await engine.finishInstall({
      code: 'code-install',
      codeVerifier: 'v',
      actor,
    });
    const { actor: sam } = await signIn(SAM);
    expect(sam).toMatchObject({
      readOnly: true,
      readOnlyReason: 'not_synced',
      canWriteLinear: false,
    });
    expect(
      await rejection(
        engine.runAllocation({
          workspaceId: 'org-acme',
          mode: 'dry_run',
          trigger: 'manual',
          actor: sam,
        })
      )
    ).toMatchObject({ name: 'EngineAuthError', code: 'read_only' });
    fake.addCode('code-reinstall', ACME_APP, 'read,write');
    const reinstalled = await engine.finishInstall({
      code: 'code-reinstall',
      codeVerifier: 'v',
      actor: sam,
    });
    expect(reinstalled).toMatchObject({
      workspaceId: 'org-acme',
      installedByUserId: 'u-sam',
      revokedAt: null,
    });
  });

  test('a reinstall keeps the saved settings, watchers included', async () => {
    const pat = await signIn(PAT);
    fake.addCode('code-install', ACME_APP, 'read,write');
    await engine.finishInstall({
      code: 'code-install',
      codeVerifier: 'v',
      actor: pat.actor,
    });
    const saved = {
      ...(await engine.getSettings('org-acme')),
      watcherUserIds: ['u-pat'],
      allocationMode: 'live' as const,
    };
    await store.saveSettings(saved);
    await mirrorPeople([PAT.user, SAM.user, ACME_APP.user]);

    const sam = await signIn(SAM);
    fake.addCode('code-reinstall', ACME_APP, 'read,write');
    await engine.finishInstall({
      code: 'code-reinstall',
      codeVerifier: 'v',
      actor: sam.actor,
    });
    expect(await store.getSettings('org-acme')).toEqual(saved);
  });
});

describe('signOut', () => {
  test('deletes the session and revokes its refresh token', async () => {
    const { token } = await signIn(PAT);
    const stored = await store.getSession(token, clock.now().toISOString());
    await engine.signOut(token);
    expect(await engine.authenticate(token)).toBeNull();
    expect(fake.revoked).toEqual([
      {
        token: stored?.tokens.refreshToken ?? 'missing',
        hint: 'refresh_token',
      },
    ]);
  });

  test('never fails because revocation failed', async () => {
    const { token } = await signIn(PAT);
    fake.failRevoke = true;
    await engine.signOut(token);
    expect(await engine.authenticate(token)).toBeNull();
    expect(
      lines.some((l) => l.includes('revoking the Linear token failed'))
    ).toBe(true);
    // Unknown and empty tokens are a no-op.
    await engine.signOut('nope');
    await engine.signOut('');
  });
});

describe('authenticate', () => {
  test('refreshes an expiring user token once, under the session lock', async () => {
    fake.addRefreshToken('r-old', PAT);
    const { token } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat Lee',
      tokens: {
        accessToken: 'a-old',
        refreshToken: 'r-old',
        expiresAt: at(60_000),
        scopes: ['read', 'write'],
      },
      expiresAt: at(86_400_000),
    });
    const [a, b] = await Promise.all([
      engine.authenticate(token),
      engine.authenticate(token),
    ]);
    expect(a?.session.userId).toBe('u-pat');
    expect(b?.canWriteLinear).toBe(true);
    expect(fake.refreshCalls).toEqual(['r-old']);
    const stored = await store.getSession(token, clock.now().toISOString());
    expect(stored?.tokens.accessToken).toMatch(/^lin_access_/);
    expect(stored?.tokens.refreshToken).toMatch(/^lin_refresh_/);
    expect(stored?.tokens.expiresAt).toBe(TOKEN_EXPIRY);
  });

  test('a dead user grant ends the session', async () => {
    fake.addRefreshToken('r-dead', PAT, { invalid: true });
    const { token } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat Lee',
      tokens: {
        accessToken: 'a-old',
        refreshToken: 'r-dead',
        expiresAt: at(-1000),
        scopes: ['read'],
      },
      expiresAt: at(86_400_000),
    });
    expect(await engine.authenticate(token)).toBeNull();
    expect(await store.getSession(token, clock.now().toISOString())).toBeNull();
    expect(
      lines.some(
        (l) => l.includes('invalid_grant') && l.includes('"level":"error"')
      )
    ).toBe(true);
  });

  test('a transient refresh failure keeps the person signed in', async () => {
    fake.addRefreshToken('r-ok', PAT);
    fake.networkDownForRefresh = true;
    const { token } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat Lee',
      tokens: {
        accessToken: 'a-old',
        refreshToken: 'r-ok',
        expiresAt: at(1000),
        scopes: ['read'],
      },
      expiresAt: at(86_400_000),
    });
    const actor = await engine.authenticate(token);
    expect(actor?.session.userId).toBe('u-pat');
    const stored = await store.getSession(token, clock.now().toISOString());
    expect(stored?.tokens.refreshToken).toBe('r-ok');
  });
});

// Review regressions: people Linear deactivated lose access.
describe('deactivated people', () => {
  async function install(actor: Actor, code: string): Promise<void> {
    fake.addCode(code, ACME_APP, 'read,write');
    await engine.finishInstall({ code, codeVerifier: 'v', actor });
  }

  test('a person deactivated in Linear is signed out', async () => {
    const pat = await signIn(PAT, 'grant_write');
    await install(pat.actor, 'code-install');
    await mirrorPeople([PAT.user, SAM.user, ACME_APP.user]);
    expect((await engine.authenticate(pat.token))?.session.userId).toBe(
      'u-pat'
    );

    await mirrorPeople([{ ...PAT.user, active: false }, SAM.user]);
    expect(await engine.authenticate(pat.token)).toBeNull();
    // The session is gone for good, not just hidden.
    expect(await store.getSession(pat.token, clock.now().toISOString())).toBe(
      null
    );
  });
});

// Owner decision 2026-10-22, "Guests limited to read only": a Linear guest
// may sign in and look, but the planner never takes a write grant for one,
// never lets one install, and their Actor is read-only (canWriteLinear
// always false), as is anyone an existing mirror does not know.
describe('guests are read-only', () => {
  const GUS: FakeIdentity = {
    user: person('u-gus', 'Gus Hart', { guest: true }),
    workspace: ACME,
  };

  async function sessionFor(
    identity: FakeIdentity,
    scopes: string[]
  ): Promise<string> {
    return (
      await store.createSession({
        workspaceId: identity.workspace.id,
        userId: identity.user.id,
        userName: identity.user.name,
        tokens: {
          accessToken: `user-token-${identity.user.id}`,
          refreshToken: null,
          expiresAt: null,
          scopes,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    ).token;
  }

  test('a guest signs in to read, but grant_write is refused and revoked', async () => {
    const { actor } = await signIn(GUS);
    expect(actor.canWriteLinear).toBe(false);

    fake.addCode('code-gus-write', GUS, 'read,write');
    const refused = await rejection(
      engine.finishSignIn({
        code: 'code-gus-write',
        codeVerifier: 'v',
        intent: 'grant_write',
      })
    );
    expect(refused).toBeInstanceOf(EngineAuthError);
    expect(refused).toMatchObject({ code: 'read_only' });
    // The write grant Linear issued is revoked, not kept.
    expect(fake.revoked).toHaveLength(1);
    expect(fake.revoked[0]?.hint).toBe('refresh_token');
  });

  test('a plain sign-in that comes back with write scope is no back door', async () => {
    // A guest who edits the authorize URL of a plain sign-in to ask for
    // `read,write` gets a write grant from Linear under intent=signin: the
    // planner keeps no write grant for a guest, whatever the intent.
    fake.addCode('code-gus-tampered', GUS, 'read,write');
    const refused = await rejection(
      engine.finishSignIn({
        code: 'code-gus-tampered',
        codeVerifier: 'v',
        intent: 'signin',
      })
    );
    expect(refused).toMatchObject({
      name: 'EngineAuthError',
      code: 'read_only',
    });
    expect(fake.revoked).toHaveLength(1);
    expect(await store.deleteExpiredSessions('9999-01-01T00:00:00.000Z')).toBe(
      0
    );
    // A member's sign-in with write scope is kept as it was.
    const { actor } = await signIn(PAT, 'grant_write');
    expect(actor).toMatchObject({ readOnly: false, canWriteLinear: true });
  });

  test('the mirror decides: a guest there (or someone it does not know) is read-only', async () => {
    const pat = await sessionFor(PAT, ['read', 'write']);
    const gus = await sessionFor(GUS, ['read', 'write']);
    const sam = await sessionFor(SAM, ['read', 'write']);
    // No mirror yet (nothing installed or synced): nobody can be placed,
    // and someone must be able to install.
    expect(await engine.authenticate(pat)).toMatchObject({
      readOnly: false,
      canWriteLinear: true,
    });

    // The mirror flags Gus as a guest and does not know Sam yet.
    await mirrorPeople([PAT.user, { ...GUS.user, guest: true }]);
    expect(await engine.authenticate(pat)).toMatchObject({
      readOnly: false,
      canWriteLinear: true,
    });
    expect(await engine.authenticate(gus)).toMatchObject({
      readOnly: true,
      readOnlyReason: 'guest',
      canWriteLinear: false,
    });
    // Sam is not called a guest: the mirror just has not seen him yet.
    const unknown = await engine.authenticate(sam);
    expect(unknown).toMatchObject({
      readOnly: true,
      readOnlyReason: 'unknown',
      canWriteLinear: false,
    });
    expect(() => requireWritable(unknown as Actor)).toThrow(
      'The planner has not seen your Linear account yet'
    );
    expect(() => requireCanInstall(unknown as Actor)).toThrow();

    // Linear makes Gus a member: read-write from his next request on.
    await mirrorPeople([PAT.user, { ...GUS.user, guest: false }, SAM.user]);
    expect(await engine.authenticate(gus)).toMatchObject({ readOnly: false });
    expect(await engine.authenticate(sam)).toMatchObject({ readOnly: false });

    // And back: Pat's open tab keeps its session, but Linear made her a
    // guest, so her next request is read-only and loses the write grant.
    await mirrorPeople([{ ...PAT.user, guest: true }, GUS.user, SAM.user]);
    expect(await engine.authenticate(pat)).toMatchObject({
      readOnly: true,
      canWriteLinear: false,
    });
  });

  test('a write grant is refused when the mirror says guest, too', async () => {
    const MIRRORED_GUEST: FakeIdentity = {
      user: person('u-gus', 'Gus Hart'),
      workspace: ACME,
    };
    await mirrorPeople([PAT.user, { ...GUS.user, guest: true }]);
    fake.addCode('code-gus-write', MIRRORED_GUEST, 'read,write');
    expect(
      await rejection(
        engine.finishSignIn({
          code: 'code-gus-write',
          codeVerifier: 'v',
          intent: 'grant_write',
        })
      )
    ).toMatchObject({ name: 'EngineAuthError', code: 'read_only' });
    expect(await store.deleteExpiredSessions('9999-01-01T00:00:00.000Z')).toBe(
      0
    );
  });

  test('a guest cannot install: refused before the code is exchanged', async () => {
    await mirrorPeople([PAT.user, { ...GUS.user, guest: true }]);
    const gus = await engine.authenticate(
      await sessionFor(GUS, ['read', 'write'])
    );
    if (gus === null) throw new Error('not signed in');
    fake.addCode('code-install', ACME_APP, 'read,write');
    expect(
      await rejection(
        engine.finishInstall({
          code: 'code-install',
          codeVerifier: 'v',
          actor: gus,
        })
      )
    ).toMatchObject({ name: 'EngineAuthError', code: 'read_only' });
    expect(fake.graphqlTokens).toEqual([]);
    expect(await store.getInstallation('org-acme')).toBeNull();
  });
});
