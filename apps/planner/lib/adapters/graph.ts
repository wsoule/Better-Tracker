import {
  type AllocationPlan,
  type DependencyGraph,
  type GraphContainer,
  type GraphEdge,
  graphContainer,
  type GraphLevel,
  type GraphNode,
  type GraphScope,
  graphScopeFor,
  homeInitiativeIds,
  type IsoDate,
  isIssueOpen,
  type MilestoneAssessment,
  type MilestoneStatus,
  nextMilestoneId,
  NO_INITIATIVE_ID,
  PRIORITY_LABEL,
  type Project,
  type ProjectAllocationPlan,
  RISK_REASON_LABEL,
  RUBRIC_GAP_LABEL,
  type Snapshot,
  STATUS_LABEL,
  toMermaid,
} from '@better-tracker/core';
import {
  type GraphEdgeData,
  type GraphEdgeKind,
  type GraphLayout,
  type GraphLegendItem,
  type GraphNodeData,
  type GraphNodeTag,
  type GraphNodeTone,
  layoutGraph,
  type NavTabItem,
  type ShellCrumb,
  type UiStatus,
} from '@better-tracker/ui';

import { dueLabel, formatDate, plural } from '../format';
import type { ReadOnlyReasonCopy } from '../read-only';
import {
  chainHref,
  GRAPH_DRAW_LIMITS,
  GRAPH_LEVEL_LABEL,
  graphHref,
  graphTrail,
  initiativeName,
  ISOLATED_MAX_ROWS,
  levelTabs,
  NARROW_MAX_ROWS,
} from './graph-scope';
import { withIssueParam } from './issue';
import { allocationCell } from './projects';
import { assessmentMark, uiStatus } from './status';

// The /graph page (architecture §8.4 "Graph", §2.10): core's
// DependencyGraph at any of its four levels (initiative, project,
// milestone, issue) inside the workspace, an initiative, a project, a
// milestone or one issue's chain, mapped onto the ui package's
// GraphNodeData / GraphEdgeData, plus everything the page says around it
// (heading, trail, receipts, notices, the screen-reader summary, the
// legend, the level tabs, the Mermaid text, each drawn node's slide-over
// details, the server-side layout, and the too-large state). Pure
// functions over engine data; the server page builds the model once and
// the client island only renders it.

export {
  chainHref,
  GRAPH_PATH,
  graphHref,
  levelTabs,
  parseGraphParams,
  parseGraphScope,
} from './graph-scope';

function timelineMilestoneHref(milestoneId: string): string {
  return `/timeline?milestone=${encodeURIComponent(milestoneId)}`;
}

function timelineProjectHref(projectId: string): string {
  return `/timeline?project=${encodeURIComponent(projectId)}`;
}

function timelineInitiativeHref(initiativeId: string): string {
  return `/timeline?initiative=${encodeURIComponent(initiativeId)}`;
}

/** A link in a node's slide-over. */
export interface GraphLink {
  label: string;
  href: string;
  /** Opens outside the app (Linear), in a new tab. */
  external: boolean;
}

/** One row of a node's property list, as plain text. */
export interface GraphProperty {
  label: string;
  value: string;
  /** Accent when the value is what needs action ("No lead", "Unassigned"). */
  tone?: 'default' | 'accent';
}

/** What the slide-over shows for a selected node. */
export interface GraphNodeDetail {
  id: string;
  kind: GraphLevel;
  title: string;
  /** Mono crumb above the title: "ATLAS BILLING MIGRATION / DUAL-WRITE". */
  breadcrumb: string;
  status: UiStatus;
  statusLabel: string;
  /** An accent strip at the top when the node is overdue. */
  alert: string | null;
  properties: GraphProperty[];
  /** Drill-down and elsewhere links, in panel order; never this page. */
  links: GraphLink[];
  /** An issue node's identifier ("ENG-12"): selecting it opens the
      issue's slide-over (?issue=, §8.5). Null for the other kinds. */
  issueKey: string | null;
}

/** One node with no blocking relation, listed under the canvas instead. */
export interface IsolatedRow {
  id: string;
  /** Initiative, project or milestone name, or issue title. */
  name: string;
  /** The issue identifier ("ENG-12"); null for the other kinds. */
  key: string | null;
  status: UiStatus;
  statusLabel: string;
  /** The mark in greys whatever the status: paused work is never loud
      (§2.8); the label still names the status. */
  statusMuted: boolean;
  /** Projects count (initiatives), lead (projects), project name
      (milestones) or assignee (issues). */
  context: string;
  contextTone: 'default' | 'accent';
  /** "Oct 26 · in 5 days", "No target date", "No open milestone". */
  due: string;
  dueTone: 'default' | 'accent';
  /** The initiative's or project's graph, the milestone's timeline drawer,
      or the issue's slide-over on this graph (?issue=). */
  href: string;
  external: boolean;
  rowLabel: string;
  tone: 'default' | 'accent' | 'muted';
}

/** The register of nodes left off the canvas (no edge in scope). */
export interface IsolatedList {
  /** "10 milestones have no blocking relations" (counts every one). */
  title: string;
  /** Why they are not drawn. */
  note: string;
  /** Register column labels: name, context, due. */
  nameLabel: string;
  contextLabel: string;
  dueLabel: string;
  /** At most ISOLATED_MAX_ROWS rows, in node order. */
  rows: IsolatedRow[];
  /** "Showing 100 of 240. Narrow the graph to see the rest.", or null. */
  cutLine: string | null;
  /** Long lists start collapsed behind a Show button. */
  collapsed: boolean;
}

/** One way to narrow a graph too large to draw. */
export interface GraphNarrowRow {
  id: string;
  label: string;
  /** "Initiative", "Project", "Milestone", "Issue". */
  kind: string;
  /** Boxes it would draw, or an issue's edges, as digits. */
  count: string;
  href: string;
}

/** What the page shows instead of a graph past GRAPH_DRAW_LIMITS. */
export interface GraphTooLarge {
  message: string;
  title: string;
  note: string | null;
  rows: GraphNarrowRow[];
}

/** A quiet one-line paragraph under the receipts. */
export interface GraphNotice {
  id:
    | 'fallback'
    | 'unplaced'
    | 'unrelated'
    | 'shared'
    | 'chain-closed'
    | 'chain-cut';
  text: string;
}

export interface GraphPageModel {
  level: GraphLevel;
  container: GraphContainer;
  /** Canonical URL of this scope (no node, no issue). */
  scopeHref: string;
  /** Remount key of the client island: scopeHref plus ?node=. */
  pageKey: string;
  heading: string;
  receipts: string;
  notices: GraphNotice[];
  /** The drill-up trail above the heading; empty in the workspace. */
  trail: ShellCrumb[];
  /** Level tabs; empty when the container offers one level. */
  tabs: NavTabItem[];
  /** BlockBar title over the graph. */
  blockTitle: string;
  /** BlockBar meta over the graph. */
  meta: string;
  /** The drawn nodes: those on at least one edge (plus any kept one). */
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  /** layoutGraph of nodes and edges, computed once on the server. */
  layout: GraphLayout | null;
  /** Slide-over details of the drawn nodes and the listed rows only. */
  details: Record<string, GraphNodeDetail>;
  /** Nodes with no blocking relation, or null when there are none. With
   * nothing drawn it is null (the empty state covers that) except at an
   * initiative's or a project's aggregate levels, where every box is
   * listed so each one's own graph stays a click away. */
  isolated: IsolatedList | null;
  /** Set instead of nodes when the graph is past GRAPH_DRAW_LIMITS. */
  tooLarge: GraphTooLarge | null;
  /** The ?node= box selected on arrival, when it is drawn. */
  initialSelectedId: string | null;
  /** A chain's issue, ruled as the graph's focus. */
  focusId: string | null;
  ariaSummary: string;
  emptyMessage: string;
  legend: GraphLegendItem[];
  /** Mermaid text of the drawn graph; null when nothing is drawn. */
  mermaid: string | null;
  /** The page's own breadcrumb ("Issues in Dual-write"), or null. */
  crumb: string | null;
}

export interface GraphPageInput {
  graph: DependencyGraph;
  snapshot: Snapshot;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  today: IsoDate;
  /** ?node=: an aggregate box to select (and keep) on arrival. */
  nodeId?: string | null;
  /** ?issue=: an issue slide-over is open, so ?node= selects nothing. Its
      node is not kept: opening a listed issue must not move it onto the
      canvas. */
  issueKey?: string | null;
  /** Actor.readOnlyReason, for the no-initiatives notice. */
  readOnlyReason?: ReadOnlyReasonCopy;
  /** Node ids drawn even without an edge. */
  keep?: readonly string[];
}

/** Isolated lists longer than this start collapsed. */
export const ISOLATED_COLLAPSE_AFTER = 6;

/**
 * The ids of nodes that touch no edge, in node order, minus `keep`. They
 * are listed under the canvas rather than drawn: a column of unconnected
 * boxes would push the few that wait on each other out of view.
 */
