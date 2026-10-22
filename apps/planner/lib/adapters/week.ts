import {
  DEFAULT_ISSUE_LIST_QUERY,
  type Issue,
  LIST_ME,
  PRIORITY_LABEL,
  type Project,
  type TimelineBar,
  type TimelineLane,
  type TimelineView,
  type User,
  type WeekIssueRow,
  type WeekSection,
  type WeekView,
} from '@better-tracker/core';
import type {
  DeadlineGroup,
  DeadlineItem,
  StatCell,
  TaskColumnId,
  TaskGroupData,
  TaskRowData,
  TaskSectionData,
  UiStatus,
  UiTone,
} from '@better-tracker/ui';

import {
  daysLeftPhrase,
  dueLabel,
  formatDate,
  formatLongDate,
  greeting,
  plural,
} from '../format';
import { issuePagePath } from './issue';
import { issueListHref, withFilterValues } from './issue-list';
import { barMark, dueTone, progressTone } from './projects';
import { blockedReasonLine, uiStatus, statusLabel } from './status';

// My week (architecture §8.4): turns the engine's WeekView (the person's
// open issues grouped by milestone) and TimelineView (every lane, bar and
// allocation outcome) into the props of the shell's StatsStrip,
// TaskGroupTable, DeadlineList and the "Needs attention" register. Pure
// functions over plain data so every line of copy is unit-tested.
//
// Tones follow architecture §8.2's status table: overdue danger, at risk,
// blocked, unassigned and due today or tomorrow warning, new to you the
// accent; the accent never means a status.
//
// Inactive projects (§2.8; the lane's `active` flag from the engine) are
// never loud here: the person's issues in them stay listed, in greys, but
// no count, deadline or attention row includes them, and the stats say
// how many were left out.

/** Milestones due within this many days count as "this week" (core's rule). */
const THIS_WEEK_DAYS = 6;

/**
 * The task table's meta columns on My week. No project column: every group
 * heading already names the project (milestone groups and the per-project
 * "No milestone" groups alike), and beside the deadlines panel the five
 * column table left issue titles too narrow to read.
 */
export const WEEK_TASK_COLUMNS: TaskColumnId[] = ['state', 'priority', 'due'];

/** One row of the "Needs attention" register (projects the person leads). */
export interface WeekAttentionItem {
  id: string;
  projectName: string;
  /** Line under the name: why it needs attention. */
  detail: string;
  /** Right-aligned chip: "Blocked", "2 unassigned". */
  flag: string;
  /** The chip's tone: warning (blocked, unassigned issues). */
  tone: UiTone;
  href: string;
  /** Accessible name of the whole-row link. */
  rowLabel: string;
}

export interface WeekPageModel {
  userId: string;
  /** The signed-in person is looking at their own week. */
  isSelf: boolean;
  heading: string;
  receipts: string;
  stats: StatCell[];
  sections: TaskSectionData[];
  emptyMessage: string;
  deadlines: DeadlineGroup[];
  attention: WeekAttentionItem[];
  attentionEmpty: string;
  /** The header's quiet link to the same person's issues on the Issues
      page: "All my issues" (`/issues?assignee=me`) on your own week,
      "All of Dev's issues" (`/issues?assignee=<id>`) on someone else's. */
  allIssuesHref: string;
  allIssuesLabel: string;
}

/** Wording and links shared by every part of the page. */
interface WeekCopy {
  /** The page shows the signed-in person's own week. */
  isSelf: boolean;
  /** Their first name ("them" when unknown). */
  name: string;
  /** Where a row's title goes (WeekPageInput.issueHref). */
  issueHref: (identifier: string) => string;
}

