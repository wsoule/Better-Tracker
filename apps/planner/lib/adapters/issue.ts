import {
  COMMENT_MAX_LENGTH,
  diffDays,
  estimateLabel,
  type EstimateScale,
  type Issue,
  ISSUE_DESCRIPTION_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
  type IssueComment,
  type IssueDetail,
  type IssueDetailMilestone,
  type IssuePersonRef,
  type IssueRelationRow,
  PRIORITY_LABEL,
  RUBRIC_GAP_SHORT_LABEL,
  type Snapshot,
  todayIn,
  type WorkflowStateType,
} from '@better-tracker/core';
import type { IssueDetailResult } from '@better-tracker/engine';
import type {
  EstimateChoice,
  LabelChoice,
  PersonChoice,
  PlanChoice,
  ShellCrumb,
  StateChoice,
  TaskActivityItem,
  TaskComment,
  TaskDetailAlert,
  TaskPriority,
  TaskStateKind,
  UiStatus,
  UiTone,
} from '@better-tracker/ui';

import { formatDate, plural } from '../format';
import { chainHref } from './graph-scope';
import { assessmentMark } from './status';

// The issue page and the issue slide-over (architecture §8.5, owner
// decision 2026-10-21): the engine's IssueDetailResult (mirror facts plus
// the live description, labels, estimate, due date and comments) mapped
// onto the task family's vocabulary. Everything here is plain data, so a
// server page can hand it to the client island that adds the edit controls
// (app/(app)/components/issue-task.tsx); the read-only wording, the alerts
// and the picker options are decided here, once, and unit-tested.
//
// Tones follow the status colours of architecture §8.2: danger (red) for
// what is overdue or failed, warning (amber) for blocked, holds up,
// stalled, unassigned, a missing or deactivated lead and a due date today
// or tomorrow, muted for the quiet. Inactive projects (§2.8) are never
// loud: an issue in one gets no alert strip, a grey milestone mark and no
// tone anywhere.

/** One allocation run entry about the issue (newest first). */
export type IssueHistoryEntry = IssueDetailResult['allocationHistory'][number];

/** How a read-only property value is drawn. */
export interface IssueFact {
  text: string;
  tone: UiTone;
  /** A sentence under the value. */
  note?: string;
  noteTone?: UiTone;
  /** Tabular figures (dates, durations, estimates). */
  mono?: boolean;
  /** The labels as chips (name and Linear's colour) instead of `text`. */
  labels?: { name: string; color: string }[];
  /** A person's round avatar before the text: their name, or '' for the
      dashed empty avatar (nobody). */
  avatar?: string;
  /** A leading glyph: the priority bars or a milestone status mark. */
  glyph?:
    | { kind: 'priority'; priority: TaskPriority }
    | { kind: 'status'; status: UiStatus; label: string; muted: boolean };
}

/** A blocks relation row, before the client adds its links and buttons. */
export interface IssueRelationModel {
  /** The Linear relation id (DELETE /api/relations/[id]). */
  relationId: string;
  /** The other issue. */
  issueId: string;
  taskKey: string;
  title: string;
  state: { kind: TaskStateKind; label: string };
  /** null prints "Unassigned". */
  assignee: string | null;
  /** "Beacon search / Search v2 beta", or "No project". */
  context: string;
  external: boolean;
  resolved: boolean;
}

/** The current values the edit controls start from. */
export interface IssueEditValues {
  title: string;
  stateId: string | null;
  assigneeId: string | null;
  priority: TaskPriority;
  projectId: string | null;
  milestoneId: string | null;
  /** The live fields: null when Linear could not be read (not editable). */
  live: {
    description: string;
    labelIds: string[];
    estimate: number | null;
    dueDate: string | null;
  } | null;
}

/** What the edit controls may offer (from the mirror and the live read). */
export interface IssueEditModel {
  values: IssueEditValues;
  states: StateChoice[];
  people: PersonChoice[];
  /** Printed when the assignee is not assignable any more (deactivated). */
  assigneeLabel?: string;
  projects: PlanChoice[];
  /** Printed when the project is not among `projects`. */
  projectLabel?: string;
  /** Each project's milestones, in project order. */
  milestones: Record<string, PlanChoice[]>;
  milestoneLabel?: string;
  labels: LabelChoice[];
  /** The team's scale; null when the team does not estimate or the scale
      could not be read (then the estimate is read-only). */
  estimates: EstimateChoice[] | null;
  limits: { title: number; description: number; comment: number };
}

