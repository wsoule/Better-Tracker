import {
  type MilestoneStatus,
  NO_INITIATIVE_ID,
  type ProjectAllocationPlan,
  type ProjectStatusType,
  type RiskReason,
  type TimelineBar,
  type TimelineLane,
  type TimelineView,
} from '@better-tracker/core';
import type {
  ChipTone,
  SegmentedOption,
  UiStatus,
  UiTone,
} from '@better-tracker/ui';

import { dueLabel, plural } from '../format';
import { graphHref, initiativeGraphHref } from './graph-scope';
import { assessmentMark, blockedReasonLine } from './status';

// The projects register (architecture §8.4): one row per lane of the
// engine's TimelineView (every project that is not completed or canceled),
// grouped by initiative in timeline order. Each row carries the project's
// Linear status, its next milestone (due, mark, progress), its lead, and
// what the allocation plan would do with it. Pure functions over plain
// data, shared by the server page and the client island that filters.
// An inactive project (§2.8; the lane's `active` flag) stays listed, in
// greys (its next milestone's mark, date and progress included), and is
// never counted as at risk.
//
// Tones follow architecture §8.2's status table: overdue danger (red), at
// risk, blocked, no lead and a missing date warning (amber), complete
// success (green), allocating and a started project info (blue), inactive
// muted (grey). The purple accent never means a status here.

export type ProjectFilterId = 'all' | 'blocked' | 'at_risk' | 'inactive';

export const PROJECT_FILTER_IDS: readonly ProjectFilterId[] = [
  'all',
  'blocked',
  'at_risk',
  'inactive',
];

const FILTER_LABEL: Record<ProjectFilterId, string> = {
  all: 'All',
  blocked: 'Blocked',
  at_risk: 'At risk',
  inactive: 'Inactive',
};

/** Linear's default status names, used when the mirror has no name. */
const STATUS_TYPE_LABEL: Record<ProjectStatusType, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  started: 'In Progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
};

export interface ProjectNextMilestone {
  id: string;
  name: string;
  href: string;
  /** "Oct 18 · 3 days overdue", "No target date". */
  dueLabel: string;
  /** The due date's colour (dueTone): danger overdue, warning due today or
      tomorrow or undated (a missing input), default later, muted in an
      inactive project. */
  dueTone: UiTone;
  status: UiStatus;
  statusLabel: string;
  done: number;
  total: number;
  /** The progress fill (progressTone): danger overdue, warning behind
      pace, success complete, muted in an inactive project, default (ink)
      otherwise. */
  progressTone: ProgressTone;
  /** An inactive project's milestone: the mark is drawn in greys. */
  muted: boolean;
}

export interface ProjectAllocationCell {
  /** The chip: "Allocating 2", "Blocked", "Nothing to do"… */
  label: string;
  /** Mono line under it: why it is blocked (blockedReasonLine), e.g.
      "Project has no lead" or "Next milestone is missing: done means…". */
  detail?: string;
  /** Chip tone (architecture §8.2 "allocation"): info = allocating,
      default = nothing to do, warning = blocked, muted = nothing applies
      (no open milestone, inactive, not evaluated). */
  tone: 'default' | 'muted' | 'info' | 'warning';
  /** BLOCKED keeps the filled chip it had before the status hues (an
      amber slab); the other cells stay outlined. */
  filled?: true;
}

export interface ProjectRowModel {
  id: string;
  name: string;
  initiative: string;
  linearStatus: string;
  /** The Linear status chip (LINEAR_STATUS_TONE): muted backlog, planned
      and canceled, info started, warning paused, success completed;
      always muted for an inactive project, whose row carries no status
      colour (§2.8). */
  linearStatusTone: ChipTone;
  /** Allocation and warnings apply to this project. */
  active: boolean;
  next: ProjectNextMilestone | null;
  /** null renders "No lead" in the warning tone. */
  lead: string | null;
  allocation: ProjectAllocationCell;
  /** The register row's tone: warning (the 2px amber rule) when allocation
      is blocked, muted for an inactive project. */
  rowTone: 'default' | 'warning' | 'muted';
  /** The filters (other than "all") this row matches. */
  tags: ProjectFilterId[];
  timelineHref: string;
  graphHref: string;
  linearUrl: string;
  /** Lower-cased words the search box matches against. */
  searchText: string;
}

export interface ProjectGroupModel {
  /** Initiative id, or "none" for "No initiative". */
  id: string;
  name: string;
  /** The group's dependency graph (initiativeGraphHref): its projects, or
      the workspace's projects when the viewer has no initiatives. */
  graphHref: string;
  rows: ProjectRowModel[];
}

