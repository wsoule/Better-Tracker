import type {
  GraphClusterData,
  GraphEdgeData,
  GraphNodeData,
  GraphNodeReadiness,
} from '../src/graph/types';

// An issue-level chart in miniature, as the planner draws it: two
// milestones in one project, a chain A → B → C → D (A done, B started),
// E waiting on B too, a side chain F → G, an unlinked open issue U, an
// overdue issue, and a 2-cycle X ⇄ Y.

const READY: GraphNodeReadiness = {
  state: 'ready',
  label: 'Ready',
  tone: 'success',
  blockedBy: 0,
  unblocks: 1,
};
const DONE: GraphNodeReadiness = {
  state: 'done',
  label: '',
  tone: 'muted',
  blockedBy: 0,
  unblocks: 0,
};

function blocked(n: number): GraphNodeReadiness {
  return {
    state: 'blocked',
    label: `Blocked by ${n}`,
    tone: 'warning',
    blockedBy: n,
    unblocks: 0,
  };
}

function issue(
  key: string,
  label: string,
  cluster: string,
  extra: Partial<GraphNodeData> = {}
): GraphNodeData {
  return {
    id: `iss-${key.toLowerCase()}`,
    key,
    label,
    sublabel: `${key} · Ana`,
    tone: 'default',
    status: 'open',
    statusLabel: 'Open',
    cluster,
    readiness: READY,
    drillHref: `/graph?chain=${key}`,
    ...extra,
  };
}

export const CLUSTERS: GraphClusterData[] = [
  { id: 'proj-atlas', label: 'Atlas', drillHref: '/graph?project=atlas' },
  {
    id: 'ms-beta',
    label: 'Beta',
    parent: 'proj-atlas',
    drillHref: '/graph?milestone=beta',
  },
  { id: 'ms-ga', label: 'GA', parent: 'proj-atlas' },
];

export const ISSUES: GraphNodeData[] = [
  issue('ATL-1', 'Schema freeze', 'ms-beta', {
    tone: 'muted',
    status: 'done',
    statusLabel: 'Done',
    readiness: DONE,
  }),
  issue('ATL-2', 'Dual-write', 'ms-beta', { inProgress: true }),
  issue('ATL-3', 'Backfill', 'ms-beta', { readiness: blocked(1) }),
  issue('ATL-4', 'Cutover', 'ms-ga', {
    readiness: blocked(2),
    tone: 'danger',
    tags: ['Overdue'],
  }),
  issue('ATL-5', 'Read path', 'ms-ga', { readiness: blocked(1) }),
  issue('ATL-6', 'Metrics', 'ms-ga'),
  issue('ATL-7', 'Dashboards', 'ms-ga', { readiness: blocked(1) }),
  issue('ATL-8', 'Docs', 'ms-ga', {
    readiness: {
      state: 'independent',
      label: 'No dependencies',
      tone: 'default',
      blockedBy: 0,
      unblocks: 0,
    },
  }),
  issue('ATL-9', 'Lock A', 'ms-ga', {
    readiness: blocked(1),
    tone: 'danger',
    tags: ['On a cycle'],
  }),
  issue('ATL-10', 'Lock B', 'ms-ga', {
    readiness: blocked(1),
    tone: 'danger',
    tags: ['On a cycle'],
  }),
];

const id = (key: string) => `iss-${key.toLowerCase()}`;

function wait(
  from: string,
  to: string,
  kind: GraphEdgeData['kind'] = 'default'
): GraphEdgeData {
  return { from: id(from), to: id(to), kind };
}

export const ISSUE_EDGES: GraphEdgeData[] = [
  wait('ATL-1', 'ATL-2', 'resolved'),
  wait('ATL-2', 'ATL-3'),
  wait('ATL-3', 'ATL-4'),
  wait('ATL-2', 'ATL-5'),
  wait('ATL-6', 'ATL-7'),
  wait('ATL-9', 'ATL-10', 'cycle'),
  wait('ATL-10', 'ATL-9', 'cycle'),
  // A repeat and a self-loop, both dropped.
  wait('ATL-2', 'ATL-3'),
  wait('ATL-6', 'ATL-6'),
];

export { id as issueId };
