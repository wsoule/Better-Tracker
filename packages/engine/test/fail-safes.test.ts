// The fail-safes for settings one deployment shares across workspaces
// (owner decision 2026-10-25): one Slack bot never carries digests while
// the planner may serve more than one workspace, and WATCHER_EMAILS seeds
// watchers only in a workspace LINEAR_WORKSPACES names (or the only one
// installed while it is unset). OAuth mode only.

import {
  createFixtureStore,
  FIXTURE_APP_USER_ID,
  type FixtureStore,
} from '@better-tracker/linear';
import type { Store } from '@better-tracker/store';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { seedDemoWorkspace } from '../src/boot';
import {
  createEngine,
  type Engine,
  SLACK_SHARED_OFF,
  type WorkspaceAdmission,
} from '../src/index';
import {
  createClock,
  fixtureProvider,
  openTestStore,
  recordingChannel,
  recordingLogger,
  TEST_CONFIG,
  WORKSPACE_ID,
} from './helpers';

// Each test opens one or more PGlite stores (1–2 s each); helpers.ts sets
// the same default, but only for the first file that imports it.
setDefaultTimeout(60_000);

let open: Store | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

interface Setup {
  engine: Engine;
  store: Store;
  fixture: FixtureStore;
  channel: ReturnType<typeof recordingChannel>;
  logs: string[];
}

/**
 * An OAuth-mode engine over the demo workspace (the fixture provider acting
 * like real Linear), with `workspaces` admission and WATCHER_EMAILS.
 */
async function oauthSetup(
  options: {
    workspaces?: WorkspaceAdmission;
    watcherEmails?: string[];
  } = {}
): Promise<Setup> {
  const clock = createClock();
  const store = await openTestStore(clock);
  open = store;
  const fixture = createFixtureStore(clock.today());
  fixture.now = clock.now;
  const channel = recordingChannel();
  const { logger, lines } = recordingLogger();
  const engine = createEngine({
    store,
    linear: fixtureProvider(fixture, { mode: 'linear' }),
    channel,
    logger,
    config: {
      ...TEST_CONFIG,
      auth: 'oauth',
      bootstrapWatcherEmails: options.watcherEmails ?? [],
      ...(options.workspaces === undefined
        ? {}
        : { workspaces: options.workspaces }),
    },
    now: clock.now,
  });
  return { engine, store, fixture, channel, logs: lines };
}

/** Installs a second workspace next to the demo one. */
async function installOther(store: Store): Promise<void> {
  const at = '2026-10-01T00:00:00.000Z';
  await store.saveInstallation({
    workspaceId: 'org-other',
    workspaceName: 'Other Co',
    urlKey: 'other',
    appUserId: 'u-other-app',
    installedByUserId: 'u-other',
    revokedAt: null,
    tokens: {
      accessToken: 'other-app-token',
      refreshToken: null,
      expiresAt: null,
      scopes: ['read', 'write'],
    },
    createdAt: at,
    updatedAt: at,
  });
}