export interface ProjectsPageModel {
  groups: ProjectGroupModel[];
  /** SegmentedControl options with counts: All / Blocked / At risk / Inactive. */
  filters: SegmentedOption[];
  total: number;
  receipts: string;
}

/**
 * The status mark of a timeline bar, through the planner's one mapping
 * (assessmentMark): a bar carries the same status and rubric as the
 * assessment it came from, so on-track-but-invalid reads as hatched.
 */
export function barMark(bar: TimelineBar): {
  status: UiStatus;
  label: string;
} {
  return assessmentMark(bar);
}

/** A progress fill's tone (ProgressRule): see progressTone. */
export type ProgressTone =
  | 'default'
  | 'danger'
  | 'warning'
  | 'success'
  | 'muted';

/**
 * The progress fill when the progress itself is a status (architecture
 * §8.2 "progress"): muted in an inactive project, success once complete,
 * danger when overdue, warning when there is more work left than time
 * left (behind pace); otherwise default (the ink fill). The one definition
 * for every screen (the register, My week).
 */
export function progressTone(
  milestone: { status: MilestoneStatus; reasons: readonly RiskReason[] },
  muted = false
): ProgressTone {
  if (muted) return 'muted';
  if (milestone.status === 'complete') return 'success';
  if (milestone.status === 'overdue') return 'danger';
  return milestone.reasons.includes('behind_pace') ? 'warning' : 'default';
}

/**
 * A due date's colour (architecture §8.2 "due date"): danger overdue,
 * warning due today or tomorrow, warning when undated (the date is a
 * missing input), default later or complete. The one definition for every
 * screen; callers quiet it themselves for an inactive project.
 */
export function dueTone(
  status: MilestoneStatus | null,
  daysLeft: number | null,
  undated: boolean
): 'default' | 'danger' | 'warning' {
  if (status === 'complete') return 'default';
  if (status === 'overdue') return 'danger';
  if (undated) return 'warning';
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 1) return 'warning';
  return 'default';
}

/** Linear's project status type as a chip tone (architecture §8.2), for an
    active project; an inactive one's chip is muted whatever its status
    (see toRow). Backlog and planned stay the ink chip: grey means inactive,
    and an active project that has not started yet is not inactive. */
const LINEAR_STATUS_TONE: Record<ProjectStatusType, ChipTone> = {
  backlog: 'default',
  planned: 'default',
  started: 'info',
  paused: 'warning',
  completed: 'success',
  canceled: 'muted',
};

/** What the allocation plan says about a project, as register copy. */
export function allocationCell(
  plan: ProjectAllocationPlan | null
): ProjectAllocationCell {
  if (plan === null) return { label: 'Not evaluated', tone: 'muted' };
  switch (plan.outcome) {
    case 'allocate':
      return { label: `Allocating ${plan.actions.length}`, tone: 'info' };
    case 'blocked':
      // A short chip; the reason goes on the mono line under it, worded as
      // on the timeline's Blocked banner and My week's "Needs attention".
      return plan.blockReason === null
        ? { label: 'Blocked', tone: 'warning', filled: true }
        : {
            label: 'Blocked',
            detail: blockedReasonLine(plan.blockReason, plan.gaps),
            tone: 'warning',
            filled: true,
          };
    case 'nothing_to_do':
      return { label: 'Nothing to do', tone: 'default' };
    case 'no_open_milestone':
      return { label: 'No open milestone', tone: 'muted' };
    case 'inactive':
      return { label: 'Inactive', tone: 'muted' };
  }
}

/**
 * The register's next-milestone cell. In an inactive project it is never
 * loud (§2.8): grey mark (still named with its status), muted date, grey
 * progress.
 */
function nextMilestone(
  lane: TimelineLane,
  today: string
): ProjectNextMilestone | null {
  const bar = [...lane.bars, ...lane.undated].find((b) => b.isNext);
  if (bar === undefined) return null;
  const mark = barMark(bar);
  const loud = lane.active;
  return {
    id: bar.milestoneId,
    name: bar.name,
    href: `/timeline?milestone=${encodeURIComponent(bar.milestoneId)}`,
    dueLabel: dueLabel(bar.end, bar.daysLeft, today, bar.status),
    dueTone: loud
      ? dueTone(bar.status, bar.daysLeft, bar.end === null)
      : 'muted',
    status: mark.status,
    statusLabel: loud ? mark.label : `${mark.label} · inactive project`,
    done: bar.progress.completed,
    total: bar.progress.scope,
    progressTone: progressTone(bar, !loud),
    muted: !loud,
  };
}

