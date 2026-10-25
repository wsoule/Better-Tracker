// The first-sync backoff (architecture §7): a workspace that is
// installed but has no mirror gets its first sync from the web paths
// (authenticate's mirrorForPerson and load), through one shared helper.
// After a failed attempt the next one waits 1 minute × 2^(failures − 1),
// at most 15 minutes, counted from the attempt; a sync already running in
// this process is joined as always. The worker and the Resync button call
// fullSync directly, without the wait.

import {
  createFixtureStore,
  FIXTURE_APP_USER_ID,
  FIXTURE_INSTALLER_USER_ID,
  FIXTURE_WORKSPACE,
} from '@better-tracker/linear';
import type { Store, SyncState } from '@better-tracker/store';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createEngine,
  type Engine,
  FIRST_SYNC_RETRY_MAX_MS,
  FIRST_SYNC_RETRY_MIN_MS,
  firstSyncRetryAt,
} from '../src/index';
import {
  createClock,
  fixtureProvider,
  openTestStore,
  recordingChannel,
  recordingLogger,
  rejection,
  TEST_CONFIG,
  type TestClock,
  WORKSPACE_ID,
} from './helpers';

const MINUTE_MS = 60_000;

interface Unsynced {
  engine: Engine;
  store: Store;
  clock: TestClock;
  /** fetchWorkspace calls (one per sync attempt). */
  attempts: () => number;
  /** Makes the app's workspace read fail (true) or work (false). */
  failing(value: boolean): void;
  /** Holds every workspace read until the returned release is called. */
  gate(): () => void;
}

let open: Unsynced | null = null;
afterEach(async () => {
  await open?.store.close();
  open = null;
});

