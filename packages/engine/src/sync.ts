// fullSync (§7): mirror the whole Linear workspace through the app actor,
// refine "last state change" from issue history where it matters, bootstrap
// settings on first configuration, and replace the mirror in one write.

import {
  defaultSettings,
  diffDays,
  type IsoDate,
  isOpenState,
  isValidIsoDate,
  isValidTimeZone,
  todayIn,
  type Tuning,
  type WorkflowStateType,
  type WorkspaceData,
  type WorkspaceSettings,
} from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';

import { type EngineRuntime, errorMessage, readSettings } from './runtime';
import { bootstrapWatchers } from './settings';
import type { SyncResult } from './types';

/**
 * Open issues whose "stalled" check can matter soon: those in milestones
 * dated within warnLeadDays + stallDays from today, or already past. Only
 * these get an issue-history lookup; everything else keeps the gateway's
 * timestamp approximation, which keeps the sync's request count bounded.
 */
export function issuesNeedingStateHistory(
  data: WorkspaceData,
  today: IsoDate,
  tuning: Tuning
): string[] {
  const horizon = tuning.warnLeadDays + tuning.stallDays;
  const soon = new Set<string>();
  for (const milestone of data.milestones) {
    const date = milestone.targetDate;
    if (date === null || !isValidIsoDate(date)) continue;
    if (diffDays(date, today) <= horizon) soon.add(milestone.id);
  }
  if (soon.size === 0) return [];
  const stateType = new Map<string, WorkflowStateType>(
    data.states.map((state) => [state.id, state.type])
  );
  const ids: string[] = [];
  for (const issue of data.issues) {
    if (issue.milestoneId === null || !soon.has(issue.milestoneId)) continue;
    // Unknown states count as open, like core's issueStateType fallback.
    if (isOpenState(stateType.get(issue.stateId) ?? 'backlog')) {
      ids.push(issue.id);
    }
  }
  return ids;
}

// Replaces approximated lastStateChangeAt values with history-derived ones.
// A failed history lookup keeps the approximations (logged), since they are
// the documented fallback and the next sync tries again.
async function refineLastStateChanges(
  gateway: LinearGateway,
  data: WorkspaceData,
  ids: string[],
  log: Logger
): Promise<number> {
  if (ids.length === 0) return 0;
  let changes: Map<string, string>;
  try {
    changes = await gateway.fetchLastStateChanges(ids);
  } catch (error) {
    log.warn('could not read issue history; keeping approximate state times', {
      error,
      issues: ids.length,
    });
    return 0;
  }
  let refined = 0;
  for (const issue of data.issues) {
    const at = changes.get(issue.id);
    if (at !== undefined && at !== issue.lastStateChangeAt) {
      issue.lastStateChangeAt = at;
      refined += 1;
    }
  }
  return refined;
}

// Settings for a workspace being configured: brand-new settings when none
// are saved, with the watchers bootstrapped from WATCHER_EMAILS (else the
// installer); on the very first sync over settings saved earlier (an
// install made before the owner decision of 2026-10-22 saved the installer
// as PM) an empty watcher list is filled the same way. Returns null when
// nothing needs saving.
function bootstrapSettings(input: {
  rt: EngineRuntime;
  workspaceId: string;
  data: WorkspaceData;
  current: WorkspaceSettings;
  stored: boolean;
  firstSync: boolean;
  installerId: string | null;
  log: Logger;
}): WorkspaceSettings | null {
  const { rt, current } = input;
  if (input.stored && !input.firstSync) return null;
  const base: WorkspaceSettings = input.stored
    ? current
    : defaultSettings(input.workspaceId, rt.config.defaultTimezone);
  const watcherUserIds = bootstrapWatchers({
    data: input.data,
    installerId: input.installerId,
    watcherEmails: rt.config.bootstrapWatcherEmails,
    existing: input.stored ? current.watcherUserIds : null,
    log: input.log,
  });
  const changed =
    !input.stored ||
    watcherUserIds.join(',') !== current.watcherUserIds.join(',');
  return changed ? { ...base, watcherUserIds } : null;
}

/**
 * How long a caller waits for the full sync already running for its
 * workspace, counted from that sync's start on the engine clock. One
 * GraphQL attempt may take up to its 30 s timeout and a request makes up
 * to four attempts, so a sync still running after two minutes is treated
 * as stuck: later callers then run their own instead of waiting on it.
 */
export const SYNC_JOIN_WAIT_MS = 120_000;

/** What raceJoin resolves with when the running sync took too long. */
const GAVE_UP = Symbol('gave up waiting');

