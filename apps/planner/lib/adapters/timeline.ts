import {
  BLOCK_REASON_LABEL,
  type DependencyGraph,
  missingLine,
  type MilestoneDetail,
  RISK_REASON_LABEL,
  RUBRIC_GAP_LABEL,
  RUBRIC_GAP_SHORT_LABEL,
  type RubricGap,
  type TimelineBar as CoreBar,
  type TimelineLane as CoreLane,
  type TimelineView,
  type User,
  type WorkflowStateType,
} from '@better-tracker/core';
import type {
  ChecklistItem,
  SegmentedOption,
  TimelineBar,
  TimelineDependency,
  TimelineGroup,
  TimelineLane,
  TimelineUndated,
  TimelineZoom,
  UiStatus,
  UiTone,
} from '@better-tracker/ui';

import { dueLabel, formatDate, plural } from '../format';
import { assessmentMark, blockedReasonLine } from './status';

// The timeline page's core → ui mapping (architecture §8.4 Timeline, §8.3
// slide-over): the engine's TimelineView becomes TimelineChart groups,
// lanes, bars and undated chips; the milestone-level dependency graph
// becomes connectors; the view's banners become expandable notices; a
// MilestoneDetail becomes the drawer's model. Also the URL state (filters,
// zoom, dependencies, selection) so a filtered timeline can be linked.
// Pure functions over plain data: the server page builds the models, the
// client island filters them. Nothing here imports the engine at runtime
// (the client bundle uses this module too).

/* ---- URL state ---------------------------------------------------------- */

export interface TimelineFilters {
  /** Project-name search. */
  query: string;
  /** Initiative group id (`none` for "No initiative"), or `all`. */
  initiative: string;
  /** Hide inactive projects (status outside the active list). */
  activeOnly: boolean;
  /** Keep only active projects with an at-risk or overdue milestone. */
  riskOnly: boolean;
}

export interface TimelineUrlState extends TimelineFilters {
  zoom: TimelineZoom;
  showDependencies: boolean;
}

/** What the drawer and the focused lane point at (?milestone=, ?project=). */
export interface TimelineSelection {
  milestoneId?: string | null;
  projectId?: string | null;
}

export const DEFAULT_TIMELINE_STATE: TimelineUrlState = {
  query: '',
  initiative: 'all',
  activeOnly: false,
  riskOnly: false,
  zoom: 'weeks',
  showDependencies: false,
};

type SearchParams = Record<string, string | string[] | undefined>;

const MAX_PARAM_LENGTH = 200;

/** The first value of a query parameter, trimmed and length-capped. */
function param(params: SearchParams, key: string): string | null {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_PARAM_LENGTH);
}

/** Filters, zoom and the dependency toggle from the page's searchParams. */
export function parseTimelineState(params: SearchParams): TimelineUrlState {
  return {
    query: param(params, 'q') ?? '',
    initiative: param(params, 'initiative') ?? 'all',
    activeOnly: param(params, 'active') === '1',
    riskOnly: param(params, 'risk') === '1',
    zoom: param(params, 'zoom') === 'months' ? 'months' : 'weeks',
    showDependencies: param(params, 'deps') === '1',
  };
}

/**
 * The same state from the address bar as the client island reads it
 * (useSearchParams) when the URL changes under it: back/forward, or a
 * plain /timeline link while filters are on. Parsed exactly as the server
 * parses the page's searchParams.
 */
export function parseTimelineSearch(params: {
  get(name: string): string | null;
}): TimelineUrlState {
  const record: SearchParams = {};
  for (const key of ['q', 'initiative', 'active', 'risk', 'zoom', 'deps']) {
    const value = params.get(key);
    if (value !== null) record[key] = value;
  }
  return parseTimelineState(record);
}

/** ?milestone= and ?project= (ids are opaque; the engine checks them). */
export function parseTimelineSelection(params: SearchParams): {
  milestoneId: string | null;
  projectId: string | null;
} {
  return {
    milestoneId: param(params, 'milestone'),
    projectId: param(params, 'project'),
  };
}

/**
 * The /timeline URL for a state and selection, leaving defaults out so the
 * plain timeline stays `/timeline`. Parameter order is fixed, so equal
 * states give equal strings (the client compares them).
 */
