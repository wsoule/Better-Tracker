// cleanup(): expired sessions are deleted and (in real mode) their Linear
// grants revoked best effort; webhook delivery records are kept 30 days.

import type { OAuthClientConfig } from '@better-tracker/linear';
import type { Store, StoredTokens } from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createEngine,
  createLinearProvider,
  type Engine,
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
  withRefresh = true
): Promise<string> {
  const created = await store.createSession({
    workspaceId: 'org-acme',
    userId: `u-${id}`,
    userName: id,
    tokens: userTokens(id, withRefresh),
    expiresAt: at(expiresInMs),
  });
  return created.token;
}

beforeEach(async () => {
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
      });
    } finally {
      await h.close();
    }
  });
});
