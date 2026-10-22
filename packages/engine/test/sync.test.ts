import { DEFAULT_TUNING, defaultSettings } from '@better-tracker/core';
import {
  createFixtureStore,
  createFixtureWorkspace,
  FIXTURE_APP_USER_ID,
  type FixtureStore,
  LinearApiError,
  type LinearGateway,
} from '@better-tracker/linear';
import type { Store } from '@better-tracker/store';
import { afterEach, describe, expect, test } from 'bun:test';

import { createEngine } from '../src/engine';
import type { Engine, EngineConfig } from '../src/index';
import { issuesNeedingStateHistory } from '../src/sync';
import {
  createClock,
  fixtureProvider,
  type GatewayWrapper,
  openTestStore,
  recordingChannel,
  recordingLogger,
  TEST_CONFIG,
  type TestClock,
  WORKSPACE_ID,
  rejectionMessage,
} from './helpers';

interface Setup {
  engine: Engine;
  store: Store;
  fixture: FixtureStore;
  clock: TestClock;
  logs: string[];
}

let open: Store | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

// An installed but never-synced workspace with no settings.
async function setup(
  options: { config?: Partial<EngineConfig>; wrap?: GatewayWrapper } = {}
): Promise<Setup> {
  const clock = createClock();
  const store = await openTestStore(clock);
  open = store;
  const fixture = createFixtureStore(clock.today());
  const { logger, lines } = recordingLogger();
  const engine = createEngine({
    store,
    linear: fixtureProvider(fixture, { wrap: options.wrap }),
    channel: recordingChannel(),
    logger,
    config: { ...TEST_CONFIG, ...options.config },
    now: clock.now,
  });
  await store.saveInstallation({
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Northwind Labs',
    urlKey: 'northwind',
    appUserId: FIXTURE_APP_USER_ID,
    installedByUserId: 'user-chloe',
    revokedAt: null,
    tokens: {
      accessToken: 'fixture',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    },
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
  });
  return { engine, store, fixture, clock, logs: lines };
}

describe('issuesNeedingStateHistory', () => {
  test('selects open issues of milestones due within lead + stall days or past', () => {
    const data = createFixtureWorkspace('2026-10-21');
    const ids = issuesNeedingStateHistory(data, '2026-10-21', DEFAULT_TUNING);
    // Due -3 (overdue), +5, +14 (the edge): included.
    expect(ids).toContain('iss-eng-12');
    expect(ids).toContain('iss-eng-31');
    expect(ids).toContain('iss-eng-70');
    // Closed issues, later milestones and issues without a milestone: not.
    expect(ids).not.toContain('iss-eng-1');
    expect(ids).not.toContain('iss-eng-17');
    expect(ids).not.toContain('iss-eng-72');
    expect(ids).not.toContain('iss-eng-80');
    // Exactly the open issues of the milestones due within 14 days (or past).
    const soon = new Set([
      'ms-atlas-1',
      'ms-atlas-2',
      'ms-beacon-1',
      'ms-compass-1',
      'ms-delta-1',
      'ms-ember-1',
      'ms-fjord-1',
      'ms-garnet-1',
      'ms-harbor-1',
      'ms-juniper-1',
    ]);
    const closed = new Set(
      data.states
        .filter((st) => st.type === 'completed' || st.type === 'canceled')
        .map((st) => st.id)
    );
    const expected = data.issues
      .filter(
        (i) =>
          i.milestoneId !== null &&
          soon.has(i.milestoneId) &&
          !closed.has(i.stateId)
      )
      .map((i) => i.id);
    expect([...ids].sort()).toEqual(expected.sort());
    expect(ids.length).toBeLessThan(data.issues.length);
    expect(
      issuesNeedingStateHistory(data, '2026-10-21', {
        ...DEFAULT_TUNING,
        stallDays: 1,
        warnLeadDays: 1,
      })
    ).not.toContain('iss-eng-31');
  });
});