export function timelineHref(
  state: TimelineUrlState,
  selection: TimelineSelection = {}
): string {
  const params = new URLSearchParams();
  if (selection.projectId) params.set('project', selection.projectId);
  if (selection.milestoneId) params.set('milestone', selection.milestoneId);
  const query = state.query.trim();
  if (query !== '') params.set('q', query);
  if (state.initiative !== 'all') params.set('initiative', state.initiative);
  if (state.activeOnly) params.set('active', '1');
  if (state.riskOnly) params.set('risk', '1');
  if (state.zoom === 'months') params.set('zoom', 'months');
  if (state.showDependencies) params.set('deps', '1');
  const search = params.toString();
  return search === '' ? '/timeline' : `/timeline?${search}`;
}

/* ---- permissions -------------------------------------------------------- */

/** The parts of the engine's Actor the timeline reads. */
export interface TimelinePermissions {
  isPm: boolean;
  canWriteLinear: boolean;
}

/** Re-dating and setting leads are Linear writes: PM with write scope. */
export function canEditLinear(p: TimelinePermissions): boolean {
  return p.isPm && p.canWriteLinear;
}

/**
 * A PM whose Linear token is read-only: offer the grant_write upgrade on
 * the timeline itself, whose Linear writes (re-dating, leads) are PM-only.
 * Everyone else is offered the same upgrade where they can use it: on an
 * issue they open (the issue page and slide-over, owner decision
 * 2026-10-21), never as a timeline banner about controls they do not get.
 */
export function needsWriteGrant(p: TimelinePermissions): boolean {
  return p.isPm && !p.canWriteLinear;
}

/** Where a PM upgrades their Linear grant, returning to the timeline. */
export const GRANT_WRITE_HREF =
  '/api/auth/linear?intent=grant_write&returnTo=/timeline';

/* ---- chart ---------------------------------------------------------------- */

/** Group id for projects in no initiative. */
export const NO_INITIATIVE_ID = 'none';

/** "↑2" for a positive weight override, "↓3" for a negative one. */
export function weightTag(weight: number | null): string | null {
  if (weight === null || weight === 0) return null;
  return weight > 0 ? `↑${weight}` : `↓${-weight}`;
}

/** "Missing: done means…, project lead" (the bar's hatched-input line). */
export function missingLabel(gaps: readonly RubricGap[]): string {
  return `Missing: ${gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]).join(', ')}`;
}

/** NEXT for the lane's next milestone, then the weight override. */
export function barTags(bar: CoreBar): string[] {
  const tags: string[] = [];
  if (bar.isNext) tags.push('Next');
  const weight = weightTag(bar.weight);
  if (weight !== null) tags.push(weight);
  return tags;
}

/**
 * One dated milestone as a chart bar. The mark comes from the planner's
 * one status mapping (assessmentMark: rubric-invalid on-track reads as
 * "missing"); any open milestone that fails the rubric also carries the
 * "Missing: …" line. Only open milestones get the re-date handle, and only
 * when the viewer may write to Linear.
 */
export function toChartBar(bar: CoreBar, editable: boolean): TimelineBar {
  const mark = assessmentMark(bar);
  const out: TimelineBar = {
    id: bar.milestoneId,
    label: bar.name,
    start: bar.start,
    end: bar.end ?? bar.start,
    status: mark.status,
    statusLabel: mark.label,
    progressLabel: `${bar.progress.completed}/${bar.progress.scope}`,
    tags: barTags(bar),
  };
  if (bar.status !== 'complete' && bar.rubric.gaps.length > 0) {
    out.missing = missingLabel(bar.rubric.gaps);
  }
  if (editable && bar.status !== 'complete') out.editable = true;
  return out;
}

/** An undated milestone as a hatched chip at the lane's end. */
export function toUndatedChip(bar: CoreBar): TimelineUndated {
  const mark = assessmentMark(bar);
  return {
    id: bar.milestoneId,
    label: bar.name,
    status: mark.status,
    statusLabel: mark.label,
  };
}

/**
 * The mono line under a project name: the lead, "No lead" in the accent,
 * a deactivated lead in the accent, and "Inactive · <lead>" for projects
 * outside the active statuses (drawn muted, never loud).
 */
