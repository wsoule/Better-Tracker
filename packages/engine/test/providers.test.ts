import {
  createFixtureStore,
  type OAuthClientConfig,
} from '@better-tracker/linear';
import {
  type Installation,
  type Store,
  StoreNotFoundError,
} from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createEngine,
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
  recordingChannel,
  recordingLogger,
  rejection,
  START,
  storeWith,
  TEST_CONFIG,
  type TestClock,
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

/** Linear's expires_in (86,399 s) counted from START. */
const REFRESHED_EXPIRY = '2026-10-22T14:59:59.000Z';

// A fixed clock: token expiries come from the provider's clock, never the
// wall clock.
let clock: TestClock;
let store: Store;
let fake: FakeLinear;
let provider: LinearProvider;
let lines: string[];
let logger: ReturnType<typeof recordingLogger>['logger'];

function at(offsetMs: number): string {
  return new Date(clock.now().getTime() + offsetMs).toISOString();
}

function installation(
  expiresInMs: number | null,
  refreshToken: string | null
): Installation {
  const now = clock.now().toISOString();
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
      expiresAt: expiresInMs === null ? null : at(expiresInMs),
      scopes: ['read', 'write'],
    },
    createdAt: now,
    updatedAt: now,
  };
}

// The real provider over `over` (the test store by default).
function providerOver(over: Store): LinearProvider {
  return createLinearProvider({
    store: over,
    oauth: OAUTH,
    logger,
    now: clock.now,
    fetch: fake.fetch,
  });
}

