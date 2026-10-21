// load(): the indexed workspace plus everything derived from it (§7). The
// snapshot comes from the version-keyed cache; settings and milestone meta
// are small and read fresh on every call so edits show up immediately.

import {
  assessWorkspace,
  type EvalContext,
  type IsoDate,
  isValidTimeZone,
  planAllocation,
  todayIn,
} from '@better-tracker/core';

import {
  type EngineRuntime,
  readSettings,
  requireInstallation,
} from './runtime';
import { fullSync } from './sync';
import type { LoadedWorkspace } from './types';

/** LoadedWorkspace plus the evaluation context the core builders need. */
export interface LoadedContext extends LoadedWorkspace {
  ctx: EvalContext;
}

/**
 * Loads a workspace for reading. Not installed (or revoked) →
 * EngineAuthError('not_installed'); installed but never mirrored → a full
 * sync first. `today` defaults to the date in the workspace timezone;
 * runWarnings passes an explicit day.
 */
export async function loadWorkspace(
  rt: EngineRuntime,
  workspaceId: string,
  options: { today?: IsoDate } = {}
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
  }

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
  const assessments = assessWorkspace(view.snapshot, ctx);
  const allocationPlan = planAllocation(view.snapshot, ctx, assessments);
  return {
    workspaceId,
    snapshot: view.snapshot,
    settings,
    today,
    assessments,
    allocationPlan,
    syncState: view.syncState,
    mirrorVersion: view.version,
    ctx,
  };
}