export interface WeekPageInput {
  week: WeekView;
  timeline: TimelineView;
  /** The signed-in person (differs from week.userId on someone else's week). */
  viewerId: string;
  /** Workspace-local hour 0–23, for the greeting. */
  hour: number;
  /** How long an auto-assigned issue stays "new" (tuning.newBadgeDays). */
  newBadgeDays: number;
  /**
   * The project of each "No milestone" issue (noMilestoneIssueProjects).
   * Issues missing here fall back to the timeline lanes' unplanned lists.
   */
  issueProjects?: ReadonlyMap<string, { projectId: string; name: string }>;
  /**
   * Where a row's title goes: the page's issue slide-over
   * (`/week?issue=ENG-24`). Default: the issue's page in the planner. The
   * issue in Linear stays one click away as the row's ↗ link.
   */
  issueHref?: (identifier: string) => string;
}

/**
 * The hour (0–23) of an instant in an IANA zone, for "Good morning".
 * Falls back to the UTC hour when the zone is not recognised.
 */
export function localHour(instant: string, timeZone: string): number {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return 12;
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone,
    })
      .formatToParts(date)
      .find((p) => p.type === 'hour');
    const hour = Number(part?.value);
    return Number.isFinite(hour) ? hour % 24 : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/**
 * Whose week to show. Anyone signed in may look at anyone's (`?user=<id>`;
 * owner decision 2026-10-22: no roles), but only at a person the mirror
 * knows; anything else shows the viewer's own week, so a stale or
 * hand-typed id never errors.
 */
export function resolveWeekUserId(input: {
  requested: string | string[] | undefined;
  viewerId: string;
  knownUserIds: ReadonlySet<string>;
}): string {
  const raw = Array.isArray(input.requested)
    ? input.requested[0]
    : input.requested;
  if (raw === undefined || raw === '') return input.viewerId;
  return input.knownUserIds.has(raw) ? raw : input.viewerId;
}

/**
 * Options for the "Showing" person picker everyone gets: people (never app
 * users), active ones by name, then deactivated ones marked so (someone may
 * still need to see what a deactivated lead holds). The viewer is marked
 * "(you)".
 */
export function weekPeopleOptions(
  users: readonly User[],
  viewerId: string
): { id: string; label: string }[] {
  const people = users.filter((user) => !user.app);
  const byName = (a: User, b: User) => a.name.localeCompare(b.name, 'en');
  const active = people.filter((user) => user.active).sort(byName);
  const inactive = people.filter((user) => !user.active).sort(byName);
  return [
    ...active.map((user) => ({
      id: user.id,
      label: user.id === viewerId ? `${user.name} (you)` : user.name,
    })),
    ...inactive.map((user) => ({
      id: user.id,
      label: `${user.name} (deactivated)`,
    })),
  ];
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

function timelineMilestoneHref(milestoneId: string): string {
  return `/timeline?milestone=${encodeURIComponent(milestoneId)}`;
}

function timelineProjectHref(projectId: string): string {
  return `/timeline?project=${encodeURIComponent(projectId)}`;
}

/**
 * Whether a milestone's project is active (§2.8), from the engine's flag
 * on its timeline lane. Only a lane marked inactive quiets it: a milestone
 * with no lane (its project completed or canceled) keeps its status.
 */
function milestoneActive(
  bars: Map<string, { bar: TimelineBar; lane: TimelineLane }>,
  milestoneId: string | null
): boolean {
  if (milestoneId === null) return true;
  return bars.get(milestoneId)?.lane.active ?? true;
}

/** "+1 in an inactive project", "+2 in inactive projects". */
export function inactiveNote(count: number): string {
  return count === 1
    ? '+1 in an inactive project'
    : `+${count} in inactive projects`;
}

/**
 * A stat note that also says how many were left out for being in an
 * inactive project, so a grey overdue group in the list does not seem to
 * contradict the count: the names counted (or, with none, the "+1" note
 * alone in place of `fallback`), then "+1 in an inactive project".
 */
function statNote(
  named: string | null,
  fallback: string,
  inactive: number
): string {
  if (inactive === 0) return named ?? fallback;
  return named === null
    ? inactiveNote(inactive)
    : `${named} · ${inactiveNote(inactive)}`;
}

/** Every bar (dated and undated) by milestone id, with its lane. */
function indexBars(
  timeline: TimelineView
): Map<string, { bar: TimelineBar; lane: TimelineLane }> {
  const index = new Map<string, { bar: TimelineBar; lane: TimelineLane }>();
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      for (const bar of [...lane.bars, ...lane.undated]) {
        index.set(bar.milestoneId, { bar, lane });
      }
    }
  }
  return index;
}

