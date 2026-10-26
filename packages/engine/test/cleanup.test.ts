// cleanup(): expired sessions are deleted and (in real mode) their Linear
// grants revoked best effort; webhook delivery records are kept 30 days.
// With a deadline, work that calls Linear stops before it, and nothing
// taken from the store is left unrevoked.

import type { FetchLike, OAuthClientConfig } from '@better-tracker/linear';
import type { Store, StoredTokens } from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createEngine,
  createLinearProvider,
  type Engine,
  PURGE_AFTER_DAYS,
  REVOKE_WORST_MS,
  WEBHOOK_RETENTION_DAYS,
} from '../src/index';
import { createFakeLinear, type FakeLinear } from './fake-linear';
import {
  actorFor,
  createClock,
  createDemoHarness,
  openTestStore,
  recordingChannel,
  recordingLogger,
  START,
  TEST_CONFIG,
  type TestClock,
} from './helpers';

const OAUTH: OAuthClientConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'https://planner.example/api/auth/linear/callback',
};
const DAY_MS = 86_400_000;

let clock: TestClock;
let store: Store;
let engine: Engine;
let fake: FakeLinear;
let lines: string[];

function at(offsetMs: number): string {
  return new Date(clock.now().getTime() + offsetMs).toISOString();
}

function userTokens(id: string, withRefresh: boolean): StoredTokens {
  return {
    accessToken: `a-${id}`,
    refreshToken: withRefresh ? `r-${id}` : null,
    expiresAt: at(DAY_MS),
    scopes: ['read'],
  };
}

// A session for `id` that expires `expiresInMs` from now.
async function session(
  id: string,
  expiresInMs: number,
  withRefresh = true,
  workspaceId = 'org-acme'
): Promise<string> {
  const created = await store.createSession({
    workspaceId,
    userId: `u-${id}`,
    userName: id,
    tokens: userTokens(id, withRefresh),
    expiresAt: at(expiresInMs),
  });
  return created.token;
}

// An engine over the shared store and clock whose Linear calls go through
// `fetch`.
function engineWith(fetch: FetchLike): Engine {
  const logs = recordingLogger();
  lines = logs.lines;
  return createEngine({
    store,
    linear: createLinearProvider({
      store,
      oauth: OAUTH,
      logger: logs.logger,
      now: clock.now,
      fetch,
    }),
    channel: recordingChannel(),
    logger: logs.logger,
    config: { ...TEST_CONFIG, oauth: OAUTH },
    now: clock.now,
    fetch,
  });
}

beforeEach(async () => {
  clock = createClock(START);
  store = await openTestStore(clock);
  fake = createFakeLinear();
  engine = engineWith(fake.fetch);
});
afterEach(async () => {
  // Revoked or not, no credential is ever logged.
  expect(lines.join('\n')).not.toMatch(/\b[ar]-(old|new|gone|\d+)\b/);
  await engine.close();
});

