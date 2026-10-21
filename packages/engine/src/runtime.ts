// Shared internals of one engine instance: its dependencies, the clock, and
// the per-workspace cache of indexed mirror snapshots. Every engine module
// receives this object instead of the raw deps so they share one cache.

import {
  defaultSettings,
  indexWorkspace,
  type IsoDateTime,
  type Snapshot,
  type WorkspaceSettings,
} from '@better-tracker/core';
import type { FetchLike } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { Installation, Store, SyncState } from '@better-tracker/store';

import {
  EngineAuthError,
  type EngineConfig,
  type EngineDeps,
  type LinearProvider,
} from './types';

/** An indexed mirror and the store version it was built from. */
export interface MirrorSnapshot {
  version: number;
  snapshot: Snapshot;
}

/** A cached snapshot plus the sync state read to validate it. */
export interface MirrorView extends MirrorSnapshot {
  syncState: SyncState;
}

export interface MirrorCache {
  /**
   * The workspace's indexed mirror, re-indexed only when the store's mirror
   * version moved. Null when nothing has been mirrored yet.
   */
  current(workspaceId: string): Promise<MirrorView | null>;
  /** Drops the cached snapshot (e.g. after the installation is revoked). */
  forget(workspaceId: string): void;
}

export interface EngineRuntime {
  deps: EngineDeps;
  store: Store;
  linear: LinearProvider;
  config: EngineConfig;
  logger: Logger;
  /** The current instant (deps.now or the system clock). */
  clock: () => Date;
  nowIso: () => IsoDateTime;
  fetch: FetchLike | undefined;
  mirror: MirrorCache;
  /**
   * Runs fn after every earlier call with the same key has settled, so
   * read-modify-write sequences on one record (a milestone's meta row) do
   * not overwrite each other within this process.
   */
  serialize<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * A per-key queue: each call waits for the previous call with that key to
 * settle (resolve or reject) before running. Keys are dropped once their
 * queue drains so the map does not grow with every milestone ever edited.
 */
export function createKeyedSerializer(): EngineRuntime['serialize'] {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/**
 * The snapshot cache behind load(). It keeps one indexed snapshot per
 * workspace keyed by the store's mirror version, so repeated page loads
 * re-index only after a sync or webhook changed the mirror. Concurrent
 * misses for the same version share one loadMirror + indexWorkspace.
 */
export function createMirrorCache(store: Store): MirrorCache {
  const entries = new Map<string, MirrorSnapshot>();
  const pending = new Map<string, Promise<MirrorSnapshot | null>>();

  async function loadAndIndex(
    workspaceId: string
  ): Promise<MirrorSnapshot | null> {
    const mirror = await store.loadMirror(workspaceId);
    if (mirror === null) return null;
    const entry: MirrorSnapshot = {
      version: mirror.version,
      snapshot: indexWorkspace(mirror.data),
    };
    const existing = entries.get(workspaceId);
    if (existing === undefined || existing.version <= entry.version) {
      entries.set(workspaceId, entry);
    }
    return entry;
  }

  return {
    async current(workspaceId: string): Promise<MirrorView | null> {
      const syncState = await store.getSyncState(workspaceId);
      if (syncState === null || syncState.version === 0) return null;
      const cached = entries.get(workspaceId);
      if (cached !== undefined && cached.version === syncState.version) {
        return { ...cached, syncState };
      }
      const key = `${workspaceId}\u0000${syncState.version}`;
      let promise = pending.get(key);
      if (promise === undefined) {
        promise = loadAndIndex(workspaceId).finally(() => {
          pending.delete(key);
        });
        pending.set(key, promise);
      }
      const fresh = await promise;
      return fresh === null ? null : { ...fresh, syncState };
    },
    forget(workspaceId: string): void {
      entries.delete(workspaceId);
    },
  };
}

/** Builds the runtime for createEngine. */
export function createRuntime(deps: EngineDeps): EngineRuntime {
  const clock = deps.now ?? ((): Date => new Date());
  return {
    deps,
    store: deps.store,
    linear: deps.linear,
    config: deps.config,
    logger: deps.logger,
    clock,
    nowIso: (): IsoDateTime => clock().toISOString(),
    fetch: deps.fetch,
    mirror: createMirrorCache(deps.store),
    serialize: createKeyedSerializer(),
  };
}

/**
 * The workspace's saved settings layered over the defaults, so settings
 * saved by an older version (missing a newer field) still read completely.
 * Unconfigured workspaces get the defaults with config.defaultTimezone.
 */
export async function readSettings(
  rt: EngineRuntime,
  workspaceId: string
): Promise<{ settings: WorkspaceSettings; stored: boolean }> {
  const defaults = defaultSettings(workspaceId, rt.config.defaultTimezone);
  const saved = await rt.store.getSettings(workspaceId);
  if (saved === null) return { settings: defaults, stored: false };
  return {
    settings: {
      ...defaults,
      ...saved,
      workspaceId,
      tuning: { ...defaults.tuning, ...saved.tuning },
    },
    stored: true,
  };
}

/** The workspace's active installation, or EngineAuthError('not_installed'). */
export async function requireInstallation(
  rt: EngineRuntime,
  workspaceId: string
): Promise<Installation> {
  const installation = await rt.store.getInstallation(workspaceId);
  if (installation === null) {
    throw new EngineAuthError(
      'not_installed',
      `${rt.config.appName} is not installed in this Linear workspace yet.`
    );
  }
  // revokedAt: uninstalled in Linear, or its grant stopped refreshing.
  if (installation.revokedAt !== null) {
    throw new EngineAuthError(
      'not_installed',
      `${rt.config.appName} lost its access to this Linear workspace (uninstalled, or its authorization stopped working); an admin must install it again.`
    );
  }
  return installation;
}

/** A readable message for any thrown value (never includes a stack). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
