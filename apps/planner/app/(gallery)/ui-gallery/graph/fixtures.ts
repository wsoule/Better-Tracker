import type {
  GraphEdgeData,
  GraphNodeData,
  SegmentedOption,
} from '@better-tracker/ui';

// Fixture props for /ui-gallery/graph: a fictional workspace (Atlas,
// Billing, Mobile, Search, Identity) drawn at the two levels the planner's
// /graph page shows (architecture §2.10). Shapes are the UI package's own
// GraphNodeData / GraphEdgeData, i.e. what the planner's adapter would
// produce from core's DependencyGraph.

export interface GraphFixture {
  id: string;
  title: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  ariaSummary: string;
  emptyMessage: string;
}

// ---- milestone level ------------------------------------------------------
// Twelve milestones across five projects: an overdue Atlas cutover holding
// up Billing (cross-project, aggregated), a risk chain from an unassigned
// Search milestone through Mobile, a 2-cycle inside Identity, and resolved
// edges from milestones that already shipped.

const milestoneNodes: GraphNodeData[] = [
  {
    id: 'atlas-m2',
    label: 'M2 Schema freeze',
    sublabel: 'Atlas · done Oct 9',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Complete',
    group: 'Atlas',
    href: '/timeline?milestone=atlas-m2',
  },
  {
    id: 'atlas-m3',
    label: 'M3 Cutover',
    sublabel: 'Atlas · due Oct 18 · 3d over',
    tone: 'default',
    status: 'overdue',
    statusLabel: 'Overdue',
    tags: ['OVERDUE'],
    group: 'Atlas',
    href: '/timeline?milestone=atlas-m3',
  },
  {
    id: 'atlas-m4',
    label: 'M4 Decommission legacy',
    sublabel: 'Atlas · due Nov 12',
    tone: 'default',
    status: 'at_risk',
    statusLabel: 'At risk',
    group: 'Atlas',
    href: '/timeline?milestone=atlas-m4',
  },
  {
    id: 'billing-m0',
    label: 'Payments SDK 3',
    sublabel: 'Billing · done Oct 2',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Complete',
    group: 'Billing',
    href: '/timeline?milestone=billing-m0',
  },
  {
    id: 'billing-m1',
    label: 'Invoices v2',
    sublabel: 'Billing · due Oct 30',
    tone: 'default',
    status: 'at_risk',
    statusLabel: 'At risk',
    group: 'Billing',
    href: '/timeline?milestone=billing-m1',
  },
  {
    id: 'billing-m2',
    label: 'Dunning emails',
    sublabel: 'Billing · due Nov 20',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'On track',
    group: 'Billing',
    href: '/timeline?milestone=billing-m2',
  },
  {
    id: 'search-m1',
    label: 'Index rebuild',
    sublabel: 'Search · due Nov 2 · no lead',
    tone: 'warning',
    status: 'at_risk',
    statusLabel: 'At risk',
    tags: ['UNASSIGNED'],
    group: 'Search',
    href: '/timeline?milestone=search-m1',
  },
  {
    id: 'search-m2',
    label: 'Ranking v3',
    sublabel: 'Search · no target date',
    tone: 'default',
    status: 'missing',
    statusLabel: 'Missing: target date',
    group: 'Search',
    href: '/timeline?milestone=search-m2',
  },
  {
    id: 'mobile-m1',
    label: 'Offline sync',
    sublabel: 'Mobile · due Nov 5',
    tone: 'default',
    status: 'at_risk',
    statusLabel: 'At risk',
    group: 'Mobile',
    href: '/timeline?milestone=mobile-m1',
  },
  {
    id: 'mobile-m2',
    label: 'Store release 4.2',
    sublabel: 'Mobile · due Nov 26',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'On track',
    group: 'Mobile',
    href: '/timeline?milestone=mobile-m2',
  },
  {
    id: 'identity-m1',
    label: 'SSO rollout',
    sublabel: 'Identity · due Nov 9',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'On track',
    tags: ['CYCLE'],
    group: 'Identity',
    href: '/timeline?milestone=identity-m1',
  },
  {
    id: 'identity-m2',
    label: 'Audit log export',
    sublabel: 'Identity · due Nov 16',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'On track',
    tags: ['CYCLE'],
    group: 'Identity',
    href: '/timeline?milestone=identity-m2',
  },
];