describe('cleanup in real mode', () => {
  test("revokes expired sessions' grants and keeps live sessions", async () => {
    await session('old', -DAY_MS);
    await session('gone', -60_000, false);
    const live = await session('new', DAY_MS);

    const result = await engine.cleanup();
    expect(result).toEqual({
      expiredSessions: 2,
      revokedTokens: 2,
      revokeFailures: 0,
      oldDeliveries: 0,
      endedWorkspaceSessions: 0,
      purgedWorkspaces: 0,
      oldNotifications: 0,
      oldJobClaims: 0,
      notServedWorkspaces: 0,
      reAdmittedWorkspaces: 0,
      deferred: [],
    });
    // The refresh token ends the grant; without one, the access token.
    expect(fake.revoked).toEqual([
      { token: 'r-old', hint: 'refresh_token' },
      { token: 'a-gone', hint: 'access_token' },
    ]);
    expect(await store.getSession(live, clock.now().toISOString())).not.toBe(
      null
    );
    expect(await store.takeExpiredSessions(at(0), 10)).toEqual([]);

    // Nothing left: a second pass revokes nothing.
    expect((await engine.cleanup()).expiredSessions).toBe(0);
    expect(fake.revoked).toHaveLength(2);
    const line = lines.findLast((l) => l.includes('"msg":"cleanup finished"'));
    expect(line).toContain('"expiredSessions":0');
    expect(line).toContain('"revokedTokens":0');
  });

  test('signing out an expired session leaves it for cleanup, which revokes its grant once', async () => {
    // The stash cookie lives as long as its newest session, so it carries
    // expired tokens, which a switch, sign-in or sign-out signs out; a
    // browser clock running behind can send an expired active cookie too.
    const expired = await session('7', -60_000);
    expect(await engine.signOut(expired)).toEqual({
      known: false,
      keysForgotten: 0,
    });
    expect(fake.revoked).toEqual([]);
    expect(await engine.cleanup()).toMatchObject({
      expiredSessions: 1,
      revokedTokens: 1,
    });
    expect(fake.revoked).toEqual([{ token: 'r-7', hint: 'refresh_token' }]);
    expect((await engine.cleanup()).expiredSessions).toBe(0);
    expect(fake.revoked).toHaveLength(1);
    // A live session still ends and revokes at once.
    const live = await session('8', DAY_MS);
    expect((await engine.signOut(live)).known).toBe(true);
    expect(fake.revoked.at(-1)).toEqual({
      token: 'r-8',
      hint: 'refresh_token',
    });
    expect(await store.getSession(live, at(0))).toBeNull();
  });

  test('a failed revocation never fails cleanup', async () => {
    await session('old', -DAY_MS);
    fake.failRevoke = true;
    expect(await engine.cleanup()).toMatchObject({
      expiredSessions: 1,
      revokedTokens: 0,
      revokeFailures: 1,
    });
    // The session is gone anyway, and the failure is logged without the token.
    expect(await store.takeExpiredSessions(at(0), 10)).toEqual([]);
    expect(
      lines.some(
        (l) =>
          l.includes('"level":"warn"') &&
          l.includes("could not revoke an expired session's Linear token") &&
          l.includes('"userId":"u-old"')
      )
    ).toBe(true);
  });

  test('takes a backlog in batches', async () => {
    for (let i = 0; i < 60; i += 1) {
      await session(String(i), -DAY_MS - i * 1000);
    }
    expect(await engine.cleanup()).toMatchObject({
      expiredSessions: 60,
      revokedTokens: 60,
    });
    expect(new Set(fake.revoked.map((r) => r.token)).size).toBe(60);
  });

  test('keeps webhook delivery records for 30 days', async () => {
    expect(WEBHOOK_RETENTION_DAYS).toBe(30);
    const delivery = (id: string, ageDays: number) =>
      store.recordWebhookDelivery({
        deliveryId: id,
        workspaceId: 'org-acme',
        type: 'Issue',
        action: 'update',
        entityId: 'iss-1',
        receivedAt: at(-ageDays * DAY_MS),
      });
    await delivery('d-old', 31);
    await delivery('d-recent', 29);
    expect((await engine.cleanup()).oldDeliveries).toBe(1);
    // The recent one is still known (a retry is a duplicate); the pruned
    // id could be recorded again.
    expect(await delivery('d-recent', 29)).toBe(false);
    expect(await delivery('d-old', 31)).toBe(true);
  });
});

