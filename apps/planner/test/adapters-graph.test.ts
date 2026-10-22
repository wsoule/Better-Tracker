import {
  assessWorkspace,
  buildDependencyGraph,
  DEFAULT_TUNING,
  type DependencyGraph,
  type EvalContext,
  type GraphEdge,
  type GraphNode,
  type GraphScope,
  indexWorkspace,
  type MilestoneMeta,
  planAllocation,
  viewerScope,
  visibleSnapshot,
  type WorkspaceData,
} from '@better-tracker/core';
import {
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';

import {
  buildGraphPage,
  cyclesPhrase,
  edgeKind,
  type GraphPageInput,
  graphHref,
  ISOLATED_COLLAPSE_AFTER,
  isolatedNodeIds,
  issueMark,
  listPhrase,
  nodeTags,
  nodeTone,
  parseGraphScope,
} from '../lib/adapters/graph';

// Unit tables for the small mappings, then the whole page built from the
// demo workspace through core's real graph builder (the same path the
// page takes), so counts, cycles and links are checked against real data.
// Synthetic graphs cover what the demo is too small for (the draw limits,
// the register cap, a cut chain).

const TODAY = '2026-10-21';

/** buildGraphPage's options beside the graph and the mirror. */
type PageOptions = Pick<
  GraphPageInput,
  'keep' | 'nodeId' | 'issueKey' | 'readOnlyReason'
>;

/**
 * The demo workspace (or `data`), seen by everyone or by one viewer
 * (visibleSnapshot, as the engine narrows it), with `page(scope)` building
 * the page through core's graph builder and `pageOf(graph)` building it
 * from a hand-made graph.
 */
function fixture(
  data: WorkspaceData = createFixtureWorkspace(TODAY),
  viewerId?: string
) {
  const full = indexWorkspace(data);
  const snapshot =
    viewerId === undefined
      ? full
      : visibleSnapshot(full, viewerScope(full, viewerId));
  const meta = new Map<string, MilestoneMeta>(
    FIXTURE_MILESTONE_META.map((m) => [
      m.milestoneId,
      { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
    ])
  );
  const ctx: EvalContext = {
    today: TODAY,
    now: `${TODAY}T12:00:00.000Z`,
    tuning: DEFAULT_TUNING,
    meta,
  };
  const assessments = assessWorkspace(snapshot, ctx);
  const allocationPlan = planAllocation(snapshot, ctx, assessments);
  const graphOf = (scope: GraphScope) =>
    buildDependencyGraph(snapshot, ctx, assessments, scope);
  const pageOf = (graph: DependencyGraph, options: PageOptions = {}) =>
    buildGraphPage({
      graph,
      snapshot,
      assessments,
      allocationPlan,
      today: TODAY,
      ...options,
    });
  const page = (scope: GraphScope, options: PageOptions = {}) =>
    pageOf(graphOf(scope), options);
  return { snapshot, graphOf, page, pageOf };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    kind: 'issue',
    label: 'Backfill orders',
    sublabel: 'ENG-1 · Ana Moreno',
    url: 'https://linear.app/x/issue/ENG-1',
    initiativeId: 'i1',
    projectId: 'p1',
    milestoneId: 'm1',
    ownerId: 'u1',
    external: false,
    active: true,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
    holdsCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'started',
    ...overrides,
  };
}

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: 'a',
    to: 'b',
    resolved: false,
    crossProject: false,
    crossInitiative: false,
    crossOwner: false,
    inCycle: false,
    onRiskChain: false,
    weight: 1,
    ...overrides,
  };
}

describe('parseGraphScope / graphHref', () => {
  test('no params is the milestone level', () => {
    expect(parseGraphScope({})).toEqual({ level: 'milestone' });
    expect(graphHref({ level: 'milestone' })).toBe('/graph');
  });

  test('?milestone wins over ?project, first value of a list, trimmed', () => {
    expect(parseGraphScope({ milestone: ' ms-1 ', project: 'p-1' })).toEqual({
      level: 'issue',
      milestoneId: 'ms-1',
    });
    expect(parseGraphScope({ project: ['p-1', 'p-2'] })).toEqual({
      level: 'issue',
      projectId: 'p-1',
    });
  });

  test('blank or oversized ids are ignored', () => {
    expect(parseGraphScope({ milestone: '  ' })).toEqual({
      level: 'milestone',
    });
    expect(parseGraphScope({ project: 'x'.repeat(201) })).toEqual({
      level: 'milestone',
    });
  });

  test('hrefs encode ids', () => {
    expect(graphHref({ level: 'issue', milestoneId: 'a b&c' })).toBe(
      '/graph?milestone=a%20b%26c'
    );
    expect(graphHref({ level: 'issue', projectId: 'p/1' })).toBe(
      '/graph?project=p%2F1'
    );
  });
});

describe('edgeKind', () => {
  test.each([
    [{}, 'default'],
    [{ crossProject: true }, 'cross'],
    [{ crossProject: true, onRiskChain: true }, 'risk'],
    [{ onRiskChain: true, inCycle: true }, 'cycle'],
    [{ inCycle: true, resolved: true, onRiskChain: true }, 'resolved'],
  ] as const)('%j → %s', (flags, kind) => {
    expect(edgeKind(edge(flags))).toBe(kind);
  });

  test('cross is the level’s own boundary', () => {
    const projects = edge({ crossProject: true });
    const initiatives = edge({ crossProject: true, crossInitiative: true });
    expect(edgeKind(projects, 'milestone')).toBe('cross');
    expect(edgeKind(projects, 'issue')).toBe('cross');
    // Between projects, only leaving the first initiative is "cross".
    expect(edgeKind(projects, 'project')).toBe('default');
    expect(edgeKind(initiatives, 'project')).toBe('cross');
    // Every initiative edge crosses initiatives: never drawn as cross.
    expect(edgeKind(initiatives, 'initiative')).toBe('default');
    expect(edgeKind({ ...initiatives, onRiskChain: true }, 'project')).toBe(
      'risk'
    );
  });
});

