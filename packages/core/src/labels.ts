// Shared human copy for the UI and the digests. Plain and concrete: say what
// is missing or what happened, never how bad it is.

import type {
  AllocationBlockReason,
  IssuePatchField,
  IssueSkipReason,
  MilestoneStatus,
  NoticeKind,
  Priority,
  RiskReason,
  RubricGap,
} from './types';

/** What a rubric gap means, as a standalone line ("Missing a target date"). */
export const RUBRIC_GAP_LABEL: Record<RubricGap, string> = {
  no_target_date: 'Missing a target date',
  no_done_means: 'Missing "done means…"',
  no_project_lead: 'Project has no lead',
  no_issues: 'No issues yet',
};

/** The missing item alone, for lists such as "missing: done means…". */
export const RUBRIC_GAP_SHORT_LABEL: Record<RubricGap, string> = {
  no_target_date: 'target date',
  no_done_means: 'done means…',
  no_project_lead: 'project lead',
  no_issues: 'issues',
};

export const RISK_REASON_LABEL: Record<RiskReason, string> = {
  unassigned_open: 'Open issues unassigned',
  stalled: 'No recent state change',
  behind_pace: 'More work left than time left',
};

export const STATUS_LABEL: Record<MilestoneStatus, string> = {
  empty: 'No issues yet',
  complete: 'Complete',
  unscheduled: 'No target date',
  overdue: 'Overdue',
  at_risk: 'At risk',
  on_track: 'On track',
};

export const BLOCK_REASON_LABEL: Record<AllocationBlockReason, string> = {
  no_lead: 'Project has no lead',
  lead_inactive: 'Project lead is deactivated',
  next_milestone_invalid: 'Next milestone is missing required details',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

/** An issue field as the issue page and the audit log name it. */
export const ISSUE_FIELD_LABEL: Record<IssuePatchField, string> = {
  title: 'Title',
  description: 'Description',
  stateId: 'Status',
  assigneeId: 'Assignee',
  priority: 'Priority',
  projectId: 'Project',
  projectMilestoneId: 'Milestone',
  dueDate: 'Due date',
  estimate: 'Estimate',
  labelIds: 'Labels',
};

export const ISSUE_SKIP_REASON_LABEL: Record<IssueSkipReason, string> = {
  already_assigned: 'Already assigned',
  triage: 'Still in Triage',
};

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  overdue: 'Overdue',
  at_risk: 'At risk',
  invalid_due_soon: 'Due soon, missing required details',
  allocation_blocked: 'Allocation stopped',
};

/** `1 issue`, `2 issues`: the count followed by the right noun form. */
export function countLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "2 open issues unassigned" (§2.9 digest line). */
export function unassignedLine(count: number): string {
  return `${countLabel(count, 'open issue')} unassigned`;
}

/** "no state change in 9 days" (§2.9 digest line). */
export function stalledLine(days: number): string {
  return `no state change in ${countLabel(days, 'day')}`;
}

/**
 * Days left as words: "2 days left", "due today", "3 days overdue". Null
 * (no target date) reads "no target date".
 */
export function daysLeftLabel(daysLeft: number | null): string {
  if (daysLeft === null) return 'no target date';
  if (daysLeft === 0) return 'due today';
  if (daysLeft > 0) return `${countLabel(daysLeft, 'day')} left`;
  return `${countLabel(-daysLeft, 'day')} overdue`;
}

/** "2/7 done with 2 days left", "2/7 done, due today", "2/7 done, 3 days overdue". */
export function paceLine(
  completed: number,
  scope: number,
  daysLeft: number
): string {
  const done = `${completed}/${scope} done`;
  return daysLeft > 0
    ? `${done} with ${daysLeftLabel(daysLeft)}`
    : `${done}, ${daysLeftLabel(daysLeft)}`;
}

/** "missing: done means…, project lead" for a list of rubric gaps. */
export function missingLine(gaps: readonly RubricGap[]): string {
  return `missing: ${gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]).join(', ')}`;
}
