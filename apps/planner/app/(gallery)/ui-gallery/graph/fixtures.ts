import {
  type GraphClusterData,
  type GraphEdgeData,
  type GraphHighlight,
  type GraphNodeData,
  type GraphNodeReadiness,
  longestChain,
  longestChains,
  type SegmentedOption,
} from '@better-tracker/ui';

// Fixture props for /ui-gallery/graph: a fictional workspace (Atlas,
// Billing, Mobile, Search, Identity) drawn at the two levels the planner's
// /graph page shows (architecture §2.10). Shapes are the UI package's own
// GraphNodeData / GraphEdgeData, i.e. what the planner's adapter would
// produce from core's DependencyGraph, with the readiness facts (§2.10
// "Readiness") worked out from the drawn edges by withReadiness, so every
// highlight (Status, Risk, Critical path) has something to show. As on the
// planner's page, every item is drawn, related or not (owner decision
// 2026-10-23), and the "Frames" switch draws the labelled frames
// (`clusters`) the planner draws by parent.

export interface GraphFixture {
  id: string;
  title: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  /** The frames by `group` ("Atlas", "Atlas › M3 Cutover" nested in it). */
  clusters: GraphClusterData[];
  ariaSummary: string;
  emptyMessage: string;
}

/**
 * The labelled frames of a fixture, from each node's `group`: "Atlas"
 * frames Atlas's boxes, "Atlas › M3 Cutover" a milestone frame nested in
 * Atlas's, as the planner draws an issue graph spanning projects. Each
 * node gets the innermost frame as its `cluster`. External nodes'
 * frames are dashed.
 */
function withClusters(nodes: readonly GraphNodeData[]): {
  nodes: GraphNodeData[];
  clusters: GraphClusterData[];
} {
  const clusters = new Map<string, GraphClusterData>();
  const framed = nodes.map((node) => {
    const parts = node.group?.split(' › ') ?? [];
    let parent: string | undefined;
    for (const part of parts) {
      const id = parent === undefined ? part : `${parent}/${part}`;
      const known = clusters.get(id);
      if (known === undefined) {
        clusters.set(id, {
          id,
          label: part,
          ...(parent === undefined ? {} : { parent }),
          ...(node.external === true ? { external: true } : {}),
        });
      } else if (node.external !== true && known.external === true) {
        delete known.external;
      }
      parent = id;
    }
    return parent === undefined ? { ...node } : { ...node, cluster: parent };
  });
  return { nodes: framed, clusters: [...clusters.values()] };
}

/**
 * The fixture's readiness, as a host works it out (the planner's comes
 * from core, over the whole mirror; here the drawn edges are all there
 * is): a done node (the `done` status) is done; an open one on no edge
 * has no dependencies (neutral, no chip); an open one is blocked by its
 * open blockers along edges that still block, and ready otherwise; it
 * unblocks the open nodes it alone blocks. The Status tone is green
 * when ready, amber when blocked, red when blocked on a CYCLE, faint when
 * done. Boxes say "Clear" / "Waiting on N", issues "Ready" / "Blocked by
 * N". Every edge whose ends sit in different groups (projects) is marked
 * `cross`; issues are named by their id ("ATL-42") in the readout.
 */
function withReadiness(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  unit: 'box' | 'issue'
): {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  clusters: GraphClusterData[];
} {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const done = (id: string) => byId.get(id)?.status === 'done';
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const blockers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind === 'resolved' || done(edge.from) || done(edge.to)) continue;
    const set = blockers.get(edge.to) ?? new Set<string>();
    set.add(edge.from);
    blockers.set(edge.to, set);
  }
  const unblocks = new Map<string, number>();
  for (const [waiting, set] of blockers) {
    const [only] = set;
    if (set.size === 1 && only !== undefined && only !== waiting) {
      unblocks.set(only, (unblocks.get(only) ?? 0) + 1);
    }
  }
  const readinessOf = (node: GraphNodeData): GraphNodeReadiness => {
    if (done(node.id)) {
      return {
        state: 'done',
        label: '',
        tone: 'muted',
        blockedBy: 0,
        unblocks: 0,
      };
    }
    if (!linked.has(node.id)) {
      return {
        state: 'independent',
        label: 'No dependencies',
        tone: 'default',
        blockedBy: 0,
        unblocks: 0,
      };
    }
    const blockedBy = blockers.get(node.id)?.size ?? 0;
    const cycle = node.tags?.includes('CYCLE') === true;
    if (blockedBy > 0) {
      return {
        state: 'blocked',
        label:
          unit === 'box'
            ? `Waiting on ${blockedBy}`
            : `Blocked by ${blockedBy}`,
        tone: cycle ? 'danger' : 'warning',
        blockedBy,
        unblocks: unblocks.get(node.id) ?? 0,
      };
    }
    return {
      state: 'ready',
      label: unit === 'box' ? 'Clear' : 'Ready',
      tone: 'success',
      blockedBy: 0,
      unblocks: unblocks.get(node.id) ?? 0,
    };
  };
  const framed = withClusters(nodes);
  return {
    nodes: framed.nodes.map((node) => ({
      ...node,
      ...(unit === 'issue' ? { key: node.id } : {}),
      readiness: readinessOf(node),
    })),
    clusters: framed.clusters,
    edges: edges.map((edge) => ({
      ...edge,
      cross:
        byId.get(edge.from)?.group?.split(' › ')[0] !==
        byId.get(edge.to)?.group?.split(' › ')[0],
    })),
  };
}

