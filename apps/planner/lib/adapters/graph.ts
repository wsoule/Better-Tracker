import {
  type DependencyGraph,
  type GraphEdge,
  type GraphNode,
  type GraphScope,
  type IsoDate,
  type MilestoneAssessment,
  type MilestoneStatus,
  PRIORITY_LABEL,
  RISK_REASON_LABEL,
  RUBRIC_GAP_LABEL,
  type Snapshot,
  STATUS_LABEL,
  toMermaid,
} from '@better-tracker/core';
import type {
  GraphEdgeData,
  GraphEdgeKind,
  GraphLegendItem,
  GraphNodeData,
  GraphNodeTag,
  GraphNodeTone,
  NavTabItem,
  UiStatus,
} from '@better-tracker/ui';

import { dueLabel, formatDate, plural } from '../format';
import { assessmentMark, uiStatus } from './status';

// The /graph page (architecture §8.4 "Graph", §2.10): core's
// DependencyGraph mapped onto the ui package's GraphNodeData /
// GraphEdgeData, plus everything the page says around it (receipts, the
// screen-reader summary, the legend, the level tabs, the Mermaid text and
// each node's slide-over details). Pure functions over engine data; the
// server page builds the model once and the client island only renders it.

/** Where the graph links. */
export const GRAPH_PATH = '/graph';

/** At most this many characters of an id from the URL reach the engine. */
const MAX_ID_LENGTH = 200;

/** The graph's scope as read from ?milestone= / ?project=. */
export function parseGraphScope(
  params: Record<string, string | string[] | undefined>
): GraphScope {
  const pick = (value: string | string[] | undefined): string | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined) return null;
    const id = raw.trim();
    return id === '' || id.length > MAX_ID_LENGTH ? null : id;
  };
  const milestoneId = pick(params.milestone);
  if (milestoneId !== null) return { level: 'issue', milestoneId };
  const projectId = pick(params.project);
  if (projectId !== null) return { level: 'issue', projectId };
  return { level: 'milestone' };
}

/** The /graph URL for a scope. */
export function graphHref(scope: GraphScope): string {
  if (scope.level === 'milestone') return GRAPH_PATH;
  if ('milestoneId' in scope) {
    return `${GRAPH_PATH}?milestone=${encodeURIComponent(scope.milestoneId)}`;
  }
  return `${GRAPH_PATH}?project=${encodeURIComponent(scope.projectId)}`;
}

function timelineMilestoneHref(milestoneId: string): string {
  return `/timeline?milestone=${encodeURIComponent(milestoneId)}`;
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
  kind: 'milestone' | 'issue';
  title: string;
  /** Mono crumb above the title: "ATLAS BILLING MIGRATION / DUAL-WRITE". */
  breadcrumb: string;
  status: UiStatus;
  statusLabel: string;
  /** An accent strip at the top when the node is overdue. */
  alert: string | null;
  properties: GraphProperty[];
  links: GraphLink[];
  /** For the level tabs: this milestone's issue-level graph. */
  issuesHref: string | null;
  issuesLabel: string | null;
}

/** One node with no blocking relation, listed under the canvas instead. */
export interface IsolatedRow {
  id: string;
  /** Milestone name, or issue title. */
  name: string;
  /** The issue identifier ("ENG-12"); null for a milestone. */
  key: string | null;
  status: UiStatus;
  statusLabel: string;
  /** Project name (milestone level) or assignee (issue level). */
  context: string;
  contextTone: 'default' | 'accent';
  /** "Oct 26 · in 5 days", "No target date", "No milestone". */
  due: string;
  dueTone: 'default' | 'accent';
  /** The milestone's timeline drawer, or the issue in Linear. */
  href: string;
  external: boolean;
  rowLabel: string;
  tone: 'default' | 'accent' | 'muted';
}