beforeEach(async () => {
  clock = createClock(START);
  store = await openTestStore(clock);
  fake = createFakeLinear();
  fake.addAccessToken('a-current', APP);
  const logs = recordingLogger();
  lines = logs.lines;
  logger = logs.logger;
  provider = providerOver(store);
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
    // expires_in counted from the provider's clock.
    expect(saved?.tokens.expiresAt).toBe(REFRESHED_EXPIRY);

    // Both callers act with the new token.
    await first.whoAmI();
    await second.whoAmI();
    expect(fake.graphqlTokens).toEqual(['lin_access_1', 'lin_access_1']);

    // Later calls reuse it without refreshing again.
    await provider.forApp('org-acme');
    expect(fake.refreshCalls).toEqual(['r-old']);
  });

  test('invalid_grant marks the installation for reinstall and stops retrying', async () => {
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
    expect(
      lines.some(
        (l) =>
          l.includes('"level":"error"') &&
          l.includes('marked for reinstall') &&
          l.includes('"workspaceId":"org-acme"')
      )
    ).toBe(true);
    // Recorded as revoked (what Settings and /setup show); the stored
    // tokens themselves are untouched.
    const saved = await store.getInstallation('org-acme');
    expect(saved?.revokedAt).toBe(START);
    expect(saved?.tokens.accessToken).toBe('a-current');

    // Later calls fail fast without asking Linear again, and the worker
    // no longer lists the workspace.
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
    expect(fake.refreshCalls).toEqual(['r-old']);
    const engine = createEngine({
      store,
      linear: provider,
      channel: recordingChannel(),
      logger,
      config: { ...TEST_CONFIG, oauth: OAUTH },
      now: clock.now,
      fetch: fake.fetch,
    });
    expect(await engine.listWorkspaceIds()).toEqual([]);
  });

  test('an expired token without a refresh token cannot be used', async () => {
    await store.saveInstallation(installation(-1000, null));
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
    expect((await store.getInstallation('org-acme'))?.revokedAt).toBe(START);
  });

  test('a reinstall saved while the dead grant was refreshing is kept', async () => {
    fake.addRefreshToken('r-old', APP, { invalid: true });
    await store.saveInstallation(installation(-1000, 'r-old'));
    const reinstalled: Installation = {
      ...installation(3_600_000, 'r-new'),
      tokens: {
        accessToken: 'a-new',
        refreshToken: 'r-new',
        expiresAt: at(3_600_000),
        scopes: ['read', 'write'],
      },
    };
    // The admin's reinstall was waiting on the row lock and commits right
    // after the failed refresh released it.
    const racing = storeWith(store, {
      withInstallationLock: async (workspaceId, fn) => {
        try {
          return await store.withInstallationLock(workspaceId, fn);
        } catch (error) {
          await store.saveInstallation(reinstalled);
          throw error;
        }
      },
    });
    expect(
      await rejection(providerOver(racing).forApp('org-acme'))
    ).toMatchObject({ code: 'not_installed' });
    const saved = await store.getInstallation('org-acme');
    expect(saved?.revokedAt).toBeNull();
    expect(saved?.tokens.refreshToken).toBe('r-new');
  });

  test('an installation row gone at lock time reads as not installed', async () => {
    await store.saveInstallation(installation(-1000, 'r-old'));
    const vanished = storeWith(store, {
      withInstallationLock: (workspaceId) =>
        Promise.reject(new StoreNotFoundError('installation', workspaceId)),
    });
    expect(
      await rejection(providerOver(vanished).forApp('org-acme'))
    ).toMatchObject({ name: 'EngineAuthError', code: 'not_installed' });
  });

  test('a network failure during refresh is not mistaken for a dead grant', async () => {
    fake.addRefreshToken('r-old', APP);
    fake.networkDownForRefresh = true;
    await store.saveInstallation(installation(-1000, 'r-old'));
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      name: 'OAuthError',
      code: 'network_error',
    });
    const saved = await store.getInstallation('org-acme');
    expect(saved?.tokens.refreshToken).toBe('r-old');
    // A transient failure never marks the grant dead.
    expect(saved?.revokedAt).toBeNull();
  });

  test('missing or revoked installations are not installed', async () => {
    expect(await rejection(provider.forApp('org-acme'))).toMatchObject({
      code: 'not_installed',
    });
    await store.saveInstallation(installation(3_600_000, 'r-old'));
    await store.markInstallationRevoked('org-acme', clock.now().toISOString());
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
        expiresAt: at(-1),
        scopes: ['read', 'write'],
      },
      expiresAt: at(86_400_000),
    });
    const redacted = {
      ...session,
      tokens: { ...session.tokens, accessToken: '', refreshToken: null },
    };
    const gateway = await provider.forSession(redacted);
    await gateway.whoAmI();
    expect(fake.refreshCalls).toEqual(['r-user']);
    expect(fake.graphqlTokens).toEqual(['lin_access_1']);
    const [row] = await store.takeExpiredSessions(at(86_400_000), 1);
    expect(row?.tokens.expiresAt).toBe(REFRESHED_EXPIRY);
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
        expiresAt: at(-1),
        scopes: ['read'],
      },
      expiresAt: at(86_400_000),
    });
    expect(await rejection(provider.forSession(session))).toMatchObject({
      code: 'not_signed_in',
    });
    await store.deleteSession(token);
    expect(await rejection(provider.forSession(session))).toMatchObject({
      code: 'not_signed_in',
    });
  });

  test('a missing session is recognised by its error type, not its message', async () => {
    const { session } = await store.createSession({
      workspaceId: 'org-acme',
      userId: 'u-pat',
      userName: 'Pat',
      tokens: {
        accessToken: 'a-user',
        refreshToken: 'r-user',
        expiresAt: at(3_600_000),
        scopes: ['read'],
      },
      expiresAt: at(86_400_000),
    });
    const failing = (error: Error): LinearProvider =>
      providerOver(
        storeWith(store, {
          withSessionLock: () => Promise.reject(error),
        })
      );
    // A StoreNotFoundError from another bundled copy of the store (only
    // its name and kind match) still means "sign in again"…
    const foreign = Object.assign(new Error('session row vanished'), {
      name: 'StoreNotFoundError',
      kind: 'session',
    });
    expect(await rejection(failing(foreign).forSession(session))).toMatchObject(
      { name: 'EngineAuthError', code: 'not_signed_in' }
    );
    // …while an unrelated failure that happens to say "No session" is
    // passed through untouched.
    const unrelated = new Error('No session pool available');
    expect(await rejection(failing(unrelated).forSession(session))).toBe(
      unrelated
    );
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
      expiresAt: at(86_400_000),
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