describe('cleanup within a deadline', () => {
  // Linear's revoke endpoint answering only at its timeout: every
  // revocation moves the clock on by that long.
  const SLOW_REVOKE_MS = REVOKE_WORST_MS - 1000;
  function slowRevokes(): FetchLike {
    return (input, init) => {
      if (String(input) === 'https://api.linear.app/oauth/revoke') {
        clock.set(at(SLOW_REVOKE_MS));
      }
      return fake.fetch(input, init);
    };
  }
  const deadlineIn = (ms: number): Date => new Date(clock.now().getTime() + ms);

  // An installation of `workspaceId`, revoked as `reason` `ageDays` ago.
  async function revokedWorkspace(
    workspaceId: string,
    reason: 'uninstalled' | 'removed',
    ageDays: number
  ): Promise<void> {
    await store.saveInstallation({
      workspaceId,
      workspaceName: workspaceId,
      urlKey: workspaceId,
      appUserId: 'u-app',
      installedByUserId: 'u-admin',
      revokedAt: null,
      tokens: userTokens(`app-${workspaceId}`, true),
      createdAt: at(-90 * DAY_MS),
      updatedAt: at(-90 * DAY_MS),
    });
    await store.revokeInstallation(workspaceId, reason, at(-ageDays * DAY_MS));
  }

  test('a slow revoke endpoint stops it at the deadline, every session it took revoked', async () => {
    for (let i = 0; i < 60; i += 1) {
      await session(String(i), -DAY_MS - i * 1000);
    }
    // Shares the store (the afterEach closes it once).
    const slow = engineWith(slowRevokes());
    const deadline = deadlineIn(2 * 60_000);
    const first = await slow.cleanup({ deadline });
    // Each batch is what the time left can revoke at the endpoint's
    // timeout, so the pass ends before the deadline, having revoked
    // every session it deleted, and says it left some.
    expect(first.expiredSessions).toBe(Math.floor(120_000 / REVOKE_WORST_MS));
    expect(first.revokedTokens).toBe(first.expiredSessions);
    expect(fake.revoked).toHaveLength(first.expiredSessions);
    expect(first.deferred).toEqual(['expired_sessions']);
    expect(clock.now().getTime()).toBeLessThanOrEqual(deadline.getTime());
    // The rest is still there for the next pass, which carries on.
    const left = 60 - first.expiredSessions;
    const second = await slow.cleanup({ deadline: deadlineIn(60 * 60_000) });
    expect(second).toMatchObject({
      expiredSessions: left,
      revokedTokens: left,
      deferred: [],
    });
    expect(new Set(fake.revoked.map((r) => r.token)).size).toBe(60);
  });

  test('with no time left it starts no revocation or purge, and still prunes', async () => {
    await session('old', -DAY_MS);
    await revokedWorkspace('org-gone', 'uninstalled', PURGE_AFTER_DAYS + 1);
    // Created before its workspace's removal (revoked one minute from now).
    await session('removed', DAY_MS, true, 'org-removed');
    await store.saveInstallation({
      workspaceId: 'org-removed',
      workspaceName: 'Removed',
      urlKey: 'removed',
      appUserId: 'u-app',
      installedByUserId: 'u-admin',
      revokedAt: null,
      tokens: userTokens('app-removed', true),
      createdAt: at(-DAY_MS),
      updatedAt: at(-DAY_MS),
    });
    await store.revokeInstallation('org-removed', 'removed', at(60_000));
    await store.recordWebhookDelivery({
      deliveryId: 'd-old',
      workspaceId: 'org-acme',
      type: 'Issue',
      action: 'update',
      entityId: 'iss-1',
      receivedAt: at(-31 * DAY_MS),
    });

    const result = await engine.cleanup({ deadline: deadlineIn(0) });
    expect(result).toMatchObject({
      expiredSessions: 0,
      endedWorkspaceSessions: 0,
      purgedWorkspaces: 0,
      oldDeliveries: 1,
      deferred: ['expired_sessions', 'workspace_sessions', 'purges'],
    });
    expect(fake.revoked).toEqual([]);
    expect(await store.getInstallation('org-gone')).not.toBeNull();

    // Without a deadline the same pass does all of it.
    expect(await engine.cleanup()).toMatchObject({
      expiredSessions: 1,
      endedWorkspaceSessions: 1,
      purgedWorkspaces: 1,
      deferred: [],
    });
    expect(fake.revoked).toHaveLength(2);
  });

  test('a purge starts only when its sessions can be revoked in the time left', async () => {
    await revokedWorkspace('org-gone', 'uninstalled', PURGE_AFTER_DAYS + 1);
    // Signed in after the uninstall (kept by the session step), deleted
    // and revoked by the purge.
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      await session(id, DAY_MS, true, 'org-gone');
    }
    // Two rounds of four revocations plus the transaction's allowance do
    // not fit in 30 s.
    const tight = await engine.cleanup({ deadline: deadlineIn(30_000) });
    expect(tight).toMatchObject({ purgedWorkspaces: 0, deferred: ['purges'] });
    expect(await store.getInstallation('org-gone')).not.toBeNull();
    const roomy = await engine.cleanup({ deadline: deadlineIn(2 * 60_000) });
    expect(roomy).toMatchObject({ purgedWorkspaces: 1, deferred: [] });
    expect(fake.revoked.map((r) => r.token).toSorted()).toEqual([
      'r-p1',
      'r-p2',
      'r-p3',
      'r-p4',
      'r-p5',
    ]);
  });
});

describe('cleanup in demo mode', () => {
  test('deletes expired demo sessions without calling Linear', async () => {
    const h = await createDemoHarness({ clock: createClock(START) });
    try {
      await actorFor(h, 'user-ana');
      h.clock.advanceDays(31);
      expect(await h.engine.cleanup()).toEqual({
        expiredSessions: 1,
        revokedTokens: 0,
        revokeFailures: 0,
        oldDeliveries: 0,
        endedWorkspaceSessions: 0,
        purgedWorkspaces: 0,
        oldNotifications: 0,
        oldJobClaims: 0,
        notServedWorkspaces: 0,
        reAdmittedWorkspaces: 0,
        deferred: [],
      });
    } finally {
      await h.close();
    }
  });
});