describe('node flags', () => {
  test('tags come from core flags, UNASSIGNED only while open', () => {
    expect(nodeTags(node())).toEqual([]);
    expect(
      nodeTags(node({ unassigned: true, overdue: true, inCycle: true }))
    ).toEqual(['UNASSIGNED', 'OVERDUE', 'CYCLE']);
    expect(nodeTags(node({ open: false, unassigned: true }))).toEqual([]);
  });

  test('tone: closed is muted, needs-action is accent', () => {
    expect(nodeTone(node())).toBe('default');
    expect(nodeTone(node({ open: false }))).toBe('muted');
    expect(nodeTone(node({ unassigned: true }))).toBe('accent');
    expect(nodeTone(node({ overdue: true }))).toBe('accent');
    const milestone = node({ kind: 'milestone', status: 'on_track' });
    // A later milestone's unassigned issues are normal: not the accent.
    expect(nodeTone({ ...milestone, unassigned: true })).toBe('default');
    expect(nodeTone({ ...milestone, status: 'at_risk' })).toBe('accent');
    expect(nodeTone({ ...milestone, status: 'complete' })).toBe('muted');
  });

  test('tags at every kind, in order', () => {
    const project = node({ kind: 'project', status: 'on_track' });
    // A project or initiative always holds unassigned later work: no chip.
    expect(nodeTags({ ...project, unassigned: true })).toEqual([]);
    expect(
      nodeTags({ ...project, ownerId: null, holdsCycle: true, overdue: true })
    ).toEqual(['OVERDUE', 'CYCLE INSIDE', 'NO LEAD']);
    // Paused work is never loud: no OVERDUE, no NO LEAD, but INACTIVE.
    expect(
      nodeTags({ ...project, active: false, ownerId: null, overdue: true })
    ).toEqual(['INACTIVE']);
    const milestone = node({ kind: 'milestone', status: 'overdue' });
    expect(
      nodeTags({
        ...milestone,
        unassigned: true,
        overdue: true,
        inCycle: true,
        holdsCycle: true,
      })
    ).toEqual(['UNASSIGNED', 'OVERDUE', 'CYCLE', 'CYCLE INSIDE']);
    expect(
      nodeTags(node({ kind: 'initiative', holdsCycle: true, active: false }))
    ).toEqual(['CYCLE INSIDE', 'INACTIVE']);
    // An issue's own loop is CYCLE, never CYCLE INSIDE; +N MORE on a chain.
    expect(
      nodeTags(node({ inCycle: true, holdsCycle: true, hiddenNeighbours: 2 }))
    ).toEqual(['CYCLE', '+2 MORE']);
    expect(nodeTags(node({ overdue: true, active: false }))).toEqual([]);
  });

  test('tone: inactive work is quiet, aggregate boxes follow their status', () => {
    const project = node({ kind: 'project', status: 'on_track' });
    expect(nodeTone(project)).toBe('default');
    expect(nodeTone({ ...project, status: 'at_risk' })).toBe('accent');
    expect(nodeTone({ ...project, status: 'overdue' })).toBe('accent');
    expect(nodeTone({ ...project, unassigned: true })).toBe('default');
    expect(nodeTone({ ...project, active: false, overdue: true })).toBe(
      'muted'
    );
    const initiative = node({ kind: 'initiative', status: 'overdue' });
    expect(nodeTone(initiative)).toBe('accent');
    expect(nodeTone({ ...initiative, active: false })).toBe('muted');
    const milestone = node({ kind: 'milestone', status: 'at_risk' });
    expect(nodeTone({ ...milestone, active: false })).toBe('muted');
    // An inactive project's issue keeps the default tone.
    expect(nodeTone(node({ unassigned: true, active: false }))).toBe('default');
    expect(nodeTone(node({ overdue: true, active: false }))).toBe('default');
  });

  test('issue marks: closed filled, unassigned hatched, owned hollow', () => {
    expect(
      issueMark({ open: false, unassigned: true, stateName: 'Done' })
    ).toEqual({ status: 'done', label: 'Done' });
    expect(
      issueMark({ open: true, unassigned: true, stateName: 'Backlog' })
    ).toEqual({ status: 'missing', label: 'Backlog, unassigned' });
    expect(
      issueMark({ open: true, unassigned: false, stateName: 'In Progress' })
    ).toEqual({ status: 'on_track', label: 'In Progress' });
  });
});

