import {
  type AllocationBlockReason,
  BLOCK_REASON_LABEL,
  missingLine,
  RUBRIC_GAP_SHORT_LABEL,
  STATUS_LABEL,
  type MilestoneAssessment,
  type MilestoneStatus,
  type RubricGap,
} from '@better-tracker/core';
import type { UiStatus } from '@better-tracker/ui';

// The one place planner statuses become UI marks (architecture §8.2):
// complete → done (green disc with a tick), on track → green ring, at risk
// → amber half-filled ring, overdue → red disc, and anything missing an
// input (no date, no issues) → missing (dashed grey ring).
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
 * otherwise on track reads as "missing input" (dashed), because the
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

/**
 * Why a project's allocation is stopped, as one short line, worded the
 * same on the timeline's Blocked banner, My week's "Needs attention" and
 * the projects register (it sits under a chip in a narrow column there):
 * the reason alone ("Project has no lead"), or, for an invalid next
 * milestone, the rubric items it lacks ("Next milestone is missing: done
 * means…") rather than the generic "missing required details" followed by
 * the same list.
 */
export function blockedReasonLine(
  reason: AllocationBlockReason,
  gaps: readonly RubricGap[]
): string {
  const label = BLOCK_REASON_LABEL[reason];
  if (gaps.length === 0) return label;
  if (reason === 'next_milestone_invalid') {
    const items = gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]).join(', ');
    return `Next milestone is missing: ${items}`;
  }
  return `${label} · ${missingLine(gaps)}`;
}
