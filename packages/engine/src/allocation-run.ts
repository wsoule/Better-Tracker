// runAllocation (§7 steps 1–6, design §7.4, §6.3, §6.12, §9 safety).
//
// Safety properties, each enforced here:
// - One run at a time per workspace: startRun refuses while another runs.
// - Fresh data: the plan is made right after a full sync.
// - Logged: every block, skip and assignment is a run entry.
// - Dry run writes nothing to Linear.
// - Live re-checks each issue against Linear just before writing and
//   records `stale` instead of writing when it no longer applies.
// - Assign first, then comment: a rerun never double-comments because an
//   assigned issue is never planned again (idempotent by construction).
// - A failure on one issue is recorded and the run continues.
// - Whatever throws after startRun still finishes the run as `failed`.

import {
  allocationComment,
  type AllocationAction,
  type AllocationMode,
  type AllocationPlan,
  type Issue,
  issueStateType,
  isOpenState,
  resolveTodoState,
  type Snapshot,
} from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type {
  AllocationRun,
  NewRunEntry,
  RunStatus,
  RunSummary,
  RunTrigger,
} from '@better-tracker/store';

import { loadWorkspace } from './load';
import {
  type EngineRuntime,
  errorMessage,
  requireInstallation,
} from './runtime';
import { fullSync } from './sync';
import { type Actor, EngineAuthError, EngineInputError } from './types';

/** Why a planned assignment was not applied in a live run. */
export type StaleReason =
  | 'not_found'
  | 'closed'
  | 'now_assigned'
  | 'moved_milestone'
  | 'now_triage';

/** Human copy for each stale reason (run log UI). */
export const STALE_REASON_LABEL: Record<StaleReason, string> = {
  not_found: 'No longer exists in Linear',
  closed: 'Closed in Linear since the plan was made',
  now_assigned: 'Someone was assigned in Linear since the plan was made',
  moved_milestone: 'Moved to another milestone since the plan was made',
  now_triage: 'Moved back to Triage since the plan was made',
};

/**
 * Minutes after it started that a run still `running` counts as crashed:
 * the next startRun closes it as `stale run` instead of refusing to start.
 * The daily lease (DEFAULT_DAILY_LEASE_MINUTES) is sized against it, so a
 * daily takeover never finds the dead run's allocation still in the way.
 */
export const ALLOCATION_RUN_STALE_MINUTES = 30;

export interface AllocationRunInput {
  workspaceId: string;
  mode: AllocationMode;
  trigger: RunTrigger;
  actor: Actor | null;
  /**
   * Internal: runDaily has just synced, so the run may skip its own sync.
   * Public callers always sync first.
   */
  syncFirst?: boolean;
}

// Who may start which run: the schedule (actor null) may run both modes;
// a person must be a PM of that workspace for either mode.
function authorize(input: AllocationRunInput): void {
  if (input.mode !== 'dry_run' && input.mode !== 'live') {
    throw new EngineInputError('invalid', 'mode must be dry_run or live.');
  }
  if (input.trigger !== 'schedule' && input.trigger !== 'manual') {
    throw new EngineInputError(
      'invalid',
      'trigger must be schedule or manual.'
    );
  }
  const { actor } = input;
  if (actor === null) return;
  if (actor.session.workspaceId !== input.workspaceId) {
    throw new EngineAuthError(
      'wrong_workspace',
      'You are signed in to a different Linear workspace.'
    );
  }
  if (!actor.isPm) {
    throw new EngineAuthError('not_pm', 'Only PMs can run allocation.');
  }
}

/**
 * The live re-check (§7 step 5): the reason the planned assignment no
 * longer applies to `issue` as Linear has it now, or null when it still
 * does (open, not Triage, unassigned, in the planned milestone).
 */
export function staleReason(
  snapshot: Snapshot,
  action: AllocationAction,
  issue: Issue | null
): StaleReason | null {
  if (issue === null) return 'not_found';
  const type = issueStateType(snapshot, issue);
  if (!isOpenState(type)) return 'closed';
  if (issue.assigneeId !== null) return 'now_assigned';
  if (issue.milestoneId !== action.milestoneId) return 'moved_milestone';
  if (type === 'triage') return 'now_triage';
  return null;
}