/** The project of an issue in the "No milestone" section. */
interface NoMilestoneProject {
  projectId: string;
  name: string;
  /** The project has a timeline lane (it is not completed or canceled). */
  onTimeline: boolean;
}

/**
 * The project of every issue in the person's "No milestone" section, read
 * from the mirror (the WeekView rows carry no project). Issues without a
 * project are left out.
 */
export function noMilestoneIssueProjects(
  week: WeekView,
  issues: ReadonlyMap<string, Pick<Issue, 'projectId'>>,
  projects: ReadonlyMap<string, Pick<Project, 'id' | 'name'>>
): Map<string, { projectId: string; name: string }> {
  const result = new Map<string, { projectId: string; name: string }>();
  for (const section of week.sections) {
    if (section.milestoneId !== null) continue;
    for (const row of section.rows) {
      const projectId = issues.get(row.issueId)?.projectId ?? null;
      const project = projectId === null ? undefined : projects.get(projectId);
      if (project !== undefined) {
        result.set(row.issueId, { projectId: project.id, name: project.name });
      }
    }
  }
  return result;
}

/**
 * Unplanned (no-milestone) issue id → its project: the timeline lanes
 * first (they link to the lane), then the mirror's issue → project map for
 * issues in completed or canceled projects, which have no lane.
 */
function noMilestoneProjects(
  timeline: TimelineView,
  issueProjects: ReadonlyMap<string, { projectId: string; name: string }>
): Map<string, NoMilestoneProject> {
  const projects = new Map<string, NoMilestoneProject>();
  const lanes = new Set<string>();
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      lanes.add(lane.projectId);
      for (const issueId of lane.unplannedIssueIds) {
        projects.set(issueId, {
          projectId: lane.projectId,
          name: lane.name,
          onTimeline: true,
        });
      }
    }
  }
  for (const [issueId, project] of issueProjects) {
    if (projects.has(issueId)) continue;
    projects.set(issueId, {
      ...project,
      onTimeline: lanes.has(project.projectId),
    });
  }
  return projects;
}

/**
 * A week section's status mark. The timeline bar carries the rubric, so a
 * milestone that is on track but missing an input reads as hatched here
 * too (same mark as on the timeline and in the deadline list); without a
 * bar the plain status mark is used.
 */
function sectionMark(
  section: WeekSection,
  bar: TimelineBar | undefined
): { status: UiStatus; label: string } | null {
  if (bar !== undefined) return barMark(bar);
  if (section.status === null) return null;
  return {
    status: uiStatus(section.status),
    label: statusLabel(section.status),
  };
}

function newChipLabel(
  projectName: string,
  isSelf: boolean,
  name: string
): string {
  const project = projectName === '' ? 'this project' : projectName;
  return isSelf
    ? `New — given to you because you lead ${project}`
    : `New — given to ${name} because they lead ${project}`;
}

function toTaskRow(
  row: WeekIssueRow,
  section: WeekSection,
  projectName: string | undefined,
  today: string,
  copy: WeekCopy,
  active = true
): TaskRowData {
  // A row's due date is its milestone's, coloured like it (§8.2).
  const tone =
    !active || section.targetDate === null
      ? 'default'
      : dueTone(section.status, section.daysLeft, false);
  return {
    id: row.issueId,
    key: row.identifier,
    title: row.title,
    href: copy.issueHref(row.identifier),
    externalHref: row.url,
    externalLabel: `Open ${row.identifier} in Linear`,
    project: projectName,
    state: row.stateName === '' ? row.stateType : row.stateName,
    stateKind: row.stateType,
    priority: row.priority,
    priorityLabel: PRIORITY_LABEL[row.priority],
    due:
      section.targetDate === null
        ? undefined
        : formatDate(section.targetDate, today),
    dueTone: tone === 'default' ? undefined : tone,
    chips:
      row.newBecauseLeadOf === null
        ? undefined
        : [
            {
              label: newChipLabel(row.newBecauseLeadOf, copy.isSelf, copy.name),
              tone: 'accent',
            },
          ],
  };
}

