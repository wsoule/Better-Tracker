// The issue list's reads (owner request 2026-10-22, "every issue in one
// list"; architecture §7): thin wrappers like getTimelineView that run the
// core builders over load(), narrowed to what the viewer may see (§2.13,
// the one place visibility is applied). These are reads: a guest gets
// both, and nothing here calls requireWritable.

import {
  buildIssueList,
  buildIssueListOptions,
  type IssueListQuery,
} from '@better-tracker/core';

import { loadWorkspace } from './load';
import type { EngineRuntime } from './runtime';
import type { Actor, IssueListOptionsResult, IssueListResult } from './types';

/**
 * The issue list (architecture §2.14) for `viewer`, with the mirror
 * version it was built from (the planner refetches its picker options when
 * a newer version renders). LIST_ME resolves to the viewer; the query is
 * normalized again by core. A viewer of another workspace is refused
 * (wrong_workspace).
 */
export async function getIssueList(
  rt: EngineRuntime,
  workspaceId: string,
  query: IssueListQuery,
  viewer?: Actor
): Promise<IssueListResult> {
  const loaded = await loadWorkspace(rt, workspaceId, { viewer });
  return {
    view: buildIssueList({
      snapshot: loaded.snapshot,
      ctx: loaded.ctx,
      assessments: loaded.assessments,
      allocationPlan: loaded.allocationPlan,
      query,
      viewerId: viewer?.session.userId ?? null,
    }),
    mirrorVersion: loaded.mirrorVersion,
  };
}

/** The list's picker options for `viewer`, with the mirror version. */
export async function getIssueListOptions(
  rt: EngineRuntime,
  workspaceId: string,
  viewer?: Actor
): Promise<IssueListOptionsResult> {
  const loaded = await loadWorkspace(rt, workspaceId, { viewer });
  return {
    options: buildIssueListOptions(
      loaded.snapshot,
      loaded.ctx,
      loaded.assessments
    ),
    mirrorVersion: loaded.mirrorVersion,
  };
}