describe('phrases', () => {
  const labels = new Map([
    ['a', 'Alpha'],
    ['b', 'Beta'],
    ['c', 'Gamma'],
  ]);

  test('cycles', () => {
    expect(cyclesPhrase([], labels)).toBe('no cycles');
    expect(cyclesPhrase([['a', 'b']], labels)).toBe(
      '1 cycle: Alpha and Beta wait on each other'
    );
    expect(cyclesPhrase([['a'], ['a', 'b', 'c']], labels)).toBe(
      '2 cycles: Alpha waits on itself; Alpha, Beta and Gamma wait on each other in a loop'
    );
  });

  test('lists skip missing parts', () => {
    expect(listPhrase([null, null])).toBe('');
    expect(listPhrase(['a', null])).toBe('a');
    expect(listPhrase(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('buildGraphPage on the demo workspace', () => {
  const { snapshot, page } = fixture();

  test('milestone level: every node mapped, with details and Mermaid', () => {
    const model = page({ level: 'milestone' });
    expect(model.level).toBe('milestone');
    expect(model.heading).toBe('Dependencies');
    expect(model.crumb).toBeNull();
    expect(model.nodes.length).toBeGreaterThan(0);
    expect(model.edges.length).toBeGreaterThan(0);
    for (const n of model.nodes) {
      const detail = model.details[n.id];
      expect(detail?.kind).toBe('milestone');
      expect(
        detail?.links.find((l) => l.label === 'Issues of this milestone')?.href
      ).toBe(`/graph?milestone=${encodeURIComponent(n.id)}`);
      expect(detail?.links.map((l) => l.label)).toContain(
        'Open on the timeline'
      );
    }
    expect(model.mermaid?.startsWith('flowchart LR\n')).toBe(true);
    expect(model.ariaSummary).toContain(`${model.nodes.length} milestones`);
    expect(model.ariaSummary).toContain('no cycles');
    expect(model.receipts).toContain('Select a milestone to see its issues.');
    expect(model.legend.some((item) => item.mark === 'weight')).toBe(true);
  });

  test('an overdue milestone floods, says so and names its project', () => {
    const model = page({ level: 'milestone' });
    const overdue = model.nodes.find(
      (n) => n.tags?.includes('OVERDUE') === true
    );
    expect(overdue).toBeDefined();
    if (overdue === undefined) return;
    expect(overdue.status).toBe('overdue');
    expect(overdue.tone).toBe('accent');
    const milestone = snapshot.milestones.get(overdue.id);
    const project = snapshot.projects.get(milestone?.projectId ?? '');
    expect(overdue.sublabel?.startsWith(`${project?.name} · `)).toBe(true);
    expect(model.details[overdue.id]?.alert).toMatch(/^Overdue by \d+ days?/);
  });

  test('issue level in a project with a cycle names the cycle', () => {
    const model = page({ level: 'issue', projectId: 'proj-juniper' });
    expect(model.heading).toBe('Issues in Juniper design system');
    expect(model.crumb).toBe('Issues in Juniper design system');
    expect(model.ariaSummary).toMatch(/1 cycle: .+ and .+ wait on each other/);
    expect(model.meta).toContain('1 cycle');
    const cycleNodes = model.nodes.filter(
      (n) => n.tags?.includes('CYCLE') === true
    );
    expect(cycleNodes).toHaveLength(2);
    expect(model.edges.some((e) => e.kind === 'cycle')).toBe(true);
  });

  test('issue level in a milestone: externals and Linear links', () => {
    const model = page({ level: 'issue', milestoneId: 'ms-atlas-2' });
    expect(model.heading).toBe('Issues in Dual-write');
    const external = model.nodes.filter((n) => n.external === true);
    expect(external.length).toBeGreaterThan(0);
    for (const n of model.nodes) {
      const detail = model.details[n.id];
      expect(detail?.kind).toBe('issue');
      const linear = detail?.links.find((l) => l.label === 'Open in Linear');
      expect(linear?.external).toBe(true);
      expect(linear?.href).toBe(snapshot.issues.get(n.id)?.url);
      // Selecting an issue node opens its slide-over by identifier.
      expect(detail?.issueKey).toBe(
        snapshot.issues.get(n.id)?.identifier ?? null
      );
    }
    // The scope's own milestone is not offered again as a link.
    const inScope = model.nodes.find((n) => n.external !== true);
    expect(
      model.details[inScope?.id ?? '']?.links.some(
        (l) => l.label === 'Issues of this milestone'
      )
    ).toBe(false);
    expect(model.receipts).toContain('outside it that');
  });

  test('an issue in a complete milestone gives its date no countdown', () => {
    // Atlas's Schema cutover: every issue done, due Oct 1 (20 days ago).
    const model = page({ level: 'issue', projectId: 'proj-atlas' });
    const milestone = model.details['iss-eng-1']?.properties.find(
      (p) => p.label === 'Milestone'
    );
    expect(milestone?.value).toBe('Schema cutover · Oct 1 · complete');
    expect(milestone?.tone).toBe('default');
  });

  test('a scope without any blocking relation shows the empty state', () => {
    const model = page({ level: 'issue', projectId: 'proj-compass' });
    expect(model.nodes).toEqual([]);
    expect(model.emptyMessage).toBe(
      'No issue in Compass onboarding blocks or waits on another.'
    );
    expect(model.meta).toBe('No edges');
  });
});

describe('nodes with no blocking relation', () => {
  const { snapshot, page } = fixture();

  test('isolatedNodeIds keeps node order and spares kept ids', () => {
    const edges = [{ from: 'b', to: 'c' }];
    expect(isolatedNodeIds(['a', 'b', 'c', 'd'], edges)).toEqual(['a', 'd']);
    expect(isolatedNodeIds(['a', 'b', 'c', 'd'], edges, ['d'])).toEqual(['a']);
    expect(isolatedNodeIds(['a'], [])).toEqual(['a']);
  });

  test('milestone level draws only connected milestones and lists the rest', () => {
    const model = page({ level: 'milestone' });
    const onEdge = new Set(model.edges.flatMap((e) => [e.from, e.to]));
    expect(model.nodes.length).toBeGreaterThan(0);
    for (const n of model.nodes) expect(onEdge.has(n.id)).toBe(true);

    const list = model.isolated;
    expect(list).not.toBeNull();
    if (list === null) return;
    const listed = list.rows.length;
    expect(listed).toBeGreaterThan(ISOLATED_COLLAPSE_AFTER);
    expect(list.collapsed).toBe(true);
    expect(list.title).toBe(`${listed} milestones have no blocking relations`);
    expect(list.nameLabel).toBe('Milestone');
    expect(list.contextLabel).toBe('Project');
    for (const row of list.rows) {
      expect(onEdge.has(row.id)).toBe(false);
      expect(row.href).toBe(
        `/timeline?milestone=${encodeURIComponent(row.id)}`
      );
      expect(row.external).toBe(false);
      const milestone = snapshot.milestones.get(row.id);
      expect(row.context).toBe(
        snapshot.projects.get(milestone?.projectId ?? '')?.name ?? ''
      );
    }
    // Counts in the header sentence and the block meta: shown vs listed.
    const total = model.nodes.length + listed;
    expect(model.meta).toBe(
      `${model.nodes.length} of ${total} milestones · ${model.edges.length} edges`
    );
    expect(model.receipts).toContain(
      `${listed} more have no blocking relations and are listed under the graph.`
    );
    expect(model.ariaSummary).toContain(
      `${listed} milestones with no blocking relations are listed after the graph.`
    );
    // The Mermaid copy is the drawn graph: one line per drawn node.
    const nodeLines = (model.mermaid ?? '')
      .split('\n')
      .filter((line) => /^ {2}n\d+\["/.test(line));
    expect(nodeLines).toHaveLength(model.nodes.length);
  });

  test('a kept node is drawn even without an edge', () => {
    const plain = page({ level: 'milestone' });
    const first = plain.isolated?.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const kept = page({ level: 'milestone' }, { keep: [first.id] });
    expect(kept.nodes.some((n) => n.id === first.id)).toBe(true);
    expect(kept.isolated?.rows.some((r) => r.id === first.id)).toBe(false);
  });

  test('issue level lists unrelated issues, opening their slide-over', () => {
    const model = page({ level: 'issue', milestoneId: 'ms-atlas-2' });
    const list = model.isolated;
    expect(list).not.toBeNull();
    if (list === null) return;
    expect(list.collapsed).toBe(list.rows.length > ISOLATED_COLLAPSE_AFTER);
    expect(list.nameLabel).toBe('Issue');
    expect(list.contextLabel).toBe('Assignee');
    for (const row of list.rows) {
      const issue = snapshot.issues.get(row.id);
      expect(row.key).toBe(issue?.identifier ?? null);
      expect(row.href).toBe(
        `/graph?milestone=ms-atlas-2&issue=${issue?.identifier ?? ''}`
      );
      expect(row.external).toBe(false);
      expect(row.rowLabel).toBe(`${issue?.identifier ?? ''} ${row.name}`);
      const closed = row.status === 'done';
      // A closed issue shows its milestone's date without a countdown.
      if (closed) expect(row.due).not.toMatch(/overdue|in \d+ days/);
      if (issue?.assigneeId === null && !closed) {
        expect(row.context).toBe('Unassigned');
        expect(row.contextTone).toBe('accent');
      }
    }
    const inside = model.nodes.filter((n) => n.external !== true).length;
    expect(model.receipts.startsWith(`${inside} issue`)).toBe(true);
    expect(model.receipts).toContain(
      `${list.rows.length} more in Dual-write have no blocking relations`
    );
  });

  test('with no edge at all there is only the empty state', () => {
    const model = page({ level: 'issue', projectId: 'proj-compass' });
    expect(model.nodes).toEqual([]);
    expect(model.isolated).toBeNull();
  });
});

// Goldens captured on 2026-10-22 from the page as it was before the graph
// levels change (spec §13 commit 1): today's three kinds of /graph page
// keep what they say and draw. Tags may gain CYCLE INSIDE (asserted on its
// own), so it is left out of the tag comparison.
describe('pages kept', () => {
  const { page } = fixture();
  const kept = (scope: GraphScope) => {
    const m = page(scope);
    return {
      heading: m.heading,
      receipts: m.receipts,
      meta: m.meta,
      nodes: m.nodes.map((n) => n.id),
      edges: m.edges.map((e) => [e.from, e.to, e.kind, e.weight]),
      isolatedTitle: m.isolated?.title ?? null,
      isolatedRows: m.isolated?.rows.map((r) => r.id) ?? [],
      tags: m.nodes.map((n) => [
        n.id,
        (n.tags ?? []).filter((tag) => tag !== 'CYCLE INSIDE'),
      ]),
    };
  };

  test('/graph: the workspace milestones', () => {
    expect(kept({ level: 'milestone' })).toEqual({
      heading: 'Dependencies',
      receipts:
        '4 milestones in 3 projects, joined by 3 blocking edges: 3 on a risk chain and 2 across projects. 10 more have no blocking relations and are listed under the graph. Select a milestone to see its issues.',
      meta: '4 of 14 milestones · 3 edges',
      nodes: ['ms-atlas-2', 'ms-juniper-1', 'ms-beacon-1', 'ms-atlas-3'],
      edges: [
        ['ms-atlas-2', 'ms-beacon-1', 'risk', 1],
        ['ms-atlas-2', 'ms-atlas-3', 'risk', 1],
        ['ms-beacon-1', 'ms-juniper-1', 'risk', 1],
      ],
      isolatedTitle: '10 milestones have no blocking relations',
      isolatedRows: [
        'ms-harbor-1',
        'ms-compass-1',
        'ms-garnet-1',
        'ms-ember-1',
        'ms-delta-1',
        'ms-harbor-2',
        'ms-beacon-2',
        'ms-juniper-2',
        'ms-compass-2',
        'ms-compass-3',
      ],
      tags: [
        ['ms-atlas-2', ['UNASSIGNED', 'OVERDUE']],
        ['ms-juniper-1', []],
        ['ms-beacon-1', []],
        ['ms-atlas-3', ['UNASSIGNED']],
      ],
    });
  });

  test('/graph?milestone=ms-atlas-2: the issues of Dual-write', () => {
    expect(kept({ level: 'issue', milestoneId: 'ms-atlas-2' })).toEqual({
      heading: 'Issues in Dual-write',
      receipts:
        '2 issues in Dual-write, plus 2 issues outside it that block or wait on them; 2 blocking relations: 2 on a risk chain. 3 more in Dual-write have no blocking relations and are listed under the graph.',
      meta: '4 of 7 issues · 2 edges',
      nodes: ['iss-eng-10', 'iss-eng-12', 'iss-eng-23', 'iss-eng-16'],
      edges: [
        ['iss-eng-10', 'iss-eng-16', 'risk', 1],
        ['iss-eng-12', 'iss-eng-23', 'risk', 1],
      ],
      isolatedTitle: '3 issues have no blocking relations',
      isolatedRows: ['iss-eng-11', 'iss-eng-13', 'iss-eng-14'],
      tags: [
        ['iss-eng-10', ['OVERDUE']],
        ['iss-eng-12', ['UNASSIGNED', 'OVERDUE']],
        ['iss-eng-23', []],
        ['iss-eng-16', []],
      ],
    });
  });

  test('/graph?project=proj-juniper: the issues of Juniper', () => {
    expect(kept({ level: 'issue', projectId: 'proj-juniper' })).toEqual({
      heading: 'Issues in Juniper design system',
      receipts:
        '3 issues in Juniper design system, plus 1 issue outside it that blocks or waits on them; 3 blocking relations: 1 on a risk chain and 1 cycle. 2 more in Juniper design system have no blocking relations and are listed under the graph.',
      meta: '4 of 6 issues · 3 edges · 1 cycle',
      nodes: ['iss-eng-70', 'iss-eng-71', 'iss-ops-20', 'iss-eng-23'],
      edges: [
        ['iss-eng-70', 'iss-eng-71', 'cycle', 1],
        ['iss-eng-71', 'iss-eng-70', 'cycle', 1],
        ['iss-eng-23', 'iss-ops-20', 'risk', 1],
      ],
      isolatedTitle: '2 issues have no blocking relations',
      isolatedRows: ['iss-eng-72', 'iss-eng-73'],
      tags: [
        ['iss-eng-70', ['CYCLE']],
        ['iss-eng-71', ['CYCLE']],
        ['iss-ops-20', []],
        ['iss-eng-23', []],
      ],
    });
  });
});

/** A hand-made graph for the cases the demo is too small for. */
function synthetic(
  scope: GraphScope,
  nodes: GraphNode[],
  edges: GraphEdge[]
): DependencyGraph {
  return {
    scope,
    nodes,
    edges,
    cycles: [],
    fallback: null,
    unplacedRelations: 0,
    unrelatedIssues: 0,
    chain: null,
  };
}

describe('every level on the demo workspace', () => {
  const { graphOf, page } = fixture();
  const ids = (list: readonly { id: string }[]) => list.map((n) => n.id);
  const drawnEdges = (scope: GraphScope) =>
    page(scope).edges.map((e) => [e.from, e.to, e.kind, e.weight]);

  test('/graph?level=initiative: Platform ⇄ Growth, No initiative listed', () => {
    const model = page({ level: 'initiative' });
    expect(model.heading).toBe('Dependencies');
    expect(model.crumb).toBeNull();
    expect(model.trail).toEqual([]);
    expect(model.blockTitle).toBe('Initiatives');
    expect(model.scopeHref).toBe('/graph?level=initiative');
    expect(model.receipts).toBe(
      '2 initiatives joined by 2 blocking edges: 1 cycle (Platform reliability and Customer growth wait on each other). A project in several initiatives counts under the first, as on the timeline. 1 more initiative has no blocking relations and is listed under the graph. Select an initiative to see its projects.'
    );
    expect(model.meta).toBe('2 of 3 initiatives · 2 edges · 1 cycle');
    expect(ids(model.nodes)).toEqual(['init-platform', 'init-growth']);
    expect(drawnEdges({ level: 'initiative' })).toEqual([
      ['init-platform', 'init-growth', 'cycle', 1],
      ['init-growth', 'init-platform', 'cycle', 1],
    ]);
    const platform = model.nodes[0];
    expect(platform?.sublabel).toBe('5 projects · Dec 20');
    expect(platform?.tags).toEqual(['OVERDUE', 'CYCLE', 'CYCLE INSIDE']);
    expect(platform?.tone).toBe('accent');
    expect(platform?.group).toBeUndefined();
    expect(model.isolated?.title).toBe(
      '1 initiative has no blocking relations'
    );
    expect(model.isolated?.rows).toEqual([
      {
        id: 'none',
        name: 'No initiative',
        key: null,
        status: 'at_risk',
        statusLabel: 'At risk',
        statusMuted: false,
        context: '1 project',
        contextTone: 'default',
        due: 'No target date',
        dueTone: 'default',
        href: '/graph?initiative=none',
        external: false,
        rowLabel: 'No initiative, 1 project: open its graph',
        tone: 'accent',
      },
    ]);
    expect([
      model.isolated?.nameLabel,
      model.isolated?.contextLabel,
      model.isolated?.dueLabel,
    ]).toEqual(['Initiative', 'Projects', 'Target']);
    expect(model.legend.map((item) => `${item.label} — ${item.note}`)).toEqual([
      'Initiative — blockers sit left of what waits',
      'Overdue — a project’s milestone is past due',
      'At risk — a project’s next milestone',
      'In a cycle — they wait on each other',
      'Inactive — no active project',
      'Blocks — an open issue blocks one',
      'Risk chain — a blocking issue is unassigned or overdue, or waits on one',
      'Cycle — both ends wait',
      'Count — issue relations on one edge',
    ]);
    expect(model.tabs).toEqual([
      {
        id: 'initiative',
        label: 'Initiatives',
        href: '/graph?level=initiative',
        current: true,
      },
      {
        id: 'project',
        label: 'Projects',
        href: '/graph?level=project',
        current: false,
      },
      {
        id: 'milestone',
        label: 'Milestones',
        href: '/graph',
        current: false,
      },
      {
        id: 'issue',
        label: 'Issues',
        href: '/graph?level=issue',
        current: false,
      },
    ]);
  });

  test('/graph?level=project: Atlas → Beacon → Juniper, the rest listed', () => {
    const model = page({ level: 'project' });
    expect(model.receipts).toBe(
      '3 projects in 2 initiatives, joined by 2 blocking edges: 2 on a risk chain and 2 across initiatives. 5 more have no blocking relations and are listed under the graph. Select a project to see its milestones and issues.'
    );
    expect(model.meta).toBe('3 of 8 projects · 2 edges');
    expect(ids(model.nodes)).toEqual([
      'proj-atlas',
      'proj-juniper',
      'proj-beacon',
    ]);
    expect(drawnEdges({ level: 'project' })).toEqual([
      ['proj-atlas', 'proj-beacon', 'risk', 1],
      ['proj-beacon', 'proj-juniper', 'risk', 1],
    ]);
    expect(model.nodes.map((n) => [n.id, n.sublabel, n.tags, n.group])).toEqual(
      [
        ['proj-atlas', 'Chloe Diaz', ['OVERDUE'], 'Platform reliability'],
        ['proj-juniper', 'Grace Lin', ['CYCLE INSIDE'], 'Platform reliability'],
        ['proj-beacon', 'Dev Patel', [], 'Customer growth'],
      ]
    );
    expect(model.isolated?.rows.map((r) => r.id)).toEqual([
      'proj-harbor',
      'proj-delta',
      'proj-compass',
      'proj-ember',
      'proj-garnet',
    ]);
    const delta = model.isolated?.rows.find((r) => r.id === 'proj-delta');
    expect(delta?.context).toBe('No lead');
    expect(delta?.contextTone).toBe('accent');
    expect(delta?.href).toBe('/graph?project=proj-delta');
    expect(model.isolated?.dueLabel).toBe('Next milestone');
    const deltaNode = graphOf({ level: 'project' }).nodes.find(
      (n) => n.id === 'proj-delta'
    );
    expect(deltaNode === undefined ? [] : nodeTags(deltaNode)).toEqual([
      'NO LEAD',
    ]);
    expect(model.legend.find((item) => item.mark === 'edge-cross')).toEqual({
      mark: 'edge-cross',
      label: 'Cross-initiative',
      note: 'leaves its initiative',
    });
    expect(model.legend.some((item) => item.mark === 'node-external')).toBe(
      false
    );
  });

  test('/graph: CYCLE INSIDE on ms-juniper-1, the muted swatch names inactive', () => {
    const model = page({ level: 'milestone' });
    expect(model.nodes.find((n) => n.id === 'ms-juniper-1')?.tags).toEqual([
      'CYCLE INSIDE',
    ]);
    expect(model.legend.find((item) => item.mark === 'node-muted')).toEqual({
      mark: 'node-muted',
      label: 'Complete or inactive',
      note: 'nothing open, or a paused project',
    });
    expect(model.tabs.find((tab) => tab.current === true)?.id).toBe(
      'milestone'
    );
  });

  test('an inactive project’s milestone is INACTIVE and muted in its initiative', () => {
    const graph = graphOf({
      level: 'milestone',
      initiativeId: 'init-platform',
    });
    const fjord = graph.nodes.find((n) => n.id === 'ms-fjord-1');
    expect(fjord === undefined ? null : nodeTags(fjord)).toEqual([
      'UNASSIGNED',
      'INACTIVE',
    ]);
    expect(fjord === undefined ? null : nodeTone(fjord)).toBe('muted');
    // Listed under the canvas, its mark is grey and says why.
    const row = page({
      level: 'project',
      initiativeId: 'init-platform',
    }).isolated?.rows.find((r) => r.id === 'proj-fjord');
    expect(row?.status).toBe('overdue');
    expect(row?.statusMuted).toBe(true);
    expect(row?.statusLabel).toBe('Overdue · inactive project');
    expect(row?.tone).toBe('muted');
  });

  test('/graph?initiative=init-growth: Beacon in scope, Atlas and Juniper external', () => {
    const model = page({ level: 'project', initiativeId: 'init-growth' });
    expect(model.heading).toBe('Projects in Customer growth');
    expect(model.crumb).toBe('Projects in Customer growth');
    expect(model.scopeHref).toBe('/graph?initiative=init-growth');
    expect(model.receipts).toBe(
      '1 project in Customer growth, plus 2 projects outside it that block or wait on them; 2 blocking edges: 2 on a risk chain and 2 across initiatives. 2 more in Customer growth have no blocking relations and are listed under the graph.'
    );
    expect(model.nodes.map((n) => [n.id, n.external === true])).toEqual([
      ['proj-beacon', false],
      ['proj-atlas', true],
      ['proj-juniper', true],
    ]);
    expect(model.isolated?.rows.map((r) => r.id)).toEqual([
      'proj-compass',
      'proj-ember',
    ]);
    expect(model.notices).toEqual([
      {
        id: 'shared',
        text: 'Juniper design system is also in Customer growth in Linear and counts under Platform reliability, its first initiative, as on the timeline.',
      },
    ]);
    expect(model.trail).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      { label: 'Customer growth' },
    ]);
    expect(model.tabs.map((tab) => [tab.label, tab.href, tab.current])).toEqual(
      [
        ['Projects', '/graph?initiative=init-growth', true],
        ['Milestones', '/graph?initiative=init-growth&level=milestone', false],
        ['Issues', '/graph?initiative=init-growth&level=issue', false],
      ]
    );
    expect(model.legend.find((item) => item.mark === 'node-external')).toEqual({
      mark: 'node-external',
      label: 'External',
      note: 'outside this initiative',
    });
  });

  test('an external project: its panel, with the Scope line and drill links', () => {
    const model = page({ level: 'project', initiativeId: 'init-growth' });
    expect(model.details['proj-atlas']).toEqual({
      id: 'proj-atlas',
      kind: 'project',
      title: 'Atlas billing migration',
      breadcrumb: 'Platform reliability',
      status: 'overdue',
      statusLabel: 'Overdue',
      alert: null,
      properties: [
        { label: 'Linear status', value: 'In Progress' },
        { label: 'Lead', value: 'Chloe Diaz', tone: 'default' },
        {
          label: 'Next milestone',
          value: 'Dual-write · Oct 18 · 3 days overdue',
          tone: 'accent',
        },
        {
          label: 'Progress',
          value: '0/4 done · 2 open issues unassigned',
          tone: 'accent',
        },
        { label: 'Allocation', value: 'Allocating 2', tone: 'default' },
        {
          label: 'Scope',
          value:
            'Outside Customer growth: it blocks or waits on a project here',
        },
      ],
      links: [
        {
          label: 'Milestones of Atlas billing migration',
          href: '/graph?project=proj-atlas&level=milestone',
          external: false,
        },
        {
          label: 'Issues of Atlas billing migration',
          href: '/graph?project=proj-atlas',
          external: false,
        },
        {
          label: 'Lane on the timeline',
          href: '/timeline?project=proj-atlas',
          external: false,
        },
        {
          label: 'Project in Linear',
          href: 'https://linear.app/northwind/project/atlas-billing-migration',
          external: true,
        },
      ],
      issueKey: null,
    });
    // A project in two initiatives names both.
    expect(
      model.details['proj-juniper']?.properties.find(
        (p) => p.label === 'Initiatives'
      )?.value
    ).toBe('Platform reliability · also in Customer growth');
  });

  test('an initiative’s panel: properties and links in order', () => {
    const model = page({ level: 'initiative' });
    expect(model.details['init-platform']).toEqual({
      id: 'init-platform',
      kind: 'initiative',
      title: 'Platform reliability',
      breadcrumb: 'Initiative',
      status: 'overdue',
      statusLabel: 'Overdue',
      alert: null,
      properties: [
        { label: 'Target date', value: 'Dec 20' },
        { label: 'Projects', value: '5 projects · 1 inactive' },
        { label: 'Open issues', value: '20 open · 7 unassigned' },
        {
          label: 'At risk',
          value:
            'Atlas billing migration › Dual-write (overdue); Harbor API v3 › Public beta (at risk)',
          tone: 'accent',
        },
      ],
      links: [
        {
          label: 'Projects in Platform reliability',
          href: '/graph?initiative=init-platform',
          external: false,
        },
        {
          label: 'Milestones in Platform reliability',
          href: '/graph?initiative=init-platform&level=milestone',
          external: false,
        },
        {
          label: 'Issues in Platform reliability',
          href: '/graph?initiative=init-platform&level=issue',
          external: false,
        },
        {
          label: 'Open on the timeline',
          href: '/timeline?initiative=init-platform',
          external: false,
        },
      ],
      issueKey: null,
    });
    // "No initiative" is listed, so its panel is built too.
    expect(model.details['none']?.breadcrumb).toBe(
      'Projects with no initiative'
    );
    expect(model.details['none']?.links.map((l) => l.label)).toEqual([
      'Projects with no initiative',
      'Milestones of projects with no initiative',
      'Issues of projects with no initiative',
      'Open on the timeline',
    ]);
  });

  test('a milestone’s panel drills to its project’s milestones, never to this page', () => {
    const workspace = page({ level: 'milestone' });
    expect(
      workspace.details['ms-atlas-2']?.links.map((l) => [l.label, l.href])
    ).toEqual([
      ['Issues of this milestone', '/graph?milestone=ms-atlas-2'],
      [
        'Milestones of Atlas billing migration',
        '/graph?project=proj-atlas&level=milestone&node=ms-atlas-2',
      ],
      ['Open on the timeline', '/timeline?milestone=ms-atlas-2'],
      [
        'Project in Linear',
        'https://linear.app/northwind/project/atlas-billing-migration',
      ],
    ]);
    const atlas = page({ level: 'milestone', projectId: 'proj-atlas' });
    expect(atlas.heading).toBe('Milestones in Atlas billing migration');
    expect(atlas.details['ms-atlas-2']?.links.map((l) => l.label)).toEqual([
      'Issues of this milestone',
      'Open on the timeline',
      'Project in Linear',
    ]);
    expect(
      atlas.details['ms-beacon-1']?.properties.find((p) => p.label === 'Scope')
    ).toEqual({
      label: 'Scope',
      value:
        'Outside Atlas billing migration: it blocks or waits on a milestone here',
    });
    expect(atlas.tabs.map((tab) => [tab.label, tab.href, tab.current])).toEqual(
      [
        ['Milestones', '/graph?project=proj-atlas&level=milestone', true],
        ['Issues', '/graph?project=proj-atlas', false],
      ]
    );
    expect(atlas.trail).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      {
        label: 'Platform reliability',
        href: '/graph?initiative=init-platform',
      },
      { label: 'Atlas billing migration' },
    ]);
  });

  test('the workspace issue level counts what has no relation', () => {
    const model = page({ level: 'issue' });
    expect(model.receipts).toBe(
      '9 issues in active projects, joined by 6 blocking relations: 3 on a risk chain, 1 resolved and 1 cycle.'
    );
    expect(model.isolated).toBeNull();
    expect(model.notices).toEqual([
      {
        id: 'unrelated',
        text: '34 other open issues in active projects have no blocking relations.',
      },
    ]);
    const growth = page({ level: 'issue', initiativeId: 'init-growth' });
    expect(growth.notices.map((n) => n.id)).toEqual(['unrelated', 'shared']);
    expect(growth.notices[0]?.text).toBe(
      '14 other open issues in Customer growth have no blocking relations.'
    );
  });

  test('a milestone and a chain offer one level: no tabs', () => {
    expect(page({ level: 'issue', milestoneId: 'ms-atlas-2' }).tabs).toEqual(
      []
    );
    expect(page({ level: 'issue', issueId: 'ENG-23' }).tabs).toEqual([]);
  });

  test('an empty container still has its tabs (the screen moves them to the block bar)', () => {
    const model = page({ level: 'milestone', projectId: 'proj-compass' });
    expect(model.nodes).toEqual([]);
    expect(model.receipts).toBe(
      '3 milestones in Compass onboarding, none joined to another by a blocking relation.'
    );
    expect(model.emptyMessage).toBe(
      'No open issue in Compass onboarding blocks, or waits on, an open issue in another milestone.'
    );
    expect(model.tabs.find((tab) => tab.id === 'issue')?.href).toBe(
      '/graph?project=proj-compass'
    );
    expect(model.layout).toBeNull();
    expect(model.mermaid).toBeNull();
    // Nothing is drawn, but inside a project every box is still listed.
    expect(model.isolated?.title).toBe(
      '3 milestones have no blocking relations'
    );
    expect(model.isolated?.note).toBe('Open one on the timeline.');
    expect(Object.keys(model.details)).toEqual(
      model.isolated?.rows.map((row) => row.id) ?? []
    );
    expect(Object.keys(model.details)).toHaveLength(3);
  });

  test('a drawn graph carries its server layout, one box per drawn node', () => {
    const model = page({ level: 'milestone' });
    expect(model.layout?.nodes.map((n) => n.id).sort()).toEqual(
      ids(model.nodes).sort()
    );
    expect(model.layout?.edges).toHaveLength(model.edges.length);
    expect(model.layout?.direction).toBe('LR');
  });
});

describe('“No initiative” copy, empty containers and quiet rows', () => {
  const { page, pageOf } = fixture();

  test('“No initiative” reads as a group of projects, not a name', () => {
    const projects = page({ level: 'project', initiativeId: 'none' });
    expect(projects.heading).toBe('Projects with no initiative');
    expect(projects.receipts).toBe(
      '1 project with no initiative, none joined to another by a blocking relation.'
    );
    expect(projects.emptyMessage).toBe(
      'No open issue in a project with no initiative blocks, or waits on, an open issue in another project.'
    );
    const milestones = page({ level: 'milestone', initiativeId: 'none' });
    expect(milestones.receipts).toBe(
      '1 milestone in projects with no initiative, none joined to another by a blocking relation.'
    );
    const issues = page({ level: 'issue', initiativeId: 'none' });
    expect(issues.receipts).toBe(
      '5 open issues in projects with no initiative, none blocking or waiting on another.'
    );
    expect(issues.emptyMessage).toBe(
      'No issue in a project with no initiative blocks or waits on another.'
    );
  });

  test('an initiative or project with nothing drawn still lists its boxes', () => {
    // Garnet, the one project with no initiative: its graph is a click away.
    const model = page({ level: 'project', initiativeId: 'none' });
    expect(model.nodes).toEqual([]);
    expect(model.isolated?.title).toBe('1 project has no blocking relations');
    expect(model.isolated?.note).toBe('Open one to see its issues.');
    expect(
      model.isolated?.rows.map((row) => [row.id, row.name, row.href])
    ).toEqual([
      ['proj-garnet', 'Garnet mobile app', '/graph?project=proj-garnet'],
    ]);
    // The workspace (the guest fallback included) and issue levels keep
    // the plain empty state.
    expect(page({ level: 'issue', initiativeId: 'none' }).isolated).toBeNull();
    expect(
      page({ level: 'issue', projectId: 'proj-fjord' }).isolated
    ).toBeNull();
  });

  test('an inactive project’s rows are quiet: no accent date or assignee', () => {
    // Dashboards (Fjord analytics, paused) is 5 days overdue.
    const model = page({ level: 'milestone', initiativeId: 'init-platform' });
    const dashboards = model.isolated?.rows.find((r) => r.id === 'ms-fjord-1');
    expect(dashboards).toMatchObject({
      due: 'Oct 16 · 5 days overdue',
      dueTone: 'default',
      tone: 'muted',
      statusMuted: true,
    });
    expect(model.details['ms-fjord-1']?.alert).toBeNull();
    expect(
      model.details['ms-fjord-1']?.properties.find((p) => p.label === 'Due')
    ).toMatchObject({ value: 'Oct 16 · 5 days overdue', tone: 'default' });
    // An unassigned, overdue issue of a paused project, listed beside two
    // related ones: the same facts, in ink.
    const graph = synthetic(
      { level: 'issue', projectId: 'proj-fjord' },
      [
        node({ id: 'a', projectId: 'proj-fjord', active: false }),
        node({ id: 'b', projectId: 'proj-fjord', active: false }),
        node({
          id: 'iss-fjord-1',
          projectId: 'proj-fjord',
          milestoneId: 'ms-fjord-1',
          active: false,
          unassigned: true,
          overdue: true,
        }),
      ],
      [edge({ from: 'a', to: 'b' })]
    );
    const row = pageOf(graph).isolated?.rows[0];
    expect(row).toMatchObject({ id: 'iss-fjord-1', dueTone: 'default' });
    expect(row?.contextTone).toBe('default');
  });

  test('the workspace issue legend has no External swatch; an initiative’s has', () => {
    const marks = (scope: GraphScope) => page(scope).legend.map((l) => l.mark);
    expect(marks({ level: 'issue' })).not.toContain('node-external');
    expect(marks({ level: 'issue', initiativeId: 'init-growth' })).toContain(
      'node-external'
    );
  });
});

describe('?node= on arrival', () => {
  const { page } = fixture();

  test('selects and keeps the box, and keys the island by it', () => {
    const model = page({ level: 'milestone' }, { nodeId: 'ms-harbor-1' });
    expect(model.initialSelectedId).toBe('ms-harbor-1');
    expect(model.nodes.some((n) => n.id === 'ms-harbor-1')).toBe(true);
    expect(model.isolated?.rows.some((r) => r.id === 'ms-harbor-1')).toBe(
      false
    );
    expect(model.pageKey).toBe('/graph?node=ms-harbor-1');
    expect(model.scopeHref).toBe('/graph');
    const plain = page({ level: 'milestone' });
    expect(plain.initialSelectedId).toBeNull();
    expect(plain.pageKey).toBe('/graph');
  });

  test('is ignored at the issue level, with an open issue, or off the graph', () => {
    const issue = page(
      { level: 'issue', projectId: 'proj-atlas' },
      { nodeId: 'iss-eng-1' }
    );
    expect(issue.initialSelectedId).toBeNull();
    expect(issue.isolated?.rows.some((r) => r.id === 'iss-eng-1')).toBe(true);
    const open = page(
      { level: 'milestone' },
      { nodeId: 'ms-harbor-1', issueKey: 'ENG-24' }
    );
    expect(open.initialSelectedId).toBeNull();
    expect(open.isolated?.rows.some((r) => r.id === 'ms-harbor-1')).toBe(true);
    expect(
      page({ level: 'milestone' }, { nodeId: 'nope' }).initialSelectedId
    ).toBeNull();
  });

  test('an open issue slide-over leaves its row in the register', () => {
    const model = page(
      { level: 'issue', milestoneId: 'ms-atlas-2' },
      { issueKey: 'ENG-11' }
    );
    expect(model.isolated?.rows.some((r) => r.id === 'iss-eng-11')).toBe(true);
    expect(model.nodes.some((n) => n.id === 'iss-eng-11')).toBe(false);
  });
});

describe('one issue’s chain', () => {
  const { graphOf, page, pageOf } = fixture();

  test('/graph?chain=ENG-23: the focus is ruled and kept, nothing is selected', () => {
    const model = page({ level: 'issue', issueId: 'ENG-23' });
    expect(model.heading).toBe('Blocking chain of ENG-23');
    expect(model.crumb).toBe('Chain of ENG-23');
    expect(model.blockTitle).toBe('Chain');
    expect(model.scopeHref).toBe('/graph?chain=ENG-23');
    expect(model.focusId).toBe('iss-eng-23');
    expect(model.initialSelectedId).toBeNull();
    expect(model.nodes.map((n) => n.id)).toEqual([
      'iss-eng-23',
      'iss-eng-12',
      'iss-ops-20',
    ]);
    expect(model.receipts).toBe(
      'ENG-23 “Typo tolerance”: 1 issue upstream and 1 downstream, across 3 projects; 2 blocking relations: 2 on a risk chain.'
    );
    expect(model.trail).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      { label: 'Customer growth', href: '/graph?initiative=init-growth' },
      {
        label: 'Beacon search',
        href: '/graph?project=proj-beacon&level=milestone',
      },
      { label: 'Search v2 beta', href: '/graph?milestone=ms-beacon-1' },
      { label: 'ENG-23' },
    ]);
    expect(model.legend.map((item) => item.mark)).toEqual([
      'node',
      'node-focus',
      'node-overdue',
      'node-accent',
      'node-cycle',
      'node-muted',
      'edge-default',
      'edge-risk',
      'edge-cycle',
      'edge-cross',
      'edge-resolved',
    ]);
    expect(model.notices).toEqual([]);
  });

  test('a closed focus is one hop, and says so', () => {
    const model = page({ level: 'issue', issueId: 'eng-2' });
    expect(model.scopeHref).toBe('/graph?chain=ENG-2');
    expect(model.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ['iss-eng-2', 'iss-eng-26', 'resolved'],
    ]);
    expect(model.notices).toEqual([
      {
        id: 'chain-closed',
        text: 'ENG-2 is closed, so only its own relations are drawn.',
      },
    ]);
  });

  test('a lone focus shows the chain’s empty message', () => {
    const model = page({ level: 'issue', issueId: 'ENG-11' });
    expect(model.nodes).toEqual([]);
    expect(model.focusId).toBeNull();
    expect(model.emptyMessage).toBe(
      'ENG-11 neither blocks nor waits on another issue.'
    );
    expect(model.receipts).toBe(
      'ENG-11 “Dual-write payments” neither blocks nor waits on another issue.'
    );
  });

  test('a cut chain says how much is left out and marks where it leads on', () => {
    const real = graphOf({ level: 'issue', issueId: 'ENG-23' });
    if (real.chain === null) throw new Error('ENG-23 has a chain');
    const cut: DependencyGraph = {
      ...real,
      chain: { ...real.chain, hidden: 4 },
      nodes: real.nodes.map((n) =>
        n.id === 'iss-ops-20' ? { ...n, hiddenNeighbours: 2 } : n
      ),
    };
    const model = pageOf(cut);
    expect(model.nodes.find((n) => n.id === 'iss-ops-20')?.tags).toEqual([
      '+2 MORE',
    ]);
    expect(model.notices).toEqual([
      {
        id: 'chain-cut',
        text: 'Drawn: the nearest 3 issues; 4 more are further out. Issues marked +N MORE lead on: open one and choose Graph to follow its chain.',
      },
    ]);
  });
});

describe('notices', () => {
  test('a guest falls back to the workspace project level, with the guest note', () => {
    const { graphOf, pageOf } = fixture(undefined, 'user-gus');
    const graph = graphOf({ level: 'project', initiativeId: 'init-platform' });
    expect(graph.fallback?.reason).toBe('no_initiatives');
    const model = pageOf(graph, { readOnlyReason: 'guest' });
    expect(model.heading).toBe('Dependencies');
    expect(model.trail).toEqual([]);
    expect(model.scopeHref).toBe('/graph?level=project');
    expect(model.notices).toEqual([
      {
        id: 'fallback',
        text: 'Linear shows guests no initiatives, so this graph covers every project you can see.',
      },
    ]);
    // No Initiatives tab; the others stay (in the block bar: nothing drawn).
    expect(model.tabs.map((tab) => [tab.id, tab.current])).toEqual([
      ['project', true],
      ['milestone', false],
      ['issue', false],
    ]);
    expect(model.nodes).toEqual([]);
    expect(model.isolated).toBeNull();
    expect(model.receipts).toBe(
      'Which projects wait on which, from Linear’s blocking relations between open issues.'
    );
    expect(pageOf(graph, { readOnlyReason: 'unknown' }).notices[0]?.text).toBe(
      'The planner has not seen your Linear account yet, so it shows you no initiatives; this graph covers every project you can see.'
    );
  });

  test('a member in a workspace without initiatives is told why', () => {
    const data = createFixtureWorkspace(TODAY);
    const bare: WorkspaceData = {
      ...data,
      initiatives: [],
      projects: data.projects.map((p) => ({ ...p, initiativeIds: [] })),
    };
    const { page } = fixture(bare);
    const model = page({ level: 'initiative' });
    expect(model.scopeHref).toBe('/graph?level=project');
    expect(model.notices).toEqual([
      {
        id: 'fallback',
        text: 'This workspace has no initiatives in Linear, so this graph covers every project.',
      },
    ]);
    // Without initiatives nothing crosses one, and nothing is grouped.
    expect(model.edges.map((e) => e.kind)).toEqual(['risk', 'risk']);
    expect(model.nodes.every((n) => n.group === undefined)).toBe(true);
    expect(model.legend.some((item) => item.mark === 'edge-cross')).toBe(false);
  });

  test('relations this level cannot place are counted', () => {
    const data = createFixtureWorkspace(TODAY);
    const extra: WorkspaceData = {
      ...data,
      relations: [
        ...data.relations,
        // ENG-18 (Atlas, no milestone) and ENG-80 (no project) block ENG-24.
        { id: 'rel-x1', blockerId: 'iss-eng-18', blockedId: 'iss-eng-24' },
        { id: 'rel-x2', blockerId: 'iss-eng-80', blockedId: 'iss-eng-24' },
      ],
    };
    const { page } = fixture(extra);
    expect(page({ level: 'milestone' }).notices).toEqual([
      {
        id: 'unplaced',
        text: '2 blocking relations involve issues with no milestone, so this level cannot place them; the Issues tab shows them.',
      },
    ]);
    const projects = page({ level: 'project' });
    expect(projects.notices).toEqual([
      {
        id: 'unplaced',
        text: '1 blocking relation involves an issue with no project, so this level cannot place it; the Issues tab shows it.',
      },
    ]);
    expect(projects.edges.find((e) => e.from === 'proj-atlas')?.weight).toBe(2);
  });
});

describe('the draw limits', () => {
  const { pageOf } = fixture();

  test('250 boxes are too many: no data, layout or Mermaid, narrower graphs instead', () => {
    // s0…s199 spread over init-0…init-59 (4 boxes for the first 20, 3
    // for the rest); s200…s249 all in init-late, met last in node order.
    const nodes = Array.from({ length: 250 }, (_, i) =>
      node({
        id: `s${i}`,
        initiativeId: i >= 200 ? 'init-late' : `init-${i % 60}`,
      })
    );
    const edges = Array.from({ length: 125 }, (_, i) =>
      edge({ from: `s${2 * i}`, to: `s${2 * i + 1}` })
    );
    const model = pageOf(synthetic({ level: 'issue' }, nodes, edges));
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.details).toEqual({});
    expect(model.layout).toBeNull();
    expect(model.mermaid).toBeNull();
    expect(model.isolated).toBeNull();
    expect(model.meta).toBe('250 issues · 125 edges · too many to draw');
    expect(model.receipts).toBe(
      'Which issues wait on which, from Linear’s blocking relations.'
    );
    expect(model.tooLarge?.message).toBe(
      'Too many to draw: 250 issues in the workspace are joined by 125 blocking relations, and the graph draws at most 200 boxes and 300 arrows. Narrow it down:'
    );
    expect(model.tooLarge?.title).toBe('Narrow to');
    expect(model.tooLarge?.note).toBeNull();
    const rows = model.tooLarge?.rows ?? [];
    // 61 initiatives, capped at 50, most boxes first: init-late (50) though
    // it is met last, then the ones holding 4, then 3, ties in node order.
    expect(rows).toHaveLength(50);
    expect(rows.slice(0, 2)).toEqual([
      {
        id: 'init-late',
        label: 'Unknown initiative',
        kind: 'Initiative',
        count: '50',
        href: '/graph?initiative=init-late&level=issue',
      },
      {
        id: 'init-0',
        label: 'Unknown initiative',
        kind: 'Initiative',
        count: '4',
        href: '/graph?initiative=init-0&level=issue',
      },
    ]);
    expect(rows.slice(19, 22).map((r) => [r.id, r.count])).toEqual([
      ['init-18', '4'],
      ['init-19', '4'],
      ['init-20', '3'],
    ]);
    expect(rows[49]?.id).toBe('init-48');
    // The tabs stay: the screen shows them in the block bar.
    expect(model.tabs.length).toBe(4);
  });

  test('301 arrows are too many, even between few boxes', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node({ id: `s${i}` }));
    const edges: GraphEdge[] = [];
    for (let a = 0; a < 30 && edges.length < 301; a += 1) {
      for (let b = 0; b < 30 && edges.length < 301; b += 1) {
        if (a !== b) edges.push(edge({ from: `s${a}`, to: `s${b}` }));
      }
    }
    const model = pageOf(synthetic({ level: 'issue' }, nodes, edges));
    expect(model.tooLarge).not.toBeNull();
    expect(model.nodes).toEqual([]);
  });

  test('issues with no smaller container offer the most connected ones', () => {
    // A project's 250 related issues, none in a milestone: there is no
    // milestone to narrow to, so the page lists the busiest issues.
    const nodes = Array.from({ length: 250 }, (_, i) =>
      node({ id: `s${i}`, projectId: 'proj-atlas', milestoneId: null })
    );
    const edges = Array.from({ length: 249 }, (_, i) =>
      edge({ from: 's0', to: `s${i + 1}` })
    );
    const model = pageOf(
      synthetic({ level: 'issue', projectId: 'proj-atlas' }, nodes, edges)
    );
    expect(model.tooLarge?.message).toBe(
      'Too many to draw: 250 issues in Atlas billing migration are joined by 249 blocking relations, and the graph draws at most 200 boxes and 300 arrows. Narrow it down:'
    );
    expect(model.tooLarge?.title).toBe('Most connected issues');
    expect(model.tooLarge?.note).toBe('Open one’s chain to follow it.');
    const rows = model.tooLarge?.rows ?? [];
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 2).map((r) => [r.id, r.count, r.href])).toEqual([
      ['s0', '249', '/graph?chain=s0'],
      ['s1', '1', '/graph?chain=s1'],
    ]);
    // The same in the workspace when the issues have no project.
    const loose = nodes.map((n) => ({
      ...n,
      projectId: null,
      initiativeId: null,
    }));
    const workspace = pageOf(synthetic({ level: 'issue' }, loose, edges));
    expect(workspace.tooLarge?.title).toBe('Most connected issues');
    expect(workspace.tooLarge?.rows[0]?.id).toBe('s0');
  });

  test('?node= past the limits offers its own container first', () => {
    const nodes = Array.from({ length: 210 }, (_, i) =>
      node({
        id: `s${i}`,
        kind: 'milestone',
        label: `M${i}`,
        status: 'on_track',
        projectId: i === 0 ? 'proj-atlas' : 'p1',
      })
    );
    const edges = Array.from({ length: 105 }, (_, i) =>
      edge({ from: `s${2 * i}`, to: `s${2 * i + 1}` })
    );
    const model = pageOf(synthetic({ level: 'milestone' }, nodes, edges), {
      nodeId: 's0',
    });
    expect(model.initialSelectedId).toBeNull();
    expect(model.tooLarge?.rows).toEqual([
      {
        id: 'node:s0',
        label: 'Atlas billing migration › M0',
        kind: 'Project',
        count: '1',
        href: '/graph?project=proj-atlas&level=milestone&node=s0',
      },
      {
        id: 'i1',
        label: 'Unknown initiative',
        kind: 'Initiative',
        count: '210',
        href: '/graph?initiative=i1&level=milestone',
      },
    ]);
  });

  test('inside a milestone: its most connected issues, each opening its chain', () => {
    const nodes = Array.from({ length: 202 }, (_, i) =>
      node({ id: `s${i}`, milestoneId: 'ms-atlas-2' })
    );
    // s0 blocks everything; s1 blocks the second half too.
    const edges = [
      ...Array.from({ length: 201 }, (_, i) =>
        edge({ from: 's0', to: `s${i + 1}` })
      ),
      ...Array.from({ length: 99 }, (_, i) =>
        edge({ from: 's1', to: `s${i + 103}` })
      ),
    ];
    const model = pageOf(
      synthetic({ level: 'issue', milestoneId: 'ms-atlas-2' }, nodes, edges)
    );
    expect(model.tooLarge?.title).toBe('Most connected issues');
    expect(model.tooLarge?.note).toBe('Open one’s chain to follow it.');
    const rows = model.tooLarge?.rows ?? [];
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 3).map((r) => [r.id, r.count, r.href])).toEqual([
      ['s0', '201', '/graph?chain=s0'],
      ['s1', '100', '/graph?chain=s1'],
      ['s103', '2', '/graph?chain=s103'],
    ]);
  });

  test('the register is capped at 100 rows, with the cut line', () => {
    const nodes = [
      node({ id: 'a', kind: 'milestone', status: 'on_track' }),
      node({ id: 'b', kind: 'milestone', status: 'on_track' }),
      ...Array.from({ length: 300 }, (_, i) =>
        node({ id: `m${i}`, kind: 'milestone', status: 'on_track' })
      ),
    ];
    const model = pageOf(
      synthetic({ level: 'milestone' }, nodes, [edge({ from: 'a', to: 'b' })])
    );
    const list = model.isolated;
    expect(list?.title).toBe('300 milestones have no blocking relations');
    expect(list?.rows).toHaveLength(100);
    expect(list?.rows[99]?.id).toBe('m99');
    expect(list?.cutLine).toBe(
      'Showing 100 of 300. Narrow the graph to see the rest.'
    );
    expect(list?.collapsed).toBe(true);
    // Details only for what is drawn or listed.
    expect(Object.keys(model.details)).toHaveLength(102);
    expect(model.meta).toBe('2 of 302 milestones · 1 edge');
    expect(model.receipts).toContain(
      '300 more have no blocking relations and are listed under the graph.'
    );
  });
});