/** The register of nodes left off the canvas (no edge in scope). */
export interface IsolatedList {
  /** "10 milestones have no blocking relations". */
  title: string;
  /** Why they are not drawn. */
  note: string;
  /** Register column labels: name, context. */
  nameLabel: string;
  contextLabel: string;
  rows: IsolatedRow[];
  /** Long lists start collapsed behind a Show button. */
  collapsed: boolean;
}

export interface GraphPageModel {
  level: 'milestone' | 'issue';
  /** The issue-level scope's name ("Dual-write", "Atlas billing migration"). */
  scopeLabel: string | null;
  scopeHref: string;
  heading: string;
  receipts: string;
  /** BlockBar meta over the graph. */
  meta: string;
  /** The drawn nodes: those on at least one edge (plus any kept one). */
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  details: Record<string, GraphNodeDetail>;
  /** Nodes with no blocking relation, or null when there are none or
   * when nothing is drawn at all (the empty state covers that). */
  isolated: IsolatedList | null;
  ariaSummary: string;
  emptyMessage: string;
  legend: GraphLegendItem[];
  /** Mermaid text of the drawn graph. */
  mermaid: string;
  /** The page's own breadcrumb ("Issues in Dual-write"), or null. */
  crumb: string | null;
}

export interface GraphPageInput {
  graph: DependencyGraph;
  snapshot: Snapshot;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  today: IsoDate;
  /** Node ids drawn even without an edge (a selected or focused node). */
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

/**
 * How an edge is drawn, in the ui package's precedence (resolved > cycle >
 * risk > cross > default): a closed blocker no longer holds anything up,
 * a cycle is the loudest problem, a risk chain next, then a project
 * boundary.
 */
export function edgeKind(edge: GraphEdge): GraphEdgeKind {
  if (edge.resolved) return 'resolved';
  if (edge.inCycle) return 'cycle';
  if (edge.onRiskChain) return 'risk';
  if (edge.crossProject) return 'cross';
  return 'default';
}

/** The mono chips on a node, from core's flags. */
export function nodeTags(node: GraphNode): GraphNodeTag[] {
  const tags: GraphNodeTag[] = [];
  if (node.open && node.unassigned) tags.push('UNASSIGNED');
  if (node.overdue) tags.push('OVERDUE');
  if (node.inCycle) tags.push('CYCLE');
  return tags;
}

/**
 * Node emphasis: faint once closed (an issue done or canceled, a milestone
 * complete); the accent when it needs action; ink otherwise. An issue
 * needs action when it is open and nobody owns it; a milestone when it is
 * at risk or overdue. A later milestone's unassigned issues are normal
 * (allocation hands out only the next milestone), so they keep their
 * UNASSIGNED chip without flooding every milestone in the accent.
 */
export function nodeTone(node: GraphNode): GraphNodeTone {
  if (!node.open || node.status === 'complete') return 'muted';
  if (node.overdue) return 'accent';
  if (node.kind === 'milestone') {
    return node.status === 'at_risk' ? 'accent' : 'default';
  }
  return node.unassigned ? 'accent' : 'default';
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

function milestoneMark(
  node: GraphNode,
  assessment: MilestoneAssessment | undefined
): Mark {
  if (assessment !== undefined) return assessmentMark(assessment);
  const status = isMilestoneStatus(node.status) ? node.status : 'empty';
  return { status: uiStatus(status), label: STATUS_LABEL[status] };
}

function userName(snapshot: Snapshot, id: string | null): string | null {
  if (id === null) return null;
  return snapshot.users.get(id)?.name ?? 'Unknown person';
}

function projectName(snapshot: Snapshot, id: string | null): string {
  if (id === null) return 'No project';
  return snapshot.projects.get(id)?.name ?? 'Unknown project';
}

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

function milestoneDetail(
  input: GraphPageInput,
  node: GraphNode,
  mark: Mark
): GraphNodeDetail {
  const { snapshot, assessments, today } = input;
  const milestone = snapshot.milestones.get(node.id);
  const project =
    milestone === undefined
      ? undefined
      : snapshot.projects.get(milestone.projectId);
  const assessment = assessments.get(node.id);
  const progress = assessment?.progress;
  const lead = userName(snapshot, project?.leadId ?? null);
  const properties: GraphProperty[] = [
    {
      label: 'Due',
      value: dueLabel(
        milestone?.targetDate ?? null,
        assessment?.daysLeft ?? null,
        today,
        assessment?.status
      ),
      tone: node.overdue ? 'accent' : 'default',
    },
    {
      label: 'Lead',
      value: lead ?? 'No lead',
      tone: lead === null ? 'accent' : 'default',
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
      tone: progress.openUnassigned > 0 ? 'accent' : 'default',
    });
  }
  if (assessment !== undefined && assessment.reasons.length > 0) {
    properties.push({
      label: 'Risk reasons',
      value: assessment.reasons.map((r) => RISK_REASON_LABEL[r]).join('; '),
      tone: 'accent',
    });
  }
  if (assessment !== undefined && assessment.rubric.gaps.length > 0) {
    properties.push({
      label: 'Missing',
      value: assessment.rubric.gaps.map((g) => RUBRIC_GAP_LABEL[g]).join('; '),
      tone: 'accent',
    });
  }
  const links: GraphLink[] = [
    {
      label: 'Issues of this milestone',
      href: graphHref({ level: 'issue', milestoneId: node.id }),
      external: false,
    },
    {
      label: 'Open on the timeline',
      href: timelineMilestoneHref(node.id),
      external: false,
    },
  ];
  if (project !== undefined) {
    links.push({
      label: 'Project in Linear',
      href: project.url,
      external: true,
    });
  }
  return {
    id: node.id,
    kind: 'milestone',
    title: node.label,
    breadcrumb: project?.name ?? node.sublabel,
    status: mark.status,
    statusLabel: mark.label,
    alert:
      node.overdue && assessment?.daysLeft != null
        ? `Overdue by ${plural(-assessment.daysLeft, 'day')}, with ${plural(progress?.open ?? 0, 'open issue')}.`
        : null,
    properties,
    links,
    issuesHref: graphHref({ level: 'issue', milestoneId: node.id }),
    issuesLabel: `Issues in ${node.label}`,
  };
}

function issueDetail(
  input: GraphPageInput,
  node: GraphNode,
  mark: Mark,
  scope: GraphScope
): GraphNodeDetail {
  const { snapshot, today } = input;
  const issue = snapshot.issues.get(node.id);
  const milestone =
    issue?.milestoneId == null
      ? undefined
      : snapshot.milestones.get(issue.milestoneId);
  const assessment =
    milestone === undefined ? undefined : input.assessments.get(milestone.id);
  const project = projectName(snapshot, issue?.projectId ?? null);
  const assignee = userName(snapshot, issue?.assigneeId ?? null);
  const properties: GraphProperty[] = [
    { label: 'Issue', value: issue?.identifier ?? node.sublabel },
    {
      label: 'Assignee',
      value: assignee ?? 'Unassigned',
      tone: assignee === null && node.open ? 'accent' : 'default',
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
      tone: node.overdue ? 'accent' : 'default',
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
    const inScope =
      'milestoneId' in scope && scope.milestoneId === milestone.id;
    if (!inScope) {
      links.push({
        label: 'Issues of this milestone',
        href: graphHref({ level: 'issue', milestoneId: milestone.id }),
        external: false,
      });
    }
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
      node.overdue && assessment?.daysLeft != null
        ? `Its milestone is overdue by ${plural(-assessment.daysLeft, 'day')}.`
        : null,
    properties,
    links,
    issuesHref: null,
    issuesLabel: null,
  };
}

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

const MILESTONE_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Milestone', note: 'blockers sit left of what waits' },
  { mark: 'node-overdue', label: 'Overdue', note: 'past its date' },
  { mark: 'node-accent', label: 'At risk', note: 'due soon and at risk' },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  { mark: 'node-muted', label: 'Complete', note: 'nothing open' },
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

/** The scope's display name, from the mirror. */
export function scopeLabel(
  snapshot: Snapshot,
  scope: GraphScope
): string | null {
  if (scope.level === 'milestone') return null;
  if ('milestoneId' in scope) {
    return snapshot.milestones.get(scope.milestoneId)?.name ?? null;
  }
  return snapshot.projects.get(scope.projectId)?.name ?? null;
}

/** A milestone left off the canvas, as a register row. */
function isolatedMilestoneRow(
  input: GraphPageInput,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  const { snapshot, assessments, today } = input;
  const milestone = snapshot.milestones.get(node.id);
  const assessment = assessments.get(node.id);
  return {
    id: node.id,
    name: node.label,
    key: null,
    status: data.status ?? 'missing',
    statusLabel: data.statusLabel ?? '',
    context: projectName(snapshot, node.projectId),
    contextTone: 'default',
    due: dueLabel(
      milestone?.targetDate ?? null,
      assessment?.daysLeft ?? null,
      today,
      assessment?.status
    ),
    dueTone: node.overdue ? 'accent' : 'default',
    href: timelineMilestoneHref(node.id),
    external: false,
    rowLabel: `${node.label}, ${projectName(snapshot, node.projectId)}: open on the timeline`,
    tone: data.tone === 'accent' ? 'accent' : 'default',
  };
}

/** An issue left off the canvas, as a register row (opens in Linear). */
function isolatedIssueRow(
  input: GraphPageInput,
  node: GraphNode,
  data: GraphNodeData
): IsolatedRow {
  const { snapshot, assessments, today } = input;
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
    context: assignee ?? 'Unassigned',
    contextTone: assignee === null && node.open ? 'accent' : 'default',
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
    dueTone: node.overdue ? 'accent' : 'default',
    // Issues always carry their Linear URL; the drawer is a fallback.
    href:
      node.url ??
      (milestone === undefined
        ? '/timeline'
        : timelineMilestoneHref(milestone.id)),
    external: node.url !== null,
    rowLabel: `${key === null ? '' : `${key} `}${node.label} in Linear`,
    tone:
      data.tone === 'accent'
        ? 'accent'
        : data.tone === 'muted'
          ? 'muted'
          : 'default',
  };
}

/** The register under the canvas, or null when it would be empty. */
function isolatedList(
  level: 'milestone' | 'issue',
  rows: IsolatedRow[]
): IsolatedList | null {
  if (rows.length === 0) return null;
  const n = rows.length;
  const noun = level === 'milestone' ? 'milestone' : 'issue';
  return {
    title: `${plural(n, noun)} ${n === 1 ? 'has' : 'have'} no blocking relations`,
    note:
      level === 'milestone'
        ? `Not drawn: no open issue in ${n === 1 ? 'it' : 'them'} blocks, or waits on, an open issue in another milestone.`
        : n === 1
          ? 'Not drawn: it neither blocks nor waits on another issue.'
          : 'Not drawn: none of them blocks or waits on another issue.',
    nameLabel: level === 'milestone' ? 'Milestone' : 'Issue',
    contextLabel: level === 'milestone' ? 'Project' : 'Assignee',
    rows,
    collapsed: n > ISOLATED_COLLAPSE_AFTER,
  };
}

/** Builds everything /graph shows from the engine's graph and mirror. */
export function buildGraphPage(input: GraphPageInput): GraphPageModel {
  const { graph, snapshot, assessments, today } = input;
  const scope = graph.scope;
  const level = scope.level;
  const label = scopeLabel(snapshot, scope);
  const isolatedIds = new Set(
    isolatedNodeIds(
      graph.nodes.map((n) => n.id),
      graph.edges,
      input.keep
    )
  );

  const nodes: GraphNodeData[] = [];
  const isolatedRows: IsolatedRow[] = [];
  const details: Record<string, GraphNodeDetail> = {};
  const labels = new Map<string, string>();
  for (const node of graph.nodes) {
    labels.set(node.id, node.label);
    let mark: Mark;
    let sublabel: string;
    let group: string;
    if (node.kind === 'milestone') {
      mark = milestoneMark(node, assessments.get(node.id));
      sublabel = milestoneSublabel(snapshot, node.id, today);
      group = projectName(snapshot, node.projectId);
      details[node.id] = milestoneDetail(input, node, mark);
    } else {
      const issue = snapshot.issues.get(node.id);
      const stateName =
        issue === undefined
          ? node.status
          : (snapshot.states.get(issue.stateId)?.name ?? node.status);
      mark = issueMark({
        open: node.open,
        unassigned: node.unassigned,
        stateName,
      });
      sublabel = node.sublabel;
      group = projectName(snapshot, node.projectId);
      details[node.id] = issueDetail(input, node, mark, scope);
    }
    const data: GraphNodeData = {
      id: node.id,
      label: node.label,
      sublabel,
      tone: nodeTone(node),
      status: mark.status,
      statusLabel: mark.label,
      tags: nodeTags(node),
      group,
    };
    if (node.external) data.external = true;
    if (isolatedIds.has(node.id)) {
      isolatedRows.push(
        node.kind === 'milestone'
          ? isolatedMilestoneRow(input, node, data)
          : isolatedIssueRow(input, node, data)
      );
    } else {
      nodes.push(data);
    }
  }

  const edges: GraphEdgeData[] = graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: edgeKind(edge),
    weight: edge.weight,
  }));

  const riskCount = edges.filter((e) => e.kind === 'risk').length;
  const crossCount = graph.edges.filter(
    (e) => e.crossProject && !e.resolved
  ).length;
  const resolvedCount = edges.filter((e) => e.kind === 'resolved').length;
  const cycles = cyclesPhrase(graph.cycles, labels);
  const cycleCount = graph.cycles.length;
  const metaCycles =
    cycleCount === 0 ? '' : ` · ${plural(cycleCount, 'cycle')}`;
  // With no edge there is nothing to draw: every box would stand alone,
  // so the page shows its empty state instead of a grid of boxes (and no
  // list of them either). Otherwise only nodes on an edge are drawn and
  // the rest are listed under the canvas.
  const drawn = edges.length > 0;
  const isolated = drawn ? isolatedList(level, isolatedRows) : null;
  const listed = isolated?.rows.length ?? 0;
  const drawnGraph = {
    ...graph,
    nodes: graph.nodes.filter((n) => !isolatedIds.has(n.id)),
  };
  const mermaid = toMermaid(drawn ? drawnGraph : graph);

  if (level === 'milestone') {
    const total = graph.nodes.length;
    const projects = new Set(drawnGraph.nodes.map((n) => n.projectId)).size;
    const detail = listPhrase([
      riskCount > 0 ? `${riskCount} on a risk chain` : null,
      crossCount > 0 ? `${crossCount} across projects` : null,
      cycleCount > 0 ? plural(cycleCount, 'cycle') : null,
    ]);
    const listedSentence =
      listed === 0
        ? ''
        : ` ${listed} more ${listed === 1 ? 'milestone has' : 'have'} no blocking relations and ${listed === 1 ? 'is' : 'are'} listed under the graph.`;
    return {
      level,
      scopeLabel: null,
      scopeHref: GRAPH_PATH,
      heading: 'Dependencies',
      receipts: drawn
        ? `${plural(nodes.length, 'milestone')} in ${plural(projects, 'project')}, joined by ${plural(edges.length, 'blocking edge')}${detail === '' ? '' : `: ${detail}`}.${listedSentence} Select a milestone to see its issues.`
        : 'Which milestones wait on which, from Linear’s blocking relations between open issues.',
      meta: drawn
        ? `${listed === 0 ? plural(nodes.length, 'milestone') : `${nodes.length} of ${plural(total, 'milestone')}`} · ${plural(edges.length, 'edge')}${metaCycles}`
        : 'No edges',
      nodes: drawn ? nodes : [],
      edges,
      details,
      isolated,
      ariaSummary: `Milestone dependency graph: ${plural(nodes.length, 'milestone')} in ${plural(projects, 'project')} joined by ${plural(edges.length, 'blocking edge')}, ${riskCount} on a risk chain and ${crossCount} across projects; ${cycles}.${listed === 0 ? '' : ` ${plural(listed, 'milestone')} with no blocking relations ${listed === 1 ? 'is' : 'are'} listed after the graph.`}`,
      emptyMessage:
        'No blocking relations between open work in active projects.',
      legend: MILESTONE_LEGEND,
      mermaid,
      crumb: null,
    };
  }

  const name = label ?? 'this scope';
  const outside = graph.nodes.filter((n) => n.external).length;
  const inside = graph.nodes.length - outside;
  // Externals are only ever on an edge, so every listed issue is inside.
  const insideDrawn = inside - listed;
  const outsidePart =
    outside === 0
      ? ''
      : `, plus ${plural(outside, 'issue')} outside it that ${outside === 1 ? 'blocks or waits' : 'block or wait'} on them`;
  const detail = listPhrase([
    riskCount > 0 ? `${riskCount} on a risk chain` : null,
    resolvedCount > 0 ? `${resolvedCount} resolved` : null,
    cycleCount > 0 ? plural(cycleCount, 'cycle') : null,
  ]);
  const listedSentence =
    listed === 0
      ? ''
      : ` ${listed} more in ${name} ${listed === 1 ? 'has' : 'have'} no blocking relations and ${listed === 1 ? 'is' : 'are'} listed under the graph.`;
  return {
    level,
    scopeLabel: label,
    scopeHref: graphHref(scope),
    heading: `Issues in ${name}`,
    receipts: drawn
      ? `${plural(insideDrawn, 'issue')} in ${name}${outsidePart}; ${plural(edges.length, 'blocking relation')}${detail === '' ? '' : `: ${detail}`}.${listedSentence}`
      : `${plural(inside, 'issue')} in ${name}, none blocking or waiting on another.`,
    meta: drawn
      ? `${listed === 0 ? plural(nodes.length, 'issue') : `${nodes.length} of ${plural(graph.nodes.length, 'issue')}`} · ${plural(edges.length, 'edge')}${metaCycles}`
      : 'No edges',
    nodes: drawn ? nodes : [],
    edges,
    details,
    isolated,
    ariaSummary: `Issue dependency graph for ${name}: ${plural(insideDrawn, 'issue')} in scope and ${plural(outside, 'outside issue')} joined by ${plural(edges.length, 'blocking relation')}, ${riskCount} on a risk chain and ${resolvedCount} resolved; ${cycles}.${listed === 0 ? '' : ` ${plural(listed, 'issue')} with no blocking relations ${listed === 1 ? 'is' : 'are'} listed after the graph.`}`,
    emptyMessage: `No issue in ${name} blocks or waits on another.`,
    legend: ISSUE_LEGEND,
    mermaid,
    crumb: `Issues in ${name}`,
  };
}

/**
 * The level tabs (route links): Milestones, and the issue level. At issue
 * level the second tab is the current scope; at milestone level it links
 * to the selected milestone's issues, or waits for a selection.
 */
export function levelTabs(
  model: Pick<GraphPageModel, 'level' | 'scopeLabel' | 'scopeHref'>,
  selected: Pick<GraphNodeDetail, 'issuesHref' | 'issuesLabel'> | null
): NavTabItem[] {
  const milestones: NavTabItem = {
    id: 'milestones',
    label: 'Milestones',
    href: GRAPH_PATH,
    current: model.level === 'milestone',
  };
  if (model.level === 'issue') {
    return [
      milestones,
      {
        id: 'issues',
        label: `Issues in ${model.scopeLabel ?? 'this scope'}`,
        href: model.scopeHref,
        current: true,
      },
    ];
  }
  if (selected?.issuesHref != null && selected.issuesLabel !== null) {
    return [
      milestones,
      { id: 'issues', label: selected.issuesLabel, href: selected.issuesHref },
    ];
  }
  return [
    milestones,
    { id: 'issues', label: 'Issues', note: 'select a milestone' },
  ];
}