/** The issue as the task view shows it. */
export interface IssueTaskModel {
  issueId: string;
  /** Identifier, e.g. "ENG-24". */
  key: string;
  title: string;
  linearUrl: string;
  /** The planner's page for it: /issues/ENG-24. */
  pagePath: string;
  /** The workspace's today (YYYY-MM-DD). */
  today: string;
  /** The signed-in person ("You" in the assignee picker). */
  viewerId: string;
  closed: boolean;
  /** In an inactive project (§2.8): drawn quietly. */
  quiet: boolean;
  /** Project / Milestone / KEY, linking to the timeline. */
  crumbs: ShellCrumb[];
  /** Its blocking chain as a graph (issueChainHref), shown beside
      "Blocked by" (or "Blocks" when nothing blocks it) for everyone,
      guests too; null with no relation, or when the view is drawn over
      that chain (IssueTaskInput.pageHref). */
  chainHref: string | null;
  milestone: { id: string; name: string } | null;
  status: { kind: TaskStateKind; label: string };
  alerts: TaskDetailAlert[];
  facts: {
    assignee: IssueFact;
    priority: IssueFact;
    labels: IssueFact;
    estimate: IssueFact;
    dueDate: IssueFact;
    project: IssueFact;
    milestone: IssueFact;
    inState: IssueFact;
  };
  description: {
    text: string | null;
    error: string | null;
    sourceLabel: string;
  };
  relations: {
    blockedBy: IssueRelationModel[];
    blocks: IssueRelationModel[];
    /** Relations with issues the planner does not hold, as one sentence. */
    hiddenNote: string | null;
  };
  comments: {
    items: TaskComment[];
    error: string | null;
    /** "From Linear", or that Linear holds more than were read. */
    note: string;
  };
  activity: TaskActivityItem[];
  /** The viewer's Linear token may write: show the edit controls. */
  canEdit: boolean;
  /**
   * The viewer is a Linear guest (owner decision 2026-10-22, "Guests
   * limited to read only"): no edit controls, no comment composer, no
   * relation pickers, and the read-only notice instead of "Allow edits in
   * Linear" (a guest is never offered the write grant).
   */
  readOnly: boolean;
  /** Where the viewer allows edits (grant_write), coming back here. */
  grantWriteHref: string;
  /** Linear could not be read live: the page shows the mirror only. */
  liveError: string | null;
  edit: IssueEditModel;
}

export interface IssueTaskInput {
  result: IssueDetailResult;
  /** The workspace's today and timezone (instants become local dates). */
  today: string;
  timeZone: string;
  /** The signed-in person (their assignments read "you"). */
  viewerId: string;
  /** The grant_write link for this view (lib/http grantWriteHref). */
  grantWriteHref: string;
  /** The page this view is drawn on, without its ?issue= (a slide-over's
      host page). A Graph link to it is left out: on /graph?chain=ENG-24
      ENG-24's own chain is already the page, and the link would only close
      the slide-over. */
  pageHref?: string;
}

/* ---- links ----------------------------------------------------------- */

/** The issue's page in the planner. */
export function issuePagePath(identifier: string): string {
  return `/issues/${encodeURIComponent(identifier)}`;
}

/**
 * `href` (a path with an optional query) with `?issue=` set to `key`, or
 * removed when `key` is null, keeping every other parameter: the link that
 * opens (or closes) the issue slide-over on the current page.
 */
