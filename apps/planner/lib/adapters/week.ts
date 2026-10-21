import {
  BLOCK_REASON_LABEL,
  type Issue,
  PRIORITY_LABEL,
  type Project,
  RUBRIC_GAP_SHORT_LABEL,
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
} from '@better-tracker/ui';

import {
  daysLeftPhrase,
  dueLabel,
  formatDate,
  formatLongDate,
  greeting,
  plural,
} from '../format';
import { barMark, progressTone } from './projects';
import { uiStatus, statusLabel } from './status';

// My week (architecture §8.4): turns the engine's WeekView (the person's
// open issues grouped by milestone) and TimelineView (every lane, bar and
// allocation outcome) into the props of the shell's StatsStrip,
// TaskGroupTable, DeadlineList and the "Needs attention" register. Pure
// functions over plain data so every line of copy is unit-tested.

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
  /** Mono line under the name: why it needs attention. */
  detail: string;
  /** Right-aligned accent flag: "Blocked", "2 unassigned". */
  flag: string;
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
}

export interface WeekPageInput {
  week: WeekView;
  timeline: TimelineView;
  /** The signed-in person (may differ from week.userId for a PM). */
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
 * Whose week to show. Only PMs may look at someone else's (`?user=<id>`),
 * and only at a person the mirror knows; anything else shows the viewer's
 * own week, so a stale or hand-typed id never errors.
 */
export function resolveWeekUserId(input: {
  requested: string | string[] | undefined;
  viewerId: string;
  isPm: boolean;
  knownUserIds: ReadonlySet<string>;
}): string {
  if (!input.isPm) return input.viewerId;
  const raw = Array.isArray(input.requested)
    ? input.requested[0]
    : input.requested;
  if (raw === undefined || raw === '') return input.viewerId;
  return input.knownUserIds.has(raw) ? raw : input.viewerId;
}

/**
 * Options for the PM's person picker: people (never app users), active
 * ones by name, then deactivated ones marked so (a PM may still need to see
 * what a deactivated lead holds). The viewer is marked "(you)".
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
  copy: { isSelf: boolean; name: string }
): TaskRowData {
  const overdue = section.status === 'overdue';
  return {
    id: row.issueId,
    key: row.identifier,
    title: row.title,
    href: row.url,
    external: true,
    project: projectName,
    state: row.stateName === '' ? row.stateType : row.stateName,
    stateKind: row.stateType,
    priority: row.priority,
    priorityLabel: PRIORITY_LABEL[row.priority],
    due:
      section.targetDate === null
        ? undefined
        : formatDate(section.targetDate, today),
    dueTone: overdue ? 'accent' : undefined,
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

function toTaskGroup(
  section: WeekSection,
  bar: TimelineBar | undefined,
  today: string,
  copy: { isSelf: boolean; name: string }
): TaskGroupData {
  const milestoneId = section.milestoneId ?? '';
  const mark = sectionMark(section, bar);
  const overdue = section.status === 'overdue';
  const undated = section.targetDate === null;
  // The bar knows the risk reasons (behind pace); without one, only an
  // overdue milestone's progress is called out.
  const tone =
    bar !== undefined ? progressTone(bar) : overdue ? 'accent' : 'default';
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
    dueTone: overdue || undated ? 'accent' : undefined,
    progress:
      section.progress === null
        ? undefined
        : {
            done: section.progress.completed,
            total: section.progress.scope,
            tone,
          },
    rows: section.rows.map((row) =>
      toTaskRow(row, section, section.projectName ?? undefined, today, copy)
    ),
  };
}

/**
 * The "No milestone" section's groups: one per project (PROJECT › Issues
 * without a milestone, linking to that project's lane, where the PM attaches
 * or cancels them; a completed or canceled project has no lane, so its
 * group has no link), in the order the rows come, then issues with no
 * project at all. The project lives in the group heading, as it does for
 * milestone groups, so the table needs no project column.
 */
function noMilestoneGroups(
  section: WeekSection,
  unplanned: Map<string, NoMilestoneProject>,
  today: string,
  copy: { isSelf: boolean; name: string }
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
 * THIS WEEK / LATER / NO MILESTONE in the engine's display order (overdue
 * first, then weight, then date). "This week" is always present once there
 * is anything at all, so "nothing due this week" is said rather than
 * implied; the other two appear only when they hold something.
 */
function buildSections(
  week: WeekView,
  bars: Map<string, { bar: TimelineBar; lane: TimelineLane }>,
  unplanned: Map<string, NoMilestoneProject>,
  copy: { isSelf: boolean; name: string }
): TaskSectionData[] {
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
      copy
    );
    (section.thisWeek ? thisWeek : later).push(group);
  }
  if (thisWeek.length + later.length + noMilestone.length === 0) return [];
  const sections: TaskSectionData[] = [
    { id: 'this-week', label: 'This week', groups: thisWeek },
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
 * Milestones in projects the person leads whose status (§2.5) is overdue
 * or at risk, overdue first. Only those two statuses count: a blocked
 * project whose next milestone is still on track (or due beyond
 * warnLeadDays) is not "at risk"; it is listed under "Needs attention"
 * with its block reason instead.
 */
export function atRiskInLedProjects(
  timeline: TimelineView,
  userId: string
): { milestoneId: string; project: string; milestone: string }[] {
  const overdue: { milestoneId: string; project: string; milestone: string }[] =
    [];
  const atRisk: typeof overdue = [];
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== userId) continue;
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

function buildStats(
  week: WeekView,
  timeline: TimelineView,
  copy: { isSelf: boolean; name: string },
  newBadgeDays: number,
  leadsProjects: boolean
): StatCell[] {
  const overdueSections = week.sections.filter(
    (section) => section.status === 'overdue' && section.milestoneId !== null
  );
  const overdueNames = overdueSections.map((section) => ({
    project: section.projectName ?? '',
    milestone: section.milestoneName ?? '',
  }));
  const onlyOverdueId =
    overdueSections.length === 1 ? overdueSections[0]?.milestoneId : null;

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
  const onlyRisky = risky.length === 1 ? risky[0] : undefined;
  const riskNote =
    risky.length > 0
      ? nameList(risky)
      : leadsProjects
        ? 'Nothing at risk or overdue'
        : copy.isSelf
          ? 'You lead no projects'
          : `${copy.name} leads no projects`;

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
      value: week.totals.overdue,
      note: overdueNames.length === 0 ? 'None' : nameList(overdueNames),
      tone: week.totals.overdue > 0 ? 'accent' : 'default',
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
    },
    {
      id: 'risk',
      label: copy.isSelf
        ? 'At risk in your projects'
        : `At risk in ${copy.name}'s projects`,
      value: risky.length,
      note: riskNote,
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
    { id: 'overdue', label: 'Overdue', tone: 'accent', items: sorted(overdue) },
    { id: 'today', label: 'Today', items: sorted(today) },
    { id: 'tomorrow', label: 'Tomorrow', items: sorted(tomorrow) },
    { id: 'this-week', label: 'This week', items: sorted(soon) },
  ];
}