describe('fullSync', () => {
  test('refines last state changes only where they matter', async () => {
    const requested: string[][] = [];
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchLastStateChanges: (ids) => {
        requested.push(ids);
        return Promise.resolve(
          new Map(ids.map((id) => [id, '2026-10-20T08:00:00.000Z']))
        );
      },
    });
    const s = await setup({ wrap });
    const result = await s.engine.fullSync(WORKSPACE_ID);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.counts['issues']).toBe(s.fixture.data.issues.length);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual(
      issuesNeedingStateHistory(s.fixture.data, s.clock.today(), DEFAULT_TUNING)
    );
    expect(result.counts['historyLookups']).toBe(requested[0]?.length);

    const snapshot = (await s.engine.load(WORKSPACE_ID)).snapshot;
    expect(snapshot.issues.get('iss-eng-12')?.lastStateChangeAt).toBe(
      '2026-10-20T08:00:00.000Z'
    );
    // Not looked up: keeps the gateway's timestamp.
    expect(snapshot.issues.get('iss-eng-17')?.lastStateChangeAt).toBe(
      s.fixture.data.issues.find((i) => i.id === 'iss-eng-17')
        ?.lastStateChangeAt
    );
    expect(result.version).toBe(
      (await s.engine.load(WORKSPACE_ID)).mirrorVersion
    );
  });

  test('a failed history lookup keeps approximations and the sync succeeds', async () => {
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchLastStateChanges: () =>
        Promise.reject(new LinearApiError('rate_limited', 'slow down')),
    });
    const s = await setup({ wrap });
    const result = await s.engine.fullSync(WORKSPACE_ID);
    expect(result.ok).toBe(true);
    expect(result.counts['historyRefined']).toBe(0);
    expect(s.logs.some((l) => l.includes('could not read issue history'))).toBe(
      true
    );
  });

  test('bootstraps the watchers from WATCHER_EMAILS', async () => {
    const s = await setup({
      config: {
        bootstrapWatcherEmails: [
          'GRACE@northwind.example',
          'app@northwind.example',
          'ghost@x.example',
          'grace@northwind.example',
        ],
      },
    });
    const app = s.fixture.data.users.find((u) => u.id === FIXTURE_APP_USER_ID);
    if (app !== undefined) app.email = 'app@northwind.example';
    await s.engine.fullSync(WORKSPACE_ID);
    const settings = await s.store.getSettings(WORKSPACE_ID);
    // The app user is never a watcher; the installer is not added when
    // the emails named someone.
    expect(settings?.watcherUserIds).toEqual(['user-grace']);
    expect(settings).not.toHaveProperty('pmUserIds');
    expect(settings?.timezone).toBe('UTC');
    expect(settings?.allocationMode).toBe('dry_run');
    expect(s.logs.some((l) => l.includes('ghost@x.example'))).toBe(true);

    // Later syncs never touch configured settings, an emptied watcher
    // list included (there is no "last PM" rule to refill it).
    await s.store.saveSettings({
      ...(settings ?? defaultSettings(WORKSPACE_ID, 'UTC')),
      watcherUserIds: [],
    });
    await s.engine.fullSync(WORKSPACE_ID);
    expect((await s.store.getSettings(WORKSPACE_ID))?.watcherUserIds).toEqual(
      []
    );
  });

  test('with no WATCHER_EMAILS match, the installer is the first watcher', async () => {
    for (const emails of [[], ['ghost@x.example']]) {
      const s = await setup({ config: { bootstrapWatcherEmails: emails } });
      await s.engine.fullSync(WORKSPACE_ID);
      expect((await s.store.getSettings(WORKSPACE_ID))?.watcherUserIds).toEqual(
        ['user-chloe']
      );
      await open?.close();
      open = null;
    }
  });

  test('the first sync completes settings an older install saved', async () => {
    const s = await setup({
      config: { bootstrapWatcherEmails: ['dev@northwind.example'] },
    });
    // Before the owner decision of 2026-10-22, finishInstall saved the
    // installer as the only PM and no watchers (the store drops the
    // retired key; store.test.ts reads a raw old row).
    await s.store.saveSettings({
      ...defaultSettings(WORKSPACE_ID, 'UTC'),
      pmUserIds: ['user-chloe'],
    } as ReturnType<typeof defaultSettings>);
    await s.engine.fullSync(WORKSPACE_ID);
    const settings = await s.store.getSettings(WORKSPACE_ID);
    expect(settings?.watcherUserIds).toEqual(['user-dev']);
    expect(settings).not.toHaveProperty('pmUserIds');
  });

  test('records a failure, rethrows it, and keeps the old mirror', async () => {
    let broken = false;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () =>
        broken
          ? Promise.reject(new LinearApiError('unauthorized', 'token revoked'))
          : gateway.fetchWorkspace(),
    });
    const s = await setup({ wrap });
    const ok = await s.engine.fullSync(WORKSPACE_ID);
    broken = true;
    expect(await rejectionMessage(s.engine.fullSync(WORKSPACE_ID))).toContain(
      'token revoked'
    );
    const loaded = await s.engine.load(WORKSPACE_ID);
    expect(loaded.mirrorVersion).toBe(ok.version);
    expect(loaded.syncState).toMatchObject({
      lastFullSyncStatus: 'failed',
      lastFullSyncError: 'token revoked',
    });
  });

  test('load() runs the first sync itself; a foreign workspace id is refused', async () => {
    let foreign = false;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: async () => {
        const data = await gateway.fetchWorkspace();
        return foreign ? { ...data, workspaceId: 'org-somewhere-else' } : data;
      },
    });
    const s = await setup({ wrap });
    const loaded = await s.engine.load(WORKSPACE_ID);
    expect(loaded.snapshot.issues.size).toBe(s.fixture.data.issues.length);
    expect(loaded.syncState?.lastFullSyncStatus).toBe('ok');

    foreign = true;
    expect(await rejectionMessage(s.engine.fullSync(WORKSPACE_ID))).toContain(
      'returned workspace org-somewhere-else'
    );
    expect((await s.engine.load(WORKSPACE_ID)).mirrorVersion).toBe(
      loaded.mirrorVersion
    );
  });
});