export function isolatedNodeIds(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
  keep: readonly string[] = []
): string[] {
  const linked = new Set<string>(keep);
  for (const edge of edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  return nodeIds.filter((id) => !linked.has(id));
}

function isMilestoneStatus(value: string): value is MilestoneStatus {
  return Object.hasOwn(STATUS_LABEL, value);
}

/** Whether an edge crosses the boundary the level draws as "cross": a
    project at the issue and milestone levels, a first initiative at the
    project level (never for a viewer without initiatives, whose edges
    carry no crossInitiative), nothing at the initiative level. */
function crossesBoundary(edge: GraphEdge, level: GraphLevel): boolean {
  switch (level) {
    case 'issue':
    case 'milestone':
      return edge.crossProject;
    case 'project':
      return edge.crossInitiative;
    case 'initiative':
      return false;
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * How an edge is drawn, in the ui package's precedence (resolved > cycle >
 * risk > cross > default): a closed blocker no longer holds anything up,
 * a cycle is the loudest problem, a risk chain next, then the level's
 * boundary (crossesBoundary).
 */
export function edgeKind(
  edge: GraphEdge,
  level: GraphLevel = 'issue'
): GraphEdgeKind {
  if (edge.resolved) return 'resolved';
  if (edge.inCycle) return 'cycle';
  if (edge.onRiskChain) return 'risk';
  if (crossesBoundary(edge, level)) return 'cross';
  return 'default';
}

/**
 * The mono chips on a node, from core's flags, in this order: UNASSIGNED
 * (open issues and milestones only: a project or initiative always holds
 * some unassigned later work), OVERDUE (never for an inactive project's
 * work), CYCLE, CYCLE INSIDE (a box holding an issue loop), NO LEAD (an
 * active project), INACTIVE (a box with no active project) and +N MORE (a
 * chain issue leading on to issues the chain cap left out).
 */
export function nodeTags(node: GraphNode): GraphNodeTag[] {
  const tags: GraphNodeTag[] = [];
  const aggregate = node.kind !== 'issue';
  if (
    (node.kind === 'issue' || node.kind === 'milestone') &&
    node.open &&
    node.unassigned
  ) {
    tags.push('UNASSIGNED');
  }
  if (node.overdue && node.active) tags.push('OVERDUE');
  if (node.inCycle) tags.push('CYCLE');
  if (aggregate && node.holdsCycle) tags.push('CYCLE INSIDE');
  if (node.kind === 'project' && node.active && node.ownerId === null) {
    tags.push('NO LEAD');
  }
  if (aggregate && !node.active) tags.push('INACTIVE');
  if ((node.hiddenNeighbours ?? 0) > 0) {
    tags.push(`+${node.hiddenNeighbours} MORE`);
  }
  return tags;
}

/**
 * Node emphasis, first match wins: faint once closed (an issue done or
 * canceled, a milestone complete) or when its project is inactive (a box
 * of paused work is never loud, §2.8); the accent when it needs action;
 * ink otherwise. An issue needs action when it is open and nobody owns it
 * (or its milestone is overdue), in an active project; a milestone when it
 * is at risk or overdue; a project or an initiative when its next
 * milestone (the most severe of them) is. A later milestone's unassigned
 * issues are normal (allocation hands out only the next milestone), so
 * they keep their UNASSIGNED chip without flooding every milestone in the
 * accent.
 */
export function nodeTone(node: GraphNode): GraphNodeTone {
  if (!node.open || node.status === 'complete') return 'muted';
  if (node.kind !== 'issue' && !node.active) return 'muted';
  if (node.overdue && node.active) return 'accent';
  switch (node.kind) {
    case 'issue':
      return node.unassigned && node.active ? 'accent' : 'default';
    case 'milestone':
      return node.status === 'at_risk' ? 'accent' : 'default';
    case 'project':
    case 'initiative':
      return node.status === 'at_risk' || node.status === 'overdue'
        ? 'accent'
        : 'default';
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

interface Mark {
  status: UiStatus;
  label: string;
}

/**
 * The status mark of an issue node, in the same marks as milestones
 * (lib/adapters/status.ts): closed reads as complete (filled ink), open
 * and owned as on track (hollow ink), and open with nobody assigned as a
 * missing input (hatched). The label is the Linear state's own name.
 */
export function issueMark(input: {
  open: boolean;
  unassigned: boolean;
  stateName: string;
}): Mark {
  if (!input.open) {
    return { status: uiStatus('complete'), label: input.stateName };
  }
  if (input.unassigned) {
    return { status: 'missing', label: `${input.stateName}, unassigned` };
  }
  return { status: uiStatus('on_track'), label: input.stateName };
}

function statusMark(status: string): Mark {
  const known = isMilestoneStatus(status) ? status : 'empty';
  return { status: uiStatus(known), label: STATUS_LABEL[known] };
}

function milestoneMark(
  node: GraphNode,
  assessment: MilestoneAssessment | undefined
): Mark {
  if (assessment !== undefined) return assessmentMark(assessment);
  return statusMark(node.status);
}

/* ---- page context ------------------------------------------------------ */

/** Everything the per-node builders share, computed once per page. */
interface PageContext {
  snapshot: Snapshot;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  today: IsoDate;
  scope: GraphScope;
  container: GraphContainer;
  /** Canonical URL of the page (a link to it is left out of panels). */
  scopeHref: string;
  /** The container in sentences: "Dual-write", "the workspace". */
  containerName: string;
  hasInitiatives: boolean;
  /** Each project's first initiative (homeInitiativeIds). */
  home: ReadonlyMap<string, string | null>;
  plans: ReadonlyMap<string, ProjectAllocationPlan>;
}

function homeOf(ctx: PageContext, projectId: string): string {
  return ctx.home.get(projectId) ?? NO_INITIATIVE_ID;
}

/** A project's allocation plan says it is not active (§2.8). */
function isInactive(ctx: PageContext, projectId: string): boolean {
  return ctx.plans.get(projectId)?.outcome === 'inactive';
}

function userName(snapshot: Snapshot, id: string | null): string | null {
  if (id === null) return null;
  return snapshot.users.get(id)?.name ?? 'Unknown person';
}

function projectName(snapshot: Snapshot, id: string | null): string {
  if (id === null) return 'No project';
  return snapshot.projects.get(id)?.name ?? 'Unknown project';
}

/** A container as it reads in a sentence ("No issue in {it} …"). */
function containerName(snapshot: Snapshot, container: GraphContainer): string {
  switch (container.kind) {
    case 'workspace':
      return 'the workspace';
    case 'initiative':
      return container.id === NO_INITIATIVE_ID
        ? 'the projects with no initiative'
        : (snapshot.initiatives.get(container.id)?.name ?? 'this initiative');
    case 'project':
      return snapshot.projects.get(container.id)?.name ?? 'this project';
    case 'milestone':
      return snapshot.milestones.get(container.id)?.name ?? 'this milestone';
    case 'chain':
      return snapshot.issues.get(container.id)?.identifier ?? container.id;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/**
 * Where a count of `noun`s sits, as it follows the count in a sentence:
 * "in Dual-write", "in the workspace". "No initiative" is a group of
 * projects, not a named thing, so it reads "with no initiative" after
 * projects and "in projects with no initiative" after anything else
 * ("1 project with no initiative", "3 milestones in projects with no
 * initiative"), never "projects in the projects with no initiative".
 */
function containerPhrase(ctx: PageContext, noun: string): string {
  const { container } = ctx;
  if (container.kind === 'initiative' && container.id === NO_INITIATIVE_ID) {
    return noun === 'project'
      ? 'with no initiative'
      : 'in projects with no initiative';
  }
  return `in ${ctx.containerName}`;
}

/** "a project with no initiative" or the container's name, as the place
    an open issue sits in ("No open issue in {it} blocks …"). */
function containerSubject(ctx: PageContext): string {
  const { container } = ctx;
  return container.kind === 'initiative' && container.id === NO_INITIATIVE_ID
    ? 'a project with no initiative'
    : ctx.containerName;
}

/**
 * The h1 of a scope, which is also its panel-link label: "Dependencies"
 * for the workspace, "Projects in Platform reliability", "Milestones of
 * projects with no initiative", "Issues in Dual-write", "Blocking chain
 * of ENG-24".
 */
function graphHeading(snapshot: Snapshot, scope: GraphScope): string {
  const container = graphContainer(scope);
  const levelName = GRAPH_LEVEL_LABEL[scope.level];
  switch (container.kind) {
    case 'workspace':
      return 'Dependencies';
    case 'initiative':
      if (container.id === NO_INITIATIVE_ID) {
        return scope.level === 'project'
          ? 'Projects with no initiative'
          : `${levelName} of projects with no initiative`;
      }
      return `${levelName} in ${containerName(snapshot, container)}`;
    case 'project':
    case 'milestone':
      return `${levelName} in ${containerName(snapshot, container)}`;
    case 'chain':
      return `Blocking chain of ${containerName(snapshot, container)}`;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/** The panel link to a scope, unless it is the page itself. */
function scopeLink(
  ctx: PageContext,
  label: string,
  scope: GraphScope,
  node?: string
): GraphLink | null {
  if (graphHref(scope) === ctx.scopeHref) return null;
  return { label, href: graphHref(scope, { node }), external: false };
}

function presentLinks(links: readonly (GraphLink | null)[]): GraphLink[] {
  return links.filter((link): link is GraphLink => link !== null);
}

/* ---- node marks, sublabels and details, per kind -------------------------- */

/** "Atlas billing migration · Oct 18", "… · no date": fits one node line. */
function milestoneSublabel(
  snapshot: Snapshot,
  milestoneId: string,
  today: IsoDate
): string {
  const milestone = snapshot.milestones.get(milestoneId);
  const project = projectName(snapshot, milestone?.projectId ?? null);
  const target = milestone?.targetDate ?? null;
  return `${project} · ${target === null ? 'no date' : formatDate(target, today)}`;
}

/** "Oct 18", or "No target date" (null) for "No initiative". */
function initiativeTarget(ctx: PageContext, id: string): string | null {
  if (id === NO_INITIATIVE_ID) return null;
  const target = ctx.snapshot.initiatives.get(id)?.targetDate ?? null;
  return target === null ? null : formatDate(target, ctx.today);
}

/** The next open milestone of a project and its assessment (core's rule). */
function nextMilestoneOf(ctx: PageContext, projectId: string) {
  const id = nextMilestoneId(ctx.snapshot, projectId, ctx.assessments);
  const milestone = id === null ? undefined : ctx.snapshot.milestones.get(id);
  if (milestone === undefined) return null;
  return { milestone, assessment: ctx.assessments.get(milestone.id) };
}

function projectMark(ctx: PageContext, projectId: string): Mark {
  const next = nextMilestoneOf(ctx, projectId);
  if (next?.assessment === undefined) {
    return { status: 'missing', label: 'No open milestone' };
  }
  return assessmentMark(next.assessment);
}

/** The visible projects whose first initiative is `initiativeId`. */
function projectsUnder(ctx: PageContext, initiativeId: string): Project[] {
  return ctx.snapshot.data.projects.filter(
    (project) => homeOf(ctx, project.id) === initiativeId
  );
}

/** "Outside Platform reliability: it blocks or waits on a project here". */
function outsideLine(ctx: PageContext, noun: string): GraphProperty {
  return {
    label: 'Scope',
    value: `Outside ${ctx.containerName}: it blocks or waits on a ${noun} here`,
  };
}

function initiativeDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: Mark
): GraphNodeDetail {
  const { snapshot } = ctx;
  const id = node.id;
  const none = id === NO_INITIATIVE_ID;
  const projects = projectsUnder(ctx, id);
  const inactive = projects.filter((p) => isInactive(ctx, p.id)).length;
  let open = 0;
  let unassigned = 0;
  for (const project of projects) {
    for (const issue of snapshot.issuesByProject.get(project.id) ?? []) {
      if (!isIssueOpen(snapshot, issue)) continue;
      open += 1;
      if (issue.assigneeId === null) unassigned += 1;
    }
  }
  const atRisk: string[] = [];
  for (const project of projects) {
    if (isInactive(ctx, project.id)) continue;
    const next = nextMilestoneOf(ctx, project.id);
    const status = next?.assessment?.status;
    if (next === null || (status !== 'at_risk' && status !== 'overdue')) {
      continue;
    }
    atRisk.push(
      `${project.name} › ${next.milestone.name} (${status === 'overdue' ? 'overdue' : 'at risk'})`
    );
  }
  const target = initiativeTarget(ctx, id);
  const properties: GraphProperty[] = [
    { label: 'Target date', value: target ?? 'No target date' },
    {
      label: 'Projects',
      value: `${plural(projects.length, 'project')}${inactive > 0 ? ` · ${inactive} inactive` : ''}`,
    },
    {
      label: 'Open issues',
      value: `${open} open${unassigned > 0 ? ` · ${unassigned} unassigned` : ''}`,
    },
    {
      label: 'At risk',
      value: atRisk.length === 0 ? 'None' : atRisk.join('; '),
      tone: atRisk.length === 0 ? 'default' : 'accent',
    },
  ];
  if (node.external) properties.push(outsideLine(ctx, 'project'));
  const at = (level: 'project' | 'milestone' | 'issue'): GraphScope => ({
    level,
    initiativeId: id,
  });
  const links = presentLinks([
    scopeLink(ctx, graphHeading(snapshot, at('project')), at('project')),
    scopeLink(ctx, graphHeading(snapshot, at('milestone')), at('milestone')),
    scopeLink(ctx, graphHeading(snapshot, at('issue')), at('issue')),
    {
      label: 'Open on the timeline',
      href: timelineInitiativeHref(id),
      external: false,
    },
  ]);
  return {
    id,
    kind: 'initiative',
    title: node.label,
    breadcrumb: none ? 'Projects with no initiative' : 'Initiative',
    status: mark.status,
    statusLabel: mark.label,
    alert: null,
    properties,
    links,
    issueKey: null,
  };
}

function projectDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: Mark
): GraphNodeDetail {
  const { snapshot, today } = ctx;
  const project = snapshot.projects.get(node.id);
  const active = node.active;
  const lead = userName(snapshot, project?.leadId ?? null);
  const next = nextMilestoneOf(ctx, node.id);
  const properties: GraphProperty[] = [
    { label: 'Linear status', value: project?.statusName ?? '—' },
    {
      label: 'Lead',
      value: lead ?? 'No lead',
      tone: lead === null && active ? 'accent' : 'default',
    },
    {
      label: 'Next milestone',
      value:
        next === null
          ? 'None'
          : `${next.milestone.name} · ${dueLabel(next.milestone.targetDate, next.assessment?.daysLeft ?? null, today, next.assessment?.status)}`,
      tone:
        active && next?.assessment?.status === 'overdue' ? 'accent' : 'default',
    },
  ];
  const progress = next?.assessment?.progress;
  if (progress !== undefined) {
    const unassigned =
      progress.openUnassigned > 0
        ? ` · ${plural(progress.openUnassigned, 'open issue')} unassigned`
        : '';
    properties.push({
      label: 'Progress',
      value: `${progress.completed}/${progress.scope} done${unassigned}`,
      tone: active && progress.openUnassigned > 0 ? 'accent' : 'default',
    });
  }
  const cell = allocationCell(ctx.plans.get(node.id) ?? null);
  properties.push({
    label: 'Allocation',
    value:
      cell.detail === undefined ? cell.label : `${cell.label} · ${cell.detail}`,
    // The register's chip is warning when allocation is blocked; the
    // graph's older drawing (not restyled yet) still marks it in the accent.
    tone: cell.tone === 'warning' ? 'accent' : 'default',
  });
  if (ctx.hasInitiatives && project !== undefined) {
    const first = homeOf(ctx, project.id);
    const others = project.initiativeIds.filter(
      (id) => id !== first && snapshot.initiatives.has(id)
    );
    if (others.length > 0) {
      properties.push({
        label: 'Initiatives',
        value: `${initiativeName(snapshot, first)} · also in ${others.map((id) => initiativeName(snapshot, id)).join(', ')}`,
      });
    }
  }
  if (node.external) properties.push(outsideLine(ctx, 'project'));
  const links = presentLinks([
    scopeLink(ctx, `Milestones of ${node.label}`, {
      level: 'milestone',
      projectId: node.id,
    }),
    scopeLink(ctx, `Issues of ${node.label}`, {
      level: 'issue',
      projectId: node.id,
    }),
    {
      label: 'Lane on the timeline',
      href: timelineProjectHref(node.id),
      external: false,
    },
    project === undefined
      ? null
      : { label: 'Project in Linear', href: project.url, external: true },
  ]);
  return {
    id: node.id,
    kind: 'project',
    title: node.label,
    breadcrumb: ctx.hasInitiatives
      ? initiativeName(snapshot, node.initiativeId ?? NO_INITIATIVE_ID)
      : 'Project',
    status: mark.status,
    statusLabel: mark.label,
    alert: null,
    properties,
    links,
    issueKey: null,
  };
}

function milestoneDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: Mark
): GraphNodeDetail {
  const { snapshot, assessments, today } = ctx;
  const milestone = snapshot.milestones.get(node.id);
  const project =
    milestone === undefined
      ? undefined
      : snapshot.projects.get(milestone.projectId);
  const assessment = assessments.get(node.id);
  const progress = assessment?.progress;
  const lead = userName(snapshot, project?.leadId ?? null);
  // An inactive project's milestone is never loud (§2.8): the panel says
  // the same facts without the accent, as its box and register row do.
  const loud = node.active;
  const properties: GraphProperty[] = [
    {
      label: 'Due',
      value: dueLabel(
        milestone?.targetDate ?? null,
        assessment?.daysLeft ?? null,
        today,
        assessment?.status
      ),
      tone: loud && node.overdue ? 'accent' : 'default',
    },
    {
      label: 'Lead',
      value: lead ?? 'No lead',
      tone: loud && lead === null ? 'accent' : 'default',
    },
  ];
  if (progress !== undefined) {
    const unassigned =
      progress.openUnassigned > 0
        ? ` · ${plural(progress.openUnassigned, 'open issue')} unassigned`
        : '';
    properties.push({
      label: 'Progress',
      value: `${progress.completed}/${progress.scope} done${unassigned}`,
      tone: loud && progress.openUnassigned > 0 ? 'accent' : 'default',
    });
  }
  if (assessment !== undefined && assessment.reasons.length > 0) {
    properties.push({
      label: 'Risk reasons',
      value: assessment.reasons.map((r) => RISK_REASON_LABEL[r]).join('; '),
      tone: loud ? 'accent' : 'default',
    });
  }
  if (assessment !== undefined && assessment.rubric.gaps.length > 0) {
    properties.push({
      label: 'Missing',
      value: assessment.rubric.gaps.map((g) => RUBRIC_GAP_LABEL[g]).join('; '),
      tone: loud ? 'accent' : 'default',
    });
  }
  if (node.external) properties.push(outsideLine(ctx, 'milestone'));
  const links = presentLinks([
    scopeLink(ctx, 'Issues of this milestone', {
      level: 'issue',
      milestoneId: node.id,
    }),
    project === undefined
      ? null
      : scopeLink(
          ctx,
          `Milestones of ${project.name}`,
          { level: 'milestone', projectId: project.id },
          node.id
        ),
    {
      label: 'Open on the timeline',
      href: timelineMilestoneHref(node.id),
      external: false,
    },
    project === undefined
      ? null
      : { label: 'Project in Linear', href: project.url, external: true },
  ]);
  return {
    id: node.id,
    kind: 'milestone',
    title: node.label,
    breadcrumb: project?.name ?? node.sublabel,
    status: mark.status,
    statusLabel: mark.label,
    alert:
      loud && node.overdue && assessment?.daysLeft != null
        ? `Overdue by ${plural(-assessment.daysLeft, 'day')}, with ${plural(progress?.open ?? 0, 'open issue')}.`
        : null,
    properties,
    links,
    issueKey: null,
  };
}

function issueDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: Mark
): GraphNodeDetail {
  const { snapshot, today } = ctx;
  const issue = snapshot.issues.get(node.id);
  const milestone =
    issue?.milestoneId == null
      ? undefined
      : snapshot.milestones.get(issue.milestoneId);
  const assessment =
    milestone === undefined ? undefined : ctx.assessments.get(milestone.id);
  const project = projectName(snapshot, issue?.projectId ?? null);
  const assignee = userName(snapshot, issue?.assigneeId ?? null);
  // An inactive project's issue is never loud (§2.8), like its box.
  const loud = node.active;
  const properties: GraphProperty[] = [
    { label: 'Issue', value: issue?.identifier ?? node.sublabel },
    {
      label: 'Assignee',
      value: assignee ?? 'Unassigned',
      tone: loud && assignee === null && node.open ? 'accent' : 'default',
    },
    {
      label: 'Priority',
      value: issue === undefined ? '—' : PRIORITY_LABEL[issue.priority],
    },
    { label: 'Project', value: project },
    {
      label: 'Milestone',
      value:
        milestone === undefined
          ? 'No milestone'
          : `${milestone.name} · ${dueLabel(milestone.targetDate, assessment?.daysLeft ?? null, today, assessment?.status)}`,
      tone: loud && node.overdue ? 'accent' : 'default',
    },
  ];
  if (node.external) {
    properties.push({
      label: 'Scope',
      value: 'Outside this graph’s scope: it blocks or waits on an issue here',
    });
  }
  const links: GraphLink[] = [];
  if (node.url !== null) {
    links.push({ label: 'Open in Linear', href: node.url, external: true });
  }
  if (milestone !== undefined) {
    links.push({
      label: 'Milestone on the timeline',
      href: timelineMilestoneHref(milestone.id),
      external: false,
    });
    const own = scopeLink(ctx, 'Issues of this milestone', {
      level: 'issue',
      milestoneId: milestone.id,
    });
    if (own !== null) links.push(own);
  }
  return {
    id: node.id,
    kind: 'issue',
    title: node.label,
    breadcrumb:
      milestone === undefined ? project : `${project} / ${milestone.name}`,
    status: mark.status,
    statusLabel: mark.label,
    alert:
      loud && node.overdue && assessment?.daysLeft != null
        ? `Its milestone is overdue by ${plural(-assessment.daysLeft, 'day')}.`
        : null,
    properties,
    links,
    issueKey: issue?.identifier ?? null,
  };
}

/** What one node draws and says, per kind: mark, sublabel, cluster. */
interface NodeFace {
  mark: Mark;
  sublabel: string;
  group: string | undefined;
}

function nodeFace(ctx: PageContext, node: GraphNode): NodeFace {
  const { snapshot, assessments, today } = ctx;
  switch (node.kind) {
    case 'initiative': {
      const target = initiativeTarget(ctx, node.id);
      return {
        mark: statusMark(node.status),
        sublabel:
          node.id === NO_INITIATIVE_ID
            ? node.sublabel
            : `${node.sublabel} · ${target ?? 'no target date'}`,
        group: undefined,
      };
    }
    case 'project':
      return {
        mark: projectMark(ctx, node.id),
        sublabel: node.sublabel,
        group: ctx.hasInitiatives
          ? initiativeName(snapshot, node.initiativeId ?? NO_INITIATIVE_ID)
          : undefined,
      };
    case 'milestone':
      return {
        mark: milestoneMark(node, assessments.get(node.id)),
        sublabel: milestoneSublabel(snapshot, node.id, today),
        group: projectName(snapshot, node.projectId),
      };
    case 'issue': {
      const issue = snapshot.issues.get(node.id);
      const stateName =
        issue === undefined
          ? node.status
          : (snapshot.states.get(issue.stateId)?.name ?? node.status);
      return {
        mark: issueMark({
          open: node.open,
          unassigned: node.unassigned,
          stateName,
        }),
        sublabel: node.sublabel,
        group: projectName(snapshot, node.projectId),
      };
    }
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

function nodeDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: Mark
): GraphNodeDetail {
  switch (node.kind) {
    case 'initiative':
      return initiativeDetail(ctx, node, mark);
    case 'project':
      return projectDetail(ctx, node, mark);
    case 'milestone':
      return milestoneDetail(ctx, node, mark);
    case 'issue':
      return issueDetail(ctx, node, mark);
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/* ---- phrases --------------------------------------------------------------- */

/** Names of the nodes of one cycle, as a clause ("A and B wait on each other"). */
function cycleClause(ids: readonly string[], labels: Map<string, string>) {
  const names = ids.map((id) => labels.get(id) ?? id);
  if (names.length === 1) return `${names[0]} waits on itself`;
  if (names.length === 2)
    return `${names[0]} and ${names[1]} wait on each other`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last} wait on each other in a loop`;
}

/** Joins the present parts: "a", "a and b", "a, b and c" ("" for none). */
export function listPhrase(parts: readonly (string | null)[]): string {
  const present = parts.filter((part): part is string => part !== null);
  if (present.length <= 1) return present[0] ?? '';
  return `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`;
}

/** "no cycles" / "1 cycle: A and B wait on each other". */
export function cyclesPhrase(
  cycles: readonly (readonly string[])[],
  labels: Map<string, string>
): string {
  if (cycles.length === 0) return 'no cycles';
  return `${plural(cycles.length, 'cycle')}: ${cycles.map((c) => cycleClause(c, labels)).join('; ')}`;
}

/** ": a, b and c" after a count, or "" when no part applies. */
function detailClause(parts: readonly (string | null)[]): string {
  const detail = listPhrase(parts);
  return detail === '' ? '' : `: ${detail}`;
}

/* ---- legends -------------------------------------------------------------- */

const MILESTONE_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Milestone', note: 'blockers sit left of what waits' },
  { mark: 'node-overdue', label: 'Overdue', note: 'past its date' },
  { mark: 'node-accent', label: 'At risk', note: 'due soon and at risk' },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  {
    mark: 'node-muted',
    label: 'Complete or inactive',
    note: 'nothing open, or a paused project',
  },
  { mark: 'edge-default', label: 'Blocks', note: 'an open issue blocks one' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'ends in an unassigned or overdue blocker',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  { mark: 'weight', label: 'Count', note: 'issue relations on one edge' },
];

const ISSUE_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Issue', note: 'blockers sit left of what waits' },
  { mark: 'node-overdue', label: 'Overdue', note: 'its milestone is past due' },
  { mark: 'node-accent', label: 'Needs action', note: 'open and unassigned' },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  { mark: 'node-external', label: 'External', note: 'outside this scope' },
  { mark: 'node-muted', label: 'Closed', note: 'done or canceled' },
  { mark: 'edge-default', label: 'Blocks', note: 'blocker → waiting' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'ends in an unassigned or overdue blocker',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  { mark: 'edge-resolved', label: 'Resolved', note: 'blocker closed' },
];

/** The issue legend where nothing is outside the scope: the workspace
    (it holds everything) and a chain (every box is on it). */
const ISSUE_LEGEND_NO_EXTERNAL: GraphLegendItem[] = ISSUE_LEGEND.filter(
  (item) => item.mark !== 'node-external'
);

/** The issue legend for one issue's chain: no externals, plus the focus. */
const CHAIN_LEGEND: GraphLegendItem[] = [
  ...ISSUE_LEGEND_NO_EXTERNAL.slice(0, 1),
  { mark: 'node-focus', label: 'Focus', note: 'the issue this chain is about' },
  ...ISSUE_LEGEND_NO_EXTERNAL.slice(1),
];

/** Shared by the initiative and project legends. */
const AGGREGATE_EDGES: GraphLegendItem[] = [
  { mark: 'edge-default', label: 'Blocks', note: 'an open issue blocks one' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'a blocking issue is unassigned or overdue, or waits on one',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
];

const WEIGHT_ITEM: GraphLegendItem = {
  mark: 'weight',
  label: 'Count',
  note: 'issue relations on one edge',
};

function aggregateLegend(
  kind: 'Initiative' | 'Project',
  inactiveNote: string,
  cross: GraphLegendItem | null
): GraphLegendItem[] {
  return [
    { mark: 'node', label: kind, note: 'blockers sit left of what waits' },
    {
      mark: 'node-overdue',
      label: 'Overdue',
      note: 'a project’s milestone is past due',
    },
    {
      mark: 'node-accent',
      label: 'At risk',
      note: 'a project’s next milestone',
    },
    {
      mark: 'node-cycle',
      label: 'In a cycle',
      note: 'they wait on each other',
    },
    { mark: 'node-muted', label: 'Inactive', note: inactiveNote },
    ...AGGREGATE_EDGES,
    ...(cross === null ? [] : [cross]),
    WEIGHT_ITEM,
  ];
}

const INITIATIVE_LEGEND: GraphLegendItem[] = aggregateLegend(
  'Initiative',
  'no active project',
  null
);

/** The legend with "External — outside {where}" after the cycle swatch. */
function withExternal(
  legend: readonly GraphLegendItem[],
  where: string
): GraphLegendItem[] {
  const at = legend.findIndex((item) => item.mark === 'node-cycle') + 1;
  return [
    ...legend.slice(0, at),
    { mark: 'node-external', label: 'External', note: `outside ${where}` },
    ...legend.slice(at),
  ];
}

function legendFor(ctx: PageContext): GraphLegendItem[] {
  const { container } = ctx;
  const level = ctx.scope.level;
  const where =
    container.kind === 'initiative' ? 'this initiative' : 'this project';
  switch (level) {
    case 'initiative':
      return INITIATIVE_LEGEND;
    case 'project': {
      const legend = aggregateLegend(
        'Project',
        'paused or not started',
        ctx.hasInitiatives
          ? {
              mark: 'edge-cross',
              label: 'Cross-initiative',
              note: 'leaves its initiative',
            }
          : null
      );
      return container.kind === 'workspace'
        ? legend
        : withExternal(legend, where);
    }
    case 'milestone':
      return container.kind === 'workspace'
        ? MILESTONE_LEGEND
        : withExternal(MILESTONE_LEGEND, where);
    case 'issue':
      switch (container.kind) {
        case 'chain':
          return CHAIN_LEGEND;
        case 'workspace':
          return ISSUE_LEGEND_NO_EXTERNAL;
        case 'initiative':
        case 'project':
        case 'milestone':
          return ISSUE_LEGEND;
        default: {
          const unreachable: never = container;
          return unreachable;
        }
      }
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/* ---- the "no blocking relations" register ---------------------------------- */

/** Register copy per level (§8.5 isolated register). */
const ISOLATED_COPY: Readonly<
  Record<
    GraphLevel,
    { noun: string; nameLabel: string; contextLabel: string; dueLabel: string }
  >
> = {
  initiative: {
    noun: 'initiative',
    nameLabel: 'Initiative',
    contextLabel: 'Projects',
    dueLabel: 'Target',
  },
  project: {
    noun: 'project',
    nameLabel: 'Project',
    contextLabel: 'Lead',
    dueLabel: 'Next milestone',
  },
  milestone: {
    noun: 'milestone',
    nameLabel: 'Milestone',
    contextLabel: 'Project',
    dueLabel: 'Due',
  },
  issue: {
    noun: 'issue',
    nameLabel: 'Issue',
    contextLabel: 'Assignee',
    dueLabel: 'Due',
  },
};

/** An aggregate box's mark label, saying why the box is quiet when it is
    inactive ("Overdue · inactive project"). */
function quietLabel(node: GraphNode, label: string): string {
  if (node.active) return label;
  return `${label} · ${node.kind === 'initiative' ? 'no active project' : 'inactive project'}`;
}

function rowTone(data: GraphNodeData): IsolatedRow['tone'] {
  return data.tone === 'accent'
    ? 'accent'
    : data.tone === 'muted'
      ? 'muted'
      : 'default';
}

/** An initiative left off the canvas: opens its own graph. */
function isolatedInitiativeRow(
  ctx: PageContext,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  return {
    id: node.id,
    name: node.label,
    key: null,
    status: data.status ?? 'missing',
    statusLabel: data.statusLabel ?? '',
    statusMuted: !node.active,
    context: node.sublabel,
    contextTone: 'default',
    due: initiativeTarget(ctx, node.id) ?? 'No target date',
    dueTone: 'default',
    href: graphHref({ level: 'project', initiativeId: node.id }),
    external: false,
    rowLabel: `${node.label}, ${node.sublabel}: open its graph`,
    tone: rowTone(data),
  };
}

/** A project left off the canvas: opens its issue graph. */
function isolatedProjectRow(
  ctx: PageContext,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  const project = ctx.snapshot.projects.get(node.id);
  const lead = userName(ctx.snapshot, project?.leadId ?? null);
  const next = nextMilestoneOf(ctx, node.id);
  return {
    id: node.id,
    name: node.label,
    key: null,
    status: data.status ?? 'missing',
    statusLabel: data.statusLabel ?? '',
    statusMuted: !node.active,
    context: lead ?? 'No lead',
    contextTone: lead === null && node.active ? 'accent' : 'default',
    due:
      next === null
        ? 'No open milestone'
        : dueLabel(
            next.milestone.targetDate,
            next.assessment?.daysLeft ?? null,
            ctx.today,
            next.assessment?.status
          ),
    dueTone:
      node.active && next?.assessment?.status === 'overdue'
        ? 'accent'
        : 'default',
    href: graphHref({ level: 'issue', projectId: node.id }),
    external: false,
    rowLabel: `${node.label}, ${lead ?? 'no lead'}: open its graph`,
    tone: rowTone(data),
  };
}

/** A milestone left off the canvas, as a register row. */
function isolatedMilestoneRow(
  ctx: PageContext,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  const { snapshot, assessments, today } = ctx;
  const milestone = snapshot.milestones.get(node.id);
  const assessment = assessments.get(node.id);
  return {
    id: node.id,
    name: node.label,
    key: null,
    status: data.status ?? 'missing',
    statusLabel: data.statusLabel ?? '',
    statusMuted: !node.active,
    context: projectName(snapshot, node.projectId),
    contextTone: 'default',
    due: dueLabel(
      milestone?.targetDate ?? null,
      assessment?.daysLeft ?? null,
      today,
      assessment?.status
    ),
    // Paused work is never loud (§2.8): no accent date, a muted row.
    dueTone: node.active && node.overdue ? 'accent' : 'default',
    href: timelineMilestoneHref(node.id),
    external: false,
    rowLabel: `${node.label}, ${projectName(snapshot, node.projectId)}: open on the timeline`,
    tone: rowTone(data),
  };
}

/** An issue left off the canvas, as a register row (opens the issue's
    slide-over on this graph). */
function isolatedIssueRow(
  ctx: PageContext,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  const { snapshot, assessments, today } = ctx;
  const issue = snapshot.issues.get(node.id);
  const milestone =
    issue?.milestoneId == null
      ? undefined
      : snapshot.milestones.get(issue.milestoneId);
  const assignee = userName(snapshot, issue?.assigneeId ?? null);
  const key = issue?.identifier ?? null;
  return {
    id: node.id,
    name: node.label,
    key,
    status: data.status ?? 'missing',
    statusLabel: data.statusLabel ?? '',
    statusMuted: false,
    context: assignee ?? 'Unassigned',
    // An inactive project's issue is never loud (§2.8), like its box.
    contextTone:
      assignee === null && node.open && node.active ? 'accent' : 'default',
    // A closed issue is not late, whatever its milestone's countdown says.
    due:
      milestone === undefined
        ? 'No milestone'
        : dueLabel(
            milestone.targetDate,
            node.open
              ? (assessments.get(milestone.id)?.daysLeft ?? null)
              : null,
            today
          ),
    dueTone: node.active && node.overdue ? 'accent' : 'default',
    href: withIssueParam(ctx.scopeHref, key ?? node.id),
    external: false,
    rowLabel: `${key === null ? '' : `${key} `}${node.label}`,
    tone: rowTone(data),
  };
}

function isolatedRow(
  ctx: PageContext,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  switch (node.kind) {
    case 'initiative':
      return isolatedInitiativeRow(ctx, node, data);
    case 'project':
      return isolatedProjectRow(ctx, node, data);
    case 'milestone':
      return isolatedMilestoneRow(ctx, node, data);
    case 'issue':
      return isolatedIssueRow(ctx, node, data);
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/** What a register row opens, as the note says it when the register is
    all the page shows (listsWhenEmpty). */
const OPENS: Readonly<Record<GraphLevel, string>> = {
  initiative: 'Open one to see its projects.',
  project: 'Open one to see its issues.',
  milestone: 'Open one on the timeline.',
  issue: 'Open one to see it.',
};

/**
 * The register under the canvas, or null when it would be empty. `total`
 * counts every isolated node; `rows` holds at most ISOLATED_MAX_ROWS.
 * `alone` is the empty state of a container's aggregate level: the page
 * already says nothing is joined, so the note says what a row opens.
 */
function isolatedList(
  level: GraphLevel,
  rows: IsolatedRow[],
  total: number,
  alone = false
): IsolatedList | null {
  if (total === 0) return null;
  const copy = ISOLATED_COPY[level];
  const them = total === 1 ? 'it' : 'them';
  let note: string;
  switch (level) {
    case 'initiative':
    case 'project':
    case 'milestone':
      note = alone
        ? OPENS[level]
        : `Not drawn: no open issue in ${them} blocks, or waits on, an open issue in another ${copy.noun}.`;
      break;
    case 'issue':
      note =
        total === 1
          ? 'Not drawn: it neither blocks nor waits on another issue.'
          : 'Not drawn: none of them blocks or waits on another issue.';
      break;
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
  return {
    title: `${plural(total, copy.noun)} ${total === 1 ? 'has' : 'have'} no blocking relations`,
    note,
    nameLabel: copy.nameLabel,
    contextLabel: copy.contextLabel,
    dueLabel: copy.dueLabel,
    rows,
    cutLine:
      rows.length < total
        ? `Showing ${rows.length} of ${total}. Narrow the graph to see the rest.`
        : null,
    collapsed: total > ISOLATED_COLLAPSE_AFTER,
  };
}

/* ---- notices --------------------------------------------------------------- */

/** Why a viewer with no initiatives sees the whole workspace (§9). */
function fallbackText(reason: ReadOnlyReasonCopy | undefined): string {
  switch (reason) {
    case 'guest':
      return 'Linear shows guests no initiatives, so this graph covers every project you can see.';
    case 'unknown':
      return 'The planner has not seen your Linear account yet, so it shows you no initiatives; this graph covers every project you can see.';
    default:
      return 'This workspace has no initiatives in Linear, so this graph covers every project.';
  }
}

/** "A, B, C, D, E and 3 more": at most five names, then a count. */
function namesPhrase(names: readonly string[]): string {
  if (names.length <= 5) return listPhrase(names);
  return `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
}

/**
 * Projects also in this initiative in Linear that count under another
 * (their first) initiative, as on the timeline: they are drawn as
 * externals here, so the page names them.
 */
function sharedNotice(ctx: PageContext, initiativeId: string): string | null {
  const { snapshot } = ctx;
  const shared = snapshot.data.projects.filter(
    (project) =>
      project.initiativeIds.includes(initiativeId) &&
      homeOf(ctx, project.id) !== initiativeId
  );
  if (shared.length === 0) return null;
  const here = initiativeName(snapshot, initiativeId);
  const homes = new Set(shared.map((project) => homeOf(ctx, project.id)));
  const [onlyHome] = homes;
  const names = namesPhrase(shared.map((project) => project.name));
  if (shared.length === 1 && onlyHome !== undefined) {
    return `${names} is also in ${here} in Linear and counts under ${initiativeName(snapshot, onlyHome)}, its first initiative, as on the timeline.`;
  }
  return homes.size === 1 && onlyHome !== undefined
    ? `${names} are also in ${here} in Linear and count under ${initiativeName(snapshot, onlyHome)}, their first initiative, as on the timeline.`
    : `${names} are also in ${here} in Linear and count under their first initiatives, as on the timeline.`;
}

/* ---- the too-large state ---------------------------------------------------- */

const KIND_LABEL: Readonly<Record<GraphLevel, string>> = {
  initiative: 'Initiative',
  project: 'Project',
  milestone: 'Milestone',
  issue: 'Issue',
};

function issueRowLabel(snapshot: Snapshot, node: GraphNode): string {
  const key = snapshot.issues.get(node.id)?.identifier;
  return key === undefined ? node.label : `${key} ${node.label}`;
}

function chainHrefOf(snapshot: Snapshot, node: GraphNode): string {
  return chainHref(snapshot.issues.get(node.id)?.identifier ?? node.id);
}

/** Most first; ties keep the order they were met in (node order). */
function byCountThenOrder(
  a: { n: number; order: number },
  b: { n: number; order: number }
): number {
  return b.n !== a.n ? b.n - a.n : a.order - b.order;
}

/**
 * Rows counted per child and sorted by count (descending), then by the
 * first node that counted for each, capped at NARROW_MAX_ROWS. Children
 * with no count never appear (they are never added).
 */
function rankRows(
  counted: Map<string, { row: Omit<GraphNarrowRow, 'count'>; n: number }>
): GraphNarrowRow[] {
  return [...counted.values()]
    .map((entry, order) => ({ ...entry, order }))
    .sort(byCountThenOrder)
    .slice(0, NARROW_MAX_ROWS)
    .map(({ row, n }) => ({ ...row, count: String(n) }));
}

/** Edges per node id, over the graph's edges. */
function edgeCounts(edges: readonly GraphEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  }
  return counts;
}

/**
 * The narrower graphs offered when this one is past the draw limits
 * (§11.2): the workspace's initiatives (or its projects, without
 * initiatives), an initiative's projects and a project's milestones, each
 * at the same level when it offers it, with how many of the drawn boxes
 * each holds; inside a milestone its 20 most connected issues, and in a
 * chain the focus's direct neighbours, each opening its own chain.
 */
function narrowRows(
  ctx: PageContext,
  graph: DependencyGraph,
  drawnNodes: readonly GraphNode[]
): GraphNarrowRow[] {
  const { snapshot, container, scope } = ctx;
  const counted = new Map<
    string,
    { row: Omit<GraphNarrowRow, 'count'>; n: number }
  >();
  const count = (key: string, row: () => Omit<GraphNarrowRow, 'count'>) => {
    const entry = counted.get(key);
    if (entry !== undefined) entry.n += 1;
    else counted.set(key, { row: row(), n: 1 });
  };
  switch (container.kind) {
    case 'workspace':
      for (const node of drawnNodes) {
        if (ctx.hasInitiatives) {
          const id = node.initiativeId;
          if (id === null) continue;
          count(id, () => ({
            id,
            label: initiativeName(snapshot, id),
            kind: KIND_LABEL.initiative,
            href: graphHref(
              graphScopeFor({ kind: 'initiative', id }, scope.level)
            ),
          }));
        } else {
          const id = node.projectId;
          if (id === null) continue;
          count(id, () => ({
            id,
            label: projectName(snapshot, id),
            kind: KIND_LABEL.project,
            href: graphHref(
              graphScopeFor({ kind: 'project', id }, scope.level)
            ),
          }));
        }
      }
      return rankRows(counted);
    case 'initiative':
      for (const node of drawnNodes) {
        const id = node.projectId;
        if (node.external || id === null) continue;
        count(id, () => ({
          id,
          label: projectName(snapshot, id),
          kind: KIND_LABEL.project,
          href: graphHref(graphScopeFor({ kind: 'project', id }, scope.level)),
        }));
      }
      return rankRows(counted);
    case 'project':
      for (const node of drawnNodes) {
        const id = node.milestoneId;
        if (node.external || id === null) continue;
        count(id, () => ({
          id,
          label: snapshot.milestones.get(id)?.name ?? 'Unknown milestone',
          kind: KIND_LABEL.milestone,
          href: graphHref({ level: 'issue', milestoneId: id }),
        }));
      }
      return rankRows(counted);
    case 'milestone':
      return mostConnectedRows(ctx, graph, drawnNodes, MOST_CONNECTED_ROWS);
    case 'chain':
      return mostConnectedRows(ctx, graph, drawnNodes, NARROW_MAX_ROWS);
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/** How many issues "Most connected issues" lists. */
const MOST_CONNECTED_ROWS = 20;

/**
 * The drawn issues with the most edges, most first, each opening its own
 * chain; in a chain only the focus's direct neighbours. This is what a
 * milestone and a chain offer past the draw limits, and what any issue
 * level falls back to when its boxes have no smaller container to narrow
 * to (issues with no project, or none with a milestone), so the too-large
 * state never ends in an empty list.
 */
function mostConnectedRows(
  ctx: PageContext,
  graph: DependencyGraph,
  drawnNodes: readonly GraphNode[],
  limit: number
): GraphNarrowRow[] {
  const { snapshot } = ctx;
  const edges = edgeCounts(graph.edges);
  const focus = graph.chain?.focusId ?? null;
  const neighbours = new Set<string>();
  if (focus !== null) {
    for (const edge of graph.edges) {
      if (edge.from === focus) neighbours.add(edge.to);
      if (edge.to === focus) neighbours.add(edge.from);
    }
  }
  return drawnNodes
    .map((node, order) => ({ node, order, n: edges.get(node.id) ?? 0 }))
    .filter(
      ({ node, n }) =>
        n > 0 && (focus === null ? !node.external : neighbours.has(node.id))
    )
    .sort(byCountThenOrder)
    .slice(0, limit)
    .map(({ node, n }) => ({
      id: node.id,
      label: issueRowLabel(snapshot, node),
      kind: KIND_LABEL.issue,
      count: String(n),
      href: chainHrefOf(snapshot, node),
    }));
}

/**
 * The ?node= box's own container at the same level, as the first narrow
 * row, so a link that meant "show me this box" still reaches it past the
 * draw limits: a milestone's project, or a project's first initiative.
 * Null when that container is the page itself or there is none.
 */
function arrivalRow(
  ctx: PageContext,
  node: GraphNode,
  drawnNodes: readonly GraphNode[]
): GraphNarrowRow | null {
  const { snapshot, scope } = ctx;
  let own: GraphScope;
  let label: string;
  let kind: string;
  let inOwn: (other: GraphNode) => boolean;
  if (node.kind === 'milestone' && node.projectId !== null) {
    const projectId = node.projectId;
    own = { level: 'milestone', projectId };
    label = `${projectName(snapshot, projectId)} › ${node.label}`;
    kind = KIND_LABEL.project;
    inOwn = (other) => other.projectId === projectId;
  } else if (node.kind === 'project' && ctx.hasInitiatives) {
    const initiativeId = node.initiativeId ?? NO_INITIATIVE_ID;
    own = { level: 'project', initiativeId };
    label = `${initiativeName(snapshot, initiativeId)} › ${node.label}`;
    kind = KIND_LABEL.initiative;
    inOwn = (other) => other.initiativeId === initiativeId;
  } else {
    return null;
  }
  if (graphHref(own) === ctx.scopeHref || own.level !== scope.level) {
    return null;
  }
  return {
    id: `node:${node.id}`,
    label,
    kind,
    count: String(
      drawnNodes.filter((other) => !other.external && inOwn(other)).length
    ),
    href: graphHref(own, { node: node.id }),
  };
}

/* ---- the page --------------------------------------------------------------- */

/** "milestone", "issue": the level's noun in counts. */
function levelNoun(level: GraphLevel): string {
  return ISOLATED_COPY[level].noun;
}

/** What the receipts say when no graph is drawn (or it is too large). */
function aboutSentence(ctx: PageContext, focusTitle: string | null): string {
  const { container } = ctx;
  const level = ctx.scope.level;
  switch (container.kind) {
    case 'workspace':
      switch (level) {
        case 'initiative':
          return 'Which initiatives wait on which, from Linear’s blocking relations between open issues.';
        case 'project':
          return 'Which projects wait on which, from Linear’s blocking relations between open issues.';
        case 'milestone':
          return 'Which milestones wait on which, from Linear’s blocking relations between open issues.';
        case 'issue':
          return 'Which issues wait on which, from Linear’s blocking relations.';
        default: {
          const unreachable: never = level;
          return unreachable;
        }
      }
    case 'chain':
      return `${ctx.containerName} “${focusTitle ?? ''}”: everything it waits on and everything waiting on it, through open issues.`;
    case 'initiative':
    case 'project':
    case 'milestone':
      return `Which ${levelNoun(level)}s ${containerPhrase(ctx, levelNoun(level))} wait on which, from Linear’s blocking relations.`;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/**
 * Whether an aggregate level with no blocking relation still lists its
 * boxes: inside an initiative or a project, where each row opens that
 * box's own graph (or its milestone on the timeline), so drilling down
 * never dead-ends on "none joined". The workspace (the guest fallback
 * included) and every issue level keep the plain empty state.
 */
function listsWhenEmpty(container: GraphContainer, level: GraphLevel): boolean {
  if (level === 'issue') return false;
  switch (container.kind) {
    case 'initiative':
    case 'project':
      return true;
    case 'workspace':
    case 'milestone':
    case 'chain':
      return false;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/** Builds everything /graph shows from the engine's graph and mirror. */
export function buildGraphPage(input: GraphPageInput): GraphPageModel {
  const { graph, snapshot, assessments, today } = input;
  const scope = graph.scope;
  const container = graphContainer(scope);
  const level = scope.level;
  const focusIssue =
    graph.chain === null ? undefined : snapshot.issues.get(graph.chain.focusId);
  const focusKey = focusIssue?.identifier ?? graph.chain?.focusId ?? null;
  const scopeHref =
    container.kind === 'chain'
      ? chainHref(focusKey ?? container.id)
      : graphHref(scope);
  const ctx: PageContext = {
    snapshot,
    assessments,
    today,
    scope,
    container,
    scopeHref,
    containerName: containerName(snapshot, container),
    hasInitiatives: snapshot.initiatives.size > 0,
    home: homeInitiativeIds(snapshot),
    plans: new Map(input.allocationPlan.projects.map((p) => [p.projectId, p])),
  };
  const name = ctx.containerName;
  const noun = levelNoun(level);

  // ?node= selects (and keeps) an aggregate box on arrival, unless an
  // issue's slide-over is open or the box is not in this graph.
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const arrival =
    level !== 'issue' &&
    (input.issueKey ?? null) === null &&
    input.nodeId != null
      ? nodeById.get(input.nodeId)
      : undefined;
  const keep = [...(input.keep ?? [])];
  if (arrival !== undefined) keep.push(arrival.id);
  if (graph.chain !== null) keep.push(graph.chain.focusId);
  const isolatedIds = new Set(
    isolatedNodeIds(
      graph.nodes.map((n) => n.id),
      graph.edges,
      keep
    )
  );
  const drawnGraphNodes = graph.nodes.filter((n) => !isolatedIds.has(n.id));
  const isolatedTotal = isolatedIds.size;

  // With no edge there is nothing to draw: every box would stand alone,
  // so the page shows its empty state instead of a grid of boxes (and no
  // list of them either). Past the draw limits it shows narrower graphs
  // instead, building no node data, details, layout or Mermaid. Otherwise
  // only nodes on an edge are drawn and the rest are listed under it.
  const hasEdges = graph.edges.length > 0;
  const overLimit =
    hasEdges &&
    (drawnGraphNodes.length > GRAPH_DRAW_LIMITS.nodes ||
      graph.edges.length > GRAPH_DRAW_LIMITS.edges);
  const drawn = hasEdges && !overLimit;
  // Nothing drawn inside an initiative or a project: every box is listed.
  const listAlone = !hasEdges && listsWhenEmpty(container, level);

  const nodes: GraphNodeData[] = [];
  const isolatedRows: IsolatedRow[] = [];
  const details: Record<string, GraphNodeDetail> = {};
  const labels = new Map<string, string>();
  for (const node of graph.nodes) labels.set(node.id, node.label);
  if (drawn || listAlone) {
    for (const node of graph.nodes) {
      const isolated = listAlone || isolatedIds.has(node.id);
      if (isolated && isolatedRows.length >= ISOLATED_MAX_ROWS) continue;
      const face = nodeFace(ctx, node);
      const data: GraphNodeData = {
        id: node.id,
        label: node.label,
        sublabel: face.sublabel,
        tone: nodeTone(node),
        status: face.mark.status,
        statusLabel:
          node.kind === 'issue'
            ? face.mark.label
            : quietLabel(node, face.mark.label),
        tags: nodeTags(node),
      };
      if (face.group !== undefined) data.group = face.group;
      if (node.external) data.external = true;
      details[node.id] = nodeDetail(ctx, node, face.mark);
      if (isolated) isolatedRows.push(isolatedRow(ctx, node, data));
      else nodes.push(data);
    }
  }
  const edges: GraphEdgeData[] = drawn
    ? graph.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edgeKind(edge, level),
        weight: edge.weight,
      }))
    : [];

  const edgeCount = graph.edges.length;
  const riskCount = edges.filter((e) => e.kind === 'risk').length;
  const crossProjects = graph.edges.filter(
    (e) => e.crossProject && !e.resolved
  ).length;
  const crossInitiatives = graph.edges.filter(
    (e) => e.crossInitiative && !e.resolved
  ).length;
  const resolvedCount = edges.filter((e) => e.kind === 'resolved').length;
  const cycleCount = graph.cycles.length;
  const cycles = cyclesPhrase(graph.cycles, labels);
  const cyclesPart = cycleCount > 0 ? plural(cycleCount, 'cycle') : null;
  const riskPart = riskCount > 0 ? `${riskCount} on a risk chain` : null;
  const resolvedPart = resolvedCount > 0 ? `${resolvedCount} resolved` : null;
  const crossPart =
    level === 'project'
      ? ctx.hasInitiatives && crossInitiatives > 0
        ? `${crossInitiatives} across initiatives`
        : null
      : level === 'milestone' && crossProjects > 0
        ? `${crossProjects} across projects`
        : null;
  const listed = drawn ? isolatedTotal : 0;
  const isolated = drawn
    ? isolatedList(level, isolatedRows, isolatedTotal)
    : listAlone
      ? isolatedList(level, isolatedRows, graph.nodes.length, true)
      : null;
  const outside = drawnGraphNodes.filter((n) => n.external).length;
  const insideDrawn = drawnGraphNodes.length - outside;
  const insideAll = graph.nodes.filter((n) => !n.external).length;
  const metaCycles =
    cycleCount === 0 ? '' : ` · ${plural(cycleCount, 'cycle')}`;
  const meta = overLimit
    ? `${plural(drawnGraphNodes.length, noun)} · ${plural(edgeCount, 'edge')} · too many to draw`
    : drawn
      ? `${listed === 0 ? plural(nodes.length, noun) : `${nodes.length} of ${plural(graph.nodes.length, noun)}`} · ${plural(edges.length, 'edge')}${metaCycles}`
      : 'No edges';

  const workspaceListed =
    listed === 0
      ? ''
      : ` ${listed} more ${listed === 1 ? `${noun} has` : 'have'} no blocking relations and ${listed === 1 ? 'is' : 'are'} listed under the graph.`;
  // "in Dual-write", or "with no initiative" for that group of projects.
  const where = containerPhrase(ctx, noun);
  const noInitiative =
    container.kind === 'initiative' && container.id === NO_INITIATIVE_ID;
  const containerListed =
    listed === 0
      ? ''
      : ` ${listed} more ${where} ${listed === 1 ? 'has' : 'have'} no blocking relations and ${listed === 1 ? 'is' : 'are'} listed under the graph.`;
  const outsidePart =
    outside === 0
      ? ''
      : `, plus ${plural(outside, noun)} ${noInitiative ? 'elsewhere' : 'outside it'} that ${outside === 1 ? 'blocks or waits' : 'block or wait'} on them`;
  const listedAria =
    listed === 0
      ? ''
      : ` ${plural(listed, noun)} with no blocking relations ${listed === 1 ? 'is' : 'are'} listed after the graph.`;

  let receipts: string;
  let ariaSummary: string;
  let emptyMessage: string;
  switch (container.kind) {
    case 'workspace': {
      switch (level) {
        case 'initiative': {
          // The cycles' names go in parentheses so the sentence keeps one
          // colon: "…: 1 on a risk chain and 1 cycle (A and B wait on each
          // other)."
          const namedCycles =
            cycleCount === 0
              ? null
              : `${plural(cycleCount, 'cycle')} (${graph.cycles.map((c) => cycleClause(c, labels)).join('; ')})`;
          receipts = `${plural(nodes.length, 'initiative')} joined by ${plural(edges.length, 'blocking edge')}${detailClause([riskPart, namedCycles])}. A project in several initiatives counts under the first, as on the timeline.${workspaceListed} Select an initiative to see its projects.`;
          break;
        }
        case 'project': {
          const groups = ctx.hasInitiatives
            ? new Set(
                drawnGraphNodes
                  .map((n) => n.initiativeId)
                  .filter((id) => id !== null && id !== NO_INITIATIVE_ID)
              ).size
            : 0;
          receipts = `${plural(nodes.length, 'project')}${groups > 0 ? ` in ${plural(groups, 'initiative')}` : ''}, joined by ${plural(edges.length, 'blocking edge')}${detailClause([riskPart, crossPart, cyclesPart])}.${workspaceListed} Select a project to see its milestones and issues.`;
          break;
        }
        case 'milestone': {
          const projects = new Set(drawnGraphNodes.map((n) => n.projectId))
            .size;
          receipts = `${plural(nodes.length, 'milestone')} in ${plural(projects, 'project')}, joined by ${plural(edges.length, 'blocking edge')}${detailClause([riskPart, crossPart, cyclesPart])}.${workspaceListed} Select a milestone to see its issues.`;
          break;
        }
        case 'issue':
          receipts = `${plural(nodes.length, 'issue')} in active projects, joined by ${plural(edges.length, 'blocking relation')}${detailClause([riskPart, resolvedPart, cyclesPart])}.`;
          break;
        default: {
          const unreachable: never = level;
          receipts = unreachable;
        }
      }
      if (level === 'milestone') {
        const projects = new Set(drawnGraphNodes.map((n) => n.projectId)).size;
        ariaSummary = `Milestone dependency graph: ${plural(nodes.length, 'milestone')} in ${plural(projects, 'project')} joined by ${plural(edges.length, 'blocking edge')}, ${riskCount} on a risk chain and ${crossProjects} across projects; ${cycles}.${listedAria}`;
      } else {
        ariaSummary = `${KIND_LABEL[level]} dependency graph of the workspace: ${plural(nodes.length, noun)} joined by ${plural(edges.length, level === 'issue' ? 'blocking relation' : 'blocking edge')}, ${riskCount} on a risk chain; ${cycles}.${listedAria}`;
      }
      emptyMessage =
        level === 'issue'
          ? 'No blocking relations between open issues in active projects.'
          : 'No blocking relations between open work in active projects.';
      if (!drawn) receipts = aboutSentence(ctx, null);
      break;
    }
    case 'initiative':
    case 'project':
    case 'milestone': {
      if (level === 'issue') {
        receipts = drawn
          ? `${plural(insideDrawn, 'issue')} ${where}${outsidePart}; ${plural(edges.length, 'blocking relation')}${detailClause([riskPart, resolvedPart, cyclesPart])}.${containerListed}`
          : container.kind === 'initiative'
            ? `${plural(graph.unrelatedIssues, 'open issue')} ${where}, none blocking or waiting on another.`
            : `${plural(insideAll, 'issue')} ${where}, none blocking or waiting on another.`;
        ariaSummary = `Issue dependency graph for ${name}: ${plural(insideDrawn, 'issue')} in scope and ${plural(outside, 'outside issue')} joined by ${plural(edges.length, 'blocking relation')}, ${riskCount} on a risk chain and ${resolvedCount} resolved; ${cycles}.${listedAria}`;
        emptyMessage = `No issue in ${containerSubject(ctx)} blocks or waits on another.`;
      } else {
        receipts = drawn
          ? `${plural(insideDrawn, noun)} ${where}${outsidePart}; ${plural(edges.length, 'blocking edge')}${detailClause([riskPart, crossPart, cyclesPart])}.${containerListed}`
          : `${plural(insideAll, noun)} ${where}, none joined to another by a blocking relation.`;
        ariaSummary = `${KIND_LABEL[level]} dependency graph for ${name}: ${plural(insideDrawn, noun)} in scope and ${plural(outside, `outside ${noun}`)} joined by ${plural(edges.length, 'blocking edge')}, ${riskCount} on a risk chain; ${cycles}.${listedAria}`;
        emptyMessage = `No open issue in ${containerSubject(ctx)} blocks, or waits on, an open issue in another ${noun}.`;
      }
      if (overLimit) receipts = aboutSentence(ctx, null);
      break;
    }
    case 'chain': {
      const chain = graph.chain;
      const title = focusIssue?.title ?? '';
      const projects = new Set(
        graph.nodes
          .map((n) => n.projectId)
          .filter((id): id is string => id !== null)
      ).size;
      receipts = drawn
        ? `${name} “${title}”: ${plural(chain?.upstream ?? 0, 'issue')} upstream and ${chain?.downstream ?? 0} downstream, across ${plural(projects, 'project')}; ${plural(edges.length, 'blocking relation')}${detailClause([riskPart, resolvedPart, cyclesPart])}.`
        : overLimit
          ? aboutSentence(ctx, title)
          : `${name} “${title}” neither blocks nor waits on another issue.`;
      ariaSummary = `Blocking chain of ${name}: ${plural(nodes.length, 'issue')} joined by ${plural(edges.length, 'blocking relation')}, ${riskCount} on a risk chain and ${resolvedCount} resolved; ${cycles}. ${name} is the focus.`;
      emptyMessage = `${name} neither blocks nor waits on another issue.`;
      break;
    }
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }

  const notices: GraphNotice[] = [];
  if (graph.fallback !== null) {
    notices.push({ id: 'fallback', text: fallbackText(input.readOnlyReason) });
  }
  if (graph.unplacedRelations > 0) {
    const n = graph.unplacedRelations;
    const what = level === 'milestone' ? 'milestone' : 'project';
    notices.push({
      id: 'unplaced',
      text:
        n === 1
          ? `1 blocking relation involves an issue with no ${what}, so this level cannot place it; the Issues tab shows it.`
          : `${n} blocking relations involve issues with no ${what}, so this level cannot place them; the Issues tab shows them.`,
    });
  }
  if (drawn && graph.unrelatedIssues > 0) {
    const n = graph.unrelatedIssues;
    const among =
      container.kind === 'workspace'
        ? 'in active projects'
        : containerPhrase(ctx, 'issue');
    notices.push({
      id: 'unrelated',
      text: `${plural(n, 'other open issue')} ${among} ${n === 1 ? 'has' : 'have'} no blocking relations.`,
    });
  }
  if (container.kind === 'initiative') {
    const shared = sharedNotice(ctx, container.id);
    if (shared !== null) notices.push({ id: 'shared', text: shared });
  }
  if (focusIssue !== undefined && !isIssueOpen(snapshot, focusIssue)) {
    notices.push({
      id: 'chain-closed',
      text: `${name} is closed, so only its own relations are drawn.`,
    });
  }
  if (graph.chain !== null && graph.chain.hidden > 0) {
    notices.push({
      id: 'chain-cut',
      text: `Drawn: the nearest ${graph.nodes.length} issues; ${graph.chain.hidden} more are further out. Issues marked +N MORE lead on: open one and choose Graph to follow its chain.`,
    });
  }

  let tooLarge: GraphTooLarge | null = null;
  if (overLimit) {
    const relationWord = level === 'issue' ? 'relation' : 'edge';
    let rows = narrowRows(ctx, graph, drawnGraphNodes);
    // Issues with no project (or, in a project, no milestone) have no
    // smaller container: offer the most connected ones instead.
    let byIssue = container.kind === 'milestone';
    if (rows.length === 0 && level === 'issue' && container.kind !== 'chain') {
      rows = mostConnectedRows(
        ctx,
        graph,
        drawnGraphNodes,
        MOST_CONNECTED_ROWS
      );
      byIssue = true;
    }
    if (arrival !== undefined) {
      const first = arrivalRow(ctx, arrival, drawnGraphNodes);
      if (first !== null) {
        const plain = first.href.replace(/[?&]node=[^&]*$/, '');
        rows.unshift(first);
        const dup = rows.findIndex((row, i) => i > 0 && row.href === plain);
        if (dup !== -1) rows.splice(dup, 1);
      }
    }
    // "Narrow it down:" only introduces rows that follow it.
    const limits = `and the graph draws at most ${GRAPH_DRAW_LIMITS.nodes} boxes and ${GRAPH_DRAW_LIMITS.edges} arrows${rows.length > 0 ? '. Narrow it down:' : '.'}`;
    tooLarge =
      container.kind === 'chain'
        ? {
            message: `Too many to draw: the nearest ${plural(drawnGraphNodes.length, 'issue')} on ${name}’s chain are joined by ${plural(edgeCount, 'blocking relation')}.`,
            title: 'Its direct neighbours',
            note: 'Open one’s chain to follow it.',
            rows,
          }
        : {
            message: `Too many to draw: ${plural(drawnGraphNodes.length, noun)} ${where} are joined by ${plural(edgeCount, `blocking ${relationWord}`)}, ${limits}`,
            title: byIssue ? 'Most connected issues' : 'Narrow to',
            note: byIssue ? 'Open one’s chain to follow it.' : null,
            rows,
          };
    ariaSummary = tooLarge.message;
  }

  const initialSelectedId = drawn && arrival !== undefined ? arrival.id : null;
  const heading = graphHeading(snapshot, scope);
  const mermaid = drawn
    ? toMermaid({ ...graph, nodes: drawnGraphNodes })
    : null;
  return {
    level,
    container,
    scopeHref,
    pageKey:
      initialSelectedId === null
        ? scopeHref
        : graphHref(scope, { node: initialSelectedId }),
    heading,
    receipts,
    notices,
    trail: graphTrail(snapshot, scope),
    tabs: levelTabs(scope, { hasInitiatives: ctx.hasInitiatives }),
    blockTitle: container.kind === 'chain' ? 'Chain' : GRAPH_LEVEL_LABEL[level],
    meta,
    nodes,
    edges,
    layout: drawn ? layoutGraph(nodes, edges, { direction: 'LR' }) : null,
    details,
    isolated,
    tooLarge,
    initialSelectedId,
    focusId: drawn ? (graph.chain?.focusId ?? null) : null,
    ariaSummary,
    emptyMessage,
    legend: legendFor(ctx),
    mermaid,
    crumb:
      container.kind === 'workspace'
        ? null
        : container.kind === 'chain'
          ? `Chain of ${name}`
          : heading,
  };
}