function toRow(
  lane: TimelineLane,
  initiative: string,
  today: string,
  statusNames: ReadonlyMap<string, string>
): ProjectRowModel {
  const next = nextMilestone(lane, today);
  const allocation = allocationCell(lane.allocation);
  const blocked = lane.allocation?.outcome === 'blocked';
  const atRisk =
    lane.active &&
    next !== null &&
    (next.status === 'overdue' || next.status === 'at_risk');
  const tags: ProjectFilterId[] = [];
  if (blocked) tags.push('blocked');
  if (atRisk) tags.push('at_risk');
  if (!lane.active) tags.push('inactive');
  const linearStatus =
    statusNames.get(lane.projectId) ?? STATUS_TYPE_LABEL[lane.statusType];
  return {
    id: lane.projectId,
    name: lane.name,
    initiative,
    linearStatus,
    // An inactive project's row carries no status colour (§2.8).
    linearStatusTone: lane.active
      ? LINEAR_STATUS_TONE[lane.statusType]
      : 'muted',
    active: lane.active,
    next,
    lead: lane.leadName,
    allocation,
    rowTone: blocked ? 'warning' : lane.active ? 'default' : 'muted',
    tags,
    timelineHref: `/timeline?project=${encodeURIComponent(lane.projectId)}`,
    graphHref: graphHref({ level: 'issue', projectId: lane.projectId }),
    linearUrl: lane.url,
    searchText: [
      lane.name,
      initiative,
      linearStatus,
      lane.leadName ?? 'no lead',
      next?.name ?? '',
      allocation.label,
      allocation.detail ?? '',
    ]
      .join(' ')
      .toLowerCase(),
  };
}

/** Accepts a `?filter=` value; anything unknown means "all". */
export function parseProjectFilter(value: unknown): ProjectFilterId {
  const raw = Array.isArray(value) ? (value[0] as unknown) : value;
  return PROJECT_FILTER_IDS.find((id) => id === raw) ?? 'all';
}

/** Longest search the register accepts from a URL. */
export const PROJECT_QUERY_MAX = 200;

/**
 * The search and filter a /projects query string asks for (`?q=`,
 * `?filter=`), as the client island reads them when the URL changes under
 * it (back/forward, a link to /projects). Unknown filters mean "all".
 */
export function parseProjectsSearch(params: {
  get(name: string): string | null;
}): { query: string; filter: ProjectFilterId } {
  return {
    query: (params.get('q') ?? '').slice(0, PROJECT_QUERY_MAX),
    filter: parseProjectFilter(params.get('filter') ?? undefined),
  };
}

/**
 * The rows that match a search and a filter, still grouped (groups left
 * empty are dropped). Every whitespace-separated word of the query must
 * appear in the row's name, initiative, status, lead or next milestone.
 */
export function filterProjectGroups(
  groups: readonly ProjectGroupModel[],
  query: string,
  filter: ProjectFilterId
): ProjectGroupModel[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const result: ProjectGroupModel[] = [];
  for (const group of groups) {
    const rows = group.rows.filter(
      (row) =>
        (filter === 'all' || row.tags.includes(filter)) &&
        words.every((word) => row.searchText.includes(word))
    );
    if (rows.length > 0) result.push({ ...group, rows });
  }
  return result;
}

/** Everything the /projects page renders, from the timeline view. */
export function buildProjectsPage(input: {
  timeline: TimelineView;
  /** Linear's project status names (e.g. "In Progress") by project id. */
  statusNames: ReadonlyMap<string, string>;
}): ProjectsPageModel {
  const { timeline, statusNames } = input;
  // A guest's mirror has no initiatives (§2.13): every group is then "No
  // initiative", and its graph link goes to the workspace's projects.
  const hasInitiatives = timeline.groups.some(
    (group) => group.initiativeId !== null
  );
  const groups: ProjectGroupModel[] = timeline.groups.map((group) => {
    const id = group.initiativeId ?? NO_INITIATIVE_ID;
    return {
      id,
      name: group.name,
      graphHref: initiativeGraphHref(id, hasInitiatives),
      rows: group.lanes.map((lane) =>
        toRow(lane, group.name, timeline.today, statusNames)
      ),
    };
  });
  const rows = groups.flatMap((group) => group.rows);
  const count = (id: ProjectFilterId) =>
    id === 'all'
      ? rows.length
      : rows.filter((row) => row.tags.includes(id)).length;
  const active = rows.filter((row) => row.active).length;
  const receipts = [
    plural(rows.length, 'project'),
    `${active} active`,
    `${count('blocked')} blocked`,
    `${count('at_risk')} at risk or overdue`,
  ].join(' · ');
  return {
    groups,
    filters: PROJECT_FILTER_IDS.map((id) => ({
      id,
      label: FILTER_LABEL[id],
      count: count(id),
    })),
    total: rows.length,
    receipts,
  };
}
