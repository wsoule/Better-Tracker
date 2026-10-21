import {
  STATUS_LABEL,
  type MilestoneAssessment,
  type MilestoneStatus,
} from '@better-tracker/core';
import type { UiStatus } from '@better-tracker/ui';

// The one place planner statuses become UI marks (architecture §8.2):
// complete → done (filled ink), on track → hollow ink, at risk → 2px
// accent, overdue → filled accent, and anything missing an input
// (no date, no issues) → hatched.
const STATUS_TO_UI: Record<MilestoneStatus, UiStatus> = {
  complete: 'done',
  on_track: 'on_track',
  at_risk: 'at_risk',
  overdue: 'overdue',
  unscheduled: 'missing',
  empty: 'missing',
};

export function uiStatus(status: MilestoneStatus): UiStatus {
  return STATUS_TO_UI[status];
}

export function statusLabel(status: MilestoneStatus): string {
  return STATUS_LABEL[status];
}

/**
 * Mark for an assessed milestone (or anything carrying its status and
 * rubric, such as a TimelineBar). A milestone that fails the rubric but is
 * otherwise on track reads as "missing input" (hatched), because the
 * missing input is what needs action; overdue and at-risk keep their own
 * marks (they are more urgent) and the drawer lists the gaps.
 */
export function assessmentMark(
  assessment: Pick<MilestoneAssessment, 'status' | 'rubric'>
): {
  status: UiStatus;
  label: string;
} {
  if (assessment.status === 'on_track' && !assessment.rubric.valid) {
    return { status: 'missing', label: 'Missing input' };
  }
  return {
    status: uiStatus(assessment.status),
    label: statusLabel(assessment.status),
  };
}