describe('the Slack fail-safe in the warning run', () => {
  // The demo workspace's first live run has 5 recipients (warnings.test.ts).
  async function liveRun(
    workspaces: WorkspaceAdmission | undefined,
    secondInstall: boolean
  ): Promise<Setup & { delivered: number; failed: number }> {
    const s = await oauthSetup({ workspaces });
    await seedDemoWorkspace({
      engine: s.engine,
      store: s.store,
      defaultTimezone: 'UTC',
      now: () => new Date('2026-10-21T15:00:00.000Z'),
    });
    if (secondInstall) await installOther(s.store);
    await s.store.saveSettings({
      ...(await s.engine.getSettings(WORKSPACE_ID)),
      warningsMode: 'live',
    });
    const result = await s.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    return { ...s, delivered: result.delivered, failed: result.failed };
  }

  test('one admitted workspace keeps Slack', async () => {
    for (const workspaces of [
      undefined,
      { mode: 'list', entries: [WORKSPACE_ID] } as const,
    ]) {
      const run = await liveRun(workspaces, false);
      expect(run.delivered).toBe(5);
      expect(run.channel.sent).toHaveLength(5);
      expect(run.logs.some((l) => l.includes('Slack is off'))).toBe(false);
      await open?.close();
      open = null;
    }
  });

  test('more than one possible workspace keeps every digest in the outbox', async () => {
    const cases: {
      workspaces: WorkspaceAdmission | undefined;
      secondInstall: boolean;
      reason: string;
    }[] = [
      {
        workspaces: undefined,
        secondInstall: true,
        reason: '2 Linear workspaces are installed',
      },
      {
        workspaces: { mode: 'list', entries: [WORKSPACE_ID, 'other'] },
        secondInstall: false,
        reason: 'LINEAR_WORKSPACES names 2 workspaces',
      },
      {
        workspaces: { mode: 'any' },
        secondInstall: false,
        reason: 'LINEAR_WORKSPACES is *',
      },
    ];
    for (const c of cases) {
      const run = await liveRun(c.workspaces, c.secondInstall);
      expect(run.delivered).toBe(0);
      expect(run.failed).toBe(5);
      expect(run.channel.sent).toEqual([]);
      const records = await run.engine.listNotifications(WORKSPACE_ID, 50);
      expect(records).toHaveLength(5);
      for (const record of records) {
        expect(record).toMatchObject({
          status: 'undeliverable',
          channel: 'outbox',
          error: SLACK_SHARED_OFF,
        });
      }
      const warning = run.logs.find((l) => l.includes('Slack is off'));
      expect(warning).toContain('"level":"warn"');
      expect(warning).toContain(c.reason);
      await open?.close();
      open = null;
    }
  });
});

describe('WATCHER_EMAILS', () => {
  // grace is a member, gus the demo workspace's Linear guest, ghost nobody.
  const EMAILS = [
    'grace@northwind.example',
    'gus@northwind.example',
    'ghost@x.example',
  ];

  async function firstSync(
    workspaces: WorkspaceAdmission | undefined,
    options: { secondInstall?: boolean } = {}
  ): Promise<{ watchers: string[] | undefined; logs: string[] }> {
    const s = await oauthSetup({ workspaces, watcherEmails: EMAILS });
    await s.store.saveInstallation({
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
        scopes: ['read', 'write'],
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    if (options.secondInstall === true) await installOther(s.store);
    await s.engine.fullSync(WORKSPACE_ID);
    const watchers = (await s.store.getSettings(WORKSPACE_ID))?.watcherUserIds;
    const logs = [...s.logs];
    await open?.close();
    open = null;
    return { watchers, logs };
  }

  test('seeds a workspace LINEAR_WORKSPACES names, by id or URL key, with active members only', async () => {
    for (const entries of [[WORKSPACE_ID], ['northwind']]) {
      const { watchers, logs } = await firstSync({ mode: 'list', entries });
      // The guest's address and the unknown one match nobody.
      expect(watchers).toEqual(['user-grace']);
      const unmatched = logs.find((l) =>
        l.includes('bootstrap emails match no active Linear member')
      );
      expect(unmatched).toContain('"unmatched":2');
      // Addresses are never logged.
      for (const email of EMAILS) {
        expect(logs.join('\n')).not.toContain(email);
      }
    }
  });

  test('while LINEAR_WORKSPACES is unset, only the one installed workspace is seeded', async () => {
    expect((await firstSync(undefined)).watchers).toEqual(['user-grace']);
    const two = await firstSync(undefined, { secondInstall: true });
    // The installer is the first watcher instead.
    expect(two.watchers).toEqual(['user-chloe']);
    expect(
      two.logs.some(
        (l) =>
          l.includes('WATCHER_EMAILS is not applied') &&
          l.includes('more than one workspace is installed')
      )
    ).toBe(true);
  });

  test('a workspace the list does not name, or any workspace under *, is not seeded', async () => {
    for (const workspaces of [
      { mode: 'list', entries: ['org-elsewhere', 'elsewhere'] } as const,
      { mode: 'any' } as const,
    ]) {
      const { watchers, logs } = await firstSync(workspaces);
      expect(watchers).toEqual(['user-chloe']);
      expect(
        logs.some((l) => l.includes('WATCHER_EMAILS is not applied'))
      ).toBe(true);
    }
  });
});
