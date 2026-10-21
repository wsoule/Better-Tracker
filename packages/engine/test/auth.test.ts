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
        intent: 'install',
        scope: 'read,write',
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
    expect(actor?.isPm).toBe(false);
    expect(actor?.canWriteLinear).toBe(false);
    expect(actor?.session.tokens.accessToken).toBe('');
    // The real tokens are stored (encrypted) for PM edits.
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

  test('saves the installation and makes the installer a PM', async () => {
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

    expect((await store.getSettings('org-acme'))?.pmUserIds).toEqual(['u-pat']);
    expect((await engine.authenticate(token))?.isPm).toBe(true);
    expect(await engine.listWorkspaceIds()).toEqual(['org-acme']);

    // Sam signs in afterwards: no install needed, not a PM.
    fake.addCode('code-sam', SAM, 'read');
    const sam = await engine.finishSignIn({
      code: 'code-sam',
      codeVerifier: 'v',
      intent: 'signin',
    });
    expect(sam.needsInstall).toBe(false);
    const samActor = await engine.authenticate(sam.sessionToken);
    expect(samActor?.isPm).toBe(false);

    // Reinstalling over an active installation needs a PM.
    fake.addCode('code-reinstall', ACME_APP, 'read,write');
    expect(
      await rejection(
        engine.finishInstall({
          code: 'code-reinstall',
          codeVerifier: 'v',
          actor: samActor as Actor,
        })
      )
    ).toMatchObject({ code: 'not_pm' });
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

// Review regressions: people Linear deactivated lose access, and losing
// every PM that way is recoverable by an admin reinstall.
describe('deactivated people', () => {
  // A mirror of Acme with the given people (enough for auth decisions).
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

  async function install(actor: Actor, code: string): Promise<void> {
    fake.addCode(code, ACME_APP, 'read,write');
    await engine.finishInstall({ code, codeVerifier: 'v', actor });
  }

  test('a PM deactivated in Linear is signed out', async () => {
    const pat = await signIn(PAT, 'grant_write');
    await install(pat.actor, 'code-install');
    await mirrorPeople([PAT.user, SAM.user, ACME_APP.user]);
    expect((await engine.authenticate(pat.token))?.isPm).toBe(true);

    await mirrorPeople([{ ...PAT.user, active: false }, SAM.user]);
    expect(await engine.authenticate(pat.token)).toBeNull();
    // The session is gone for good, not just hidden.
    expect(await store.getSession(pat.token, clock.now().toISOString())).toBe(
      null
    );
  });

  test('with no active PM left, an admin may reinstall and becomes PM', async () => {
    const pat = await signIn(PAT);
    await install(pat.actor, 'code-install');
    const sam = await signIn(SAM);
    await mirrorPeople([PAT.user, SAM.user, ACME_APP.user]);

    // While Pat is an active PM, Sam may not reinstall.
    fake.addCode('code-early', ACME_APP, 'read,write');
    expect(
      await rejection(
        engine.finishInstall({
          code: 'code-early',
          codeVerifier: 'v',
          actor: sam.actor,
        })
      )
    ).toMatchObject({ code: 'not_pm' });

    // Pat leaves the company: nobody could change settings any more.
    await mirrorPeople([{ ...PAT.user, active: false }, SAM.user]);
    const samNow = await engine.authenticate(sam.token);
    expect(samNow?.isPm).toBe(false);
    await install(samNow as Actor, 'code-recover');
    expect((await store.getSettings('org-acme'))?.pmUserIds).toEqual([
      'u-pat',
      'u-sam',
    ]);
    expect((await engine.authenticate(sam.token))?.isPm).toBe(true);
  });
});