export function laneSublabel(lane: CoreLane): {
  sublabel: string;
  tone: 'default' | 'accent';
} {
  const lead = lane.leadName ?? (lane.leadId === null ? null : 'Unknown lead');
  if (!lane.active) {
    return {
      sublabel: lead === null ? 'Inactive · no lead' : `Inactive · ${lead}`,
      tone: 'default',
    };
  }
  if (lead === null) return { sublabel: 'No lead', tone: 'accent' };
  if (lane.allocation?.blockReason === 'lead_inactive') {
    return { sublabel: `${lead} · deactivated`, tone: 'accent' };
  }
  return { sublabel: lead, tone: 'default' };
}

export function toChartLane(lane: CoreLane, editable: boolean): TimelineLane {
  const { sublabel, tone } = laneSublabel(lane);
  const out: TimelineLane = {
    id: lane.projectId,
    label: lane.name,
    sublabel,
    sublabelTone: tone,
    bars: lane.bars
      .filter((bar) => bar.end !== null)
      .map((bar) => toChartBar(bar, editable)),
    undated: lane.undated.map(toUndatedChip),
  };
  if (!lane.active) out.muted = true;
  return out;
}

/** Every initiative group and its lanes, in the engine's timeline order. */
export function toChartGroups(
  view: TimelineView,
  permissions: TimelinePermissions
): TimelineGroup[] {
  const editable = canEditLinear(permissions);
  return view.groups.map((group) => ({
    id: group.initiativeId ?? NO_INITIATIVE_ID,
    label: group.name,
    lanes: group.lanes.map((lane) => toChartLane(lane, editable)),
  }));
}

/**
 * Milestone-level graph edges as chart connectors (`to` waits on `from`),
 * one per pair. Issue-level graphs have no milestone edges and give none.
 */
export function chartDependencies(
  graph: DependencyGraph
): TimelineDependency[] {
  if (graph.scope.level !== 'milestone') return [];
  const seen = new Map<string, TimelineDependency>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    const prior = seen.get(key);
    seen.set(key, {
      from: edge.from,
      to: edge.to,
      onRiskChain: edge.onRiskChain || prior?.onRiskChain === true,
    });
  }
  return [...seen.values()];
}

/**
 * True when an active lane has an at-risk or overdue milestone. An
 * inactive (muted) lane never needs action (§2.8: not loud), whatever its
 * milestones' status.
 */
export function laneNeedsAction(lane: TimelineLane): boolean {
  return (
    lane.muted !== true &&
    lane.bars.some(
      (bar) => bar.status === 'overdue' || bar.status === 'at_risk'
    )
  );
}

/**
 * The toolbar's one "Show" choice. The two URL filters nest (at risk /
 * overdue only ever keeps active lanes), so one segmented control covers
 * every combination: All, Active (?active=1), At risk (?risk=1).
 */
export type TimelineShow = 'all' | 'active' | 'at_risk';

export function timelineShow(filters: TimelineFilters): TimelineShow {
  if (filters.riskOnly) return 'at_risk';
  return filters.activeOnly ? 'active' : 'all';
}

/** The URL filters for a "Show" choice. */
export function showFilters(
  show: string
): Pick<TimelineFilters, 'activeOnly' | 'riskOnly'> {
  if (show === 'at_risk') return { activeOnly: false, riskOnly: true };
  if (show === 'active') return { activeOnly: true, riskOnly: false };
  return { activeOnly: false, riskOnly: false };
}

/** The "Show" cells. No counts: the toolbar stays one row down to a
    1366px window with the sidebar open, and each initiative row of the
    chart already counts the projects it shows. */
export const SHOW_OPTIONS: readonly SegmentedOption[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'at_risk', label: 'At risk' },
];

/**
 * Applies the toolbar filters, dropping initiative groups left empty. The
 * search matches project names, case-insensitively.
 */
export function filterTimelineGroups(
  groups: readonly TimelineGroup[],
  filters: TimelineFilters
): TimelineGroup[] {
  const query = filters.query.trim().toLowerCase();
  const out: TimelineGroup[] = [];
  for (const group of groups) {
    if (filters.initiative !== 'all' && group.id !== filters.initiative) {
      continue;
    }
    const lanes = group.lanes.filter(
      (lane) =>
        (query === '' || lane.label.toLowerCase().includes(query)) &&
        (!filters.activeOnly || lane.muted !== true) &&
        (!filters.riskOnly || laneNeedsAction(lane))
    );
    if (lanes.length > 0) out.push({ ...group, lanes });
  }
  return out;
}