// The running sync's outcome, or GAVE_UP once `waitMs` of real time pass.
async function raceJoin(
  running: Promise<SyncResult>,
  waitMs: number
): Promise<SyncResult | typeof GAVE_UP> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof GAVE_UP>((resolve) => {
    timer = setTimeout(() => resolve(GAVE_UP), waitMs);
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full resync of one workspace, single-flight per workspace within this
 * process: a caller that finds a sync running for its workspace shares
 * that sync's result (or its error) instead of paging all of Linear again
 * with the app's token, whose hourly quota allocation and webhooks share.
 * The wait is bounded (SYNC_JOIN_WAIT_MS from the running sync's start),
 * so a hung sync never holds later callers: past it they run their own,
 * which then becomes the one others join. See runFullSync for what a sync
 * does.
 */
export async function fullSync(
  rt: EngineRuntime,
  workspaceId: string
): Promise<SyncResult> {
  const running = rt.syncs.get(workspaceId);
  if (running !== undefined) {
    const waitMs =
      running.startedAtMs + SYNC_JOIN_WAIT_MS - rt.clock().getTime();
    if (waitMs > 0) {
      const joined = await raceJoin(running.result, waitMs);
      if (joined !== GAVE_UP) return joined;
    }
    rt.logger.warn('a full sync is still running; starting another', {
      workspaceId,
      runningSince: new Date(running.startedAtMs).toISOString(),
    });
  }
  const own = runFullSync(rt, workspaceId);
  const entry = { startedAtMs: rt.clock().getTime(), result: own };
  rt.syncs.set(workspaceId, entry);
  const forget = (): void => {
    if (rt.syncs.get(workspaceId) === entry) rt.syncs.delete(workspaceId);
  };
  own.then(forget, forget);
  return own;
}

/**
 * One full resync. On success the mirror is replaced and the sync recorded
 * as ok; on failure the failure is recorded on sync_state and the error
 * rethrown (the mirror is left as it was).
 */
async function runFullSync(
  rt: EngineRuntime,
  workspaceId: string
): Promise<SyncResult> {
  const log = rt.logger.child({ workspaceId, op: 'fullSync' });
  const startedMs = performance.now();
  try {
    const gateway = await rt.linear.forApp(workspaceId);
    const data = await gateway.fetchWorkspace();
    if (data.workspaceId !== workspaceId) {
      throw new Error(
        `Linear returned workspace ${data.workspaceId} for ${workspaceId}`
      );
    }

    const [{ settings, stored }, syncState, installation] = await Promise.all([
      readSettings(rt, workspaceId),
      rt.store.getSyncState(workspaceId),
      rt.store.getInstallation(workspaceId),
    ]);
    const timezone = isValidTimeZone(settings.timezone)
      ? settings.timezone
      : rt.config.defaultTimezone;
    const today = todayIn(timezone, rt.clock());
    const historyIds = issuesNeedingStateHistory(data, today, settings.tuning);
    const refined = await refineLastStateChanges(
      gateway,
      data,
      historyIds,
      log
    );

    const bootstrap = bootstrapSettings({
      rt,
      workspaceId,
      data,
      current: settings,
      stored,
      firstSync: (syncState?.version ?? 0) === 0,
      installerId: installation?.installedByUserId ?? null,
      log,
    });
    if (bootstrap !== null) {
      await rt.store.saveSettings(bootstrap);
      log.info('bootstrapped workspace settings', {
        watchers: bootstrap.watcherUserIds.length,
      });
    }

    const at = rt.nowIso();
    const version = await rt.store.replaceMirror(data, at);
    await rt.store.recordFullSync(workspaceId, { at, ok: true, error: null });
    const counts: Record<string, number> = {
      users: data.users.length,
      teams: data.teams.length,
      states: data.states.length,
      initiatives: data.initiatives.length,
      projects: data.projects.length,
      milestones: data.milestones.length,
      issues: data.issues.length,
      relations: data.relations.length,
      historyLookups: historyIds.length,
      historyRefined: refined,
    };
    const durationMs = Math.round(performance.now() - startedMs);
    log.info('full sync finished', { version, durationMs, ...counts });
    return { workspaceId, ok: true, version, counts, durationMs, error: null };
  } catch (error) {
    const message = errorMessage(error);
    log.error('full sync failed', { error });
    try {
      await rt.store.recordFullSync(workspaceId, {
        at: rt.nowIso(),
        ok: false,
        error: message,
      });
    } catch (recordError) {
      log.error('could not record the failed full sync', {
        error: recordError,
      });
    }
    throw error;
  }
}