describe('a chain past the draw limits', () => {
  const { pageOf } = fixture();

  test('lists the focus’s direct neighbours, each opening its own chain', () => {
    // 20 issues all blocking each other: 380 relations between 20 boxes.
    const nodes = Array.from({ length: 20 }, (_, i) =>
      node({ id: `c${i}`, distance: i === 0 ? 0 : 1 })
    );
    const edges: GraphEdge[] = [];
    for (let a = 0; a < 20; a += 1) {
      for (let b = 0; b < 20; b += 1) {
        if (a !== b) edges.push(edge({ from: `c${a}`, to: `c${b}` }));
      }
    }
    const graph: DependencyGraph = {
      ...synthetic({ level: 'issue', issueId: 'c0' }, nodes, edges),
      chain: { focusId: 'c0', upstream: 19, downstream: 19, hidden: 0 },
    };
    const model = pageOf(graph);
    expect(model.nodes).toEqual([]);
    expect(model.focusId).toBeNull();
    expect(model.tooLarge?.message).toBe(
      'Too many to draw: the nearest 20 issues on c0’s chain are joined by 380 blocking relations.'
    );
    expect(model.tooLarge?.title).toBe('Its direct neighbours');
    const rows = model.tooLarge?.rows ?? [];
    expect(rows).toHaveLength(19);
    expect(rows[0]).toEqual({
      id: 'c1',
      label: 'Backfill orders',
      kind: 'Issue',
      count: '38',
      href: '/graph?chain=c1',
    });
  });
});