export function withIssueParam(href: string, key: string | null): string {
  const at = href.indexOf('?');
  const path = at === -1 ? href : href.slice(0, at);
  const params = new URLSearchParams(at === -1 ? '' : href.slice(at + 1));
  if (key === null) params.delete('issue');
  else params.set('issue', key);
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

/** The ?issue= value of a page's search params (the first, trimmed). */
export function parseIssueParam(
  params: Record<string, string | string[] | undefined>
): string | null {
  const raw = params.issue;
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return value === '' || value.length > 200 ? null : value;
}

/* ---- finding issues in the mirror --------------------------------------- */

/**
 * The mirrored issue a URL names: its id, or its identifier in any case
 * ("ENG-24", "eng-24"). It moved to core so the engine resolves `?chain=`
 * keys the same way; re-exported for the planner's routes and loaders.
 */
export { findIssue } from '@better-tracker/core';

/**
 * The issue's blocking chain as a graph (`/graph?chain=ENG-24`), or null
 * when it neither blocks nor waits on an issue the planner holds: that
 * chain would be the issue alone, an empty graph.
 */
export function issueChainHref(detail: IssueDetail): string | null {
  return detail.blockedBy.length > 0 || detail.blocks.length > 0
    ? chainHref(detail.issue.identifier)
    : null;
}

/** One answer of GET /api/issues/search. */
export interface IssueSearchHit {
  id: string;
  key: string;
  title: string;
  stateKind: TaskStateKind;
  stateName: string;
  open: boolean;
  /** "Beacon search / Search v2 beta", or null without a project. */
  group: string | null;
}

/** How many issues the relation picker's search answers with. */
export const ISSUE_SEARCH_LIMIT = 20;

// Lower case without diacritics, so "resume" finds "Résumé".
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function isOpenType(type: WorkflowStateType | undefined): boolean {
  return type !== 'completed' && type !== 'canceled';
}

/**
 * The relation picker's search over the mirror: by identifier (exact
 * first, then prefix or containing, so "24" finds ENG-24) and by title
 * (every word, accent-folded). Open issues before closed ones; issues of
 * the `near` issue's milestone, then project, before the rest. An empty
 * query lists open issues by that nearness. At most `limit` hits.
 */
export function searchIssueMirror(
  snapshot: Snapshot,
  query: string,
  options: { near?: string | null; limit?: number } = {}
): IssueSearchHit[] {
  const limit = options.limit ?? ISSUE_SEARCH_LIMIT;
  const near =
    options.near === null || options.near === undefined
      ? undefined
      : snapshot.issues.get(options.near);
  const q = fold(query.trim());
  const words = q.split(/\s+/).filter((word) => word !== '');
  const scored: { issue: Issue; score: number; open: boolean }[] = [];
  for (const issue of snapshot.issues.values()) {
    const type = snapshot.states.get(issue.stateId)?.type;
    const open = isOpenType(type);
    let score: number;
    if (q === '') {
      if (!open) continue;
      score = 3;
    } else {
      const key = issue.identifier.toLowerCase();
      if (key === q) score = 0;
      else if (key.startsWith(q)) score = 1;
      else if (key.includes(q)) score = 2;
      else if (words.every((word) => fold(issue.title).includes(word))) {
        score = 3;
      } else continue;
    }
    scored.push({ issue, score, open });
  }
  const nearness = (issue: Issue): number => {
    if (near === undefined) return 2;
    if (near.milestoneId !== null && issue.milestoneId === near.milestoneId) {
      return 0;
    }
    if (near.projectId !== null && issue.projectId === near.projectId) {
      return 1;
    }
    return 2;
  };
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.open !== b.open) return a.open ? -1 : 1;
    const near = nearness(a.issue) - nearness(b.issue);
    if (near !== 0) return near;
    return a.issue.identifier.localeCompare(b.issue.identifier, 'en', {
      numeric: true,
    });
  });
  return scored.slice(0, limit).map(({ issue, open }) => {
    const state = snapshot.states.get(issue.stateId);
    const project =
      issue.projectId === null
        ? undefined
        : snapshot.projects.get(issue.projectId);
    const milestone =
      issue.milestoneId === null
        ? undefined
        : snapshot.milestones.get(issue.milestoneId);
    return {
      id: issue.id,
      key: issue.identifier,
      title: issue.title,
      stateKind: state?.type ?? 'backlog',
      stateName: state?.name ?? 'Unknown state',
      open,
      group:
        project === undefined
          ? null
          : milestone === undefined
            ? project.name
            : `${project.name} / ${milestone.name}`,
    };
  });
}

/* ---- wording helpers ----------------------------------------------------- */