// ---- milestone level ------------------------------------------------------
// Fourteen milestones across five projects: an overdue Atlas cutover
// holding up Billing (cross-project, aggregated), a risk chain from an
// unassigned Search milestone through Mobile, a 2-cycle inside Identity,
// resolved edges from milestones that already shipped, and two on no
// relation (a Search milestone with no dependencies, a shipped Mobile
// release), drawn all the same.

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
    id: 'search-m3',
    label: 'Query suggestions',
    sublabel: 'Search · due Dec 4',
    tone: 'default',
    status: 'on_track',
    statusLabel: 'On track',
    group: 'Search',
    href: '/timeline?milestone=search-m3',
  },
  {
    id: 'mobile-m0',
    label: 'Store release 4.1',
    sublabel: 'Mobile · done Oct 6',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Complete',
    group: 'Mobile',
    href: '/timeline?milestone=mobile-m0',
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
  ...withReadiness(milestoneNodes, milestoneEdges, 'box'),
  ariaSummary:
    'Dependency graph of 14 milestones in 5 projects: Atlas M3 Cutover is overdue and holds up Atlas M4 and Billing Invoices v2; unassigned Search Index rebuild holds up Mobile Offline sync and Store release; Identity SSO rollout and Audit log export wait on each other.',
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
  ...withReadiness(issueNodes, issueEdges, 'issue'),
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
  ...withReadiness(chainNodes, chainEdges, 'issue'),
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

/** Mermaid's style lines for one highlight, as core's mermaidParts writes
    them (hexes: the light theme's --red / --amber / --green marks). */
function mermaidStyles(
  fixture: GraphFixture,
  ids: ReadonlyMap<string, string>,
  highlight: GraphHighlight
): string[] {
  const lines: string[] = [];
  const classed = (test: (node: GraphNodeData) => boolean) =>
    fixture.nodes
      .filter(test)
      .map((node) => ids.get(node.id))
      .join(',');
  const links = (test: (edge: GraphEdgeData) => boolean) =>
    fixture.edges.flatMap((edge, i) => (test(edge) ? [i] : [])).join(',');
  const external = classed((node) => node.external === true);
  const tone = (node: GraphNodeData) => node.readiness?.tone;
  if (highlight === 'status') {
    lines.push(
      '  classDef ready stroke:#16853c',
      '  classDef blocked stroke:#bd790a,stroke-width:2px',
      '  classDef stuck stroke:#d92d20,stroke-width:2px,stroke-dasharray:5 3',
      '  classDef quiet opacity:0.6',
      '  classDef external stroke-dasharray:3 3,opacity:0.7'
    );
    for (const [name, want] of [
      ['ready', 'success'],
      ['blocked', 'warning'],
      ['stuck', 'danger'],
      ['quiet', 'muted'],
    ] as const) {
      const list = classed((node) => tone(node) === want);
      if (list !== '') lines.push(`  class ${list} ${name}`);
    }
    if (external !== '') lines.push(`  class ${external} external`);
    const unblocked = links((edge) => edge.kind === 'resolved');
    if (unblocked !== '') lines.push(`  linkStyle ${unblocked} stroke:#16853c`);
    return lines;
  }
  if (highlight === 'critical') {
    const chain = longestChain(longestChains(fixture.nodes, fixture.edges));
    if (chain !== null) {
      const steps = chain.groups
        .map((group) => group.map((id) => ids.get(id)).join(' + '))
        .join(' → ');
      lines.push(`  %% Critical path: ${steps} (${chain.length} nodes)`);
      lines.push('  classDef critical stroke-width:3px');
    }
    lines.push('  classDef external stroke-dasharray:3 3,opacity:0.7');
    if (chain !== null) {
      lines.push(
        `  class ${chain.nodeIds.map((id) => ids.get(id)).join(',')} critical`
      );
      const on = new Set(chain.edges.map((e) => `${e.from}->${e.to}`));
      const chainLinks = links((edge) => on.has(`${edge.from}->${edge.to}`));
      if (chainLinks !== '')
        lines.push(`  linkStyle ${chainLinks} stroke-width:3px`);
    }
    if (external !== '') lines.push(`  class ${external} external`);
    return lines;
  }
  lines.push(
    '  classDef overdue stroke:#d92d20,stroke-width:2px',
    '  classDef risk stroke:#bd790a,stroke-width:2px',
    '  classDef cycle stroke:#d92d20,stroke-dasharray:5 3',
    '  classDef external stroke-dasharray:3 3,opacity:0.7'
  );
  // Overdue first and red, as the canvas floods it; never also amber risk.
  const overdue = (node: GraphNodeData) =>
    node.tags?.includes('OVERDUE') === true;
  const overdueNodes = classed(overdue);
  const riskNodes = classed(
    (node) => node.tags?.includes('UNASSIGNED') === true && !overdue(node)
  );
  const cycleNodes = classed((node) => node.tags?.includes('CYCLE') === true);
  if (overdueNodes !== '') lines.push(`  class ${overdueNodes} overdue`);
  if (riskNodes !== '') lines.push(`  class ${riskNodes} risk`);
  if (cycleNodes !== '') lines.push(`  class ${cycleNodes} cycle`);
  if (external !== '') lines.push(`  class ${external} external`);
  const risk = links((edge) => edge.kind === 'risk');
  if (risk !== '') lines.push(`  linkStyle ${risk} stroke:#bd790a`);
  return lines;
}

/**
 * The gallery's stand-in for core's toMermaid (the gallery imports only the
 * UI package): `flowchart LR`, positional ids, quoted labels whose second
 * line ends in the readiness word ("Blocked by 1", "Clear"; none when done
 * or with no dependencies), each node inside its frame's `subgraph c<k>`
 * block (nested as the frames are; a frame with no node left out; pass no
 * `clusters` when the frames are off), `-->` blocking and `-.->` unblocked
 * edges, counts on aggregated edges, then the highlight's classes: Status
 * by readiness, Risk the overdue / risk / cycle classes, Critical path the
 * longest chain drawn 3px wide in no hue. Externals are dashed in every
 * highlight.
 */
export function toMermaid(
  fixture: GraphFixture,
  highlight: GraphHighlight = 'status',
  clusters: readonly GraphClusterData[] = fixture.clusters
): string {
  const ids = new Map(fixture.nodes.map((node, i) => [node.id, `n${i}`]));
  const lines = ['flowchart LR'];
  const nodeLine = (node: GraphNodeData, i: number): string => {
    // As core: no word on a done node or on one with no dependencies.
    const word =
      node.readiness?.state === 'independent'
        ? ''
        : (node.readiness?.label ?? '');
    const second = [node.sublabel ?? '', word]
      .filter((part) => part !== '')
      .map(escapeLabel)
      .join(' · ');
    const sub = second === '' ? '' : `<br/>${second}`;
    return `n${i}["${escapeLabel(node.label)}${sub}"]`;
  };
  // As core's clusteredNodeLines: nodes with no known frame first, then
  // each frame (in `clusters` order among siblings) with its nodes before
  // the frames inside it.
  const indexOf = new Map(clusters.map((cluster, k) => [cluster.id, k]));
  const members = new Map<string | null, number[]>();
  fixture.nodes.forEach((node, i) => {
    const key =
      node.cluster !== undefined && indexOf.has(node.cluster)
        ? node.cluster
        : null;
    members.set(key, [...(members.get(key) ?? []), i]);
  });
  const children = new Map<string | null, GraphClusterData[]>();
  for (const cluster of clusters) {
    const parent =
      cluster.parent !== undefined && indexOf.has(cluster.parent)
        ? cluster.parent
        : null;
    children.set(parent, [...(children.get(parent) ?? []), cluster]);
  }
  const filled = (cluster: GraphClusterData, seen: Set<string>): boolean => {
    if (seen.has(cluster.id)) return false;
    seen.add(cluster.id);
    return (
      (members.get(cluster.id)?.length ?? 0) > 0 ||
      (children.get(cluster.id) ?? []).some((child) => filled(child, seen))
    );
  };
  const written = new Set<string>();
  const write = (parent: string | null, depth: number): void => {
    const pad = '  '.repeat(depth);
    for (const i of members.get(parent) ?? []) {
      lines.push(`${pad}${nodeLine(fixture.nodes[i], i)}`);
    }
    for (const cluster of children.get(parent) ?? []) {
      if (written.has(cluster.id) || !filled(cluster, new Set())) continue;
      written.add(cluster.id);
      lines.push(
        `${pad}subgraph c${indexOf.get(cluster.id) ?? 0}["${escapeLabel(cluster.label)}"]`
      );
      write(cluster.id, depth + 1);
      lines.push(`${pad}end`);
    }
  };
  write(null, 1);
  fixture.edges.forEach((edge) => {
    const arrow = edge.kind === 'resolved' ? '-.->' : '-->';
    const count =
      edge.weight !== undefined && edge.weight > 1 ? `|${edge.weight}|` : '';
    lines.push(`  ${ids.get(edge.from)} ${arrow}${count} ${ids.get(edge.to)}`);
  });
  lines.push(...mermaidStyles(fixture, ids, highlight));
  return lines.join('\n');
}