// Block and skip entries for the run log, one per blocked project and one
// per skipped issue.
function planNotes(plan: AllocationPlan): NewRunEntry[] {
  const entries: NewRunEntry[] = [];
  for (const project of plan.projects) {
    if (project.outcome === 'blocked') {
      entries.push({
        action: 'block',
        outcome: 'noted',
        projectId: project.projectId,
        milestoneId: project.nextMilestoneId,
        issueId: null,
        issueIdentifier: null,
        assigneeId: null,
        reason: project.blockReason,
        detail: { gaps: project.gaps },
        error: null,
      });
    }
    for (const skip of project.skipped) {
      entries.push({
        action: 'skip',
        outcome: 'noted',
        projectId: project.projectId,
        milestoneId: project.nextMilestoneId,
        issueId: skip.issueId,
        issueIdentifier: skip.identifier,
        assigneeId: null,
        reason: skip.reason,
        detail: {},
        error: null,
      });
    }
  }
  return entries;
}

// An assign entry for `action` with the given outcome.
function assignEntry(
  action: AllocationAction,
  outcome: NewRunEntry['outcome'],
  extra: Partial<Pick<NewRunEntry, 'reason' | 'detail' | 'error'>> = {}
): NewRunEntry {
  return {
    action: 'assign',
    outcome,
    projectId: action.projectId,
    milestoneId: action.milestoneId,
    issueId: action.issueId,
    issueIdentifier: action.identifier,
    assigneeId: action.assigneeId,
    reason: extra.reason ?? null,
    detail: {
      title: action.title,
      fromStateId: action.fromStateId,
      toStateId: action.toStateId,
      ...extra.detail,
    },
    error: extra.error ?? null,
  };
}

interface LiveCounts {
  applied: number;
  failed: number;
  stale: number;
  commentFailures: number;
}

// Applies one planned assignment live: re-check, assign (+ move to Todo),
// patch the mirror, then comment. Never throws for Linear failures on this
// issue; they become a `failed` entry (or an error on the applied entry
// when only the comment failed).
async function applyAction(
  rt: EngineRuntime,
  gateway: LinearGateway,
  snapshot: Snapshot,
  action: AllocationAction,
  runId: string,
  workspaceId: string,
  counts: LiveCounts,
  log: Logger
): Promise<void> {
  const issueLog = log.child({
    issueId: action.issueId,
    identifier: action.identifier,
  });
  let current: Issue | null;
  try {
    current = await gateway.fetchIssue(action.issueId);
  } catch (error) {
    counts.failed += 1;
    issueLog.error('could not re-check the issue before assigning', { error });
    await rt.store.appendRunEntries(runId, [
      assignEntry(action, 'failed', {
        error: `Re-check failed: ${errorMessage(error)}`,
      }),
    ]);
    return;
  }

  const stale = staleReason(snapshot, action, current);
  if (stale !== null || current === null) {
    counts.stale += 1;
    issueLog.info('planned assignment is stale; not written', {
      reason: stale,
    });
    await rt.store.appendRunEntries(runId, [
      assignEntry(action, 'stale', {
        reason: stale ?? 'not_found',
        detail: {
          currentAssigneeId: current?.assigneeId ?? null,
          currentMilestoneId: current?.milestoneId ?? null,
          currentStateId: current?.stateId ?? null,
        },
      }),
    ]);
    return;
  }

  // Move out of Backlog only if the issue is (still) in Backlog now.
  const toStateId =
    issueStateType(snapshot, current) === 'backlog'
      ? (resolveTodoState(snapshot, current.teamId)?.id ?? null)
      : null;
  let updated: Issue;
  try {
    updated = await gateway.updateIssue(action.issueId, {
      assigneeId: action.assigneeId,
      ...(toStateId === null ? {} : { stateId: toStateId }),
    });
  } catch (error) {
    counts.failed += 1;
    issueLog.error('assigning the issue failed', { error });
    await rt.store.appendRunEntries(runId, [
      assignEntry(action, 'failed', {
        error: errorMessage(error),
        detail: { toStateId },
      }),
    ]);
    return;
  }

  try {
    await rt.store.applyMirrorChanges(workspaceId, {
      upsert: [{ kind: 'issue', entity: updated }],
      remove: [],
    });
  } catch (error) {
    // Linear has the write; the next sync brings the mirror up to date.
    issueLog.warn('could not patch the mirror after assigning', { error });
  }

  const milestone = snapshot.milestones.get(action.milestoneId);
  const project = snapshot.projects.get(action.projectId);
  const body = allocationComment({
    appName: rt.config.appName,
    projectName: project?.name ?? action.projectId,
    milestoneName: milestone?.name ?? action.milestoneId,
    targetDate: milestone?.targetDate ?? '',
  });
  counts.applied += 1;
  try {
    const comment = await gateway.createComment(action.issueId, body);
    issueLog.info('assigned issue', {
      assigneeId: action.assigneeId,
      toStateId,
      commentId: comment.id,
    });
    await rt.store.appendRunEntries(runId, [
      assignEntry(action, 'applied', {
        reason: comment.id,
        detail: { toStateId, commentId: comment.id },
      }),
    ]);
  } catch (error) {
    counts.commentFailures += 1;
    issueLog.error('assigned the issue but could not comment', { error });
    await rt.store.appendRunEntries(runId, [
      assignEntry(action, 'applied', {
        detail: { toStateId, commentId: null },
        error: `Assigned, but the comment failed: ${errorMessage(error)}`,
      }),
    ]);
  }
}