/** The workspace-local calendar date of an instant. */
function localDate(iso: string, timeZone: string): string {
  try {
    return todayIn(timeZone, new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** "due Oct 23, in 2 days", "due today", "due Oct 18, 3 days overdue". */
export function whenDue(
  date: string | null,
  daysLeft: number | null,
  today: string,
  complete = false
): string {
  if (date === null) return 'no target date';
  const when = formatDate(date, today);
  if (complete) return `complete · ${when}`;
  if (daysLeft === null) return `due ${when}`;
  if (daysLeft === 0) return 'due today';
  if (daysLeft === 1) return 'due tomorrow';
  if (daysLeft > 1) return `due ${when}, in ${daysLeft} days`;
  return `due ${when}, ${plural(-daysLeft, 'day')} overdue`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "ENG-23 (In Progress, Dev Patel)", "ENG-12 (Backlog, unassigned)". */
function blockerPhrase(row: IssueRelationRow): string {
  return `${row.identifier} (${row.stateName}, ${row.assigneeName ?? 'unassigned'})`;
}

/** "A", "A and B", "A, B and 2 more". */
function listPhrase(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length <= max) {
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
  }
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

function relationModel(row: IssueRelationRow): IssueRelationModel {
  const context = [row.projectName, row.milestoneName]
    .filter((part): part is string => part !== null && part !== '')
    .join(' / ');
  return {
    relationId: row.relationId,
    issueId: row.issueId,
    taskKey: row.identifier,
    title: row.title,
    state: { kind: row.stateType, label: row.stateName },
    assignee: row.assigneeName,
    context: context === '' ? 'No project' : context,
    external: row.external,
    resolved: row.resolved,
  };
}

/* ---- alerts ---------------------------------------------------------------- */

/**
 * The alerts above the properties (only what needs action and is not
 * already said by a property): the milestone is overdue (danger), the
 * issue waits on open blockers, it holds up at-risk milestones (warning).
 * Stalled and unassigned are not alerts: the "Time in state" and
 * "Assignee" properties already carry them in the warning tone (with what
 * allocation will do as the assignee's note), so the drawer says each
 * fact once. TaskDetail draws the most severe alert tinted and the rest
 * as a neutral list. Closed issues and issues of inactive projects get
 * none.
 */
export function issueAlerts(
  detail: IssueDetail,
  today: string,
  options: {
    closed: boolean;
    quiet: boolean;
    /** The chain link to offer (default issueChainHref); null for none. */
    chainHref?: string | null;
  }
): TaskDetailAlert[] {
  if (options.closed || options.quiet) return [];
  const alerts: TaskDetailAlert[] = [];
  const { milestone, project } = detail;
  // Blocked and Holds up both open the issue's own blocking chain.
  const chain =
    options.chainHref === undefined
      ? issueChainHref(detail)
      : options.chainHref;
  const graphAction =
    chain === null ? undefined : { label: 'Graph', href: chain };

  if (
    milestone !== null &&
    project !== null &&
    milestone.status === 'overdue' &&
    milestone.targetDate !== null
  ) {
    const late = milestone.daysLeft === null ? 0 : -milestone.daysLeft;
    alerts.push({
      id: 'overdue',
      label: 'Overdue',
      tone: 'danger',
      message: `${milestone.name} was due ${formatDate(milestone.targetDate, today)}, ${late === 0 ? 'today' : `${plural(late, 'day')} ago`}.`,
    });
  }

  const openBlockers = detail.blockedBy.filter((row) => !row.resolved);
  if (openBlockers.length > 0) {
    alerts.push({
      id: 'blocked',
      label: 'Blocked',
      tone: 'warning',
      message: `Waiting on ${listPhrase(openBlockers.map(blockerPhrase))}.`,
      action: graphAction,
    });
  }

  const holds = detail.why.blocksAtRiskMilestones;
  if (holds.length > 0) {
    alerts.push({
      id: 'holds-up',
      label: 'Holds up',
      tone: 'warning',
      message: `${listPhrase(
        holds.map(
          (m) =>
            `${m.projectName} / ${m.name} (${m.status === 'overdue' ? 'overdue' : 'at risk'})`
        )
      )} waits on this.`,
      action: graphAction,
    });
  }

  return alerts;
}

/** What allocation will do with an unassigned issue of the next
    milestone (the Assignee property's note), and whether that is stopped
    (no lead, a deactivated lead, a rubric gap: the warning tone). */
function unassignedNote(
  milestone: IssueDetailMilestone,
  lead: IssuePersonRef | null,
  projectName: string,
  today: string
): { text: string; stopped: boolean } {
  const where = `In the next milestone, ${milestone.name} (${whenDue(milestone.targetDate, milestone.daysLeft, today)})`;
  if (lead === null) {
    return {
      text: `${where}, but ${projectName} has no lead, so nothing in it is allocated.`,
      stopped: true,
    };
  }
  if (!lead.active) {
    return {
      text: `${where}, but its lead ${lead.name} is deactivated in Linear, so allocation is stopped.`,
      stopped: true,
    };
  }
  if (!milestone.rubric.valid) {
    const gaps = milestone.rubric.gaps
      .map((gap) => RUBRIC_GAP_SHORT_LABEL[gap])
      .join(', ');
    return {
      text: `${where}, but the milestone is missing ${gaps}, so allocation is stopped.`,
      stopped: true,
    };
  }
  return {
    text: `${where}: the next live allocation run gives it to ${lead.name}.`,
    stopped: false,
  };
}

/* ---- properties ---------------------------------------------------------- */

function assigneeFact(
  detail: IssueDetail,
  history: readonly IssueHistoryEntry[],
  input: { today: string; timeZone: string; viewerId: string },
  loud: boolean
): IssueFact {
  const { assignee, milestone, project } = detail;
  if (assignee === null) {
    const fact: IssueFact = {
      text: 'Unassigned',
      tone: loud ? 'warning' : 'muted',
      avatar: '',
    };
    // In the next milestone, the note says what allocation will do (this
    // was an "Unassigned" alert; the property already says unassigned).
    if (
      loud &&
      detail.why.unassignedInNextMilestone &&
      milestone !== null &&
      project !== null
    ) {
      const next = unassignedNote(
        milestone,
        project.lead,
        project.name,
        input.today
      );
      fact.note = next.text;
      fact.noteTone = next.stopped ? 'warning' : 'default';
    }
    return fact;
  }
  const isViewer = assignee.id === input.viewerId;
  const fact: IssueFact = {
    text: isViewer ? `${assignee.name} (you)` : assignee.name,
    tone: 'default',
    avatar: assignee.name,
  };
  if (!assignee.active) {
    return {
      ...fact,
      note: 'Deactivated in Linear',
      noteTone: loud ? 'warning' : 'muted',
    };
  }
  const given = history.find(
    (entry) =>
      entry.action === 'assign' &&
      entry.outcome === 'applied' &&
      entry.runMode === 'live' &&
      entry.assigneeId === assignee.id
  );
  if (given !== undefined) {
    const day = formatDate(
      localDate(given.createdAt, input.timeZone),
      input.today
    );
    const project = detail.project?.name ?? 'the project';
    fact.note = isViewer
      ? `Given to you by the planner on ${day}: you lead ${project}.`
      : `Given by the planner on ${day}: they lead ${project}.`;
  }
  return fact;
}

function milestoneFact(
  detail: IssueDetail,
  today: string,
  quiet: boolean
): IssueFact {
  const { milestone, project } = detail;
  if (milestone === null) {
    return {
      text: 'No milestone',
      tone: 'muted',
      note:
        project === null
          ? undefined
          : 'Not allocated by the planner until it is in a milestone',
    };
  }
  const mark = assessmentMark(milestone);
  const parts = [
    quiet ? `${mark.label} · inactive project` : mark.label,
    whenDue(
      milestone.targetDate,
      milestone.daysLeft,
      today,
      milestone.status === 'complete'
    ),
    `${milestone.progress.completed} of ${milestone.progress.scope} done`,
  ];
  if (milestone.isNext) parts.push('next milestone');
  return {
    text: milestone.name,
    tone: 'default',
    glyph: {
      kind: 'status',
      status: mark.status,
      label: quiet ? `${mark.label} · inactive project` : mark.label,
      muted: quiet,
    },
    note: capitalise(parts.join(' · ')),
  };
}

function projectFact(detail: IssueDetail, quiet: boolean): IssueFact {
  const { project } = detail;
  if (project === null) {
    return {
      text: 'No project',
      tone: 'muted',
      note: 'Outside the plan: the planner allocates and warns per project',
    };
  }
  if (quiet) {
    return {
      text: project.name,
      tone: 'default',
      note: `${project.statusName} · inactive project`,
      noteTone: 'muted',
    };
  }
  if (project.lead === null) {
    return {
      text: project.name,
      tone: 'default',
      note: 'No lead',
      noteTone: 'warning',
    };
  }
  return {
    text: project.name,
    tone: 'default',
    note: project.lead.active
      ? `Lead ${project.lead.name}`
      : `Lead ${project.lead.name} (deactivated in Linear)`,
    noteTone: project.lead.active ? 'default' : 'warning',
  };
}

function inStateFact(
  detail: IssueDetail,
  input: { today: string; timeZone: string },
  options: { closed: boolean; quiet: boolean }
): IssueFact {
  const { timing } = detail;
  const stateName = detail.state?.name ?? 'its state';
  const days = timing.daysInState;
  const sinceDate = localDate(timing.lastStateChangeAt, input.timeZone);
  const since = formatDate(sinceDate, input.today);
  const stalled = timing.stalled && !options.closed && !options.quiet;
  // daysInState counts whole 24-hour days, so 0 means "under a day": a
  // change last evening is yesterday on the calendar, not today.
  const underADay =
    sinceDate === input.today ? 'Since today' : 'Since yesterday';
  return {
    text: days === 0 ? underADay : plural(days, 'day'),
    tone: stalled ? 'warning' : 'default',
    mono: true,
    note: stalled
      ? `Stalled: ${stateName} with no change since ${since}`
      : `${stateName} since ${since}`,
    noteTone: stalled ? 'warning' : 'default',
  };
}

const UNAVAILABLE: IssueFact = {
  text: 'Unavailable',
  tone: 'muted',
  note: 'Linear could not be read just now',
};

function labelsFact(result: IssueDetailResult): IssueFact {
  if (result.extra === null) return UNAVAILABLE;
  const { labels } = result.extra;
  return labels.length === 0
    ? { text: 'No labels', tone: 'muted' }
    : {
        text: labels.map((label) => label.name).join(', '),
        tone: 'default',
        labels: labels.map((label) => ({
          name: label.name,
          color: label.color,
        })),
      };
}

/** "3 points", "1 point", "L" (T-shirt sizes read as themselves). */
export function estimateText(scale: EstimateScale, value: number): string {
  const label = estimateLabel(scale, value);
  if (scale.type === 'tShirt') return label;
  return `${label} ${value === 1 ? 'point' : 'points'}`;
}

function estimateFact(result: IssueDetailResult): IssueFact {
  const scale = result.estimateScale;
  if (result.extra === null || scale === null) return UNAVAILABLE;
  const value = result.extra.estimate;
  if (scale.type === 'notUsed') {
    return value === null
      ? {
          text: 'Not used',
          tone: 'muted',
          note: 'This team does not use estimates',
        }
      : { text: String(value), tone: 'default', mono: true };
  }
  if (value === null) return { text: 'No estimate', tone: 'muted' };
  return { text: estimateText(scale, value), tone: 'default', mono: true };
}

function dueDateFact(
  result: IssueDetailResult,
  today: string,
  loud: boolean
): IssueFact {
  if (result.extra === null) return UNAVAILABLE;
  const due = result.extra.dueDate;
  if (due === null) return { text: 'No due date', tone: 'muted' };
  const left = diffDays(due, today);
  // §8.2: overdue is danger, due today or tomorrow warning; later dates
  // and quiet issues stay neutral.
  const tone: UiTone = !loud
    ? 'default'
    : left < 0
      ? 'danger'
      : left <= 1
        ? 'warning'
        : 'default';
  return {
    text: formatDate(due, today),
    tone,
    mono: true,
    note:
      left === 0
        ? 'Due today'
        : left === 1
          ? 'Due tomorrow'
          : left > 1
            ? `In ${left} days`
            : `${plural(-left, 'day')} overdue`,
    // Only the date carries the tone; the note under it stays quiet, so
    // one fact is coloured once.
    noteTone: 'muted',
  };
}

/* ---- comments and activity --------------------------------------------- */

function commentModel(
  comment: IssueComment,
  today: string,
  timeZone: string
): TaskComment {
  const author = comment.author?.name ?? comment.externalAuthor ?? 'Linear';
  return {
    id: comment.id,
    author,
    at: formatDate(localDate(comment.createdAt, timeZone), today),
    dateTime: comment.createdAt,
    body: comment.body,
    href: comment.url ?? undefined,
    tone: comment.author === null ? 'muted' : 'default',
  };
}

const TRIGGER_LABEL: Record<IssueHistoryEntry['runTrigger'], string> = {
  schedule: 'Daily run',
  manual: 'Manual run',
};

const STALE_TEXT: Record<string, string> = {
  not_found: 'it no longer existed in Linear',
  closed: 'it had been closed in Linear',
  now_assigned: 'someone had been assigned in Linear',
  moved_milestone: 'it had moved to another milestone',
  now_triage: 'it had moved back to Triage',
};

const SKIP_TEXT: Record<string, string> = {
  already_assigned: 'it was already assigned',
  triage: 'it was still in Triage',
};

interface Dated {
  at: string;
  /** The ledger line; its detail is always a sentence here. */
  item: Omit<TaskActivityItem, 'id' | 'at' | 'dateTime' | 'detail'> & {
    detail?: string;
  };
}

// One allocation entry as an activity line; identical repeats (the same
// dry-run plan day after day) are folded by the caller.
function historyLine(
  entry: IssueHistoryEntry,
  names: ReadonlyMap<string, string>,
  stateNames: ReadonlyMap<string, string>
): Dated['item'] {
  const name =
    entry.assigneeId === null
      ? 'the lead'
      : (names.get(entry.assigneeId) ?? 'a deactivated person');
  const run = `${TRIGGER_LABEL[entry.runTrigger]}${entry.runMode === 'dry_run' ? ' · dry run' : ''}`;
  const href = `/runs/${encodeURIComponent(entry.runId)}`;
  if (entry.action === 'skip') {
    const why =
      entry.reason !== null && Object.hasOwn(SKIP_TEXT, entry.reason)
        ? SKIP_TEXT[entry.reason]
        : (entry.reason ?? 'no reason recorded');
    return {
      label: 'Skipped by the planner',
      detail: `${run}: ${why}.`,
      tone: 'muted',
      href,
    };
  }
  const stateOf = (key: string): string | undefined => {
    const id = entry.detail[key];
    return typeof id === 'string' ? stateNames.get(id) : undefined;
  };
  const from = stateOf('fromStateId');
  const to = stateOf('toStateId');
  const move =
    from !== undefined && to !== undefined && from !== to
      ? ` · ${from} → ${to}`
      : '';
  switch (entry.outcome) {
    case 'applied':
      return {
        label: `Assigned to ${name} by the planner`,
        detail:
          entry.error === null
            ? `${run}${move} · a comment in Linear says why.`
            : `${run}${move} · the comment failed: ${entry.error}`,
        // Assigned (success); the comment saying why failed: partly
        // failed (warning).
        tone: entry.error === null ? 'success' : 'warning',
        href,
      };
    case 'failed':
      return {
        label: `Assigning ${name} failed`,
        detail: `${run}: ${entry.error ?? 'the Linear write failed.'}`,
        tone: 'danger',
        href,
      };
    case 'stale':
      return {
        label: `Not assigned to ${name}`,
        detail: `${run}: ${
          entry.reason !== null && Object.hasOwn(STALE_TEXT, entry.reason)
            ? STALE_TEXT[entry.reason]
            : 'it no longer applied when re-checked'
        }.`,
        tone: 'muted',
        href,
      };
    default:
      return {
        label: `Would be assigned to ${name}`,
        detail: `${run}${move} · nothing was written to Linear.`,
        tone: 'muted',
        href,
      };
  }
}

/**
 * The activity ledger, newest first: the planner's allocation decisions
 * about this issue (identical repeats folded into the newest, with a
 * count) and the lifecycle instants the mirror knows (created, started,
 * completed or canceled, the move into the current state).
 */
export function issueActivity(
  detail: IssueDetail,
  history: readonly IssueHistoryEntry[],
  input: {
    today: string;
    timeZone: string;
    names: ReadonlyMap<string, string>;
  }
): TaskActivityItem[] {
  const stateNames = new Map(
    detail.options.states.map((state) => [state.id, state.name])
  );
  const dated: Dated[] = [];
  const folded = new Map<string, Dated & { count: number }>();
  for (const entry of history) {
    const signature = [
      entry.action,
      entry.outcome,
      entry.assigneeId,
      entry.runMode,
      entry.reason,
      entry.error,
    ].join('|');
    const seen = folded.get(signature);
    if (seen !== undefined) {
      seen.count += 1;
      continue;
    }
    const line: Dated & { count: number } = {
      at: entry.createdAt,
      item: historyLine(entry, input.names, stateNames),
      count: 1,
    };
    folded.set(signature, line);
    dated.push(line);
  }
  for (const line of folded.values()) {
    if (line.count > 1) {
      line.item = {
        ...line.item,
        detail: `${line.item.detail ?? ''} Seen in ${line.count} runs.`,
      };
    }
  }

  const { timing } = detail;
  const stateName = detail.state?.name ?? 'its current state';
  const lifecycle: [string | null, string][] = [
    [timing.createdAt, 'Created in Linear'],
    [timing.startedAt, 'Started'],
    [timing.completedAt, 'Completed'],
    [timing.canceledAt, 'Canceled'],
  ];
  const instants = new Set<string>();
  for (const [at, label] of lifecycle) {
    if (at === null) continue;
    instants.add(at);
    dated.push({ at, item: { label, tone: 'muted' } });
  }
  // The move into the current state, unless it is another instant above or
  // the day the issue was created (it was created in that state).
  const sameDayAsCreated =
    localDate(timing.lastStateChangeAt, input.timeZone) ===
    localDate(timing.createdAt, input.timeZone);
  if (!instants.has(timing.lastStateChangeAt) && !sameDayAsCreated) {
    dated.push({
      at: timing.lastStateChangeAt,
      item: { label: `Moved to ${stateName}`, tone: 'muted' },
    });
  }

  return dated
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((line, index) => ({
      id: `activity-${index}`,
      at: formatDate(localDate(line.at, input.timeZone), input.today),
      dateTime: line.at,
      ...line.item,
    }));
}

/* ---- edit options ---------------------------------------------------------- */

function editModel(result: IssueDetailResult, today: string): IssueEditModel {
  const { detail, extra } = result;
  const { options } = detail;
  const people: PersonChoice[] = options.assignees.map((person) => ({
    id: person.id,
    name: person.name,
    hint:
      person.displayName !== '' && person.displayName !== person.name
        ? person.displayName
        : undefined,
  }));
  const assignable = new Set(people.map((person) => person.id));
  const projects: PlanChoice[] = options.projects.map((project) => ({
    id: project.id,
    name: project.name,
    hint: project.includesTeam
      ? project.statusName
      : `${project.statusName} · not ${detail.team?.key ?? 'this team'}'s`,
    group: project.active ? 'Active projects' : 'Other projects',
  }));
  const milestones: Record<string, PlanChoice[]> = {};
  for (const project of options.projects) {
    milestones[project.id] = project.milestones.map((milestone) => ({
      id: milestone.id,
      name: milestone.name,
      hint:
        milestone.targetDate === null
          ? 'No target date'
          : formatDate(milestone.targetDate, today),
    }));
  }

  // Labels the issue carries but the team cannot apply any more (archived,
  // another team's) stay listed so they can be removed.
  const labelChoice = (label: IssueDetailResult['labels'][number]) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    group:
      label.group === null
        ? undefined
        : {
            id: label.group.id,
            name: label.group.name,
            singleSelect: label.group.singleSelect,
          },
  });
  const labels: LabelChoice[] = result.labels.map(labelChoice);
  const known = new Set(labels.map((label) => label.id));
  for (const label of extra?.labels ?? []) {
    if (!known.has(label.id)) labels.push(labelChoice(label));
  }

  const scale = result.estimateScale;
  const estimates =
    extra === null || scale === null || scale.type === 'notUsed'
      ? null
      : result.estimateOptions.map((option) => ({ ...option }));

  const projectKnown =
    detail.project === null ||
    options.projects.some((project) => project.id === detail.project?.id);
  const milestoneKnown =
    detail.milestone === null ||
    detail.project === null ||
    (milestones[detail.project.id] ?? []).some(
      (milestone) => milestone.id === detail.milestone?.id
    );

  return {
    values: {
      title: detail.issue.title,
      stateId: detail.state?.id ?? null,
      assigneeId: detail.assignee?.id ?? null,
      priority: detail.priority,
      projectId: detail.project?.id ?? null,
      milestoneId: detail.milestone?.id ?? null,
      live:
        extra === null
          ? null
          : {
              description: extra.description ?? '',
              labelIds: extra.labels.map((label) => label.id),
              estimate: extra.estimate,
              dueDate: extra.dueDate,
            },
    },
    states: options.states.map((state) => ({
      id: state.id,
      name: state.name,
      kind: state.type,
    })),
    people,
    assigneeLabel:
      detail.assignee !== null && !assignable.has(detail.assignee.id)
        ? `${detail.assignee.name} (deactivated)`
        : undefined,
    projects,
    projectLabel: projectKnown ? undefined : detail.project?.name,
    milestones,
    milestoneLabel: milestoneKnown ? undefined : detail.milestone?.name,
    labels,
    estimates,
    limits: {
      title: ISSUE_TITLE_MAX_LENGTH,
      description: ISSUE_DESCRIPTION_MAX_LENGTH,
      comment: COMMENT_MAX_LENGTH,
    },
  };
}

/* ---- the whole view ------------------------------------------------------- */

/**
 * The issue's task view model from the engine's IssueDetailResult: crumbs
 * (project and milestone linking to the timeline), the status, the alert
 * strips, the read-only facts, the description and comments (or why they
 * could not be read), the blocks relations, the activity ledger, and what
 * the edit controls offer. `names` maps user ids to names for the history
 * (the mirror's people, deactivated ones included).
 */
export function buildIssueTaskModel(
  input: IssueTaskInput & { names: ReadonlyMap<string, string> }
): IssueTaskModel {
  const { result, today, timeZone } = input;
  const { detail, extra } = result;
  const { issue, project, milestone } = detail;
  const kind: TaskStateKind = detail.state?.type ?? 'backlog';
  const closed = kind === 'completed' || kind === 'canceled';
  const quiet = project !== null && !project.active;
  const loud = !closed && !quiet;

  const crumbs: ShellCrumb[] = [];
  if (project !== null) {
    crumbs.push({
      label: project.name,
      href: `/timeline?project=${encodeURIComponent(project.id)}`,
    });
  }
  if (milestone !== null) {
    crumbs.push({
      label: milestone.name,
      href: `/timeline?milestone=${encodeURIComponent(milestone.id)}`,
    });
  }
  crumbs.push({ label: issue.identifier });

  const hidden = detail.hiddenRelations;
  // The chain as a graph, unless the view is drawn over that very graph.
  const ownChain = issueChainHref(detail);
  const chainHref = ownChain === input.pageHref ? null : ownChain;
  return {
    issueId: issue.id,
    key: issue.identifier,
    title: issue.title,
    linearUrl: issue.url,
    pagePath: issuePagePath(issue.identifier),
    today,
    viewerId: input.viewerId,
    closed,
    quiet,
    crumbs,
    chainHref,
    milestone:
      milestone === null ? null : { id: milestone.id, name: milestone.name },
    status: { kind, label: detail.state?.name ?? 'Unknown state' },
    alerts: issueAlerts(detail, today, { closed, quiet, chainHref }),
    facts: {
      assignee: assigneeFact(detail, result.allocationHistory, input, loud),
      priority: {
        text: PRIORITY_LABEL[detail.priority],
        tone: 'default',
        glyph: { kind: 'priority', priority: detail.priority },
      },
      labels: labelsFact(result),
      estimate: estimateFact(result),
      dueDate: dueDateFact(result, today, loud),
      project: projectFact(detail, quiet),
      milestone: milestoneFact(detail, today, quiet),
      inState: inStateFact(detail, input, { closed, quiet }),
    },
    description: {
      text: extra?.description ?? null,
      error: extra === null ? result.extraError : null,
      sourceLabel:
        result.extraSource === 'app'
          ? 'From Linear · read as the planner app'
          : 'From Linear',
    },
    relations: {
      blockedBy: detail.blockedBy.map(relationModel),
      blocks: detail.blocks.map(relationModel),
      hiddenNote:
        hidden === 0
          ? null
          : `${plural(hidden, 'more blocking relation')} ${hidden === 1 ? 'links' : 'link'} to issues the planner does not hold (a closed project, or a team the app cannot see). Linear shows ${hidden === 1 ? 'it' : 'them'}.`,
    },
    comments: {
      items:
        extra === null
          ? []
          : extra.comments.map((comment) =>
              commentModel(comment, today, timeZone)
            ),
      error: extra === null ? result.extraError : null,
      note:
        extra !== null && extra.commentsTruncated
          ? `First ${extra.comments.length} · more in Linear`
          : 'From Linear',
    },
    activity: issueActivity(detail, result.allocationHistory, {
      today,
      timeZone,
      names: input.names,
    }),
    canEdit: result.canEdit && result.readOnly !== true,
    // `readOnly` is additive in the engine's result; an older result
    // without it is read as a member's.
    readOnly: result.readOnly === true,
    grantWriteHref: input.grantWriteHref,
    liveError: result.extraError,
    edit: editModel(result, today),
  };
}
