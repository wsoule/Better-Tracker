// Read models for the web app: thin wrappers that run the core builders
// over load(), narrowed to what the viewer may see when one is given
// (§2.13), plus the run log, notification and audit listings.

import {
  buildDependencyGraph,
  buildMilestoneDetail,
  buildTimelineView,
  buildWeekView,
  DAY_MS,
  type DependencyGraph,
  type GraphScope,
  type MilestoneDetail,
  type RecentAllocation,
  resolveGraphScope,
  type TimelineView,
  type WeekView,
} from '@better-tracker/core';
import type { RunEntry } from '@better-tracker/store';

import { loadWorkspace } from './load';
import type { EngineRuntime } from './runtime';
import { type Actor, EngineInputError } from './types';

/**
 * Applied live assignments as core's RecentAllocation (My week's "new"
 * mark). Entries missing an issue, assignee or milestone are skipped.
 */
export function toRecentAllocations(
  entries: readonly RunEntry[]
): RecentAllocation[] {
  const recent: RecentAllocation[] = [];
  for (const entry of entries) {
    if (
      entry.issueId === null ||
      entry.assigneeId === null ||
      entry.milestoneId === null
    ) {
      continue;
    }
    recent.push({
      issueId: entry.issueId,
      assigneeId: entry.assigneeId,
      projectId: entry.projectId,
      milestoneId: entry.milestoneId,
      at: entry.createdAt,
    });
  }
  return recent;
}

/**
 * My week for `userId` (§7.1 of the design), as `viewer` may see it
 * (§2.13): viewing someone else's week shows only what the viewer can see.
 */
export async function getWeekView(
  rt: EngineRuntime,
  workspaceId: string,
  userId: string,
  viewer?: Actor
): Promise<WeekView> {
  const loaded = await loadWorkspace(rt, workspaceId, { viewer });
  if (!loaded.snapshot.users.has(userId)) {
    throw new EngineInputError(
      'not_found',
      'That person is not in this workspace.'
    );
  }
  const since = new Date(
    rt.clock().getTime() - loaded.settings.tuning.newBadgeDays * DAY_MS
  ).toISOString();
  const entries = await rt.store.listAppliedAssignments(workspaceId, since);
  return buildWeekView({
    snapshot: loaded.snapshot,
    ctx: loaded.ctx,
    assessments: loaded.assessments,
    userId,
    recentAllocations: toRecentAllocations(entries),
  });
}

/** The timeline (§7.2 of the design), as `viewer` may see it. */
export async function getTimelineView(
  rt: EngineRuntime,
  workspaceId: string,
  viewer?: Actor
): Promise<TimelineView> {
  const loaded = await loadWorkspace(rt, workspaceId, { viewer });
  return buildTimelineView({
    snapshot: loaded.snapshot,
    ctx: loaded.ctx,
    assessments: loaded.assessments,
    allocationPlan: loaded.allocationPlan,
  });
}

/**
 * The dependency graph (§2.10) of a scope, as `viewer` may see it: a level
 * inside the workspace, an initiative, a project, a milestone, or one
 * issue's chain. The scope is checked against the viewer's mirror by core's
 * resolveGraphScope: a malformed scope is EngineInputError('invalid') and
 * an id the viewer's mirror lacks (unknown or hidden alike) 'not_found'. A
 * scope naming initiatives for a viewer whose mirror has none (a guest)
 * answers the workspace instead, with `fallback` set. A read: it writes
 * nothing, so it never calls requireWritable.
 */
export async function getGraph(
  rt: EngineRuntime,
  workspaceId: string,
  scope: GraphScope,
  viewer?: Actor
): Promise<DependencyGraph> {
  const loaded = await loadWorkspace(rt, workspaceId, { viewer });
  const resolution = resolveGraphScope(loaded.snapshot, scope);
  if (!resolution.ok) {
    throw new EngineInputError(resolution.problem, resolution.message);
  }
  // The builder resolves the scope again (cheap) and sets `fallback`.
  return buildDependencyGraph(
    loaded.snapshot,
    loaded.ctx,
    loaded.assessments,
    scope
  );
}

/** The milestone drawer; unknown ids are EngineInputError('not_found'). */
export async function getMilestoneDetail(
  rt: EngineRuntime,
  workspaceId: string,
  milestoneId: string,
  viewer?: Actor
): Promise<MilestoneDetail> {
  const loaded = await loadWorkspace(rt, workspaceId, { viewer });
  const detail = buildMilestoneDetail({
    snapshot: loaded.snapshot,
    ctx: loaded.ctx,
    assessments: loaded.assessments,
    milestoneId,
  });
  if (detail === null) {
    throw new EngineInputError(
      'not_found',
      'That milestone is not in the mirror.'
    );
  }
  return detail;
}