/**
 * One milestone group of the person's issues. A milestone in an inactive
 * project (§2.8) is drawn quietly: a grey mark still named with its
 * status, "Inactive project" where the days left would be, and no status
 * colour on its date or progress (a grey fill).
 */
function toTaskGroup(
  section: WeekSection,
  bar: TimelineBar | undefined,
  today: string,
  copy: WeekCopy,
  active = true
): TaskGroupData {
  const milestoneId = section.milestoneId ?? '';
  const mark = sectionMark(section, bar);
  const overdue = section.status === 'overdue';
  const undated = section.targetDate === null;
  // The bar knows the risk reasons (behind pace); without one, only an
  // overdue milestone's progress is called out.
  const tone =
    bar !== undefined ? progressTone(bar) : overdue ? 'danger' : 'default';
  const due = dueTone(section.status, section.daysLeft, undated);
  const quiet = {
    statusLabel: mark === null ? undefined : `${mark.label} · inactive project`,
    daysLeftLabel: 'Inactive project',
    muted: true,
  };
  return {
    id: milestoneId,
    eyebrow: section.projectName ?? undefined,
    title: section.milestoneName ?? 'Untitled milestone',
    href: timelineMilestoneHref(milestoneId),
    status: mark?.status,
    statusLabel: mark?.label,
    dueLabel:
      section.targetDate === null
        ? dueLabel(null, null, today)
        : formatDate(section.targetDate, today),
    daysLeftLabel:
      section.daysLeft === null ? undefined : daysLeftPhrase(section.daysLeft),
    dueTone: due === 'default' ? undefined : due,
    ...(active ? {} : { ...quiet, dueTone: undefined }),
    progress:
      section.progress === null
        ? undefined
        : {
            done: section.progress.completed,
            total: section.progress.scope,
            tone: active ? tone : 'muted',
          },
    rows: section.rows.map((row) =>
      toTaskRow(
        row,
        section,
        section.projectName ?? undefined,
        today,
        copy,
        active
      )
    ),
  };
}

/**
 * The "No milestone" section's groups: one per project (Project / Issues
 * without a milestone, linking to that project's lane, where anyone can
 * attach them to a milestone or cancel them; a completed or canceled
 * project has no lane, so its group has no link), in the order the rows
 * come, then issues with no
 * project at all. The project lives in the group heading, as it does for
 * milestone groups, so the table needs no project column.
 */
function noMilestoneGroups(
  section: WeekSection,
  unplanned: Map<string, NoMilestoneProject>,
  today: string,
  copy: WeekCopy
): TaskGroupData[] {
  const groups = new Map<string, TaskGroupData>();
  const orphans: TaskRowData[] = [];
  for (const row of section.rows) {
    const project = unplanned.get(row.issueId);
    const taskRow = toTaskRow(row, section, project?.name, today, copy);
    if (project === undefined) {
      orphans.push(taskRow);
      continue;
    }
    const existing = groups.get(project.projectId);
    if (existing !== undefined) {
      existing.rows.push(taskRow);
      continue;
    }
    groups.set(project.projectId, {
      id: `no-milestone:${project.projectId}`,
      eyebrow: project.name,
      title: 'Issues without a milestone',
      href: project.onTimeline
        ? timelineProjectHref(project.projectId)
        : undefined,
      rows: [taskRow],
    });
  }
  const result = [...groups.values()];
  if (orphans.length > 0) {
    result.push({
      id: 'no-milestone:none',
      title: 'Issues without a project or milestone',
      rows: orphans,
    });
  }
  return result;
}

