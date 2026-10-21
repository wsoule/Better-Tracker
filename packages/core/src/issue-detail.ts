// The issue page's view model (owner decision 2026-10-21): one issue with
// its context in the plan (project, milestone, blockers), how long it has
// sat in its state, why it matters, and the options the edit controls may
// offer. Everything comes from the mirror; the fields the mirror does not
// keep (description, labels, estimate, due date, comments) are read live by
// the engine and travel next to this model, not inside it.

import { DAY_MS, elapsedMs } from './dates';
import { waitingIssues } from './graph';
import { compareIssues, compareMilestones, orderProjects } from './ordering';
import { isOpenState, issueStateType, milestoneTargetDate } from './snapshot';
import type {
  EvalContext,
  Issue,
  IssueDetail,
  IssueDetailMilestone,
  IssueDetailProject,
  IssueEditOptions,
  IssuePersonRef,
  IssueProjectOption,
  IssueRelationRow,
  IssueWhyItMatters,
  Milestone,
  MilestoneAssessment,
  Project,
  Snapshot,
  User,
} from './types';

/** Longest issue title the planner sends, in characters (§7). */
export const ISSUE_TITLE_MAX_LENGTH = 255;
/** Longest issue description the planner sends, in UTF-16 code units (§7). */
export const ISSUE_DESCRIPTION_MAX_LENGTH = 100_000;
/** Longest comment the planner sends, in characters (§7). */
export const COMMENT_MAX_LENGTH = 10_000;

// Plain code-unit comparison: deterministic on every host.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function personRef(user: User | undefined, id: string): IssuePersonRef {
  return user === undefined
    ? { id, name: 'Unknown user', active: false }
    : { id: user.id, name: user.name, active: user.active };
}

// True when the project receives allocation and warnings (§2.8). A project
// the mirror does not hold counts as inactive here.
function isActiveProject(
  project: Project | undefined,
  ctx: EvalContext
): boolean {
  return (
    project !== undefined &&
    ctx.tuning.activeProjectStatuses.includes(project.statusType)
  );
}

// One relation row for `other`, the issue at the far end of the relation.
function relationRow(
  snapshot: Snapshot,
  ctx: EvalContext,
  relationId: string,
  other: Issue,
  blocker: Issue
): IssueRelationRow {
  const state = snapshot.states.get(other.stateId);
  const assignee =
    other.assigneeId === null
      ? undefined
      : snapshot.users.get(other.assigneeId);
  const project =
    other.projectId === null
      ? undefined
      : snapshot.projects.get(other.projectId);
  const milestone =
    other.milestoneId === null
      ? undefined
      : snapshot.milestones.get(other.milestoneId);
  return {
    relationId,
    issueId: other.id,
    identifier: other.identifier,
    title: other.title,
    url: other.url,
    stateName: state?.name ?? '',
    stateType: issueStateType(snapshot, other),
    assigneeId: other.assigneeId,
    assigneeName:
      other.assigneeId === null ? null : (assignee?.name ?? 'Unknown user'),
    projectId: other.projectId,
    projectName: project?.name ?? null,
    milestoneId: milestone?.id ?? null,
    milestoneName: milestone?.name ?? null,
    external: !isActiveProject(project, ctx),
    resolved: !isOpenState(issueStateType(snapshot, blocker)),
  };
}

// Rows whose other issue is still open come first, then issue order.
function sortRows(
  snapshot: Snapshot,
  rows: { row: IssueRelationRow; other: Issue }[]
): IssueRelationRow[] {
  return rows
    .sort((a, b) => {
      const openA = isOpenState(issueStateType(snapshot, a.other)) ? 0 : 1;
      const openB = isOpenState(issueStateType(snapshot, b.other)) ? 0 : 1;
      if (openA !== openB) return openA - openB;
      return compareIssues(a.other, b.other);
    })
    .map((entry) => entry.row);
}

