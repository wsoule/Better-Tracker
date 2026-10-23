// Background sync in the planner process (LINEAR_AUTH=api_key, architecture
// §7 "API-key mode"). With personal API keys nothing is stored that could
// read Linear while nobody is connected, so the worker's cron is off and
// this scheduler keeps the mirror fresh instead: one unref'd timer, running
// only while the vault holds at least one entry. Each tick sweeps expired
// keys (so an idle key is forgotten within a minute of its limit even when
// nobody makes a request), and every `intervalMs` starts a full sync while
// a workspace member is connected (the sync reads with that member's key,
// key-provider.ts). A background sync never touches a key's lastUsed, so it
// cannot keep an idle key alive.

import type { Logger } from '@better-tracker/logger';

import type { KeyVault } from './key-vault';

/** How often the scheduler sweeps the vault (and checks whether a sync is due). */
export const KEY_SYNC_SWEEP_MS = 60_000;

/** The timer functions the scheduler uses (injectable for tests). */
export interface KeySyncTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface KeySyncScheduler {
  /** The vault's onSizeChange: starts the timer at 1+, stops it at 0. */
  onSizeChange(size: number): void;
  /** One tick, as the timer runs it (tests call it directly). */
  tick(): Promise<void>;
  /** Whether the timer is running. */
  running(): boolean;
  /** Stops the timer for good (engine.close()). */
  close(): void;
}

export interface KeySyncOptions {
  vault: KeyVault;
  /** SYNC_INTERVAL_MINUTES in ms: time between background syncs. */
  intervalMs: number;
  /** Default KEY_SYNC_SWEEP_MS. */
  sweepMs?: number;
  /** Epoch ms (the engine's clock). */
  now: () => number;
  /** Defaults to the global setInterval / clearInterval, unref'd. */
  timers?: KeySyncTimers;
  /** The workspace the planner serves (the binding), or null before one. */
  workspaceId: () => Promise<string | null>;
  /** A full sync of the workspace (single-flight in the engine). */
  runSync: (workspaceId: string) => Promise<unknown>;
  logger: Logger;
}

const defaultTimers: KeySyncTimers = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    // Never keeps the process alive on its own.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** Builds the scheduler (stopped until the vault's first entry). */
export function createKeySyncScheduler(
  options: KeySyncOptions
): KeySyncScheduler {
  const timers = options.timers ?? defaultTimers;
  const sweepMs = options.sweepMs ?? KEY_SYNC_SWEEP_MS;
  const log = options.logger.child({ op: 'key-sync' });
  let handle: unknown = null;
  let closed = false;
  let busy = false;
  // When the last background sync started; the timer's start counts as
  // one, since the first connect already synced (or decided not to).
  let lastStartMs = 0;

  function start(): void {
    if (closed || handle !== null) return;
    lastStartMs = options.now();
    handle = timers.setInterval(() => {
      void scheduler.tick();
    }, sweepMs);
  }

  function stop(): void {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  }

  const scheduler: KeySyncScheduler = {
    onSizeChange(size) {
      if (size > 0) start();
      else stop();
    },

    async tick() {
      if (busy) return;
      busy = true;
      try {
        const swept = options.vault.sweep();
        if (swept > 0) log.info('forgot expired Linear API keys', { swept });
        if (options.vault.count() === 0) {
          stop();
          return;
        }
        if (options.now() - lastStartMs < options.intervalMs) return;
        const workspaceId = await options.workspaceId();
        if (workspaceId === null) return;
        if (options.vault.readers(workspaceId).length === 0) return;
        lastStartMs = options.now();
        try {
          await options.runSync(workspaceId);
        } catch (error) {
          // fullSync records the failure on sync_state; the next tick or a
          // Resync tries again (with the next reader once this one is gone).
          log.warn('background sync failed', { workspaceId, error });
        }
      } catch (error) {
        log.warn('background sync tick failed', { error });
      } finally {
        busy = false;
      }
    },

    running() {
      return handle !== null;
    },

    close() {
      closed = true;
      stop();
    },
  };
  return scheduler;
}