/**
 * This week / Later / No milestone in the engine's display order (overdue
 * first, then weight, then date). "This week" is always present once there
 * is anything at all, so "nothing due this week" is said rather than
 * implied; the other two appear only when they hold something.
 */
function buildSections(
  week: WeekView,
  bars: Map<string, { bar: TimelineBar; lane: TimelineLane }>,
  unplanned: Map<string, NoMilestoneProject>,
  copy: WeekCopy
): TaskSectionData[] {
  // THIS WEEK is shown even when empty; it says so in the planner's words.
  const nothingDue = copy.isSelf
    ? 'Nothing of yours is due this week.'
    : `Nothing of ${copy.name}'s is due this week.`;
  const thisWeek: TaskGroupData[] = [];
  const later: TaskGroupData[] = [];
  const noMilestone: TaskGroupData[] = [];
  for (const section of week.sections) {
    if (section.milestoneId === null) {
      noMilestone.push(
        ...noMilestoneGroups(section, unplanned, week.today, copy)
      );
      continue;
    }
    const group = toTaskGroup(
      section,
      bars.get(section.milestoneId)?.bar,
      week.today,
      copy,
      milestoneActive(bars, section.milestoneId)
    );
    (section.thisWeek ? thisWeek : later).push(group);
  }
  if (thisWeek.length + later.length + noMilestone.length === 0) return [];
  const sections: TaskSectionData[] = [
    {
      id: 'this-week',
      label: 'This week',
      emptyLabel: nothingDue,
      groups: thisWeek,
    },
  ];
  if (later.length > 0) {
    sections.push({ id: 'later', label: 'Later', groups: later });
  }
  if (noMilestone.length > 0) {
    sections.push({
      id: 'no-milestone',
      label: 'No milestone',
      groups: noMilestone,
    });
  }
  return sections;
}

/** "Project · Milestone", or "… and 2 more" for a list of them. */
function nameList(items: { project: string; milestone: string }[]): string {
  const [first, ...rest] = items;
  if (first === undefined) return '';
  const head = `${first.project} · ${first.milestone}`;
  return rest.length === 0 ? head : `${head} and ${rest.length} more`;
}

/**
 * Milestones in active projects the person leads whose status (§2.5) is
 * overdue or at risk, overdue first. Only those two statuses count: a
 * blocked project whose next milestone is still on track (or due beyond
 * warnLeadDays) is not "at risk"; it is listed under "Needs attention"
 * with its block reason instead. Inactive projects (§2.8) are left out;
 * `inactive: true` lists theirs instead, for the "+1" note.
 */
export function atRiskInLedProjects(
  timeline: TimelineView,
  userId: string,
  { inactive = false }: { inactive?: boolean } = {}
): { milestoneId: string; project: string; milestone: string }[] {
  const overdue: { milestoneId: string; project: string; milestone: string }[] =
    [];
  const atRisk: typeof overdue = [];
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== userId || lane.active === inactive) continue;
      for (const bar of [...lane.bars, ...lane.undated]) {
        const item = {
          milestoneId: bar.milestoneId,
          project: lane.name,
          milestone: bar.name,
        };
        if (bar.status === 'overdue') overdue.push(item);
        else if (bar.status === 'at_risk') atRisk.push(item);
      }
    }
  }
  return [...overdue, ...atRisk];
}

/**
 * The overdue milestones the person has open issues in, split by whether
 * their project is active (§2.8): only active ones are counted.
 */
function overdueSections(
  week: WeekView,
  bars: Map<string, { bar: TimelineBar; lane: TimelineLane }>
): { active: WeekSection[]; inactive: number } {
  const active: WeekSection[] = [];
  let inactive = 0;
  for (const section of week.sections) {
    if (section.status !== 'overdue' || section.milestoneId === null) continue;
    if (milestoneActive(bars, section.milestoneId)) active.push(section);
    else inactive += 1;
  }
  return { active, inactive };
}

