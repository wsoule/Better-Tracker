import {
  createFixtureStore,
  type OAuthClientConfig,
} from '@better-tracker/linear';
import type { Installation, Store } from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createFixtureLinearProvider,
  createLinearProvider,
  EngineAuthError,
  needsRefresh,
  type LinearProvider,
} from '../src/index';
import {
  ACME,
  createFakeLinear,
  type FakeIdentity,
  type FakeLinear,
  person,
} from './fake-linear';
import {
  createClock,
  openTestStore,
  recordingLogger,
  rejection,
} from './helpers';

const OAUTH: OAuthClientConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'https://planner.example/api/auth/linear/callback',
};
const APP: FakeIdentity = {
  user: person('u-app', 'Planner app', { app: true }),
  workspace: ACME,
};

let store: Store;
let fake: FakeLinear;
let provider: LinearProvider;
let lines: string[];

function installation(
  expiresInMs: number | null,
  refreshToken: string | null
): Installation {
  const now = new Date().toISOString();
  return {
    workspaceId: 'org-acme',
    workspaceName: 'Acme',
    urlKey: 'acme',
    appUserId: 'u-app',
    installedByUserId: 'u-pat',
    revokedAt: null,
    tokens: {
      accessToken: 'a-current',
      refreshToken,
      expiresAt:
        expiresInMs === null
          ? null
          : new Date(Date.now() + expiresInMs).toISOString(),
      scopes: ['read', 'write'],
    },
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(async () => {
  const clock = createClock(new Date().toISOString());
  store = await openTestStore(clock);
  fake = createFakeLinear();
  fake.addAccessToken('a-current', APP);
  const logs = recordingLogger();
  lines = logs.lines;
  provider = createLinearProvider({
    store,
    oauth: OAUTH,
    logger: logs.logger,
    fetch: fake.fetch,
  });
});
afterEach(async () => {
  expect(lines.join('\n')).not.toMatch(
    /lin_(access|refresh)_\d|a-current|r-old/
  );
  await store.close();
});

describe('needsRefresh', () => {
  test('refreshes within five minutes of expiry, never without an expiry', () => {
    const now = new Date('2026-10-21T12:00:00.000Z');
    const tokens = (expiresAt: string | null) => ({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt,
      scopes: [],
    });
    expect(needsRefresh(tokens(null), now)).toBe(false);
    expect(needsRefresh(tokens('2026-10-21T12:06:00.000Z'), now)).toBe(false);
    expect(needsRefresh(tokens('2026-10-21T12:05:00.000Z'), now)).toBe(true);
    expect(needsRefresh(tokens('2026-10-21T11:00:00.000Z'), now)).toBe(true);
    expect(needsRefresh(tokens('garbage'), now)).toBe(true);
  });
});

describe('real provider: installation tokens', () => {
  test('uses a valid token as is', async () => {
    await store.saveInstallation(installation(3_600_000, 'r-old'));
    const gateway = await provider.forApp('org-acme');
    expect((await gateway.whoAmI()).user.id).toBe('u-app');
    expect(fake.refreshCalls).toEqual([]);
    expect(fake.graphqlTokens).toEqual(['a-current']);
  });

  test('refreshes an expiring token once and persists the rotated pair', async () => {
    fake.addRefreshToken('r-old', APP);
    await store.saveInstallation(installation(60_000, 'r-old'));
    const [first, second] = await Promise.all([
      provider.forApp('org-acme'),
      provider.forApp('org-acme'),
    ]);
    expect(fake.refreshCalls).toEqual(['r-old']);

    const saved = await store.getInstallation('org-acme');
    expect(saved?.tokens.accessToken).toBe('lin_access_1');
    expect(saved?.tokens.refreshToken).toBe('lin_refresh_1');
    expect(saved?.tokens.scopes).toEqual(['read', 'write']);
    expect(Date.parse(saved?.tokens.expiresAt ?? '')).toBeGreaterThan(
      Date.now() + 86_000_000
    );

    // Both callers act with the new token.
    await first.whoAmI();
    await second.whoAmI();
    expect(fake.graphqlTokens).toEqual(['lin_access_1', 'lin_access_1']);

    // Later calls reuse it without refreshing again.
    await provider.forApp('org-acme');
    expect(fake.refreshCalls).toEqual(['r-old']);
  });

  test('invalid_grant means the app must be reinstalled', async () => {
    fake.addRefreshToken('r-old', APP, { invalid: true });
    await store.saveInstallation(installation(-1000, 'r-old'));
    let caught: unknown;
    try {
      await provider.forApp('org-acme');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineAuthError);
    expect((caught as EngineAuthError).code).toBe('not_installed');
    expect(
      lines.some(
        (l) => l.includes('"level":"error"') && l.includes('invalid_grant')
      )
    ).toBe(true);
    // The stored tokens are untouched.
    expect((await store.getInstallation('org-acme'))?.tokens.accessToken).toBe(
      'a-current'
    );
  });

  test('an expired token without a refresh token cannot be used', async () => {
    await store.saveInstallation(installation(-1000, null));
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
  });

  test('a network failure during refresh is not mistaken for a dead grant', async () => {
    fake.addRefreshToken('r-old', APP);
    fake.networkDownForRefresh = true;
    await store.saveInstallation(installation(-1000, 'r-old'));
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      name: 'OAuthError',
      code: 'network_error',
    });
    expect((await store.getInstallation('org-acme'))?.tokens.refreshToken).toBe(
      'r-old'
    );
  });

  test('missing or revoked installations are not installed', async () => {
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
    await store.saveInstallation(installation(3_600_000, 'r-old'));
    await store.markInstallationRevoked('org-acme', new Date().toISOString());
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
  });
});