// The issue's blocks relations in both directions, from the raw relation
// list (the snapshot's indexes drop relation ids). One row per blocker /
// blocked pair; relations whose other end is not mirrored are counted.
function relationsOf(
  snapshot: Snapshot,
  ctx: EvalContext,
  issue: Issue
): {
  blockedBy: IssueRelationRow[];
  blocks: IssueRelationRow[];
  hidden: number;
} {
  const blockedBy: { row: IssueRelationRow; other: Issue }[] = [];
  const blocks: { row: IssueRelationRow; other: Issue }[] = [];
  const seenPairs = new Set<string>();
  let hidden = 0;
  for (const relation of snapshot.data.relations) {
    const isBlocked = relation.blockedId === issue.id;
    const isBlocker = relation.blockerId === issue.id;
    if (!isBlocked && !isBlocker) continue;
    const pair = `${relation.blockerId}\u0000${relation.blockedId}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const blocker = snapshot.issues.get(relation.blockerId);
    const blocked = snapshot.issues.get(relation.blockedId);
    if (blocker === undefined || blocked === undefined) {
      hidden += 1;
      continue;
    }
    if (isBlocked) {
      blockedBy.push({
        row: relationRow(snapshot, ctx, relation.id, blocker, blocker),
        other: blocker,
      });
    }
    if (isBlocker) {
      blocks.push({
        row: relationRow(snapshot, ctx, relation.id, blocked, blocker),
        other: blocked,
      });
    }
  }
  return {
    blockedBy: sortRows(snapshot, blockedBy),
    blocks: sortRows(snapshot, blocks),
    hidden,
  };
}

// The "why it matters" flags. The two transitive sets walk the whole
// workspace once each (O(issues + relations)), like the graph does.
function whyItMatters(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  issue: Issue,
  project: Project | undefined
): IssueWhyItMatters {
  const open = isOpenState(issueStateType(snapshot, issue));
  const isOpen = (candidate: Issue): boolean =>
    isOpenState(issueStateType(snapshot, candidate));
  const isUnassigned = (candidate: Issue): boolean =>
    isOpen(candidate) && candidate.assigneeId === null;
  const isOverdue = (candidate: Issue): boolean =>
    isOpen(candidate) &&
    candidate.milestoneId !== null &&
    assessments.get(candidate.milestoneId)?.status === 'overdue';

  const assessment =
    issue.milestoneId === null ? undefined : assessments.get(issue.milestoneId);
  const unassignedInNextMilestone =
    open &&
    issue.assigneeId === null &&
    issueStateType(snapshot, issue) !== 'triage' &&
    assessment?.isNext === true &&
    isActiveProject(project, ctx);

  const held = new Map<string, Milestone>();
  const blockedOpen: Issue[] = [];
  if (open) {
    for (const blockedId of snapshot.blocking.get(issue.id) ?? []) {
      const blocked = snapshot.issues.get(blockedId);
      if (blocked === undefined || !isOpen(blocked)) continue;
      blockedOpen.push(blocked);
      if (blocked.milestoneId === null) continue;
      const status = assessments.get(blocked.milestoneId)?.status;
      if (status !== 'overdue' && status !== 'at_risk') continue;
      const milestone = snapshot.milestones.get(blocked.milestoneId);
      if (milestone === undefined) continue;
      if (!isActiveProject(snapshot.projects.get(milestone.projectId), ctx)) {
        continue;
      }
      held.set(milestone.id, milestone);
    }
  }
  const blocksAtRiskMilestones = [...held.values()]
    .sort(compareMilestones(snapshot, ctx, assessments))
    .map((milestone) => ({
      milestoneId: milestone.id,
      name: milestone.name,
      projectName: snapshot.projects.get(milestone.projectId)?.name ?? '',
      status:
        assessments.get(milestone.id)?.status === 'overdue'
          ? ('overdue' as const)
          : ('at_risk' as const),
    }));

  const waitsOnUnassigned =
    open && waitingIssues(snapshot, isUnassigned).has(issue.id);
  const waitsOnOverdue =
    open && waitingIssues(snapshot, isOverdue).has(issue.id);
  const isRiskBase = isUnassigned(issue) || isOverdue(issue);
  return {
    unassignedInNextMilestone,
    blocksAtRiskMilestones,
    waitsOnUnassigned,
    waitsOnOverdue,
    onRiskChain:
      waitsOnUnassigned ||
      waitsOnOverdue ||
      (isRiskBase && blockedOpen.length > 0),
  };
}

/**
 * The options the issue page's edit controls may offer, from the mirror:
 * the team's workflow states in Linear's order, active people (no app
 * users) by name, and the projects with their milestones, active projects
 * first (timeline order), then the rest.
 */
export function buildIssueEditOptions(
  snapshot: Snapshot,
  ctx: EvalContext,
  teamId: string
): IssueEditOptions {
  const states = snapshot.data.states
    .filter((state) => state.teamId === teamId)
    .sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      const byName = compareStrings(a.name, b.name);
      return byName !== 0 ? byName : compareStrings(a.id, b.id);
    });
  const assignees = snapshot.data.users
    .filter((user) => user.active && !user.app)
    .sort((a, b) => {
      const byName = compareStrings(a.name, b.name);
      return byName !== 0 ? byName : compareStrings(a.id, b.id);
    })
    .map((user) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
    }));
  const toOption = (project: Project): IssueProjectOption => ({
    id: project.id,
    name: project.name,
    statusName: project.statusName,
    active: isActiveProject(project, ctx),
    includesTeam: project.teamIds.includes(teamId),
    milestones: (snapshot.milestonesByProject.get(project.id) ?? []).map(
      (milestone) => ({
        id: milestone.id,
        name: milestone.name,
        targetDate: milestoneTargetDate(milestone),
      })
    ),
  });
  const ordered = orderProjects(snapshot).map(toOption);
  return {
    states,
    assignees,
    projects: [
      ...ordered.filter((option) => option.active),
      ...ordered.filter((option) => !option.active),
    ],
  };
}

/**
 * The issue page (owner decision 2026-10-21): the mirrored issue with its
 * state, team, assignee, project (lead, active flag) and milestone
 * (status, next flag, rubric gaps), its blockers and the issues it blocks,
 * timing (days in its current state, stalled per tuning.stallDays), the
 * "why it matters" flags and the edit options. Null when the mirror has no
 * such issue.
 */
export function buildIssueDetail(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  issueId: string;
}): IssueDetail | null {
  const { snapshot, ctx, assessments } = input;
  const issue = snapshot.issues.get(input.issueId);
  if (issue === undefined) return null;

  const state = snapshot.states.get(issue.stateId);
  const project =
    issue.projectId === null
      ? undefined
      : snapshot.projects.get(issue.projectId);
  let projectView: IssueDetailProject | null = null;
  if (project !== undefined) {
    projectView = {
      id: project.id,
      name: project.name,
      url: project.url,
      statusType: project.statusType,
      statusName: project.statusName,
      active: isActiveProject(project, ctx),
      lead:
        project.leadId === null
          ? null
          : personRef(snapshot.users.get(project.leadId), project.leadId),
    };
  }

  const milestone =
    issue.milestoneId === null
      ? undefined
      : snapshot.milestones.get(issue.milestoneId);
  const assessment =
    milestone === undefined ? undefined : assessments.get(milestone.id);
  let milestoneView: IssueDetailMilestone | null = null;
  if (milestone !== undefined && assessment !== undefined) {
    milestoneView = {
      id: milestone.id,
      name: milestone.name,
      targetDate: milestoneTargetDate(milestone),
      daysLeft: assessment.daysLeft,
      status: assessment.status,
      reasons: [...assessment.reasons],
      isNext: assessment.isNext,
      rubric: {
        valid: assessment.rubric.valid,
        gaps: [...assessment.rubric.gaps],
      },
      progress: { ...assessment.progress },
    };
  }

  const open = isOpenState(issueStateType(snapshot, issue));
  const sinceChange = elapsedMs(ctx.now, issue.lastStateChangeAt) ?? 0;
  const relations = relationsOf(snapshot, ctx, issue);

  return {
    issue,
    state:
      state === undefined
        ? null
        : { id: state.id, name: state.name, type: state.type },
    team: snapshot.teams.get(issue.teamId) ?? null,
    assignee:
      issue.assigneeId === null
        ? null
        : personRef(snapshot.users.get(issue.assigneeId), issue.assigneeId),
    priority: issue.priority,
    project: projectView,
    milestone: milestoneView,
    blockedBy: relations.blockedBy,
    blocks: relations.blocks,
    hiddenRelations: relations.hidden,
    timing: {
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      startedAt: issue.startedAt,
      completedAt: issue.completedAt,
      canceledAt: issue.canceledAt,
      lastStateChangeAt: issue.lastStateChangeAt,
      daysInState: Math.max(0, Math.floor(sinceChange / DAY_MS)),
      stalled: open && sinceChange > ctx.tuning.stallDays * DAY_MS,
    },
    why: whyItMatters(snapshot, ctx, assessments, issue, project),
    options: buildIssueEditOptions(snapshot, ctx, issue.teamId),
  };
}