function buildStats(
  week: WeekView,
  timeline: TimelineView,
  bars: Map<string, { bar: TimelineBar; lane: TimelineLane }>,
  copy: WeekCopy,
  newBadgeDays: number,
  leadsProjects: boolean
): StatCell[] {
  const late = overdueSections(week, bars);
  const overdueNames = late.active.map((section) => ({
    project: section.projectName ?? '',
    milestone: section.milestoneName ?? '',
  }));
  const onlyOverdueId =
    late.active.length === 1 ? late.active[0]?.milestoneId : null;
  const overdueNote = statNote(
    overdueNames.length === 0 ? null : nameList(overdueNames),
    'None',
    late.inactive
  );

  const newProjects = new Set<string>();
  for (const section of week.sections) {
    for (const row of section.rows) {
      if (row.newBecauseLeadOf !== null) newProjects.add(row.newBecauseLeadOf);
    }
  }
  const [onlyNewProject] = [...newProjects];
  const leadVerb = copy.isSelf ? 'you lead' : 'they lead';
  const newNote =
    week.totals.new === 0
      ? `None in the last ${plural(newBadgeDays, 'day')}`
      : newProjects.size === 1 && onlyNewProject !== undefined
        ? `Because ${leadVerb} ${onlyNewProject === '' ? 'the project' : onlyNewProject}`
        : `Because ${leadVerb} ${plural(newProjects.size, 'project')}`;

  const risky = atRiskInLedProjects(timeline, week.userId);
  const quietRisky = atRiskInLedProjects(timeline, week.userId, {
    inactive: true,
  }).length;
  const onlyRisky = risky.length === 1 ? risky[0] : undefined;
  const riskNote = statNote(
    risky.length > 0 ? nameList(risky) : null,
    leadsProjects
      ? 'Nothing at risk or overdue'
      : copy.isSelf
        ? 'You lead no projects'
        : `${copy.name} leads no projects`,
    quietRisky
  );

  return [
    {
      id: 'open',
      label: 'Open issues',
      value: week.totals.open,
      note: `${week.totals.thisWeek} this week`,
    },
    {
      id: 'overdue',
      label: 'Overdue milestones',
      value: late.active.length,
      note: overdueNote,
      tone: late.active.length > 0 ? 'danger' : 'default',
      href:
        onlyOverdueId === null || onlyOverdueId === undefined
          ? undefined
          : timelineMilestoneHref(onlyOverdueId),
    },
    {
      id: 'new',
      label: copy.isSelf ? 'New to you' : `New to ${copy.name}`,
      value: week.totals.new,
      note: newNote,
      tone: week.totals.new > 0 ? 'accent' : 'default',
    },
    {
      id: 'risk',
      label: copy.isSelf
        ? 'At risk in your projects'
        : `At risk in ${copy.name}'s projects`,
      value: risky.length,
      note: riskNote,
      tone: risky.length > 0 ? 'warning' : 'default',
      href:
        onlyRisky === undefined
          ? undefined
          : timelineMilestoneHref(onlyRisky.milestoneId),
    },
  ];
}

/**
 * Upcoming deadlines (Gr8r's panel): dated, not-yet-complete milestones the
 * person leads or has open issues in, grouped Overdue / Today / Tomorrow /
 * This week (up to six days out). Each group lists the nearest first.
 * Milestones of inactive projects (§2.8) are not deadlines: left out.
 */
