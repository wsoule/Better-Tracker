// load(): the indexed workspace plus everything derived from it (§7). The
// snapshot comes from the version-keyed cache; settings and milestone meta
// are small and read fresh on every call so edits show up immediately.

import {
  assessWorkspace,
  type EvalContext,
  type IsoDate,
  isValidTimeZone,
  planAllocation,
  type Snapshot,
  todayIn,
} from '@better-tracker/core';

import {
  type EngineRuntime,
  readSettings,
  requireInstallation,
} from './runtime';
import { fullSync } from './sync';
import type { Actor, LoadedWorkspace } from './types';
import { viewerSnapshot } from './visibility';

/** LoadedWorkspace plus the evaluation context the core builders need. */
export interface LoadedContext extends LoadedWorkspace {
  ctx: EvalContext;
  /**
   * The whole mirror, whoever the load was for (`snapshot` is narrowed
   * when a viewer was given): for log filters that must tell "hidden" from
   * "no longer mirrored".
   */
  fullSnapshot: Snapshot;
}

/**
 * True when the mirror was written before team visibility was mirrored
 * (§2.13): some team lacks `visibility`. Such a mirror shows its teams to
 * nobody, so load() syncs it first.
 */
function predatesVisibility(snapshot: Snapshot): boolean {
  return snapshot.data.teams.some((team) => team.visibility === undefined);
}

/**
 * Loads a workspace for reading. Not installed (or revoked) →
 * EngineAuthError('not_installed'); installed but never mirrored → a full
 * sync first (and a mirror written before team visibility was mirrored is
 * synced first too; if that sync fails it is read as it is, which shows
 * people nothing rather than too much). `today` defaults to the date in
 * the workspace timezone; runWarnings passes an explicit day.
 *
 * With `viewer`, everything is built from the mirror narrowed to what that
 * person may see (§2.13, the one place views apply visibility): the
 * snapshot, and the assessments and allocation plan computed over it.
 * Without it the whole mirror is used: the worker's own jobs.
 */
export async function loadWorkspace(
  rt: EngineRuntime,
  workspaceId: string,
  options: { today?: IsoDate; viewer?: Actor } = {}
): Promise<LoadedContext> {
  await requireInstallation(rt, workspaceId);
  let view = await rt.mirror.current(workspaceId);
  if (view === null) {
    await fullSync(rt, workspaceId);
    view = await rt.mirror.current(workspaceId);
    if (view === null) {
      throw new Error(
        `No mirror for workspace ${workspaceId} after a full sync`
      );
    }
  } else if (predatesVisibility(view.snapshot)) {
    try {
      await fullSync(rt, workspaceId);
      view = (await rt.mirror.current(workspaceId)) ?? view;
    } catch (error) {
      rt.logger.warn(
        'could not resync a mirror written before team visibility; reading it as it is',
        { workspaceId, error }
      );
    }
  }
  const snapshot =
    options.viewer === undefined
      ? view.snapshot
      : viewerSnapshot(view.snapshot, workspaceId, options.viewer).snapshot;

  const [{ settings }, metaRows] = await Promise.all([
    readSettings(rt, workspaceId),
    rt.store.listMilestoneMeta(workspaceId),
  ]);
  let timezone = settings.timezone;
  if (!isValidTimeZone(timezone)) {
    rt.logger.warn('saved timezone is invalid; using the default', {
      workspaceId,
      timezone,
    });
    timezone = rt.config.defaultTimezone;
  }
  const now = rt.clock();
  const today = options.today ?? todayIn(timezone, now);
  const ctx: EvalContext = {
    today,
    now: now.toISOString(),
    tuning: settings.tuning,
    meta: new Map(metaRows.map((meta) => [meta.milestoneId, meta])),
  };
  const assessments = assessWorkspace(snapshot, ctx);
  const allocationPlan = planAllocation(snapshot, ctx, assessments);
  return {
    workspaceId,
    snapshot,
    fullSnapshot: view.snapshot,
    settings,
    today,
    assessments,
    allocationPlan,
    syncState: view.syncState,
    mirrorVersion: view.version,
    ctx,
  };
}