/**
 * Needs attention: projects the person leads whose allocation is blocked
 * (with the reason and the missing rubric items), or whose next milestone
 * still has open unassigned issues. Blocked projects first, each project
 * once, otherwise in timeline order.
 */
export function buildAttention(
  timeline: TimelineView,
  userId: string
): WeekAttentionItem[] {
  const blocked: WeekAttentionItem[] = [];
  const unassigned: WeekAttentionItem[] = [];
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== userId) continue;
      const bars = [...lane.bars, ...lane.undated];
      const next = bars.find((bar) => bar.isNext);
      const plan = lane.allocation;
      if (plan?.outcome === 'blocked' && plan.blockReason !== null) {
        const gaps = plan.gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]);
        const reason = BLOCK_REASON_LABEL[plan.blockReason];
        const detail =
          gaps.length > 0 ? `${reason}: ${gaps.join(', ')}` : reason;
        blocked.push({
          id: lane.projectId,
          projectName: lane.name,
          detail,
          flag: 'Blocked',
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

/** Everything the /week page renders, from the two engine views. */
export function buildWeekPage(input: WeekPageInput): WeekPageModel {
  const { week, timeline } = input;
  const isSelf = week.userId === input.viewerId;
  const name = firstName(week.userName);
  const copy = { isSelf, name: name === '' ? 'them' : name };
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

  const receiptParts = [
    formatLongDate(week.today),
    week.totals.thisWeek === 0
      ? 'Nothing due this week'
      : `${plural(week.totals.thisWeek, 'issue')} due this week`,
  ];
  if (week.totals.overdue > 0) {
    receiptParts.push(`${plural(week.totals.overdue, 'milestone')} overdue`);
  }

  return {
    userId: week.userId,
    isSelf,
    heading,
    receipts: receiptParts.join(' · '),
    stats: buildStats(week, timeline, copy, input.newBadgeDays, leadsProjects),
    sections: buildSections(week, bars, unplanned, copy),
    emptyMessage: isSelf
      ? "Nothing assigned to you is open. Work in your projects' next milestones lands here when the daily run assigns it."
      : `Nothing assigned to ${week.userName === '' ? 'this person' : week.userName} is open.`,
    deadlines: buildDeadlines(week, timeline, bars),
    attention: buildAttention(timeline, week.userId),
    attentionEmpty: !leadsProjects
      ? isSelf
        ? 'You lead no projects'
        : `${copy.name} leads no projects`
      : isSelf
        ? 'Nothing needs attention in the projects you lead'
        : `Nothing needs attention in the projects ${copy.name} leads`,
  };
}
