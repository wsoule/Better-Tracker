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
import { bootstrapPeople } from './settings';
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
// are saved; on the very first sync after an install (which saved only the
// installer as PM) the bootstrap email lists are merged in. Returns null
// when nothing needs saving.
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
  const people = bootstrapPeople({
    data: input.data,
    installerId: input.installerId,
    pmEmails: rt.config.bootstrapPmEmails,
    watcherEmails: rt.config.bootstrapWatcherEmails,
    existing: input.stored
      ? { pmUserIds: current.pmUserIds, watcherUserIds: current.watcherUserIds }
      : null,
    log: input.log,
  });
  const next: WorkspaceSettings = { ...base, ...people };
  const changed =
    !input.stored ||
    people.pmUserIds.join(',') !== current.pmUserIds.join(',') ||
    people.watcherUserIds.join(',') !== current.watcherUserIds.join(',');
  return changed ? next : null;
}

/**
 * Full resync of one workspace. On success the mirror is replaced and the
 * sync recorded as ok; on failure the failure is recorded on sync_state and
 * the error rethrown (the mirror is left as it was).
 */
export async function fullSync(
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
        pms: bootstrap.pmUserIds.length,
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
