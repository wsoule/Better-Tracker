// Shared internals of one engine instance: its dependencies, the clock, and
// the per-workspace cache of indexed mirror snapshots. Every engine module
// receives this object instead of the raw deps so they share one cache.

import {
  containsLinearCredential,
  defaultSettings,
  indexWorkspace,
  type IsoDateTime,
  redactLinearSecrets,
  type Snapshot,
  type WorkspaceSettings,
} from '@better-tracker/core';
import { type FetchLike, LinearApiError } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { Installation, Store, SyncState } from '@better-tracker/store';

import {
  DEFAULT_MIRROR_CACHE_WORKSPACES,
  MAX_MIRROR_CACHE_WORKSPACES,
} from './config';
import {
  type ApiKeyDeps,
  EngineAuthError,
  type EngineConfig,
  type EngineDeps,
  EngineInputError,
  type LinearProvider,
  type SyncResult,
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
   * version (or its last successful sync) changed. Null when nothing has
   * been mirrored yet.
   */
  current(workspaceId: string): Promise<MirrorView | null>;
  /** Drops the cached snapshot (e.g. after the installation is revoked). */
  forget(workspaceId: string): void;
}

/** A full sync running in this process (single-flight per workspace). */
export interface InFlightSync {
  /** rt.clock() when it started, in epoch ms. */
  startedAtMs: number;
  result: Promise<SyncResult>;
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
  /** The full sync each workspace has running, if any (see fullSync). */
  syncs: Map<string, InFlightSync>;
  /**
   * api_key mode: the in-memory key vault and its sync scheduler (null in
   * every other mode). Never handed out of the engine.
   */
  keys: ApiKeyDeps | null;
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

/** A cached snapshot plus the sync generation it was loaded under. */
interface CachedMirror extends MirrorSnapshot {
  /** syncState.lastSuccessAt when it was loaded (null: none recorded). */
  generation: IsoDateTime | null;
}

/**
 * The snapshot cache behind load(). It keeps one indexed snapshot per
 * workspace, used only while the store's mirror version AND its last
 * successful sync time both equal the ones it was loaded under, so
 * repeated page loads re-index only after a sync or webhook changed the
 * mirror. Any difference is stale, lower or higher: a purged workspace's
 * versions start again at 1 after a reinstall, and the sync time keeps an
 * old snapshot from matching once the new versions reach its number.
 * Concurrent misses for the same version share one loadMirror +
 * indexWorkspace. At most `capacity` workspaces are kept
 * (MIRROR_CACHE_WORKSPACES, clamped to 1–64): the least recently read is
 * dropped first, so one process serving many workspaces stays bounded.
 */
export function createMirrorCache(
  store: Store,
  options: { capacity?: number } = {}
): MirrorCache {
  const capacity = Math.min(
    MAX_MIRROR_CACHE_WORKSPACES,
    Math.max(1, Math.floor(options.capacity ?? DEFAULT_MIRROR_CACHE_WORKSPACES))
  );
  // Map order is recency: the first key is the least recently read.
  const entries = new Map<string, CachedMirror>();
  const pending = new Map<string, Promise<CachedMirror | null>>();

  function remember(workspaceId: string, entry: CachedMirror): void {
    entries.delete(workspaceId);
    entries.set(workspaceId, entry);
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  async function loadAndIndex(
    workspaceId: string,
    generation: IsoDateTime | null
  ): Promise<CachedMirror | null> {
    const mirror = await store.loadMirror(workspaceId);
    if (mirror === null) return null;
    const entry: CachedMirror = {
      version: mirror.version,
      snapshot: indexWorkspace(mirror.data),
      generation,
    };
    // Last load wins: a slower load of an older version may land after a
    // newer one, and the next read then sees the mismatch and reloads.
    remember(workspaceId, entry);
    return entry;
  }

  return {
    async current(workspaceId: string): Promise<MirrorView | null> {
      const syncState = await store.getSyncState(workspaceId);
      if (syncState === null || syncState.version === 0) return null;
      const generation = syncState.lastSuccessAt ?? null;
      const cached = entries.get(workspaceId);
      if (
        cached !== undefined &&
        cached.version === syncState.version &&
        cached.generation === generation
      ) {
        remember(workspaceId, cached);
        return {
          version: cached.version,
          snapshot: cached.snapshot,
          syncState,
        };
      }
      const key = `${workspaceId}\u0000${syncState.version}\u0000${generation ?? ''}`;
      let promise = pending.get(key);
      if (promise === undefined) {
        promise = loadAndIndex(workspaceId, generation).finally(() => {
          pending.delete(key);
        });
        pending.set(key, promise);
      }
      const fresh = await promise;
      return fresh === null
        ? null
        : { version: fresh.version, snapshot: fresh.snapshot, syncState };
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
    mirror: createMirrorCache(deps.store, {
      capacity: deps.config.mirrorCacheWorkspaces,
    }),
    serialize: createKeyedSerializer(),
    syncs: new Map(),
    keys: deps.keys ?? null,
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

/**
 * The two not_installed messages, shared by every path that finds them
 * (requireInstallation for allocation, edits and settings; the real Linear
 * provider for sync and webhooks), so a person sees the same words
 * whichever action ran into it. `lostAccess` covers a revoked
 * installation and a grant Linear rejects, which both need a reinstall.
 */
export const NOT_INSTALLED_MESSAGE: {
  missing(appName: string): string;
  lostAccess(appName: string): string;
  unbound(appName: string): string;
} = {
  missing: (appName) =>
    `${appName} is not installed in this Linear workspace yet.`,
  lostAccess: (appName) =>
    `${appName} lost its access to this Linear workspace (uninstalled, or its authorization stopped working); an admin must install it again.`,
  // api_key mode: nothing to install; the first member's key binds it.
  unbound: (appName) =>
    `${appName} serves no Linear workspace yet: a workspace member connects their API key first.`,
};

/** The workspace's active installation, or EngineAuthError('not_installed'). */
export async function requireInstallation(
  rt: EngineRuntime,
  workspaceId: string
): Promise<Installation> {
  const installation = await rt.store.getInstallation(workspaceId);
  if (installation === null) {
    throw new EngineAuthError(
      'not_installed',
      rt.config.auth === 'api_key'
        ? NOT_INSTALLED_MESSAGE.unbound(rt.config.appName)
        : NOT_INSTALLED_MESSAGE.missing(rt.config.appName)
    );
  }
  // revokedAt: uninstalled in Linear, or its grant stopped refreshing.
  if (installation.revokedAt !== null) {
    throw new EngineAuthError(
      'not_installed',
      NOT_INSTALLED_MESSAGE.lostAccess(rt.config.appName)
    );
  }
  return installation;
}

/**
 * `error`, or a copy of it without credential-shaped text when its message
 * or stack holds any (a Linear credential echoed by a failure). A full
 * sync's error is shared with every caller that joined it (another
 * person's Resync), so it must never carry the reader's key. The copy
 * keeps the engine's and Linear's error classes, codes and kinds.
 */
export function withoutCredentials(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (
    !containsLinearCredential(error.message) &&
    !containsLinearCredential(error.stack ?? '')
  ) {
    return error;
  }
  const message = redactLinearSecrets(error.message);
  let copy: Error;
  if (error instanceof EngineAuthError) {
    copy = new EngineAuthError(error.code, message);
  } else if (error instanceof EngineInputError) {
    copy = new EngineInputError(error.code, message, {
      retryAt: error.retryAt,
    });
  } else if (error instanceof LinearApiError) {
    copy = new LinearApiError(error.kind, message, { retryAt: error.retryAt });
  } else {
    copy = new Error(message);
    copy.name = redactLinearSecrets(error.name);
  }
  copy.stack = redactLinearSecrets(error.stack ?? `${copy.name}: ${message}`);
  return copy;
}

/** A readable message for any thrown value (never includes a stack). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
