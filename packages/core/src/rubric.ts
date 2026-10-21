// The milestone rubric (§6.7 of the design doc, §2.3–2.4 of the spec).

import { progressOf } from './progress';
import { milestoneTargetDate } from './snapshot';
import type {
  DoneMeans,
  Milestone,
  MilestoneMeta,
  Progress,
  Project,
  RubricGap,
  RubricResult,
  Snapshot,
} from './types';

const DONE_MEANS_LINE = /^\s*done means\b[\s:—–-]*(.+)$/i;

/**
 * Where a milestone's "done means…" outcome comes from: the planner's own
 * field first, else the first line of the Linear description that starts
 * with "Done means" (so teams can author it in Linear), else nothing.
 */
export function resolveDoneMeans(
  m: Milestone,
  meta: MilestoneMeta | undefined
): DoneMeans {
  const own = meta?.doneMeans?.trim() ?? '';
  if (own !== '') return { text: own, source: 'planner' };
  if (m.description !== null) {
    for (const line of m.description.split(/\r?\n/)) {
      const match = DONE_MEANS_LINE.exec(line);
      const text = match?.[1]?.trim() ?? '';
      if (text !== '') return { text, source: 'linear_description' };
    }
  }
  return { text: null, source: null };
}

/**
 * The rubric verdict from already-computed parts; gaps come out in display
 * order (date, done means, lead, issues). Shared by evaluateRubric and
 * assessWorkspace so the latter does not recount issues.
 */
export function rubricFrom(input: {
  milestone: Milestone | undefined;
  project: Project | undefined;
  progress: Progress;
  doneMeans: DoneMeans;
}): RubricResult {
  const gaps: RubricGap[] = [];
  if (
    input.milestone === undefined ||
    milestoneTargetDate(input.milestone) === null
  ) {
    gaps.push('no_target_date');
  }
  if (input.doneMeans.text === null) gaps.push('no_done_means');
  if (input.project?.leadId == null) gaps.push('no_project_lead');
  if (input.progress.total === 0) gaps.push('no_issues');
  return { valid: gaps.length === 0, gaps };
}

/**
 * Checks one milestone against the rubric. A project lead counts even when
 * deactivated (allocation reports that separately as `lead_inactive`). An
 * unknown milestone id fails every item.
 */
export function evaluateRubric(
  snapshot: Snapshot,
  milestoneId: string,
  meta: MilestoneMeta | undefined
): RubricResult {
  const milestone = snapshot.milestones.get(milestoneId);
  return rubricFrom({
    milestone,
    project:
      milestone === undefined
        ? undefined
        : snapshot.projects.get(milestone.projectId),
    progress: progressOf(
      snapshot,
      snapshot.issuesByMilestone.get(milestoneId) ?? []
    ),
    doneMeans:
      milestone === undefined
        ? { text: null, source: null }
        : resolveDoneMeans(milestone, meta),
  });
}
