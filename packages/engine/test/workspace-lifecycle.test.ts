// Several workspaces on one deployment (owner decision 2026-10-25): how an
// installation is revoked (Linear's OAuthApp revoked webhook, a dead app
// grant, the operator's remove), what cleanup() then ends and purges, the
// retention it applies, and the operator commands (remove, purge, block,
// unblock) the worker's CLI calls. OAuth mode over the fake Linear
// endpoints; no workspace reads are needed.

import type { OAuthClientConfig } from '@better-tracker/linear';
import type {
  Installation,
  RevokedReason,
  Store,
  StoredTokens,
} from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createEngine,
  createLinearProvider,
  type Engine,
  type EngineConfig,
  JOB_CLAIM_RETENTION_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  OPERATOR_OFF_MESSAGE,
  OPERATOR_PURGE_MIN_MINUTES,
  PURGE_AFTER_DAYS,
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
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const NEVER = '2099-01-01T00:00:00.000Z';

const PAT: FakeIdentity = { user: person('u-pat', 'Pat Lee'), workspace: ACME };
const ACME_APP: FakeIdentity = {
  user: person('u-acme-app', 'Planner app', { app: true }),
  workspace: ACME,
};

let clock: TestClock;
let store: Store;
let engine: Engine;
let fake: FakeLinear;
let lines: string[];
let logger: ReturnType<typeof recordingLogger>['logger'];

function at(offsetMs: number): string {
  return new Date(clock.now().getTime() + offsetMs).toISOString();
}

// An engine over `over` with the real provider and the fake Linear,
// logging into the test's one recording logger.
function engineOver(
  over: Store,
  config: EngineConfig = { ...TEST_CONFIG, oauth: OAUTH }
): Engine {
  return createEngine({
    store: over,
    linear: createLinearProvider({
      store: over,
      oauth: OAUTH,
      logger,
      now: clock.now,
      fetch: fake.fetch,
    }),
    channel: recordingChannel(),
    logger,
    config,
    now: clock.now,
    fetch: fake.fetch,
  });
}

beforeEach(async () => {
  clock = createClock(START);
  store = await openTestStore(clock);
  fake = createFakeLinear();
  const logs = recordingLogger();
  lines = logs.lines;
  logger = logs.logger;
  engine = engineOver(store);
});
afterEach(async () => {
  // No credential is ever logged, whatever was revoked or purged.
  expect(lines.join('\n')).not.toMatch(
    /secret-(access|refresh)|lin_(access|refresh)_\d/
  );
  await engine.close();
});

function appTokens(
  name: string,
  expiresAt: string | null = NEVER
): StoredTokens {
  return {
    accessToken: `secret-access-${name}`,
    refreshToken: `secret-refresh-${name}`,
    expiresAt,
    scopes: ['read', 'write'],
  };
}

// Saves an active installation updated at `updatedAt` (default: now).
async function install(
  workspace: { id: string; name: string; urlKey: string },
  options: { updatedAt?: string; tokens?: StoredTokens } = {}
): Promise<Installation> {
  const updatedAt = options.updatedAt ?? at(0);
  const installation: Installation = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    urlKey: workspace.urlKey,
    appUserId: `u-${workspace.urlKey}-app`,
    installedByUserId: 'u-pat',
    revokedAt: null,
    tokens: options.tokens ?? appTokens(workspace.urlKey),
    createdAt: updatedAt,
    updatedAt,
  };
  await store.saveInstallation(installation);
  return installation;
}

// A session in `workspaceId` for `name`, created now, never expiring.
async function session(
  workspaceId: string,
  name: string,
  extra: { workspaceName?: string; workspaceUrlKey?: string } = {}
): Promise<string> {
  const created = await store.createSession({
    workspaceId,
    userId: `u-${name}`,
    userName: name,
    tokens: {
      accessToken: `secret-access-${name}`,
      refreshToken: `secret-refresh-${name}`,
      expiresAt: NEVER,
      scopes: ['read'],
    },
    expiresAt: NEVER,
    ...extra,
  });
  return created.token;
}