function buildDeadlines(
  week: WeekView,
  timeline: TimelineView,
  bars: Map<string, { bar: TimelineBar; lane: TimelineLane }>
): DeadlineGroup[] {
  const ids = new Set<string>();
  for (const section of week.sections) {
    if (section.milestoneId !== null) ids.add(section.milestoneId);
  }
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== week.userId) continue;
      for (const bar of lane.bars) ids.add(bar.milestoneId);
    }
  }

  const overdue: { item: DeadlineItem; daysLeft: number }[] = [];
  const today: typeof overdue = [];
  const tomorrow: typeof overdue = [];
  const soon: typeof overdue = [];
  for (const id of ids) {
    const entry = bars.get(id);
    if (entry === undefined) continue;
    const { bar, lane } = entry;
    if (!lane.active) continue;
    if (bar.end === null || bar.daysLeft === null) continue;
    if (bar.status === 'complete') continue;
    const mark = barMark(bar);
    const open = bar.progress.open;
    const unassigned = bar.progress.openUnassigned;
    const item: DeadlineItem = {
      id: bar.milestoneId,
      label: bar.name,
      // The count first, then the project: the panel is narrow and cuts the
      // line's end, and unassigned issues are what needs someone to act.
      sublabel: `${
        unassigned > 0 ? `${unassigned} unassigned` : `${open} open`
      } · ${lane.name}`,
      href: timelineMilestoneHref(bar.milestoneId),
      status: mark.status,
      statusLabel: mark.label,
      dueLabel: formatDate(bar.end, week.today),
    };
    const entryWithDays = { item, daysLeft: bar.daysLeft };
    if (bar.status === 'overdue') overdue.push(entryWithDays);
    else if (bar.daysLeft === 0) today.push(entryWithDays);
    else if (bar.daysLeft === 1) tomorrow.push(entryWithDays);
    else if (bar.daysLeft > 1 && bar.daysLeft <= THIS_WEEK_DAYS) {
      soon.push(entryWithDays);
    }
  }
  const sorted = (list: typeof overdue) =>
    [...list]
      .sort((a, b) =>
        a.daysLeft === b.daysLeft
          ? a.item.label.localeCompare(b.item.label, 'en')
          : a.daysLeft - b.daysLeft
      )
      .map((entry) => entry.item);
  return [
    {
      id: 'overdue',
      label: 'Overdue',
      // Overdue is danger and due today or tomorrow a warning (§8.2); an
      // empty group stays neutral.
      tone: overdue.length > 0 ? 'danger' : 'default',
      items: sorted(overdue),
    },
    {
      id: 'today',
      label: 'Today',
      tone: today.length > 0 ? 'warning' : 'default',
      items: sorted(today),
    },
    {
      id: 'tomorrow',
      label: 'Tomorrow',
      tone: tomorrow.length > 0 ? 'warning' : 'default',
      items: sorted(tomorrow),
    },
    { id: 'this-week', label: 'This week', items: sorted(soon) },
  ];
}

/**
 * Needs attention: active projects the person leads whose allocation is
 * blocked (with the reason and the missing rubric items), or whose next
 * milestone still has open unassigned issues. Blocked projects first, each
 * project once, otherwise in timeline order. An inactive project (§2.8)
 * never needs attention here: nothing in it is allocated or warned about.
 */
export function buildAttention(
  timeline: TimelineView,
  userId: string
): WeekAttentionItem[] {
  const blocked: WeekAttentionItem[] = [];
  const unassigned: WeekAttentionItem[] = [];
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== userId || !lane.active) continue;
      const bars = [...lane.bars, ...lane.undated];
      const next = bars.find((bar) => bar.isNext);
      const plan = lane.allocation;
      if (plan?.outcome === 'blocked' && plan.blockReason !== null) {
        const detail = blockedReasonLine(plan.blockReason, plan.gaps);
        blocked.push({
          id: lane.projectId,
          projectName: lane.name,
          detail,
          flag: 'Blocked',
          tone: 'warning',
          href:
            plan.nextMilestoneId === null
              ? timelineProjectHref(lane.projectId)
              : timelineMilestoneHref(plan.nextMilestoneId),
          rowLabel: `${lane.name}: allocation blocked. ${detail}`,
        });
        continue;
      }
      if (next !== undefined && next.progress.openUnassigned > 0) {
        const count = next.progress.openUnassigned;
        unassigned.push({
          id: lane.projectId,
          projectName: lane.name,
          detail: `Next: ${next.name}`,
          flag: `${count} unassigned`,
          tone: 'warning',
          href: timelineMilestoneHref(next.milestoneId),
          rowLabel: `${lane.name}: ${plural(count, 'open issue')} unassigned in ${next.name}`,
        });
      }
    }
  }
  return [...blocked, ...unassigned];
}