/** Connectors whose two ends are both drawn (dated bars still shown). */
export function visibleDependencies(
  dependencies: readonly TimelineDependency[],
  groups: readonly TimelineGroup[]
): TimelineDependency[] {
  const bars = new Set<string>();
  for (const group of groups) {
    for (const lane of group.lanes) {
      for (const bar of lane.bars) bars.add(bar.id);
    }
  }
  return dependencies.filter((dep) => bars.has(dep.from) && bars.has(dep.to));
}

/** Lane names link to their focused lane (built by the client from state). */
export function withLaneHrefs(
  groups: readonly TimelineGroup[],
  hrefFor: (laneId: string) => string
): TimelineGroup[] {
  return groups.map((group) => ({
    ...group,
    lanes: group.lanes.map((lane) => ({ ...lane, href: hrefFor(lane.id) })),
  }));
}

export function countLanes(groups: readonly TimelineGroup[]): number {
  return groups.reduce((sum, group) => sum + group.lanes.length, 0);
}

/** The toolbar's initiative choices: All, then each group in order. */
export function initiativeOptions(
  groups: readonly TimelineGroup[]
): { id: string; label: string }[] {
  return [
    { id: 'all', label: 'All initiatives' },
    ...groups.map((group) => ({ id: group.id, label: group.label })),
  ];
}

/** Milestone name and project name by id, for the drawer while it loads. */
export function milestoneNames(
  groups: readonly TimelineGroup[]
): Record<string, { label: string; projectName: string }> {
  const out: Record<string, { label: string; projectName: string }> = {};
  for (const group of groups) {
    for (const lane of group.lanes) {
      for (const bar of [...lane.bars, ...lane.undated]) {
        out[bar.id] = { label: bar.label, projectName: lane.label };
      }
    }
  }
  return out;
}

/* ---- banners ---------------------------------------------------------- */

export type TimelineBannerId = 'no_lead' | 'no_date' | 'unplanned' | 'blocked';

export interface TimelineBannerLink {
  label: string;
  href: string;
}

export interface TimelineBannerItem {
  id: string;
  label: string;
  /** Where the row goes on the timeline (a lane or a milestone drawer). */
  target: TimelineSelection;
  /** Mono line under the label. */
  detail?: string;
  /** Issue links into Linear. */
  links?: TimelineBannerLink[];
}

export interface TimelineBanner {
  id: TimelineBannerId;
  /** Mono key: NO LEAD, NO DATE, UNPLANNED, BLOCKED. */
  label: string;
  count: number;
  /** One sentence with the count. */
  text: string;
  items: TimelineBannerItem[];
}

/** What the banners need to know about an issue. */
export interface IssueRef {
  identifier: string;
  url: string;
}

/**
 * The timeline banners (§7.2, §8.4): projects without a lead, milestones
 * without a date, open issues without a milestone (per project), and
 * projects whose allocation is blocked (reason + missing rubric items).
 * Banners with nothing in them are left out.
 */