const milestoneEdges: GraphEdgeData[] = [
  { from: 'atlas-m2', to: 'atlas-m3', kind: 'resolved', weight: 2 },
  { from: 'atlas-m3', to: 'atlas-m4', kind: 'risk', weight: 3 },
  { from: 'atlas-m3', to: 'billing-m1', kind: 'risk', weight: 2 },
  { from: 'billing-m0', to: 'mobile-m1', kind: 'resolved' },
  { from: 'billing-m1', to: 'billing-m2', kind: 'risk' },
  { from: 'search-m1', to: 'mobile-m1', kind: 'risk', weight: 4 },
  { from: 'search-m1', to: 'search-m2', kind: 'risk' },
  { from: 'mobile-m1', to: 'mobile-m2', kind: 'risk' },
  { from: 'identity-m1', to: 'identity-m2', kind: 'cycle' },
  { from: 'identity-m2', to: 'identity-m1', kind: 'cycle' },
  { from: 'identity-m1', to: 'mobile-m2', kind: 'cross' },
  { from: 'identity-m2', to: 'atlas-m4', kind: 'cross', weight: 2 },
];

export const MILESTONE_GRAPH: GraphFixture = {
  id: 'milestones',
  title: 'Milestones',
  nodes: milestoneNodes,
  edges: milestoneEdges,
  ariaSummary:
    'Dependency graph of 12 milestones in 5 projects: Atlas M3 Cutover is overdue and holds up Atlas M4 and Billing Invoices v2; unassigned Search Index rebuild holds up Mobile Offline sync and Store release; Identity SSO rollout and Audit log export wait on each other.',
  emptyMessage: 'No milestone waits on another. Nothing to draw.',
};

// ---- issue level ----------------------------------------------------------
// Issues in Atlas, framed by milestone, plus the one-hop blockers and
// waiters in other projects as external nodes (where cross-project
// dependencies show up, §2.10).

const issueNodes: GraphNodeData[] = [
  {
    id: 'ATL-41',
    label: 'Freeze writes on legacy DB',
    sublabel: 'ATL-41 · Ana',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Done',
    group: 'Atlas › M3 Cutover',
    href: 'https://linear.app/acme/issue/ATL-41',
  },
  {
    id: 'ATL-42',
    label: 'Dual-write shim',
    sublabel: 'ATL-42 · Ben',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'In progress',
    tags: ['OVERDUE'],
    group: 'Atlas › M3 Cutover',
    href: 'https://linear.app/acme/issue/ATL-42',
  },
  {
    id: 'ATL-43',
    label: 'Backfill orders table',
    sublabel: 'ATL-43 · unassigned',
    tone: 'danger',
    status: 'missing',
    statusLabel: 'Todo',
    tags: ['UNASSIGNED', 'OVERDUE'],
    group: 'Atlas › M3 Cutover',
    href: 'https://linear.app/acme/issue/ATL-43',
  },
  {
    id: 'ATL-44',
    label: 'Switch read path to the new cluster',
    sublabel: 'ATL-44 · Ana',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Todo',
    tags: ['OVERDUE'],
    group: 'Atlas › M3 Cutover',
    href: 'https://linear.app/acme/issue/ATL-44',
  },
  {
    id: 'ATL-51',
    label: 'Cutover rehearsal',
    sublabel: 'ATL-51 · Chi',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Todo',
    tags: ['CYCLE'],
    group: 'Atlas › M4 Decommission',
    href: 'https://linear.app/acme/issue/ATL-51',
  },
  {
    id: 'ATL-52',
    label: 'Archive legacy tables',
    sublabel: 'ATL-52 · unassigned',
    tone: 'warning',
    status: 'missing',
    statusLabel: 'Backlog',
    tags: ['UNASSIGNED'],
    group: 'Atlas › M4 Decommission',
    href: 'https://linear.app/acme/issue/ATL-52',
  },
  {
    id: 'ATL-53',
    label: 'Update the cutover runbook',
    sublabel: 'ATL-53 · Ana',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'In progress',
    tags: ['CYCLE'],
    group: 'Atlas › M4 Decommission',
    href: 'https://linear.app/acme/issue/ATL-53',
  },
  {
    id: 'PLT-7',
    label: 'Provision read replica',
    sublabel: 'Platform · PLT-7 · done',
    external: true,
    tone: 'muted',
    status: 'done',
    statusLabel: 'Done',
    group: 'Platform',
    href: 'https://linear.app/acme/issue/PLT-7',
  },
  {
    id: 'BIL-12',
    label: 'Invoice ID migration',
    sublabel: 'Billing · BIL-12 · Dana',
    external: true,
    tone: 'default',
    status: 'on_track',
    statusLabel: 'In progress',
    group: 'Billing',
    href: 'https://linear.app/acme/issue/BIL-12',
  },
  {
    id: 'MOB-30',
    label: 'Offline cache schema',
    sublabel: 'Mobile · MOB-30 · Eve',
    external: true,
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Todo',
    group: 'Mobile',
    href: 'https://linear.app/acme/issue/MOB-30',
  },
];