// The final status and error text of a run from its live counts.
function finalStatus(counts: LiveCounts): {
  status: Exclude<RunStatus, 'running'>;
  error: string | null;
} {
  if (counts.failed > 0 && counts.applied === 0) {
    return {
      status: 'failed',
      error: `${counts.failed} assignment(s) failed and none were applied.`,
    };
  }
  if (counts.failed > 0 || counts.commentFailures > 0) {
    const parts: string[] = [];
    if (counts.failed > 0) parts.push(`${counts.failed} assignment(s) failed`);
    if (counts.commentFailures > 0) {
      parts.push(`${counts.commentFailures} comment(s) could not be posted`);
    }
    return { status: 'partial', error: `${parts.join('; ')}.` };
  }
  return { status: 'succeeded', error: null };
}

/** The engine's runAllocation; see the module comment for its guarantees. */
export async function runAllocation(
  rt: EngineRuntime,
  input: AllocationRunInput
): Promise<AllocationRun> {
  authorize(input);
  const { workspaceId, mode, trigger, actor } = input;
  await requireInstallation(rt, workspaceId);

  const run = await rt.store.startRun({
    workspaceId,
    mode,
    trigger,
    startedByUserId: actor?.session.userId ?? null,
    now: rt.nowIso(),
    staleAfterMinutes: ALLOCATION_RUN_STALE_MINUTES,
  });
  if (run === null) {
    throw new EngineInputError(
      'conflict',
      'An allocation run is already in progress.'
    );
  }
  const log = rt.logger.child({ workspaceId, runId: run.id, mode, trigger });
  log.info('allocation run started', { userId: actor?.session.userId ?? null });

  const summary: RunSummary = {
    assigned: 0,
    wouldAssign: 0,
    failed: 0,
    blockedProjects: 0,
    skippedIssues: 0,
  };
  try {
    if (input.syncFirst !== false) await fullSync(rt, workspaceId);
    const loaded = await loadWorkspace(rt, workspaceId);
    const plan = loaded.allocationPlan;
    summary.blockedProjects = plan.totals.blockedProjects;
    summary.skippedIssues = plan.totals.skippedIssues;
    await rt.store.appendRunEntries(run.id, planNotes(plan));

    const actions = plan.projects.flatMap((project) => project.actions);
    let result: {
      status: Exclude<RunStatus, 'running'>;
      error: string | null;
    } = { status: 'succeeded', error: null };
    if (mode === 'dry_run') {
      await rt.store.appendRunEntries(
        run.id,
        actions.map((action) => assignEntry(action, 'planned'))
      );
      summary.wouldAssign = actions.length;
    } else {
      const counts: LiveCounts = {
        applied: 0,
        failed: 0,
        stale: 0,
        commentFailures: 0,
      };
      if (actions.length > 0) {
        const gateway = await rt.linear.forApp(workspaceId);
        for (const action of actions) {
          await applyAction(
            rt,
            gateway,
            loaded.snapshot,
            action,
            run.id,
            workspaceId,
            counts,
            log
          );
        }
      }
      summary.assigned = counts.applied;
      summary.failed = counts.failed;
      result = finalStatus(counts);
      log.info('live allocation applied', { ...counts });
    }

    const finishedAt = rt.nowIso();
    await rt.store.finishRun(run.id, { ...result, summary, now: finishedAt });
    log.info('allocation run finished', { status: result.status, ...summary });
    return { ...run, ...result, summary, finishedAt };
  } catch (error) {
    log.error('allocation run failed', { error });
    try {
      await rt.store.finishRun(run.id, {
        status: 'failed',
        summary,
        error: errorMessage(error),
        now: rt.nowIso(),
      });
    } catch (finishError) {
      log.error('could not mark the allocation run failed', {
        error: finishError,
      });
    }
    throw error;
  }
}