export function buildTimelineBanners(
  view: TimelineView,
  issues: ReadonlyMap<string, IssueRef>
): TimelineBanner[] {
  const { banners } = view;
  const out: TimelineBanner[] = [];

  const noLead = banners.projectsWithoutLead;
  if (noLead.length > 0) {
    out.push({
      id: 'no_lead',
      label: 'No lead',
      count: noLead.length,
      text:
        noLead.length === 1
          ? '1 active project has no lead: nothing in it is allocated.'
          : `${noLead.length} active projects have no lead: nothing in them is allocated.`,
      items: noLead.map((project) => ({
        id: project.projectId,
        label: project.name,
        target: { projectId: project.projectId },
      })),
    });
  }

  const noDate = banners.milestonesWithoutDate;
  if (noDate.length > 0) {
    out.push({
      id: 'no_date',
      label: 'No date',
      count: noDate.length,
      text:
        noDate.length === 1
          ? '1 milestone has no target date, so it fails the rubric and gets no warnings.'
          : `${noDate.length} milestones have no target date, so they fail the rubric and get no warnings.`,
      items: noDate.map((milestone) => ({
        id: milestone.milestoneId,
        label: `${milestone.projectName} › ${milestone.name}`,
        target: {
          milestoneId: milestone.milestoneId,
          projectId: milestone.projectId,
        },
      })),
    });
  }

  const unplanned = banners.issuesWithoutMilestone;
  if (unplanned.count > 0) {
    out.push({
      id: 'unplanned',
      label: 'Unplanned',
      count: unplanned.count,
      text:
        unplanned.count === 1
          ? '1 open issue has no milestone, so it is never allocated. Attach it to one in Linear, or cancel it.'
          : `${unplanned.count} open issues in ${plural(unplanned.byProject.length, 'project')} have no milestone, so they are never allocated. Attach or cancel them in Linear.`,
      items: unplanned.byProject.map((project) => {
        const links: TimelineBannerLink[] = [];
        for (const id of project.issueIds) {
          const issue = issues.get(id);
          if (issue !== undefined) {
            links.push({ label: issue.identifier, href: issue.url });
          }
        }
        return {
          id: project.projectId,
          label: project.name,
          detail: plural(project.issueIds.length, 'open issue'),
          target: { projectId: project.projectId },
          links,
        };
      }),
    });
  }

  const blocked = banners.blockedProjects;
  if (blocked.length > 0) {
    const nextById = new Map<string, string | null>();
    for (const group of view.groups) {
      for (const lane of group.lanes) {
        nextById.set(lane.projectId, lane.allocation?.nextMilestoneId ?? null);
      }
    }
    out.push({
      id: 'blocked',
      label: 'Blocked',
      count: blocked.length,
      text: `Allocation is stopped in ${plural(blocked.length, 'project')} until the missing input is fixed.`,
      items: blocked.map((project) => {
        const nextId = nextById.get(project.projectId) ?? null;
        return {
          id: project.projectId,
          label: project.name,
          detail: blockedReasonLine(project.reason, project.gaps),
          target:
            project.reason === 'next_milestone_invalid' && nextId !== null
              ? { milestoneId: nextId, projectId: project.projectId }
              : { projectId: project.projectId },
        };
      }),
    });
  }

  return out;
}

/**
 * The header's receipts line: "9 projects (1 inactive) · 21 milestones ·
 * 3 overdue · 2 at risk · Oct 7 – Dec 30". Overdue and at risk count
 * active projects only (§2.8: an inactive project is never loud; its lane
 * is drawn in greys), so the inactive count says why a grey overdue bar
 * is not in them.
 */
export function timelineReceipts(view: TimelineView): string {
  let lanes = 0;
  let inactive = 0;
  let milestones = 0;
  let overdue = 0;
  let atRisk = 0;
  for (const group of view.groups) {
    for (const lane of group.lanes) {
      lanes += 1;
      if (!lane.active) inactive += 1;
      for (const bar of [...lane.bars, ...lane.undated]) {
        milestones += 1;
        if (!lane.active) continue;
        if (bar.status === 'overdue') overdue += 1;
        if (bar.status === 'at_risk') atRisk += 1;
      }
    }
  }
  return [
    inactive > 0
      ? `${plural(lanes, 'project')} (${inactive} inactive)`
      : plural(lanes, 'project'),
    plural(milestones, 'milestone'),
    `${overdue} overdue`,
    `${atRisk} at risk`,
    `${formatDate(view.windowStart, view.today)} – ${formatDate(view.windowEnd, view.today)}`,
  ].join(' · ');
}

/** The server-built model the timeline's client island renders. */
export interface TimelinePageModel {
  today: string;
  windowStart: string;
  windowEnd: string;
  groups: TimelineGroup[];
  dependencies: TimelineDependency[];
  banners: TimelineBanner[];
  /** Drag handles and the drawer's date/lead controls. */
  canEditLinear: boolean;
  /** Weight and "done means…" (tool-owned writes). */
  canEditMeta: boolean;
  needsWriteGrant: boolean;
}

export function buildTimelinePage(input: {
  view: TimelineView;
  graph: DependencyGraph;
  permissions: TimelinePermissions;
  issues: ReadonlyMap<string, IssueRef>;
}): TimelinePageModel {
  const { view, graph, permissions, issues } = input;
  return {
    today: view.today,
    windowStart: view.windowStart,
    windowEnd: view.windowEnd,
    groups: toChartGroups(view, permissions),
    dependencies: chartDependencies(graph),
    banners: buildTimelineBanners(view, issues),
    canEditLinear: canEditLinear(permissions),
    canEditMeta: permissions.isPm,
    needsWriteGrant: needsWriteGrant(permissions),
  };
}

/* ---- the slide-over drawer -------------------------------------------- */