async function statusOf(workspaceId: string) {
  return (await store.listWorkspaceStatus()).find(
    (status) => status.workspaceId === workspaceId
  );
}

async function revoke(workspaceId: string, reason: RevokedReason) {
  expect(await store.revokeInstallation(workspaceId, reason, at(0))).toBe(true);
}

function revokedEvent(
  workspaceId: string,
  createdAt: string | null | undefined,
  deliveryId = `delivery-${Math.random()}`
): Parameters<Engine['handleWebhook']>[0] {
  return {
    deliveryId,
    workspaceId,
    type: 'OAuthApp',
    action: 'revoked',
    entityId: null,
    updatedFrom: null,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function logged(message: string): string[] {
  return lines.filter((line) => line.includes(`"msg":"${message}"`));
}

describe('revoking an installation', () => {
  test('OAuthApp revoked uninstalls: reason, wiped credentials, no Linear call', async () => {
    await install(ACME);
    const pat = await session(ACME.id, 'pat');
    clock.set(at(5 * MINUTE_MS));
    expect(
      await engine.handleWebhook(revokedEvent(ACME.id, at(-MINUTE_MS)))
    ).toBe('processed');

    const status = await statusOf(ACME.id);
    expect(status?.installation).toMatchObject({
      revokedAt: at(0),
      revokedReason: 'uninstalled',
    });
    expect((await store.getInstallation(ACME.id))?.tokens).toMatchObject({
      accessToken: '',
      refreshToken: null,
      expiresAt: null,
    });
    expect(await engine.listWorkspaceIds()).toEqual([]);
    expect(
      logged('the app was revoked for this workspace; it must be reinstalled')
    ).toHaveLength(1);
    // Nothing went to Linear, and sessions wait for cleanup.
    expect(fake.revoked).toEqual([]);
    expect(await store.getSession(pat, at(0))).not.toBeNull();
  });

  test('a revoke created before a reinstall is stale: ignored, logged at info', async () => {
    // Uninstalled at T, reinstalled at T + 10 min; the revoke's delivery
    // (created at T) arrives late, after the reinstall.
    const uninstalledAt = at(0);
    await install(ACME, {
      updatedAt: at(10 * MINUTE_MS),
      tokens: appTokens('new'),
    });
    clock.set(at(20 * MINUTE_MS));
    expect(
      await engine.handleWebhook(revokedEvent(ACME.id, uninstalledAt))
    ).toBe('processed');

    const saved = await store.getInstallation(ACME.id);
    expect(saved?.revokedAt).toBeNull();
    expect(saved?.tokens.refreshToken).toBe('secret-refresh-new');
    const stale = logged(
      'stale OAuthApp revoked ignored: the app was reinstalled after it'
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('"level":"info"');
    expect(
      logged('the app was revoked for this workspace; it must be reinstalled')
    ).toEqual([]);

    // A fresh revoke (after the reinstall) still applies.
    expect(
      await engine.handleWebhook(revokedEvent(ACME.id, at(-MINUTE_MS)))
    ).toBe('processed');
    expect((await statusOf(ACME.id))?.installation?.revokedReason).toBe(
      'uninstalled'
    );
    // A later copy of it changes nothing.
    expect(
      await engine.handleWebhook(revokedEvent(ACME.id, at(-MINUTE_MS)))
    ).toBe('processed');
    expect(
      logged('OAuthApp revoked for an installation already revoked; ignored')
    ).toHaveLength(1);
  });

  test('without a createdAt, or with one that is not a date, the revoke applies', async () => {
    for (const createdAt of [undefined, null, 'not a date']) {
      await install(ACME, { updatedAt: at(10 * MINUTE_MS) });
      await engine.handleWebhook(revokedEvent(ACME.id, createdAt));
      expect((await statusOf(ACME.id))?.installation?.revokedReason).toBe(
        'uninstalled'
      );
    }
  });

  test('a dead app grant: grant_dead, members keep their sessions, never purged by cleanup', async () => {
    fake.addRefreshToken('secret-refresh-acme', ACME_APP, { invalid: true });
    await install(ACME, { tokens: appTokens('acme', at(-1000)) });
    const pat = await session(ACME.id, 'pat');

    expect(await rejection(engine.fullSync(ACME.id))).toMatchObject({
      name: 'EngineAuthError',
      code: 'not_installed',
    });
    expect((await statusOf(ACME.id))?.installation?.revokedReason).toBe(
      'grant_dead'
    );
    expect((await store.getInstallation(ACME.id))?.tokens.accessToken).toBe('');

    // Members are not signed out: they reach /setup's "Reinstall needed".
    expect(await engine.cleanup()).toMatchObject({
      endedWorkspaceSessions: 0,
      purgedWorkspaces: 0,
    });
    expect((await engine.authenticate(pat))?.session.userId).toBe('u-pat');

    // Long past the purge grace: still there (no admin asked for anything).
    clock.advanceDays(PURGE_AFTER_DAYS + 30);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(0);
    expect(await store.getInstallation(ACME.id)).not.toBeNull();
    expect(await store.getSession(pat, at(0))).not.toBeNull();

    // Only the operator's purge deletes it, ending the session first.
    expect(await engine.purgeWorkspaceNow('acme')).toMatchObject({
      purged: true,
      workspaceId: ACME.id,
      endedSessions: 1,
    });
    expect(fake.revoked).toContainEqual({
      token: 'secret-refresh-pat',
      hint: 'refresh_token',
    });
    expect(await store.getInstallation(ACME.id)).toBeNull();
  });
});

describe('cleanup after a revoke', () => {
  test('ends the sessions created before an uninstall and keeps later ones', async () => {
    await install(ACME);
    const before = [
      await session(ACME.id, 'pat'),
      await session(ACME.id, 'sam'),
    ];
    const other = await session(OTHER.id, 'olga');
    clock.set(at(MINUTE_MS));
    await engine.handleWebhook(revokedEvent(ACME.id, at(0)));
    // An admin signs in afterwards to reinstall.
    clock.set(at(MINUTE_MS));
    const admin = await session(ACME.id, 'ada');

    expect(await engine.cleanup()).toMatchObject({
      endedWorkspaceSessions: 2,
      revokedTokens: 2,
      revokeFailures: 0,
      purgedWorkspaces: 0,
    });
    for (const token of before) {
      expect(await store.getSession(token, at(0))).toBeNull();
    }
    expect(fake.revoked.map((r) => r.token).sort()).toEqual([
      'secret-refresh-pat',
      'secret-refresh-sam',
    ]);
    expect(await store.getSession(admin, at(0))).not.toBeNull();
    // Another workspace's sessions are untouched.
    expect(await store.getSession(other, at(0))).not.toBeNull();
    // Nothing left to end.
    expect((await engine.cleanup()).endedWorkspaceSessions).toBe(0);
  });

  test('a failed grant revocation is counted and logged without the token', async () => {
    await install(ACME);
    await session(ACME.id, 'pat');
    clock.set(at(MINUTE_MS));
    await engine.handleWebhook(revokedEvent(ACME.id, at(0)));
    fake.failRevoke = true;
    expect(await engine.cleanup()).toMatchObject({
      endedWorkspaceSessions: 1,
      revokedTokens: 0,
      revokeFailures: 1,
    });
    expect(
      lines.some(
        (l) =>
          l.includes('"level":"warn"') &&
          l.includes(
            'could not revoke the Linear token of a session of an uninstalled workspace'
          ) &&
          l.includes('"userId":"u-pat"')
      )
    ).toBe(true);
  });

  test('purges uninstalled and removed workspaces after 30 days, never grant_dead', async () => {
    expect(PURGE_AFTER_DAYS).toBe(30);
    const DEAD = { id: 'org-dead', name: 'Dead Co', urlKey: 'dead' };
    for (const workspace of [ACME, OTHER, DEAD]) {
      await install(workspace);
      await store.saveSettings({
        ...(await engine.getSettings(workspace.id)),
        watcherUserIds: ['u-pat'],
      });
    }
    await revoke(ACME.id, 'uninstalled');
    await revoke(OTHER.id, 'removed');
    await revoke(DEAD.id, 'grant_dead');
    // Signed in after the uninstall (to reinstall) but never did: the
    // purge ends that session first, revoking its grant.
    clock.set(at(MINUTE_MS));
    const late = await session(ACME.id, 'ada');

    clock.advanceDays(29);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(0);
    clock.set(at(DAY_MS));
    expect(await engine.cleanup()).toMatchObject({
      purgedWorkspaces: 2,
      revokedTokens: 1,
    });
    for (const id of [ACME.id, OTHER.id]) {
      expect(await store.getInstallation(id)).toBeNull();
      expect(await store.getSettings(id)).toBeNull();
    }
    expect(await store.getSession(late, at(0))).toBeNull();
    expect(fake.revoked).toEqual([
      { token: 'secret-refresh-ada', hint: 'refresh_token' },
    ]);
    expect(await store.getInstallation(DEAD.id)).not.toBeNull();
    expect(await store.getSettings(DEAD.id)).not.toBeNull();

    // Logged with the id only: a workspace's name must not outlive it.
    const purged = logged('workspace purged');
    expect(purged).toHaveLength(2);
    expect(purged.join('\n')).toContain(ACME.id);
    expect(purged.join('\n')).not.toMatch(/Acme|Other Co/);

    clock.advanceDays(365);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(0);
    expect(await store.getInstallation(DEAD.id)).not.toBeNull();
  });

  test('purges at most three workspaces per call', async () => {
    const ids = ['org-a', 'org-b', 'org-c', 'org-d'];
    for (const id of ids) {
      await install({ id, name: id, urlKey: id });
      await revoke(id, 'removed');
    }
    clock.advanceDays(PURGE_AFTER_DAYS + 1);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(3);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(1);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(0);
  });

  test('a reinstall that wins the race with a purge keeps every session', async () => {
    await install(ACME);
    await revoke(ACME.id, 'uninstalled');
    // An admin signs in to reinstall, on the last day of the grace.
    clock.advanceDays(PURGE_AFTER_DAYS + 1);
    const admin = await session(ACME.id, 'ada');
    // The reinstall commits after cleanup listed the workspace as due,
    // just before the purge takes its lock.
    const racing = engineOver(
      storeWith(store, {
        purgeWorkspace: async (workspaceId, options) => {
          await install(ACME, { tokens: appTokens('again') });
          return store.purgeWorkspace(workspaceId, options);
        },
      })
    );
    expect(await racing.cleanup()).toMatchObject({
      purgedWorkspaces: 0,
      revokedTokens: 0,
    });
    expect((await store.getInstallation(ACME.id))?.revokedAt).toBeNull();
    expect(await store.getSession(admin, at(0))).not.toBeNull();
    expect(fake.revoked).toEqual([]);
  });

  test('a reinstall within the grace keeps everything', async () => {
    await install(ACME);
    await revoke(ACME.id, 'uninstalled');
    clock.advanceDays(10);
    await install(ACME, { tokens: appTokens('new') });
    clock.advanceDays(PURGE_AFTER_DAYS);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(0);
    expect((await store.getInstallation(ACME.id))?.revokedAt).toBeNull();
  });
});

describe('retention', () => {
  test('notifications are kept 90 days and job claims 30, each bounded per call', async () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    expect(JOB_CLAIM_RETENTION_DAYS).toBe(30);
    for (const ageDays of [91, 89]) {
      const createdAt = at(-ageDays * DAY_MS);
      const day = createdAt.slice(0, 10);
      await store.insertNotification({
        workspaceId: ACME.id,
        day,
        recipientId: 'u-pat',
        channel: 'outbox',
        status: 'preview',
        digest: {
          recipientId: 'u-pat',
          recipientName: 'Pat Lee',
          recipientEmail: null,
          day,
          items: [],
        },
        error: null,
        now: createdAt,
      });
    }
    for (const ageDays of [31, 29]) {
      const claimedAt = at(-ageDays * DAY_MS);
      await store.claimJob(ACME.id, 'daily', claimedAt.slice(0, 10), claimedAt);
    }

    // The limits each prune passes, seen through a wrapped store.
    const limits: number[] = [];
    const spied = storeWith(store, {
      pruneNotifications: (before, limit) => {
        limits.push(limit);
        return store.pruneNotifications(before, limit);
      },
      pruneJobClaims: (before, limit) => {
        limits.push(limit);
        return store.pruneJobClaims(before, limit);
      },
    });
    const spiedEngine = engineOver(spied);
    expect(await spiedEngine.cleanup()).toMatchObject({
      oldNotifications: 1,
      oldJobClaims: 1,
    });
    expect(limits).toEqual([2000, 2000]);
    expect(
      (await store.listNotifications(ACME.id, { limit: 10 })).map(
        (n) => n.createdAt
      )
    ).toEqual([at(-89 * DAY_MS)]);
    expect((await spiedEngine.cleanup()).oldNotifications).toBe(0);
  });
});

describe('operator commands', () => {
  test('remove: app token revoked with Linear, revoked as removed, sessions ended; a reinstall stays open', async () => {
    await install(ACME);
    const pat = await session(ACME.id, 'pat');
    const sam = await session(ACME.id, 'sam');

    // Named by URL key, in any case.
    expect(await engine.removeWorkspace('ACME')).toEqual({
      workspaceId: ACME.id,
      revoked: true,
      appTokenRevoked: true,
      endedSessions: 2,
      revokedTokens: 2,
      revokeFailures: 0,
    });
    expect(fake.revoked.map((r) => r.token).sort()).toEqual([
      'secret-refresh-acme',
      'secret-refresh-pat',
      'secret-refresh-sam',
    ]);
    expect((await statusOf(ACME.id))?.installation?.revokedReason).toBe(
      'removed'
    );
    expect((await store.getInstallation(ACME.id))?.tokens.accessToken).toBe('');
    for (const token of [pat, sam]) {
      expect(await engine.authenticate(token)).toBeNull();
    }

    // Again: nothing left to revoke or end.
    expect(await engine.removeWorkspace(ACME.id)).toMatchObject({
      revoked: false,
      appTokenRevoked: null,
      endedSessions: 0,
    });

    // An admin signs in and reinstalls.
    fake.addCode('code-pat', PAT, 'read');
    const signedIn = await engine.finishSignIn({
      code: 'code-pat',
      codeVerifier: 'v',
      intent: 'signin',
    });
    expect(signedIn.needsInstall).toBe(true);
    const actor = await engine.authenticate(signedIn.sessionToken);
    if (actor === null) throw new Error('not signed in');
    fake.addCode('code-install', ACME_APP, 'read,write');
    await engine.finishInstall({
      code: 'code-install',
      codeVerifier: 'v',
      actor,
    });
    expect((await store.getInstallation(ACME.id))?.revokedAt).toBeNull();
  });

  test('remove still revokes when Linear refuses the app token revocation', async () => {
    await install(ACME);
    fake.failRevoke = true;
    expect(await engine.removeWorkspace(ACME.id)).toMatchObject({
      revoked: true,
      appTokenRevoked: false,
    });
    expect(logged("could not revoke the app's Linear token")).toHaveLength(1);
  });

  test('names: unknown, malformed, shared URL keys, and a workspace only signed in to', async () => {
    expect(await rejection(engine.removeWorkspace('globex'))).toMatchObject({
      name: 'EngineInputError',
      code: 'not_found',
    });
    expect(await rejection(engine.removeWorkspace('not a key!'))).toMatchObject(
      {
        code: 'invalid',
      }
    );
    // A renamed workspace left an old installation with the same key.
    await install(ACME);
    await install({ id: 'org-acme-old', name: 'Old Acme', urlKey: 'acme' });
    expect(await rejection(engine.removeWorkspace('acme'))).toMatchObject({
      code: 'conflict',
    });
    // Sessions only (nobody installed): found by the session's URL key;
    // nothing to purge, but remove ends the sessions.
    const olga = await session(OTHER.id, 'olga', {
      workspaceName: OTHER.name,
      workspaceUrlKey: OTHER.urlKey,
    });
    expect(await engine.purgeWorkspaceNow('other')).toEqual({
      purged: false,
      workspaceId: OTHER.id,
      reason: 'not_installed',
    });
    expect(await engine.removeWorkspace('other')).toEqual({
      workspaceId: OTHER.id,
      revoked: false,
      appTokenRevoked: null,
      endedSessions: 1,
      revokedTokens: 1,
      revokeFailures: 0,
    });
    expect(await store.getSession(olga, at(0))).toBeNull();
  });

  test('purge: refuses an active or just-revoked workspace, then deletes everything', async () => {
    expect(OPERATOR_PURGE_MIN_MINUTES).toBe(15);
    await install(ACME);
    await store.saveSettings(await engine.getSettings(ACME.id));
    expect(await engine.purgeWorkspaceNow('acme')).toEqual({
      purged: false,
      workspaceId: ACME.id,
      reason: 'not_revoked',
    });
    await engine.removeWorkspace('acme');
    expect(await engine.purgeWorkspaceNow('acme')).toMatchObject({
      purged: false,
      reason: 'too_recent',
    });
    expect(
      await engine.purgeWorkspaceNow('acme', { now: at(14 * MINUTE_MS) })
    ).toMatchObject({ purged: false, reason: 'too_recent' });
    // An admin signed in after the removal but never reinstalled.
    clock.set(at(16 * MINUTE_MS));
    await session(ACME.id, 'ada');
    const purged = await engine.purgeWorkspaceNow('acme');
    expect(purged).toMatchObject({
      purged: true,
      workspaceId: ACME.id,
      endedSessions: 1,
    });
    if (!purged.purged) throw new Error('not purged');
    // The session is deleted by the purge itself (then its grant revoked).
    expect(purged.counts).toMatchObject({
      installations: 1,
      sessions: 1,
      settings: 1,
    });
    expect(fake.revoked).toContainEqual({
      token: 'secret-refresh-ada',
      hint: 'refresh_token',
    });
    expect(await store.getInstallation(ACME.id)).toBeNull();
    expect(await rejection(engine.purgeWorkspaceNow('acme'))).toMatchObject({
      code: 'not_found',
    });
  });

  test('block: by URL key resolves to the org id and removes; unknown keys wait for their first match', async () => {
    await install(ACME);
    const pat = await session(ACME.id, 'pat');

    expect(await engine.blockWorkspace('Acme', '  spam  ')).toEqual({
      key: ACME.id,
      kind: 'id',
      workspaceId: ACME.id,
      removal: {
        workspaceId: ACME.id,
        revoked: true,
        appTokenRevoked: true,
        endedSessions: 1,
        revokedTokens: 1,
        revokeFailures: 0,
      },
    });
    expect(await store.getSession(pat, at(0))).toBeNull();
    expect(await engine.blockWorkspace('globex')).toEqual({
      key: 'globex',
      kind: 'url_key',
      workspaceId: null,
      removal: null,
    });
    // An org id nobody here knows yet is still blocked by id.
    const orgId = 'A1B2C3D4-0000-4000-8000-00000000000F';
    expect(await engine.blockWorkspace(orgId, null)).toMatchObject({
      key: orgId.toLowerCase(),
      kind: 'id',
      workspaceId: null,
    });
    expect(await engine.listBlockedWorkspaces()).toEqual([
      expect.objectContaining({
        key: orgId.toLowerCase(),
        kind: 'id',
        reason: null,
      }),
      expect.objectContaining({ key: 'globex', kind: 'url_key' }),
      expect.objectContaining({ key: ACME.id, kind: 'id', reason: 'spam' }),
    ]);
    expect(
      await rejection(engine.blockWorkspace('globex', 'x'.repeat(501)))
    ).toMatchObject({ code: 'invalid' });

    // Unblocking by URL key lifts the block stored under the org id.
    expect(await engine.unblockWorkspace('acme')).toBe(true);
    expect(await engine.unblockWorkspace('GLOBEX')).toBe(true);
    expect(await engine.unblockWorkspace('globex')).toBe(false);
    expect((await engine.listBlockedWorkspaces()).map((b) => b.key)).toEqual([
      orgId.toLowerCase(),
    ]);
    // Unblocked, the workspace stays removed until an admin reinstalls.
    expect((await statusOf(ACME.id))?.installation?.revokedReason).toBe(
      'removed'
    );
  });

  test('unblock by URL key still lifts a block once the workspace is purged', async () => {
    await install(ACME);
    expect(await engine.blockWorkspace('acme', 'abuse')).toMatchObject({
      key: ACME.id,
      kind: 'id',
    });
    expect(await engine.listBlockedWorkspaces()).toEqual([
      expect.objectContaining({ key: ACME.id, urlKey: 'acme' }),
    ]);
    // Purged 30 days later: nothing here knows linear.app/acme any more.
    clock.advanceDays(PURGE_AFTER_DAYS + 1);
    expect((await engine.cleanup()).purgedWorkspaces).toBe(1);
    expect(await statusOf(ACME.id)).toBeUndefined();
    expect(await engine.unblockWorkspace('acme')).toBe(true);
    expect(await engine.listBlockedWorkspaces()).toEqual([]);
    expect(await engine.unblockWorkspace('acme')).toBe(false);
  });

  test('unblock by a URL key two blocked workspaces went by names the id instead', async () => {
    await install(ACME);
    await engine.blockWorkspace('acme');
    // A second org later took linear.app/acme and was blocked by it too.
    await install({ id: 'org-acme-2', name: 'Acme 2', urlKey: 'acme-2' });
    await store.blockWorkspace('org-acme-2', 'id', null, at(0), {
      urlKey: 'acme',
    });
    expect(await rejection(engine.unblockWorkspace('acme'))).toMatchObject({
      code: 'conflict',
    });
    expect(await engine.listBlockedWorkspaces()).toHaveLength(2);
    expect(await engine.unblockWorkspace('org-acme-2')).toBe(true);
    expect(await engine.unblockWorkspace('acme')).toBe(true);
    expect(await engine.listBlockedWorkspaces()).toEqual([]);
  });

  test('listWorkspaceStatus holds no tokens and counts live sessions', async () => {
    await install(ACME);
    await session(ACME.id, 'pat');
    const listed = await engine.listWorkspaceStatus();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      workspaceId: ACME.id,
      urlKey: 'acme',
      sessionCount: 1,
    });
    expect(JSON.stringify(listed)).not.toContain('secret-');
  });

  test('personal API keys: every command but the listings refuses', async () => {
    const keyed = engineOver(store, { ...TEST_CONFIG, auth: 'api_key' });
    for (const call of [
      () => keyed.removeWorkspace('acme'),
      () => keyed.purgeWorkspaceNow('acme'),
      () => keyed.blockWorkspace('acme'),
      () => keyed.unblockWorkspace('acme'),
      () => keyed.revokeWorkspace(ACME.id, 'removed'),
    ]) {
      expect(await rejection(call())).toMatchObject({
        code: 'invalid',
        message: OPERATOR_OFF_MESSAGE,
      });
    }
    expect(await keyed.listWorkspaceStatus()).toEqual([]);
    expect(await keyed.listBlockedWorkspaces()).toEqual([]);
  });
});