const issueEdges: GraphEdgeData[] = [
  { from: 'ATL-41', to: 'ATL-42', kind: 'resolved' },
  { from: 'PLT-7', to: 'ATL-42', kind: 'resolved' },
  { from: 'ATL-42', to: 'ATL-43', kind: 'risk' },
  { from: 'BIL-12', to: 'ATL-43', kind: 'cross' },
  { from: 'ATL-43', to: 'ATL-44', kind: 'risk' },
  { from: 'ATL-43', to: 'ATL-52', kind: 'risk' },
  { from: 'ATL-44', to: 'ATL-51', kind: 'risk' },
  { from: 'ATL-44', to: 'MOB-30', kind: 'risk' },
  { from: 'ATL-51', to: 'ATL-53', kind: 'cycle' },
  { from: 'ATL-53', to: 'ATL-51', kind: 'cycle' },
];

export const ISSUE_GRAPH: GraphFixture = {
  id: 'issues',
  title: 'Issues in Atlas',
  nodes: issueNodes,
  edges: issueEdges,
  ariaSummary:
    'Dependency graph of 7 Atlas issues and 3 external issues: unassigned ATL-43 Backfill orders table waits on the overdue dual-write shim and on Billing BIL-12, and holds up the read-path switch, the rehearsal and Mobile MOB-30; ATL-51 and ATL-53 wait on each other.',
  emptyMessage: 'No issue in Atlas blocks another.',
};

export const LEVELS: SegmentedOption[] = [
  { id: MILESTONE_GRAPH.id, label: 'Milestones', count: milestoneNodes.length },
  {
    id: ISSUE_GRAPH.id,
    label: 'Issues in Atlas',
    count: issueNodes.filter((node) => node.external !== true).length,
  },
];

export const GRAPHS: Record<string, GraphFixture> = {
  [MILESTONE_GRAPH.id]: MILESTONE_GRAPH,
  [ISSUE_GRAPH.id]: ISSUE_GRAPH,
};

// ---- one issue's chain -----------------------------------------------------
// What /graph?chain=ATL-43 draws: everything the unassigned backfill waits
// on and everything waiting on it, through open issues. The focus carries
// the 2px ink rule (DependencyGraph focusId); a closed direct blocker is a
// resolved leaf; PLT-9 leads on to two issues the chain cap left out, so it
// carries the +2 MORE chip.

const chainNodes: GraphNodeData[] = [
  {
    id: 'ATL-43',
    label: 'Backfill orders table',
    sublabel: 'ATL-43 · unassigned',
    tone: 'warning',
    status: 'missing',
    statusLabel: 'Todo',
    tags: ['UNASSIGNED'],
    group: 'Atlas',
    href: 'https://linear.app/acme/issue/ATL-43',
  },
  {
    id: 'ATL-42',
    label: 'Dual-write shim',
    sublabel: 'ATL-42 · Ben',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'In progress',
    group: 'Atlas',
    href: 'https://linear.app/acme/issue/ATL-42',
  },
  {
    id: 'ATL-40',
    label: 'Snapshot the legacy DB',
    sublabel: 'ATL-40 · Ana',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Done',
    group: 'Atlas',
    href: 'https://linear.app/acme/issue/ATL-40',
  },
  {
    id: 'BIL-12',
    label: 'Invoice ID migration',
    sublabel: 'BIL-12 · Dana',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'In progress',
    group: 'Billing',
    href: 'https://linear.app/acme/issue/BIL-12',
  },
  {
    id: 'ATL-44',
    label: 'Switch read path to the new cluster',
    sublabel: 'ATL-44 · Ana',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Todo',
    group: 'Atlas',
    href: 'https://linear.app/acme/issue/ATL-44',
  },
  {
    id: 'ATL-52',
    label: 'Archive legacy tables',
    sublabel: 'ATL-52 · Chi',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Backlog',
    group: 'Atlas',
    href: 'https://linear.app/acme/issue/ATL-52',
  },
  {
    id: 'PLT-9',
    label: 'Provision write replica',
    sublabel: 'PLT-9 · Eve',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'In progress',
    tags: ['+2 MORE'],
    group: 'Platform',
    href: 'https://linear.app/acme/issue/PLT-9',
  },
  {
    id: 'MOB-30',
    label: 'Offline cache schema',
    sublabel: 'MOB-30 · Eve',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Todo',
    group: 'Mobile',
    href: 'https://linear.app/acme/issue/MOB-30',
  },
];

const chainEdges: GraphEdgeData[] = [
  { from: 'PLT-9', to: 'ATL-42', kind: 'cross' },
  { from: 'ATL-40', to: 'ATL-43', kind: 'resolved' },
  { from: 'ATL-42', to: 'ATL-43', kind: 'default' },
  { from: 'BIL-12', to: 'ATL-43', kind: 'cross' },
  { from: 'ATL-43', to: 'ATL-44', kind: 'risk' },
  { from: 'ATL-43', to: 'ATL-52', kind: 'risk' },
  { from: 'ATL-44', to: 'MOB-30', kind: 'risk' },
];