export interface DrawerIssue {
  id: string;
  key: string;
  title: string;
  url: string;
  state: string;
  stateKind: WorkflowStateType;
  open: boolean;
  /** null renders "Unassigned" (accent while the issue is open). */
  assignee: string | null;
  /** Identifiers of the open issues blocking this one. */
  blockedBy: string[];
}

export interface DrawerOption {
  id: string;
  label: string;
  disabled?: boolean;
}

/** The drawer's "Next milestone" cell. */
export interface DrawerNext {
  /** "Yes" or "No". */
  value: string;
  /** "Allocation stopped · Project has no lead", "Read path switch is
      next", or null when there is nothing to add. */
  note: string | null;
  tone: 'default' | 'accent';
}

export interface DrawerLimits {
  doneMeansMax: number;
  weightMin: number;
  weightMax: number;
}

export interface MilestoneDrawerModel {
  milestoneId: string;
  /** The workspace's today, for wording dates the person picks. */
  today: string;
  projectId: string;
  title: string;
  /** "ATLAS BILLING MIGRATION / DUAL-WRITE" (uppercased by the drawer). */
  breadcrumb: string;
  projectName: string;
  /** Open in Linear: the project (Linear has no milestone page URL). */
  linearUrl: string;
  /** The canonical link copied by "Copy link". */
  path: string;
  /** "Overdue by 3 days." when overdue (and the project is active), else
      null. */
  overdueText: string | null;
  /**
   * The milestone of an inactive project (§2.8): never loud. No overdue
   * strip, a grey status mark (its label still names the status), and no
   * accent on the risk lines, due date, progress or issue rows.
   */
  muted: boolean;
  status: {
    status: UiStatus;
    label: string;
    /** Risk reasons and missing rubric input, as plain lines. */
    lines: string[];
  };
  due: {
    /** YYYY-MM-DD or null (no target date). */
    value: string | null;
    /** "Oct 18 · 3 days overdue", "No target date". */
    label: string;
    tone: UiTone;
  };
  lead: {
    id: string | null;
    /** null renders "No lead" in the accent. */
    name: string | null;
    /** DEACTIVATED_LEAD_NOTE for a lead Linear deactivated (accent). */
    note: string | null;
  };
  progress: {
    done: number;
    total: number;
    canceled: number;
    tone: 'default' | 'accent';
  };
  weight: { value: number | null; label: string };
  isNext: boolean;
  /** The "Next milestone" cell: yes / no, plus what that means here. */
  next: DrawerNext;
  doneMeans: {
    /** The resolved text (planner first, then the Linear description). */
    text: string | null;
    /** "Written in the planner" / "From the Linear description". */
    sourceLabel: string | null;
    /** The planner's own text (what the PM edits); empty when unset. */
    plannerText: string;
  };
  rubric: ChecklistItem[];
  issues: DrawerIssue[];
  openIssues: number;
  waitsOn: { id: string; label: string }[];
  graphHref: string;
  permissions: {
    /** Date and lead (Linear writes). */
    canEditLinear: boolean;
    /** Weight and "done means…". */
    canEditMeta: boolean;
  };
  /** Active people who may lead (PMs with write scope only). */
  leadOptions: DrawerOption[];
  limits: DrawerLimits;
}

const RUBRIC_ORDER: readonly RubricGap[] = [
  'no_target_date',
  'no_done_means',
  'no_project_lead',
  'no_issues',
];

/** "Overdue by 1 day." / "Overdue by 3 days." */
export function overdueText(daysLate: number): string {
  return `Overdue by ${plural(daysLate, 'day')}.`;
}

/** The weight cell: the override as a tag, or the default order. */
export function weightLabel(weight: number | null): string {
  const tag = weightTag(weight);
  if (weight === null) return 'None · date order';
  return tag ?? '0 · date order';
}

/** What the lead note says about a lead Linear has deactivated. */
export const DEACTIVATED_LEAD_NOTE =
  'Deactivated in Linear: nothing in this project is allocated.';

/**
 * The "Next milestone" cell (§2.6, §2.8). For the project's next
 * milestone it says when allocation will not hand its issues out (an
 * inactive project, or a blocked one with the reason, in the accent), so
 * a stopped project is visible from the milestone itself. For any other
 * milestone it names the one that is next.
 */