// An installed demo workspace with no mirror yet, whose first sync fails
// until told otherwise.
async function unsyncedWorkspace(): Promise<Unsynced> {
  const clock = createClock();
  const store = await openTestStore(clock);
  const fixture = createFixtureStore(clock.today());
  fixture.now = clock.now;
  let attempts = 0;
  let failing = true;
  let held: Promise<void> | null = null;
  const engine = createEngine({
    store,
    linear: fixtureProvider(fixture, {
      wrap: (gateway, actor) =>
        actor !== 'app'
          ? gateway
          : {
              ...gateway,
              fetchWorkspace: async () => {
                attempts += 1;
                if (held !== null) await held;
                if (failing) throw new Error('Linear is down');
                return gateway.fetchWorkspace();
              },
            },
    }),
    channel: recordingChannel(),
    logger: recordingLogger().logger,
    config: TEST_CONFIG,
    now: clock.now,
  });
  const at = clock.now().toISOString();
  await store.saveInstallation({
    workspaceId: FIXTURE_WORKSPACE.id,
    workspaceName: FIXTURE_WORKSPACE.name,
    urlKey: FIXTURE_WORKSPACE.urlKey,
    appUserId: FIXTURE_APP_USER_ID,
    installedByUserId: FIXTURE_INSTALLER_USER_ID,
    revokedAt: null,
    tokens: {
      accessToken: 'fixture',
      refreshToken: null,
      expiresAt: null,
      scopes: ['read', 'write'],
    },
    createdAt: at,
    updatedAt: at,
  });
  open = {
    engine,
    store,
    clock,
    attempts: () => attempts,
    failing: (value) => {
      failing = value;
    },
    gate: () => {
      let release: () => void = () => undefined;
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
  };
  return open;
}

function advance(u: Unsynced, ms: number): void {
  u.clock.set(new Date(u.clock.now().getTime() + ms).toISOString());
}

describe('firstSyncRetryAt', () => {
  const failed = (failures: number): SyncState => ({
    workspaceId: 'org-acme',
    version: 0,
    lastFullSyncAt: '2026-10-21T15:00:00.000Z',
    lastFullSyncStatus: 'failed',
    lastFullSyncError: 'Linear is down',
    lastWebhookAt: null,
    consecutiveFailures: failures,
  });

  test('doubles from one minute and stops at fifteen', () => {
    expect(FIRST_SYNC_RETRY_MIN_MS).toBe(MINUTE_MS);
    expect(FIRST_SYNC_RETRY_MAX_MS).toBe(15 * MINUTE_MS);
    const waits = [1, 2, 3, 4, 5, 6, 40, 5000].map(
      (n) =>
        (Date.parse(firstSyncRetryAt(failed(n)) ?? '') -
          Date.parse('2026-10-21T15:00:00.000Z')) /
        MINUTE_MS
    );
    expect(waits).toEqual([1, 2, 4, 8, 15, 15, 15, 15]);
  });

  test('nothing to wait for unless the last attempt failed', () => {
    expect(firstSyncRetryAt(null)).toBeNull();
    expect(
      firstSyncRetryAt({ ...failed(3), lastFullSyncStatus: 'ok' })
    ).toBeNull();
    expect(
      firstSyncRetryAt({ ...failed(3), lastFullSyncStatus: null })
    ).toBeNull();
    // A failure recorded without a count is one failure.
    const { consecutiveFailures: _, ...older } = failed(1);
    expect(firstSyncRetryAt(older)).toBe('2026-10-21T15:01:00.000Z');
  });
});

describe('the first sync waits after a failure', () => {
  test('authenticate retries with doubling waits, then places people once it lands', async () => {
    const u = await unsyncedWorkspace();
    const { sessionToken } = await u.engine.devSignIn('user-elena');
    const signedIn = async () => {
      const actor = await u.engine.authenticate(sessionToken);
      if (actor === null) throw new Error('signed out');
      return actor;
    };
    expect(await signedIn()).toMatchObject({ readOnlyReason: 'not_synced' });
    expect(u.attempts()).toBe(1);

    // Every page view inside the wait starts nothing.
    expect(await signedIn()).toMatchObject({ readOnlyReason: 'not_synced' });
    advance(u, MINUTE_MS - 1000);
    await signedIn();
    expect(u.attempts()).toBe(1);
    advance(u, 2000);
    await signedIn();
    expect(u.attempts()).toBe(2);

    // Two failures: two minutes.
    advance(u, 2 * MINUTE_MS - 1000);
    await signedIn();
    expect(u.attempts()).toBe(2);
    advance(u, 2000);
    await signedIn();
    expect(u.attempts()).toBe(3);

    // Linear recovers; the next attempt (after four minutes) lands.
    u.failing(false);
    advance(u, 4 * MINUTE_MS + 1000);
    const placed = await signedIn();
    expect(placed.readOnly).toBe(false);
    expect(u.attempts()).toBe(4);
    await signedIn();
    expect(u.attempts()).toBe(4);
  });

  test('load waits on the same backoff and says when it retries', async () => {
    const u = await unsyncedWorkspace();
    expect(await rejection(u.engine.load(WORKSPACE_ID))).toMatchObject({
      message: 'Linear is down',
    });
    expect(u.attempts()).toBe(1);
    const waiting = await rejection(u.engine.load(WORKSPACE_ID));
    expect(waiting).toMatchObject({
      name: 'EngineInputError',
      code: 'rate_limited',
      retryAt: new Date(u.clock.now().getTime() + MINUTE_MS).toISOString(),
    });
    expect((waiting as Error).message).toContain(
      'The first sync from Linear failed.'
    );
    expect(u.attempts()).toBe(1);

    // A page's authenticate respects the same wait.
    const { sessionToken } = await u.engine.devSignIn('user-elena');
    await u.engine.authenticate(sessionToken);
    expect(u.attempts()).toBe(1);

    u.failing(false);
    advance(u, MINUTE_MS + 1000);
    const loaded = await u.engine.load(WORKSPACE_ID);
    expect(loaded.mirrorVersion).toBeGreaterThan(0);
    expect(u.attempts()).toBe(2);
    // The landed sync records its size and duration (the worker's budget)
    // and clears the failure count.
    expect(loaded.syncState).toMatchObject({
      lastFullSyncStatus: 'ok',
      consecutiveFailures: 0,
      mirrorIssueCount: loaded.snapshot.issues.size,
    });
    expect(loaded.syncState?.lastFullSyncMs).toBeGreaterThanOrEqual(0);
  });

  test('the wait is capped at fifteen minutes', async () => {
    const u = await unsyncedWorkspace();
    const at = u.clock.now().toISOString();
    for (let i = 0; i < 9; i += 1) {
      await u.store.recordFullSync(WORKSPACE_ID, {
        at,
        ok: false,
        error: 'Linear is down',
      });
    }
    advance(u, 15 * MINUTE_MS - 1000);
    expect(await rejection(u.engine.load(WORKSPACE_ID))).toMatchObject({
      code: 'rate_limited',
    });
    expect(u.attempts()).toBe(0);
    advance(u, 2000);
    expect(await rejection(u.engine.load(WORKSPACE_ID))).toMatchObject({
      message: 'Linear is down',
    });
    expect(u.attempts()).toBe(1);
  });

  test('a sync already running in this process is joined, not waited out', async () => {
    const u = await unsyncedWorkspace();
    await u.store.recordFullSync(WORKSPACE_ID, {
      at: u.clock.now().toISOString(),
      ok: false,
      error: 'Linear is down',
    });
    u.failing(false);
    const release = u.gate();
    // The Resync button (or the worker) syncs directly, without the wait.
    const resync = u.engine.fullSync(WORKSPACE_ID);
    const page = u.engine.load(WORKSPACE_ID);
    // Long enough for the page to reach the sync it joins.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [synced, loaded] = await Promise.all([resync, page]);
    expect(loaded.mirrorVersion).toBe(synced.version);
    expect(u.attempts()).toBe(1);
  });
});