describe('real provider: session tokens', () => {
  test('reads the session row (not the redacted copy) and refreshes it', async () => {
    fake.addRefreshToken('r-user', APP);
    const { session } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat',
      tokens: {
        accessToken: 'a-user',
        refreshToken: 'r-user',
        expiresAt: new Date(Date.now() - 1).toISOString(),
        scopes: ['read', 'write'],
      },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const redacted = {
      ...session,
      tokens: { ...session.tokens, accessToken: '', refreshToken: null },
    };
    const gateway = await provider.forSession(redacted);
    await gateway.whoAmI();
    expect(fake.refreshCalls).toEqual(['r-user']);
    expect(fake.graphqlTokens).toEqual(['lin_access_1']);
  });

  test('a dead grant or a deleted session means signing in again', async () => {
    fake.addRefreshToken('r-dead', APP, { invalid: true });
    const { token, session } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat',
      tokens: {
        accessToken: 'a-user',
        refreshToken: 'r-dead',
        expiresAt: new Date(Date.now() - 1).toISOString(),
        scopes: ['read'],
      },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await rejection(provider.forSession(session))).toMatchObject({
      code: 'not_signed_in',
    });
    await store.deleteSession(token);
    expect(await rejection(provider.forSession(session))).toMatchObject({
      code: 'not_signed_in',
    });
  });
});

describe('fixture provider', () => {
  test('serves the shared fixture as the app and as people', async () => {
    const fixture = createFixtureStore('2026-10-21');
    const fixtureProvider = createFixtureLinearProvider(fixture);
    expect(fixtureProvider.mode).toBe('fixture');
    const app = await fixtureProvider.forApp('org-northwind');
    expect((await app.whoAmI()).user.id).toBe('user-app');
    const { session } = await store.createSession({
      workspaceId: 'org-northwind',
      userId: 'user-ben',
      userName: 'Ben',
      tokens: {
        accessToken: 'fixture',
        refreshToken: null,
        expiresAt: null,
        scopes: ['read', 'write'],
      },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const ben = await fixtureProvider.forSession(session);
    expect((await ben.whoAmI()).user.id).toBe('user-ben');
    await ben.updateProjectLead('proj-delta', 'user-ben');
    // The app gateway sees the human's write: one shared workspace.
    expect((await app.fetchProject('proj-delta'))?.project.leadId).toBe(
      'user-ben'
    );
    expect(await rejection(fixtureProvider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
  });
});