export function nextMilestoneCell(
  isNext: boolean,
  lane: CoreLane | undefined
): DrawerNext {
  const allocation = lane?.allocation ?? null;
  if (isNext) {
    if (lane !== undefined && !lane.active) {
      return {
        value: 'Yes',
        note: 'Inactive project: no allocation or warnings',
        tone: 'default',
      };
    }
    if (allocation?.outcome === 'blocked' && allocation.blockReason !== null) {
      return {
        value: 'Yes',
        note: `Allocation stopped · ${BLOCK_REASON_LABEL[allocation.blockReason]}`,
        tone: 'accent',
      };
    }
    return { value: 'Yes', note: null, tone: 'default' };
  }
  const nextId = allocation?.nextMilestoneId ?? null;
  const next =
    nextId === null || lane === undefined
      ? undefined
      : [...lane.bars, ...lane.undated].find(
          (other) => other.milestoneId === nextId
        );
  return {
    value: 'No',
    note: next === undefined ? null : `${next.name} is next`,
    tone: 'default',
  };
}

/**
 * The rubric as four checklist items (§2.4), worded with
 * RUBRIC_GAP_LABEL when an item is missing, with what is there when it is
 * met. The missing items say where to fix them.
 */
export function rubricChecklist(
  detail: MilestoneDetail,
  today: string,
  canEdit: { linear: boolean; meta: boolean },
  leadDeactivated = false
): ChecklistItem[] {
  const gaps = new Set(detail.assessment.rubric.gaps);
  const { milestone, assessment } = detail;
  const fixHere = {
    no_target_date: canEdit.linear
      ? 'Set it above, or in Linear.'
      : 'Set it in Linear.',
    no_done_means: canEdit.meta
      ? 'Write it above, or start a line of the Linear description with "Done means:".'
      : 'Start a line of the Linear description with "Done means:".',
    no_project_lead: canEdit.linear
      ? 'Set a lead above, or in Linear.'
      : 'Set a lead in Linear.',
    no_issues: 'Add issues to this milestone in Linear.',
  } satisfies Record<RubricGap, string>;
  const metNote = {
    no_target_date:
      milestone.targetDate === null
        ? ''
        : formatDate(milestone.targetDate, today),
    no_done_means:
      assessment.doneMeans.source === 'planner'
        ? 'Written in the planner'
        : 'From the Linear description',
    // Having a lead meets the rubric, but a deactivated one still stops
    // allocation (§2.8), so the met item says so.
    no_project_lead: leadDeactivated
      ? `${detail.leadName ?? 'Unknown'} · deactivated in Linear`
      : (detail.leadName ?? ''),
    no_issues: plural(assessment.progress.total, 'issue'),
  } satisfies Record<RubricGap, string>;
  const label = {
    no_target_date: 'Target date',
    no_done_means: '"Done means…"',
    no_project_lead: 'Project lead',
    no_issues: 'At least one issue',
  } satisfies Record<RubricGap, string>;
  return RUBRIC_ORDER.map((gap) => {
    const met = !gaps.has(gap);
    return {
      id: gap,
      label: label[gap],
      met,
      note: met ? metNote[gap] : `${RUBRIC_GAP_LABEL[gap]}. ${fixHere[gap]}`,
    };
  });
}

/** People who can lead a project: active, not apps, by name. The current
 * lead stays listed (disabled) when Linear has deactivated them. */
export function leadOptions(
  users: readonly User[],
  currentLeadId: string | null
): DrawerOption[] {
  const people: DrawerOption[] = users
    .filter((user) => user.active && !user.app)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((user) => ({ id: user.id, label: user.name }));
  if (
    currentLeadId !== null &&
    !people.some((person) => person.id === currentLeadId)
  ) {
    const current = users.find((user) => user.id === currentLeadId);
    people.unshift({
      id: currentLeadId,
      label: `${current?.name ?? 'Unknown'} (deactivated)`,
      disabled: true,
    });
  }
  return people;
}

/**
 * The milestone drawer (§8.3): header, overdue strip, property list
 * (status, due, lead, progress, weight, next, done means…), rubric,
 * issues with their blockers, and what it waits on. Edit controls are
 * offered by permission; the routes enforce the same rules.
 */