/** Whether the person leads any project on the timeline. */
function leadsAnyProject(timeline: TimelineView, userId: string): boolean {
  return timeline.groups.some((group) =>
    group.lanes.some((lane) => lane.leadId === userId)
  );
}

/** Names of the inactive projects the person leads, in timeline order. */
function inactiveLedProjects(timeline: TimelineView, userId: string): string[] {
  return timeline.groups.flatMap((group) =>
    group.lanes
      .filter((lane) => lane.leadId === userId && !lane.active)
      .map((lane) => lane.name)
  );
}

/**
 * The "Needs attention" empty line. When the person leads inactive
 * projects it says they are left out, so a paused project with unassigned
 * issues is not mistaken for one that was missed.
 */
function attentionEmptyLine(
  timeline: TimelineView,
  userId: string,
  copy: WeekCopy,
  leadsProjects: boolean
): string {
  if (!leadsProjects) {
    return copy.isSelf
      ? 'You lead no projects'
      : `${copy.name} leads no projects`;
  }
  const base = copy.isSelf
    ? 'Nothing needs attention in the projects you lead'
    : `Nothing needs attention in the projects ${copy.name} leads`;
  const inactive = inactiveLedProjects(timeline, userId);
  if (inactive.length === 0) return base;
  return inactive.length === 1
    ? `${base}. ${inactive[0]} is inactive, so it is left out`
    : `${base}. ${inactive.length} inactive projects are left out`;
}

/** Everything the /week page renders, from the two engine views. */
export function buildWeekPage(input: WeekPageInput): WeekPageModel {
  const { week, timeline } = input;
  const isSelf = week.userId === input.viewerId;
  const name = firstName(week.userName);
  const copy: WeekCopy = {
    isSelf,
    name: name === '' ? 'them' : name,
    issueHref: input.issueHref ?? issuePagePath,
  };
  const bars = indexBars(timeline);
  const unplanned = noMilestoneProjects(
    timeline,
    input.issueProjects ?? new Map()
  );
  const leadsProjects = leadsAnyProject(timeline, week.userId);

  const heading = isSelf
    ? name === ''
      ? greeting(input.hour)
      : `${greeting(input.hour)}, ${name}`
    : week.userName === ''
      ? 'Their week'
      : `${week.userName}'s week`;

  // Overdue counts active projects only, like the stat (§2.8).
  const overdue = overdueSections(week, bars).active.length;
  const receiptParts = [
    formatLongDate(week.today),
    week.totals.thisWeek === 0
      ? 'Nothing due this week'
      : `${plural(week.totals.thisWeek, 'issue')} due this week`,
  ];
  if (overdue > 0) {
    receiptParts.push(`${plural(overdue, 'milestone')} overdue`);
  }

  return {
    userId: week.userId,
    isSelf,
    heading,
    receipts: receiptParts.join(' · '),
    stats: buildStats(
      week,
      timeline,
      bars,
      copy,
      input.newBadgeDays,
      leadsProjects
    ),
    sections: buildSections(week, bars, unplanned, copy),
    emptyMessage: isSelf
      ? "Nothing assigned to you is open. Work in your projects' next milestones lands here when the daily run assigns it."
      : `Nothing assigned to ${week.userName === '' ? 'this person' : week.userName} is open.`,
    deadlines: buildDeadlines(week, timeline, bars),
    attention: buildAttention(timeline, week.userId),
    attentionEmpty: attentionEmptyLine(
      timeline,
      week.userId,
      copy,
      leadsProjects
    ),
    allIssuesHref: issueListHref(
      withFilterValues(DEFAULT_ISSUE_LIST_QUERY, 'assigneeIds', [
        isSelf ? LIST_ME : week.userId,
      ])
    ),
    allIssuesLabel: isSelf
      ? 'All my issues'
      : name === ''
        ? 'All their issues'
        : `All of ${name}'s issues`,
  };
}