export const CHAIN_GRAPH: GraphFixture & { focusId: string } = {
  id: 'chain',
  title: 'Blocking chain of ATL-43',
  focusId: 'ATL-43',
  nodes: chainNodes,
  edges: chainEdges,
  ariaSummary:
    'Blocking chain of ATL-43 Backfill orders table: it waits on the dual-write shim (which waits on Platform PLT-9), on Billing BIL-12 and on the finished legacy snapshot; it holds up the read-path switch, which holds up Mobile MOB-30, and the legacy archive.',
  emptyMessage: 'ATL-43 neither blocks nor waits on another issue.',
};

// ---- a Dispatch-shaped epic ----------------------------------------------
// Top-to-bottom, no groups, read-only: the shape Dispatch's epic graph
// takes (tasks with blockedBy), to show the component outside the planner.

export const EPIC_NODES: GraphNodeData[] = [
  {
    id: 't1',
    label: 'Spec the sync protocol',
    sublabel: '#1 · landed',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Landed',
  },
  {
    id: 't2',
    label: 'Server endpoint',
    sublabel: '#2 · working',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Working',
  },
  {
    id: 't3',
    label: 'Client queue',
    sublabel: '#3 · needs you',
    tone: 'warning',
    status: 'at_risk',
    statusLabel: 'Needs you',
  },
  {
    id: 't4',
    label: 'Conflict resolution',
    sublabel: '#4 · draft',
    tone: 'default',
    status: 'missing',
    statusLabel: 'Draft',
  },
  {
    id: 't5',
    label: 'Ship behind a flag',
    sublabel: '#5 · ready',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'Ready',
  },
];

export const EPIC_EDGES: GraphEdgeData[] = [
  { from: 't1', to: 't2', kind: 'resolved' },
  { from: 't1', to: 't3', kind: 'resolved' },
  { from: 't2', to: 't4', kind: 'default' },
  { from: 't3', to: 't4', kind: 'risk' },
  { from: 't4', to: 't5', kind: 'risk' },
];

// ---- Mermaid ---------------------------------------------------------------

// Mermaid label escapes, as core's toMermaid applies them.
function escapeLabel(text: string): string {
  return text.replace(
    /["#%&()<>[\]`{|}]/g,
    (ch) => `#${ch.codePointAt(0) ?? 0};`
  );
}

/**
 * The gallery's stand-in for core's toMermaid (the gallery imports only the
 * UI package): `flowchart LR`, positional ids, quoted labels, `-->` open and
 * `-.->` resolved edges, counts on aggregated edges, risk/cycle/external
 * classes.
 */
export function toMermaid(fixture: GraphFixture): string {
  const ids = new Map(fixture.nodes.map((node, i) => [node.id, `n${i}`]));
  const lines = ['flowchart LR'];
  fixture.nodes.forEach((node, i) => {
    const sub =
      node.sublabel !== undefined && node.sublabel !== ''
        ? `<br/>${escapeLabel(node.sublabel)}`
        : '';
    lines.push(`  n${i}["${escapeLabel(node.label)}${sub}"]`);
  });
  const risk: number[] = [];
  fixture.edges.forEach((edge, i) => {
    const arrow = edge.kind === 'resolved' ? '-.->' : '-->';
    const count =
      edge.weight !== undefined && edge.weight > 1 ? `|${edge.weight}|` : '';
    lines.push(`  ${ids.get(edge.from)} ${arrow}${count} ${ids.get(edge.to)}`);
    if (edge.kind === 'risk') risk.push(i);
  });
  lines.push(
    '  classDef risk stroke:#c27d0a,stroke-width:2px',
    '  classDef cycle stroke:#d92d20,stroke-dasharray:5 3',
    '  classDef external stroke-dasharray:3 3'
  );
  const classed = (test: (node: GraphNodeData) => boolean) =>
    fixture.nodes
      .filter(test)
      .map((node) => ids.get(node.id))
      .join(',');
  const riskNodes = classed(
    (node) =>
      node.tags?.includes('UNASSIGNED') === true ||
      node.tags?.includes('OVERDUE') === true
  );
  const cycleNodes = classed((node) => node.tags?.includes('CYCLE') === true);
  const externalNodes = classed((node) => node.external === true);
  if (riskNodes !== '') lines.push(`  class ${riskNodes} risk`);
  if (cycleNodes !== '') lines.push(`  class ${cycleNodes} cycle`);
  if (externalNodes !== '') lines.push(`  class ${externalNodes} external`);
  if (risk.length > 0) {
    lines.push(`  linkStyle ${risk.join(',')} stroke:#c27d0a`);
  }
  return lines.join('\n');
}