export function buildMilestoneDrawer(input: {
  detail: MilestoneDetail;
  today: string;
  permissions: TimelinePermissions;
  users: readonly User[];
  /** Every mirrored issue by id, for blocked-by keys outside this milestone. */
  issues: ReadonlyMap<string, IssueRef>;
  limits: DrawerLimits;
  /** The timeline view, for the project's allocation state and its next
      milestone's name (the "Next milestone" cell). */
  view?: TimelineView;
}): MilestoneDrawerModel {
  const { detail, today, permissions, users, limits } = input;
  const { milestone, project, assessment } = detail;
  const mark = assessmentMark(assessment);
  const linear = canEditLinear(permissions);
  const meta = permissions.isPm;

  const lines = assessment.reasons.map((reason) => RISK_REASON_LABEL[reason]);
  if (!assessment.rubric.valid && assessment.status !== 'complete') {
    const gaps = missingLine(assessment.rubric.gaps);
    lines.push(gaps.charAt(0).toUpperCase() + gaps.slice(1));
  }

  const lead =
    project.leadId === null ? undefined : findUser(users, project.leadId);
  const leadDeactivated = lead !== undefined && !lead.active;
  const lane = input.view?.groups
    .flatMap((group) => group.lanes)
    .find((candidate) => candidate.projectId === project.id);
  const keyOf = (id: string): string =>
    detail.issues.find((issue) => issue.issueId === id)?.identifier ??
    input.issues.get(id)?.identifier ??
    'Unknown issue';

  const issues: DrawerIssue[] = detail.issues.map((issue) => ({
    id: issue.issueId,
    key: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.stateName,
    stateKind: issue.stateType,
    open: issue.stateType !== 'completed' && issue.stateType !== 'canceled',
    assignee: issue.assigneeName,
    blockedBy: issue.blockedByIds.map(keyOf),
  }));

  const { progress } = assessment;
  // An inactive project's milestone keeps its real status, said quietly:
  // its dates are not deadlines while the project is paused (§2.8).
  const muted = lane !== undefined && !lane.active;
  const overdue =
    !muted && assessment.status === 'overdue' && assessment.daysLeft !== null
      ? overdueText(-assessment.daysLeft)
      : null;

  return {
    milestoneId: milestone.id,
    today,
    projectId: project.id,
    title: milestone.name,
    breadcrumb: `${project.name} / ${milestone.name}`,
    projectName: project.name,
    linearUrl: project.url,
    path: `/timeline?milestone=${encodeURIComponent(milestone.id)}`,
    overdueText: overdue,
    muted,
    status: {
      status: mark.status,
      label: muted ? `${mark.label} · inactive project` : mark.label,
      lines,
    },
    due: {
      value: milestone.targetDate,
      label: dueLabel(
        milestone.targetDate,
        assessment.daysLeft,
        today,
        assessment.status
      ),
      tone:
        !muted &&
        (milestone.targetDate === null || assessment.status === 'overdue')
          ? 'accent'
          : 'default',
    },
    lead: {
      id: project.leadId,
      name: detail.leadName,
      note: leadDeactivated ? DEACTIVATED_LEAD_NOTE : null,
    },
    progress: {
      done: progress.completed,
      total: progress.scope,
      canceled: progress.canceled,
      tone:
        !muted &&
        (assessment.status === 'overdue' ||
          assessment.reasons.includes('behind_pace'))
          ? 'accent'
          : 'default',
    },
    weight: {
      value: detail.meta?.weight ?? null,
      label: weightLabel(detail.meta?.weight ?? null),
    },
    isNext: assessment.isNext,
    next: nextMilestoneCell(assessment.isNext, lane),
    doneMeans: {
      text: assessment.doneMeans.text,
      sourceLabel:
        assessment.doneMeans.source === 'planner'
          ? 'Written in the planner'
          : assessment.doneMeans.source === 'linear_description'
            ? 'From the Linear description'
            : null,
      plannerText: detail.meta?.doneMeans ?? '',
    },
    rubric: rubricChecklist(detail, today, { linear, meta }, leadDeactivated),
    issues,
    openIssues: progress.open,
    waitsOn: detail.waitsOn.map((other) => ({
      id: other.milestoneId,
      label: `${other.projectName} › ${other.name}`,
    })),
    graphHref: `/graph?milestone=${encodeURIComponent(milestone.id)}`,
    permissions: { canEditLinear: linear, canEditMeta: meta },
    leadOptions: linear ? leadOptions(users, project.leadId) : [],
    limits,
  };
}

function findUser(users: readonly User[], id: string): User | undefined {
  return users.find((user) => user.id === id);
}
