import {
  createFixtureStore,
  FIXTURE_WORKSPACE,
  type LinearGateway,
} from '@better-tracker/linear';
import type { Store } from '@better-tracker/store';
import { afterEach, describe, expect, test } from 'bun:test';
// getSettings reads a workspace's settings without syncing: the worker
// reads the timezone on every tick, before deciding whether to sync.

import { createEngine } from '../src/engine';
import {
  createClock,
  createDemoHarness,
  type DemoHarness,
  fixtureProvider,
  type GatewayWrapper,
  openTestStore,
  recordingChannel,
  recordingLogger,
  TEST_CONFIG,
  WORKSPACE_ID,
} from './helpers';

let harness: DemoHarness | null = null;
let bare: Store | null = null;
afterEach(async () => {
  await harness?.close();
  await bare?.close();
  harness = null;
  bare = null;
});

describe('getSettings', () => {
  test('returns the saved settings without touching Linear', async () => {
    let fetches = 0;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () => {
        fetches += 1;
        return gateway.fetchWorkspace();
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    const saved = (await h.engine.load(WORKSPACE_ID)).settings;
    await h.store.saveSettings({ ...saved, timezone: 'Europe/Berlin' });
    fetches = 0;
    expect(await h.engine.getSettings(WORKSPACE_ID)).toEqual({
      ...saved,
      timezone: 'Europe/Berlin',
    });
    expect(fetches).toBe(0);
  });

  test('a never-mirrored workspace gets the defaults, and is not synced', async () => {
    const clock = createClock();
    bare = await openTestStore(clock);
    await bare.saveInstallation({
      workspaceId: WORKSPACE_ID,
      workspaceName: FIXTURE_WORKSPACE.name,
      urlKey: FIXTURE_WORKSPACE.urlKey,
      appUserId: 'app',
      installedByUserId: 'user-ana',
      revokedAt: null,
      tokens: {
        accessToken: 'x',
        refreshToken: null,
        expiresAt: null,
        scopes: ['read', 'write'],
      },
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
    });
    let fetches = 0;
    const engine = createEngine({
      store: bare,
      linear: fixtureProvider(createFixtureStore(clock.today()), {
        wrap: (gateway): LinearGateway => ({
          ...gateway,
          fetchWorkspace: () => {
            fetches += 1;
            return gateway.fetchWorkspace();
          },
        }),
      }),
      channel: recordingChannel(),
      logger: recordingLogger().logger,
      config: { ...TEST_CONFIG, defaultTimezone: 'America/Chicago' },
      now: clock.now,
    });
    const settings = await engine.getSettings(WORKSPACE_ID);
    expect(settings.workspaceId).toBe(WORKSPACE_ID);
    expect(settings.timezone).toBe('America/Chicago');
    expect(settings.pmUserIds).toEqual([]);
    expect(fetches).toBe(0);
    expect(await bare.getSyncState(WORKSPACE_ID)).toBeNull();
  });
});
