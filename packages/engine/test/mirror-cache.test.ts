// The in-process mirror cache (runtime.ts createMirrorCache): a snapshot is
// used only while the store's mirror version and last successful sync both
// equal the ones it was loaded under (a purge and reinstall start the
// versions again at 1), and at most MIRROR_CACHE_WORKSPACES workspaces are
// kept, least recently read dropped first.

import type { WorkspaceData } from '@better-tracker/core';
import type { Store } from '@better-tracker/store';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_MIRROR_CACHE_WORKSPACES,
  loadEngineConfigFromEnv,
  MAX_MIRROR_CACHE_WORKSPACES,
} from '../src/index';
import { createMirrorCache } from '../src/runtime';
import { person } from './fake-linear';
import {
  createClock,
  openTestStore,
  START,
  storeWith,
  type TestClock,
} from './helpers';

let clock: TestClock;
let store: Store;
let loads: string[];
let counted: Store;

beforeEach(async () => {
  clock = createClock(START);
  store = await openTestStore(clock);
  loads = [];
  // The store with every loadMirror (a re-index) recorded.
  counted = storeWith(store, {
    loadMirror: (workspaceId) => {
      loads.push(workspaceId);
      return store.loadMirror(workspaceId);
    },
  });
});
afterEach(async () => {
  await store.close();
});

// A mirror of `workspaceId` holding one person called `name`.
function mirrorOf(workspaceId: string, name: string): WorkspaceData {
  return {
    workspaceId,
    users: [person(`u-${name.toLowerCase()}`, name)],
    teams: [],
    states: [],
    initiatives: [],
    projects: [],
    milestones: [],
    issues: [],
    relations: [],
  };
}

// Writes the mirror `times` times as a successful full sync at the clock's
// now; returns the last version.
async function sync(
  workspaceId: string,
  name: string,
  times = 1
): Promise<number> {
  let version = 0;
  for (let i = 0; i < times; i += 1) {
    const at = clock.now().toISOString();
    version = await store.replaceMirror(mirrorOf(workspaceId, name), at);
    await store.recordFullSync(workspaceId, { at, ok: true, error: null });
  }
  return version;
}

// Installs, uninstalls and purges `workspaceId`, so its versions restart.
async function purge(workspaceId: string): Promise<void> {
  const at = clock.now().toISOString();
  await store.saveInstallation({
    workspaceId,
    workspaceName: 'Acme',
    urlKey: 'acme',
    appUserId: 'u-app',
    installedByUserId: 'u-pat',
    revokedAt: null,
    tokens: {
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    },
    createdAt: at,
    updatedAt: at,
  });
  expect(await store.revokeInstallation(workspaceId, 'uninstalled', at)).toBe(
    true
  );
  const result = await store.purgeWorkspace(workspaceId, {
    revokedBefore: '2999-01-01T00:00:00.000Z',
  });
  expect(result.purged).toBe(true);
}

async function nameIn(
  cache: ReturnType<typeof createMirrorCache>,
  workspaceId: string
): Promise<string | undefined> {
  return (await cache.current(workspaceId))?.snapshot.data.users[0]?.name;
}

describe('the mirror cache', () => {
  test('a lower version than the cached one replaces it (purge, then reinstall)', async () => {
    const cache = createMirrorCache(counted);
    expect(await sync('org-acme', 'Old', 5)).toBe(5);
    expect(await nameIn(cache, 'org-acme')).toBe('Old');
    expect(await nameIn(cache, 'org-acme')).toBe('Old');
    expect(loads).toEqual(['org-acme']);

    await purge('org-acme');
    expect(await cache.current('org-acme')).toBeNull();
    clock.set('2026-10-22T15:00:00.000Z');
    expect(await sync('org-acme', 'New')).toBe(1);
    expect(await nameIn(cache, 'org-acme')).toBe('New');
    // Cached at version 1 now, not re-indexed on every read.
    expect(await nameIn(cache, 'org-acme')).toBe('New');
    expect(loads).toEqual(['org-acme', 'org-acme']);
  });

  test('the purged snapshot is never served once the new versions reach its number', async () => {
    const cache = createMirrorCache(counted);
    expect(await sync('org-acme', 'Old', 3)).toBe(3);
    expect(await nameIn(cache, 'org-acme')).toBe('Old');

    // This process reads nothing between the purge and version 3 again.
    await purge('org-acme');
    clock.set('2026-10-22T15:00:00.000Z');
    expect(await sync('org-acme', 'New', 3)).toBe(3);
    expect(await nameIn(cache, 'org-acme')).toBe('New');
  });

  test('a webhook write (a new version, same sync) re-indexes once', async () => {
    const cache = createMirrorCache(counted);
    await sync('org-acme', 'Old');
    await cache.current('org-acme');
    await store.applyMirrorChanges('org-acme', {
      upsert: [{ kind: 'user', entity: person('u-old', 'Renamed') }],
      remove: [],
    });
    expect(await nameIn(cache, 'org-acme')).toBe('Renamed');
    expect(await nameIn(cache, 'org-acme')).toBe('Renamed');
    expect(loads).toHaveLength(2);
  });

  test('keeps at most `capacity` workspaces, dropping the least recently read', async () => {
    const cache = createMirrorCache(counted, { capacity: 2 });
    for (const [id, name] of [
      ['org-a', 'Ann'],
      ['org-b', 'Bob'],
      ['org-c', 'Cyd'],
    ] as const) {
      await sync(id, name);
    }
    await cache.current('org-a');
    await cache.current('org-b');
    await cache.current('org-a'); // a is now the most recently read
    expect(loads).toEqual(['org-a', 'org-b']);
    await cache.current('org-c'); // drops b
    await cache.current('org-a');
    await cache.current('org-c');
    expect(loads).toEqual(['org-a', 'org-b', 'org-c']);
    expect(await nameIn(cache, 'org-b')).toBe('Bob');
    expect(loads).toEqual(['org-a', 'org-b', 'org-c', 'org-b']);
    // b's reload dropped a (c was read after a).
    await cache.current('org-c');
    await cache.current('org-a');
    expect(loads).toEqual(['org-a', 'org-b', 'org-c', 'org-b', 'org-a']);
  });

  test('forget drops one workspace', async () => {
    const cache = createMirrorCache(counted);
    await sync('org-acme', 'Old');
    await cache.current('org-acme');
    cache.forget('org-acme');
    await cache.current('org-acme');
    expect(loads).toEqual(['org-acme', 'org-acme']);
  });
});

describe('MIRROR_CACHE_WORKSPACES', () => {
  test('defaults to 16 and accepts 1 to 64', () => {
    expect(DEFAULT_MIRROR_CACHE_WORKSPACES).toBe(16);
    expect(MAX_MIRROR_CACHE_WORKSPACES).toBe(64);
    const demo = { LINEAR_FIXTURE: '1' };
    expect(loadEngineConfigFromEnv(demo).mirrorCacheWorkspaces).toBe(16);
    for (const value of ['1', '64', ' 8 ']) {
      expect(
        loadEngineConfigFromEnv({ ...demo, MIRROR_CACHE_WORKSPACES: value })
          .mirrorCacheWorkspaces
      ).toBe(Number(value));
    }
    for (const value of ['0', '65', '2.5', 'many', '-3']) {
      expect(() =>
        loadEngineConfigFromEnv({ ...demo, MIRROR_CACHE_WORKSPACES: value })
      ).toThrow('MIRROR_CACHE_WORKSPACES must be a whole number from 1 to 64');
    }
  });
});
