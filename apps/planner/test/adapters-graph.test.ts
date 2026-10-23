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
import { longestChain, longestChains } from '@better-tracker/ui';
import { describe, expect, test } from 'bun:test';

import {
  buildGraphPage,
  clusterData,
  crossesBoundary,
  cyclesPhrase,
  edgeKind,
  type GraphPageInput,
  type GraphPageModel,
  graphHref,
  issueMark,
  listPhrase,
  nodeReadiness,
  nodeTags,
  nodeTone,
  parseGraphScope,
  pathWordsFor,
  READINESS_TONE,
} from '../lib/adapters/graph';

// Unit tables for the small mappings, then the whole page built from the
// demo workspace through core's real graph builder (the same path the
// page takes), so counts, cycles and links are checked against real data.
// Synthetic graphs cover what the demo is too small for (the draw limits,
// a cut chain). Every item of a scope is drawn, on a relation or not, in
// labelled frames by parent (owner decision 2026-10-23).

const TODAY = '2026-10-21';

/** The planner's idle hints: trace, lock, open and drill into a box. */
const GESTURE_WORDS = {
  hint: 'Point at or focus a box to trace what it waits on and holds up; click it to lock the trace, double-click to open its graph.',
  tapHint:
    'Tap a box to lock the trace of what it waits on and holds up; tap it again to open it, or double-tap for its graph.',
  hintCritical:
    'Point at or focus a box to show the longest chain through it; click it to lock it, double-click to open its graph.',
  tapHintCritical:
    'Tap a box to lock the longest chain through it; tap it again to open it, or double-tap for its graph.',
};

/** buildGraphPage's options beside the graph and the mirror. */
type PageOptions = Pick<
  GraphPageInput,
  'nodeId' | 'issueKey' | 'readOnlyReason'
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
    clusterId: null,
    active: true,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
    holdsCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'started',
    readiness: 'ready',
    blockedBy: 0,
    unplacedBlockers: 0,
    unblocks: 0,
    openIssues: 1,
    readyIssues: 1,
    ...overrides,
  };
}

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: 'a',
    to: 'b',
    resolved: false,
    blocking: true,
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
    [
      { inCycle: true, resolved: true, blocking: false, onRiskChain: true },
      'resolved',
    ],
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

  test('tone: closed is muted, overdue danger, needs action warning', () => {
    expect(nodeTone(node())).toBe('default');
    expect(nodeTone(node({ open: false }))).toBe('muted');
    expect(nodeTone(node({ unassigned: true }))).toBe('warning');
    expect(nodeTone(node({ overdue: true }))).toBe('danger');
    // Overdue wins over unassigned: the box floods red either way.
    expect(nodeTone(node({ overdue: true, unassigned: true }))).toBe('danger');
    const milestone = node({ kind: 'milestone', status: 'on_track' });
    // A later milestone's unassigned issues are normal: no amber rule.
    expect(nodeTone({ ...milestone, unassigned: true })).toBe('default');
    expect(nodeTone({ ...milestone, status: 'at_risk' })).toBe('warning');
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
    // An open issue of a paused project says so (its quiet box has a
    // word); a closed one is quiet anyway.
    expect(nodeTags(node({ overdue: true, active: false }))).toEqual([
      'INACTIVE',
    ]);
    expect(
      nodeTags(node({ overdue: true, active: false, open: false }))
    ).toEqual([]);
    // On an open cycle this graph does not draw whole: the word, without
    // the dashed outline of a drawn cycle (CYCLE).
    expect(
      nodeTags(node({ holdsCycle: true, readiness: 'blocked', blockedBy: 1 }))
    ).toEqual(['ON A CYCLE']);
  });

  test('tone: inactive work is quiet, aggregate boxes follow their status', () => {
    const project = node({ kind: 'project', status: 'on_track' });
    expect(nodeTone(project)).toBe('default');
    expect(nodeTone({ ...project, status: 'at_risk' })).toBe('warning');
    expect(nodeTone({ ...project, status: 'overdue' })).toBe('danger');
    expect(nodeTone({ ...project, unassigned: true })).toBe('default');
    expect(nodeTone({ ...project, active: false, overdue: true })).toBe(
      'muted'
    );
    const initiative = node({ kind: 'initiative', status: 'overdue' });
    expect(nodeTone(initiative)).toBe('danger');
    expect(nodeTone({ ...initiative, active: false })).toBe('muted');
    const milestone = node({ kind: 'milestone', status: 'at_risk' });
    expect(nodeTone({ ...milestone, active: false })).toBe('muted');
    // An inactive project's issue keeps the default tone.
    expect(nodeTone(node({ unassigned: true, active: false }))).toBe('default');
    expect(nodeTone(node({ overdue: true, active: false }))).toBe('default');
  });

  test('issue marks: closed filled, unassigned hatched, owned hollow ink', () => {
    expect(
      issueMark({ open: false, unassigned: true, stateName: 'Done' })
    ).toEqual({ status: 'done', label: 'Done' });
    expect(
      issueMark({ open: true, unassigned: true, stateName: 'Backlog' })
    ).toEqual({ status: 'missing', label: 'Backlog, unassigned' });
    expect(
      issueMark({ open: true, unassigned: false, stateName: 'In Progress' })
    ).toEqual({ status: 'open', label: 'In Progress' });
    // An owned open issue makes no status claim of its own (its milestone
    // does), so it never takes the milestone's on-track green.
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
      // The graph's own links, then the Issues page, then the timeline.
      expect(detail?.links.map((l) => l.label)).toEqual([
        'Issues of this milestone',
        ...(detail?.links
          .filter((l) => l.label.startsWith('Milestones of '))
          .map((l) => l.label) ?? []),
        'Open as list',
        'Open on the timeline',
        ...(detail?.links.some((l) => l.label === 'Project in Linear')
          ? ['Project in Linear']
          : []),
      ]);
      expect(detail?.links.find((l) => l.label === 'Open as list')?.href).toBe(
        `/issues?milestone=${encodeURIComponent(n.id)}`
      );
    }
    expect(model.mermaid?.body.startsWith('flowchart LR\n')).toBe(true);
    expect(model.ariaSummary).toContain(`${model.nodes.length} milestones`);
    expect(model.ariaSummary).toContain('no cycles');
    expect(model.receipts).toContain('Select a milestone to see its issues.');
    expect(model.legends.risk.some((item) => item.mark === 'weight')).toBe(
      true
    );
  });

  test('an overdue milestone floods red, says so and names its project', () => {
    const model = page({ level: 'milestone' });
    const overdue = model.nodes.find(
      (n) => n.tags?.includes('OVERDUE') === true
    );
    expect(overdue).toBeDefined();
    if (overdue === undefined) return;
    expect(overdue.status).toBe('overdue');
    expect(overdue.tone).toBe('danger');
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

  test('a scope without any blocking relation still draws every issue', () => {
    const model = page({ level: 'issue', projectId: 'proj-compass' });
    expect(model.nodes.map((n) => n.id).sort()).toEqual(
      [...snapshot.issues.values()]
        .filter((issue) => issue.projectId === 'proj-compass')
        .map((issue) => issue.id)
        .sort()
    );
    expect(model.edges).toEqual([]);
    expect(model.meta).toBe('9 issues · 0 edges');
    expect(model.receipts).toBe(
      '9 issues in Compass onboarding, in 3 milestones; no blocking relations.'
    );
    // Nothing waits on anything: every open one has no dependencies, in
    // no status hue, and there is no chain to number.
    expect(
      model.nodes.every(
        (n) =>
          n.readiness?.state === 'done' ||
          (n.readiness?.state === 'independent' &&
            n.readiness.tone === 'default')
      )
    ).toBe(true);
    expect(model.readouts.critical).toBe(
      'No open chain: nothing drawn waits on anything open.'
    );
  });

  test('a scope with nothing in it shows the empty state', () => {
    // Garnet's Push notifications milestone holds no issue yet.
    const model = page({ level: 'issue', milestoneId: 'ms-garnet-2' });
    expect(model.nodes).toEqual([]);
    expect(model.clusters).toEqual([]);
    expect(model.layout).toBeNull();
    expect(model.mermaid).toBeNull();
    expect(model.emptyMessage).toBe('No issues in Push notifications.');
    expect(model.ariaSummary).toBe('No issues in Push notifications.');
    expect(model.meta).toBe('No issues');
    expect(model.receipts).toBe(
      'Every issue in Push notifications, and which wait on which, from Linear’s blocking relations.'
    );
  });
});

// The owner's correction (2026-10-23): the graph is there to show all
// issues, not just blocking ones. Every item of the scope is drawn, the
// blocking relations are the arrows, and labelled frames group the boxes
// by parent so the unrelated ones pack instead of piling up.
describe('every item drawn, framed by parent', () => {
  const { snapshot, graphOf, page } = fixture();

  test('the milestone level draws every milestone, framed by its project', () => {
    const graph = graphOf({ level: 'milestone' });
    const model = page({ level: 'milestone' });
    expect(model.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(model.nodes).toHaveLength(17);
    const onEdge = new Set(model.edges.flatMap((e) => [e.from, e.to]));
    expect(model.nodes.filter((n) => !onEdge.has(n.id))).toHaveLength(13);
    // Each box sits in its project's frame; the paused Fjord's is muted.
    // A double-click on a frame's title opens that project's milestones.
    expect(model.clusters).toEqual(
      clusterData(
        graph.clusters,
        new Map(
          graph.clusters.map((c) => [
            c.id,
            `/graph?project=${c.refId ?? ''}&level=milestone`,
          ])
        )
      )
    );
    expect(model.clusters).toHaveLength(9);
    for (const n of model.nodes) {
      const milestone = snapshot.milestones.get(n.id);
      expect(n.cluster).toBe(`project:${milestone?.projectId ?? ''}`);
    }
    expect(model.clusters.find((c) => c.id === 'project:proj-fjord')).toEqual({
      id: 'project:proj-fjord',
      label: 'Fjord analytics',
      muted: true,
      drillHref: '/graph?project=proj-fjord&level=milestone',
    });
    // Counts say what is drawn; nothing is "listed under the graph".
    expect(model.meta).toBe('17 milestones · 3 edges');
    expect(model.receipts).not.toContain('listed');
    expect(model.ariaSummary).not.toContain('listed');
    // The server layout is framed: one frame per cluster, every box in it.
    expect(model.layout?.clustered).toBe(true);
    expect(
      model.layout?.groups.filter((g) => g.kind === 'cluster').map((g) => g.id)
    ).toEqual(model.clusters.map((c) => c.id));
    expect(model.layout?.nodes).toHaveLength(17);
    // The Mermaid copy is the drawn graph: one line per box, one subgraph
    // per frame.
    const lines = (model.mermaid?.body ?? '').split('\n');
    expect(lines.filter((line) => /^ +n\d+\["/.test(line))).toHaveLength(17);
    expect(
      lines.filter((line) => /^ +subgraph c\d+\["/.test(line))
    ).toHaveLength(9);
  });

  test('an item on no relation reads “No dependencies”, in no status hue', () => {
    const model = page({ level: 'milestone' });
    const harbor = model.nodes.find((n) => n.id === 'ms-harbor-1');
    expect(harbor?.readiness).toEqual({
      state: 'independent',
      label: 'No dependencies',
      tone: 'default',
      blockedBy: 0,
      unblocks: 0,
      canStart: true,
    });
    // Its own facts keep their hue: at risk and unassigned stay amber.
    expect([harbor?.tone, harbor?.tags]).toEqual(['warning', ['UNASSIGNED']]);
    expect(
      model.details['ms-harbor-1']?.properties.find(
        (p) => p.label === 'Readiness'
      )
    ).toEqual({
      label: 'Readiness',
      value:
        'No dependencies: it neither waits on nor holds up another milestone',
      tone: 'default',
    });
    // The Status legend says so, with a plain box.
    expect(model.legends.status[1]).toEqual({
      mark: 'node',
      label: 'No dependencies',
      note: 'it neither waits on nor holds up another milestone',
    });
  });

  test('the issue level draws done issues and leaves canceled ones out', () => {
    const model = page({ level: 'issue', projectId: 'proj-atlas' });
    const ids = model.nodes.map((n) => n.id);
    // Schema cutover's done ENG-1 and ENG-2 are drawn, muted with their
    // filled mark; ENG-3 (canceled) and ENG-14 (duplicate) are not.
    expect(ids).toContain('iss-eng-1');
    expect(ids).toContain('iss-eng-2');
    expect(ids).not.toContain('iss-eng-3');
    expect(ids).not.toContain('iss-eng-14');
    const done = model.nodes.find((n) => n.id === 'iss-eng-1');
    expect([done?.tone, done?.status, done?.readiness?.state]).toEqual([
      'muted',
      'done',
      'done',
    ]);
    // Milestone frames nest in project frames: the issues span Atlas and
    // the external Beacon.
    expect(
      model.clusters.map((c) => [c.id, c.parent ?? null, c.external === true])
    ).toEqual([
      ['project:proj-atlas', null, false],
      ['milestone:ms-atlas-2', 'project:proj-atlas', false],
      ['milestone:ms-atlas-1', 'project:proj-atlas', false],
      ['milestone:ms-atlas-3', 'project:proj-atlas', false],
      ['milestone:none:proj-atlas', 'project:proj-atlas', false],
      ['project:proj-beacon', null, true],
      ['milestone:ms-beacon-1', 'project:proj-beacon', true],
    ]);
    expect(model.clusters[4]?.label).toBe('No milestone');
    expect(model.receipts).toBe(
      '9 issues in Atlas billing migration, 8 of them in 3 milestones, plus 2 issues outside it that block or wait on them; 3 blocking relations: 2 on a risk chain and 1 unblocked.'
    );
    // The frames' legend item, in every highlight.
    for (const legend of Object.values(model.legends)) {
      expect(legend.find((item) => item.mark === 'cluster')).toEqual({
        mark: 'cluster',
        label: 'Milestone',
        note: 'a frame of its issues, inside its project’s',
      });
    }
  });

  test('clusterData: parents, muted and external frames', () => {
    expect(
      clusterData([
        {
          id: 'project:p1',
          kind: 'project',
          refId: 'p1',
          label: 'Orion',
          parentId: null,
          projectId: 'p1',
          active: false,
          external: false,
        },
        {
          id: 'milestone:none:p1',
          kind: 'milestone',
          refId: null,
          label: 'No milestone',
          parentId: 'project:p1',
          projectId: 'p1',
          active: true,
          external: true,
        },
      ])
    ).toEqual([
      { id: 'project:p1', label: 'Orion', muted: true },
      {
        id: 'milestone:none:p1',
        label: 'No milestone',
        parent: 'project:p1',
        external: true,
      },
    ]);
  });

  test('the initiative level packs its loose boxes; a chain keeps one flow', () => {
    const initiatives = page({ level: 'initiative' });
    expect(initiatives.clusters).toEqual([]);
    expect(initiatives.layout?.clustered).toBe(true);
    expect(
      initiatives.legends.status.some((item) => item.mark === 'cluster')
    ).toBe(false);
    const chain = page({ level: 'issue', issueId: 'ENG-23' });
    expect(chain.clusters).toEqual([]);
    expect(chain.layout?.clustered).toBeUndefined();
    expect(chain.nodes.every((n) => n.cluster === undefined)).toBe(true);
  });

  // Frames pack onto shelves that wrap, so an arrow between two frames
  // can run right to left (the showcase review counted 41 of 247 at the
  // workspace issue level); only inside a frame does the flow always run
  // left to right, and the Risk legend's box says so where frames are
  // drawn. One flow (the initiative level, a chain) keeps the plain note.
  test('the Risk legend says blockers sit left in a frame wherever frames are drawn', () => {
    const boxNote = (scope: GraphScope) =>
      page(scope).legends.risk.find((item) => item.mark === 'node')?.note;
    const framed = 'in a frame, blockers sit left of what waits';
    expect(boxNote({ level: 'issue' })).toBe(framed);
    expect(boxNote({ level: 'milestone' })).toBe(framed);
    expect(boxNote({ level: 'project' })).toBe(framed);
    expect(boxNote({ level: 'initiative' })).toBe(
      'blockers sit left of what waits'
    );
    expect(boxNote({ level: 'issue', issueId: 'ENG-23' })).toBe(
      'blockers sit left of what waits'
    );
  });

  test('a paused project’s frame is muted, and the legend says so', () => {
    const model = page({ level: 'issue' });
    expect(
      model.clusters
        .filter((c) => c.muted === true)
        .map((c) => [c.id, c.parent ?? null])
    ).toEqual([
      ['project:proj-fjord', null],
      ['milestone:ms-fjord-1', 'project:proj-fjord'],
    ]);
    expect(
      model.legends.risk.filter((item) => item.mark.startsWith('cluster'))
    ).toEqual([
      {
        mark: 'cluster',
        label: 'Milestone',
        note: 'a frame of its issues, inside its project’s',
      },
      {
        mark: 'cluster-muted',
        label: 'Inactive',
        note: 'a hatched frame of paused work',
      },
    ]);
  });
});

// Goldens captured on 2026-10-22 from the page as it was before the graph
// levels change (spec §13 commit 1): today's three kinds of /graph page
// keep what they say and draw. Tags may gain CYCLE INSIDE (asserted on its
// own), so it is left out of the tag comparison. Updated 2026-10-23 for the
// owner's every-item rule: the boxes that were listed under the canvas are
// drawn now, in the same order around the related ones, inside frames.
describe('pages kept', () => {
  const { page } = fixture();
  const kept = (scope: GraphScope) => {
    const m = page(scope);
    return {
      heading: m.heading,
      receipts: m.receipts,
      meta: m.meta,
      nodes: m.nodes.map((n) => n.id),
      clusters: m.clusters.map((c) => c.id),
      edges: m.edges.map((e) => [e.from, e.to, e.kind, e.weight]),
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
        '17 milestones in 9 projects; 3 blocking edges: 3 on a risk chain and 2 across projects. Select a milestone to see its issues.',
      meta: '17 milestones · 3 edges',
      // The four related ones keep their order; the ten that were listed
      // keep theirs; the paused Dashboards, the complete Schema cutover and
      // the empty Push notifications are drawn too.
      nodes: [
        'ms-fjord-1',
        'ms-atlas-2',
        'ms-juniper-1',
        'ms-atlas-1',
        'ms-beacon-1',
        'ms-harbor-1',
        'ms-compass-1',
        'ms-garnet-1',
        'ms-ember-1',
        'ms-delta-1',
        'ms-garnet-2',
        'ms-atlas-3',
        'ms-harbor-2',
        'ms-beacon-2',
        'ms-juniper-2',
        'ms-compass-2',
        'ms-compass-3',
      ],
      clusters: [
        'project:proj-atlas',
        'project:proj-harbor',
        'project:proj-delta',
        'project:proj-fjord',
        'project:proj-juniper',
        'project:proj-beacon',
        'project:proj-compass',
        'project:proj-ember',
        'project:proj-garnet',
      ],
      edges: [
        ['ms-atlas-2', 'ms-beacon-1', 'risk', 1],
        ['ms-atlas-2', 'ms-atlas-3', 'risk', 1],
        ['ms-beacon-1', 'ms-juniper-1', 'risk', 1],
      ],
      tags: [
        ['ms-fjord-1', ['UNASSIGNED', 'INACTIVE']],
        ['ms-atlas-2', ['UNASSIGNED', 'OVERDUE']],
        ['ms-juniper-1', []],
        ['ms-atlas-1', []],
        ['ms-beacon-1', []],
        ['ms-harbor-1', ['UNASSIGNED']],
        ['ms-compass-1', ['UNASSIGNED']],
        ['ms-garnet-1', []],
        ['ms-ember-1', ['UNASSIGNED']],
        ['ms-delta-1', ['UNASSIGNED']],
        ['ms-garnet-2', []],
        ['ms-atlas-3', ['UNASSIGNED']],
        ['ms-harbor-2', []],
        ['ms-beacon-2', []],
        ['ms-juniper-2', []],
        ['ms-compass-2', []],
        ['ms-compass-3', ['UNASSIGNED']],
      ],
    });
  });

  test('/graph?milestone=ms-atlas-2: the issues of Dual-write', () => {
    expect(kept({ level: 'issue', milestoneId: 'ms-atlas-2' })).toEqual({
      heading: 'Issues in Dual-write',
      receipts:
        '4 issues in Dual-write, plus 2 issues outside it that block or wait on them; 2 blocking relations: 2 on a risk chain.',
      meta: '6 issues · 2 edges',
      // ENG-14 is a duplicate: never drawn.
      nodes: [
        'iss-eng-10',
        'iss-eng-12',
        'iss-eng-11',
        'iss-eng-13',
        'iss-eng-23',
        'iss-eng-16',
      ],
      clusters: [
        'project:proj-atlas',
        'milestone:ms-atlas-2',
        'milestone:ms-atlas-3',
        'project:proj-beacon',
        'milestone:ms-beacon-1',
      ],
      edges: [
        ['iss-eng-10', 'iss-eng-16', 'risk', 1],
        ['iss-eng-12', 'iss-eng-23', 'risk', 1],
      ],
      tags: [
        ['iss-eng-10', ['OVERDUE']],
        ['iss-eng-12', ['UNASSIGNED', 'OVERDUE']],
        ['iss-eng-11', ['OVERDUE']],
        ['iss-eng-13', ['UNASSIGNED', 'OVERDUE']],
        ['iss-eng-23', []],
        ['iss-eng-16', []],
      ],
    });
  });

  test('/graph?project=proj-juniper: the issues of Juniper', () => {
    expect(kept({ level: 'issue', projectId: 'proj-juniper' })).toEqual({
      heading: 'Issues in Juniper design system',
      receipts:
        '5 issues in Juniper design system, in 2 milestones, plus 1 issue outside it that blocks or waits on them; 3 blocking relations: 1 on a risk chain and 1 cycle.',
      meta: '6 issues · 3 edges · 1 cycle',
      nodes: [
        'iss-eng-70',
        'iss-eng-71',
        'iss-ops-20',
        'iss-eng-72',
        'iss-eng-73',
        'iss-eng-23',
      ],
      clusters: [
        'project:proj-juniper',
        'milestone:ms-juniper-1',
        'milestone:ms-juniper-2',
        'project:proj-beacon',
        'milestone:ms-beacon-1',
      ],
      edges: [
        ['iss-eng-70', 'iss-eng-71', 'cycle', 1],
        ['iss-eng-71', 'iss-eng-70', 'cycle', 1],
        ['iss-eng-23', 'iss-ops-20', 'risk', 1],
      ],
      tags: [
        ['iss-eng-70', ['CYCLE']],
        ['iss-eng-71', ['CYCLE']],
        ['iss-ops-20', []],
        ['iss-eng-72', []],
        ['iss-eng-73', []],
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
    clusters: [],
    fallback: null,
    unplacedRelations: 0,
    chain: null,
  };
}

describe('every level on the demo workspace', () => {
  const { graphOf, page, pageOf } = fixture();
  const ids = (list: readonly { id: string }[]) => list.map((n) => n.id);
  const drawnEdges = (scope: GraphScope) =>
    page(scope).edges.map((e) => [e.from, e.to, e.kind, e.weight]);

  test('/graph?level=initiative: Platform ⇄ Growth, No initiative drawn beside them', () => {
    const model = page({ level: 'initiative' });
    expect(model.heading).toBe('Dependencies');
    expect(model.crumb).toBeNull();
    expect(model.trail).toEqual([]);
    expect(model.blockTitle).toBe('Initiatives');
    expect(model.scopeHref).toBe('/graph?level=initiative');
    expect(model.receipts).toBe(
      '2 initiatives and the projects with no initiative; 2 blocking edges: 1 cycle (Platform reliability and Customer growth wait on each other). A project in several initiatives counts under the first, as on the timeline. Select an initiative to see its projects.'
    );
    expect(model.meta).toBe('3 initiatives · 2 edges · 1 cycle');
    expect(ids(model.nodes)).toEqual(['init-platform', 'init-growth', 'none']);
    expect(drawnEdges({ level: 'initiative' })).toEqual([
      ['init-platform', 'init-growth', 'cycle', 1],
      ['init-growth', 'init-platform', 'cycle', 1],
    ]);
    const platform = model.nodes[0];
    expect(platform?.sublabel).toBe('5 projects · Dec 20');
    expect(platform?.tags).toEqual(['OVERDUE', 'CYCLE', 'CYCLE INSIDE']);
    // Its next milestones are overdue: the red flood, not the purple.
    expect(platform?.tone).toBe('danger');
    expect(platform?.cluster).toBeUndefined();
    // "No initiative" is on no relation: drawn all the same, in no frame
    // (the initiative level has none), its at-risk amber kept, its
    // readiness neutral.
    expect(model.nodes[2]).toEqual({
      id: 'none',
      label: 'No initiative',
      sublabel: '1 project',
      // A double-click opens its projects.
      drillHref: '/graph?initiative=none',
      tone: 'warning',
      status: 'at_risk',
      statusLabel: 'At risk',
      tags: [],
      readiness: {
        state: 'independent',
        label: 'No dependencies',
        tone: 'default',
        blockedBy: 0,
        unblocks: 0,
        canStart: true,
      },
    });
    expect(model.clusters).toEqual([]);
    expect(model.ariaSummary).toBe(
      'Initiative dependency graph of the workspace: 2 initiatives and the projects with no initiative, with 2 blocking edges, 0 on a risk chain; 1 cycle: Platform reliability and Customer growth wait on each other. 2 waiting, 1 with no dependencies. Critical path: 2 initiatives: Platform reliability + Customer growth.'
    );
    expect(
      model.legends.risk.map((item) => `${item.label} — ${item.note}`)
    ).toEqual([
      'Initiative — blockers sit left of what waits',
      'Overdue — a project’s milestone is past due',
      'At risk — a project’s next milestone',
      'In a cycle — they wait on each other',
      'Inactive — no active project',
      'Blocks — an open issue blocks one',
      'Risk chain — a blocking issue is unassigned or overdue, or waits on one',
      'Cycle — both ends wait',
      'Count — issue relations on one edge',
      'Reading — the box you point at or focus',
      'Locked — the box you click or tap: its paths stay lit, Open beside it',
      'Waits on — what the box you point at waits on',
      'Holds up — what waits on it, through box arrows',
      'Clear next — clear once it is finished',
    ]);
    // The swatches draw the status hues: the red flood, the amber rule.
    expect(model.legends.risk.slice(0, 3).map((item) => item.mark)).toEqual([
      'node',
      'node-overdue',
      'node-warning',
    ]);
    expect(model.legends.risk.some((item) => item.mark === 'node-accent')).toBe(
      false
    );
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

  test('/graph?level=project: Atlas → Beacon → Juniper among every project, framed by initiative', () => {
    const model = page({ level: 'project' });
    expect(model.receipts).toBe(
      '9 projects in 2 initiatives, 1 with no initiative; 2 blocking edges: 2 on a risk chain and 2 across initiatives. Select a project to see its milestones and issues.'
    );
    expect(model.meta).toBe('9 projects · 2 edges');
    expect(drawnEdges({ level: 'project' })).toEqual([
      ['proj-atlas', 'proj-beacon', 'risk', 1],
      ['proj-beacon', 'proj-juniper', 'risk', 1],
    ]);
    // Every project, the paused Fjord included, each in its first
    // initiative's frame, "No initiative" last.
    expect(
      model.nodes.map((n) => [n.id, n.sublabel, n.tags, n.cluster])
    ).toEqual([
      ['proj-atlas', 'Chloe Diaz', ['OVERDUE'], 'initiative:init-platform'],
      ['proj-harbor', 'Elena Novak', [], 'initiative:init-platform'],
      ['proj-delta', 'No lead', ['NO LEAD'], 'initiative:init-platform'],
      ['proj-fjord', 'Femi Adeyemi', ['INACTIVE'], 'initiative:init-platform'],
      [
        'proj-juniper',
        'Grace Lin',
        ['CYCLE INSIDE'],
        'initiative:init-platform',
      ],
      ['proj-beacon', 'Dev Patel', [], 'initiative:init-growth'],
      ['proj-compass', 'Ana Moreno', [], 'initiative:init-growth'],
      ['proj-ember', 'Hugo Laurent', [], 'initiative:init-growth'],
      ['proj-garnet', 'Ben Carter', [], 'initiative:none'],
    ]);
    // A double-click on a frame's title opens that initiative's projects.
    expect(model.clusters).toEqual([
      {
        id: 'initiative:init-platform',
        label: 'Platform reliability',
        drillHref: '/graph?initiative=init-platform',
      },
      {
        id: 'initiative:init-growth',
        label: 'Customer growth',
        drillHref: '/graph?initiative=init-growth',
      },
      {
        id: 'initiative:none',
        label: 'No initiative',
        drillHref: '/graph?initiative=none',
      },
    ]);
    expect(
      model.legends.status.find((item) => item.mark === 'cluster')
    ).toEqual({
      mark: 'cluster',
      label: 'Initiative',
      note: 'a frame of its projects (each under its first initiative)',
    });
    expect(model.details['proj-delta']?.properties[1]).toEqual({
      label: 'Lead',
      value: 'No lead',
      tone: 'warning',
    });
    const deltaNode = graphOf({ level: 'project' }).nodes.find(
      (n) => n.id === 'proj-delta'
    );
    expect(deltaNode === undefined ? [] : nodeTags(deltaNode)).toEqual([
      'NO LEAD',
    ]);
    expect(
      model.legends.risk.find((item) => item.mark === 'edge-cross')
    ).toEqual({
      mark: 'edge-cross',
      label: 'Cross-initiative',
      note: 'leaves its initiative',
    });
    expect(
      model.legends.risk.some((item) => item.mark === 'node-external')
    ).toBe(false);
  });

  test('/graph: CYCLE INSIDE on ms-juniper-1, the muted swatch names inactive', () => {
    const model = page({ level: 'milestone' });
    expect(model.nodes.find((n) => n.id === 'ms-juniper-1')?.tags).toEqual([
      'CYCLE INSIDE',
    ]);
    expect(
      model.legends.risk.find((item) => item.mark === 'node-muted')
    ).toEqual({
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
    // Drawn among the others, its box is faint and its mark says why, in
    // its initiative's frame.
    const box = page({
      level: 'project',
      initiativeId: 'init-platform',
    }).nodes.find((n) => n.id === 'proj-fjord');
    expect(box?.status).toBe('overdue');
    expect(box?.statusLabel).toBe('Overdue · inactive project');
    expect(box?.tone).toBe('muted');
    expect(box?.readiness?.tone).toBe('muted');
    expect(box?.cluster).toBe('initiative:init-platform');
  });

  test('/graph?initiative=init-growth: Beacon in scope, Atlas and Juniper external', () => {
    const model = page({ level: 'project', initiativeId: 'init-growth' });
    expect(model.heading).toBe('Projects in Customer growth');
    expect(model.crumb).toBe('Projects in Customer growth');
    expect(model.scopeHref).toBe('/graph?initiative=init-growth');
    expect(model.receipts).toBe(
      '3 projects in Customer growth, plus 2 projects outside it that block or wait on them; 2 blocking edges: 2 on a risk chain and 2 across initiatives.'
    );
    // Its three projects, related or not, then the two outside ones on an
    // edge, in Platform reliability's dashed frame.
    expect(
      model.nodes.map((n) => [n.id, n.external === true, n.cluster])
    ).toEqual([
      ['proj-beacon', false, 'initiative:init-growth'],
      ['proj-compass', false, 'initiative:init-growth'],
      ['proj-ember', false, 'initiative:init-growth'],
      ['proj-atlas', true, 'initiative:init-platform'],
      ['proj-juniper', true, 'initiative:init-platform'],
    ]);
    // The page's own frame opens what its panel's next link opens (its
    // milestones: its projects are this page); the outside one its
    // projects.
    expect(model.clusters).toEqual([
      {
        id: 'initiative:init-growth',
        label: 'Customer growth',
        drillHref: '/graph?initiative=init-growth&level=milestone',
      },
      {
        id: 'initiative:init-platform',
        label: 'Platform reliability',
        external: true,
        drillHref: '/graph?initiative=init-platform',
      },
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
    expect(
      model.legends.risk.find((item) => item.mark === 'node-external')
    ).toEqual({
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
          tone: 'danger',
        },
        {
          label: 'Progress',
          value: '0/4 done · 2 open issues unassigned',
          tone: 'warning',
        },
        // Where it stands, mirror-wide (§2.10 "Readiness"), in the Status
        // tone: nothing outside it holds it up.
        {
          label: 'Readiness',
          value: 'Clear: nothing outside it holds it up',
          tone: 'success',
        },
        { label: 'Open issues', value: '7 open · 6 can start · 1 blocked' },
        // The register's allocation chip tone (§8.2): info allocating.
        { label: 'Allocation', value: 'Allocating 2', tone: 'info' },
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
          label: 'Open as list',
          href: '/issues?project=proj-atlas',
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
        {
          label: 'Readiness',
          value: 'Waiting on 1 initiative: Customer growth',
          tone: 'warning',
        },
        {
          label: 'Open issues',
          value: '20 open · 16 can start · 4 blocked · 7 unassigned',
        },
        {
          label: 'At risk',
          value:
            'Atlas billing migration › Dual-write (overdue); Harbor API v3 › Public beta (at risk)',
          // One of them is overdue: red, not amber.
          tone: 'danger',
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
          label: 'Open as list',
          href: '/issues?initiative=init-platform',
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
      'Open as list',
      'Open on the timeline',
    ]);
    expect(
      model.details['none']?.links.find((l) => l.label === 'Open as list')?.href
    ).toBe('/issues?initiative=none');
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
      ['Open as list', '/issues?milestone=ms-atlas-2'],
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
      'Open as list',
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

  test('the workspace issue level draws every issue and counts them all', () => {
    const graph = graphOf({ level: 'issue' });
    const model = page({ level: 'issue' });
    expect(ids(model.nodes)).toEqual(ids(graph.nodes));
    expect(model.receipts).toBe(
      '51 issues in the workspace, 45 of them in 16 milestones; 6 blocking relations: 3 on a risk chain, 1 unblocked and 1 cycle.'
    );
    expect(model.meta).toBe('51 issues · 6 edges · 1 cycle');
    // Nothing is counted and left out any more: no "unrelated" notice.
    expect(model.notices).toEqual([]);
    expect(model.readouts.status).toBe(
      '3 ready · 5 blocked · 36 with no dependencies · 7 done'
    );
    expect(model.ariaSummary).toBe(
      'Issue dependency graph of the workspace: 51 issues, 45 of them in 16 milestones, with 6 blocking relations, 3 on a risk chain and 1 unblocked; 1 cycle: Color tokens and Type scale wait on each other. 3 ready, 5 blocked, 36 with no dependencies, 7 done. Critical path: 3 issues: ENG-12, ENG-23, OPS-20.'
    );
    // 9 project frames, each holding its milestones' (and "No
    // milestone") frames, then "No project".
    expect(model.clusters.filter((c) => c.parent === undefined)).toHaveLength(
      10
    );
    expect(model.clusters).toHaveLength(28);
    expect(model.clusters.at(-1)).toEqual({
      id: 'project:none',
      label: 'No project',
    });
    const growth = page({ level: 'issue', initiativeId: 'init-growth' });
    expect(growth.notices.map((n) => n.id)).toEqual(['shared']);
    expect(growth.receipts).toBe(
      '20 issues in Customer growth, in 6 milestones, plus 3 issues outside it that block or wait on them; 3 blocking relations: 2 on a risk chain and 1 unblocked.'
    );
  });

  test('a milestone and a chain offer one level: no tabs', () => {
    expect(page({ level: 'issue', milestoneId: 'ms-atlas-2' }).tabs).toEqual(
      []
    );
    expect(page({ level: 'issue', issueId: 'ENG-23' }).tabs).toEqual([]);
  });

  test('boxes on no relation are drawn: Compass’s milestones, none waiting', () => {
    const model = page({ level: 'milestone', projectId: 'proj-compass' });
    expect(ids(model.nodes)).toEqual([
      'ms-compass-1',
      'ms-compass-2',
      'ms-compass-3',
    ]);
    expect(model.edges).toEqual([]);
    expect(model.receipts).toBe(
      '3 milestones in Compass onboarding; no blocking edges.'
    );
    expect(model.meta).toBe('3 milestones · 0 edges');
    // The page's own frame: its issues, the panel's next link.
    expect(model.clusters).toEqual([
      {
        id: 'project:proj-compass',
        label: 'Compass onboarding',
        drillHref: '/graph?project=proj-compass',
      },
    ]);
    expect(Object.keys(model.details)).toEqual(ids(model.nodes));
    expect(model.readouts.status).toBe(
      '3 with no dependencies · 8 open issues: 8 can start'
    );
  });

  test('an empty container still has its tabs (the screen moves them to the block bar)', () => {
    // A project with no milestone yet: nothing to draw at that level.
    const model = pageOf(
      synthetic({ level: 'milestone', projectId: 'proj-compass' }, [], [])
    );
    expect(model.nodes).toEqual([]);
    expect(model.receipts).toBe(
      'Every milestone in Compass onboarding, and which wait on which, from Linear’s blocking relations.'
    );
    expect(model.emptyMessage).toBe('No milestones in Compass onboarding.');
    expect(model.meta).toBe('No milestones');
    expect(model.tabs.find((tab) => tab.id === 'issue')?.href).toBe(
      '/graph?project=proj-compass'
    );
    expect(model.layout).toBeNull();
    expect(model.mermaid).toBeNull();
    expect(model.details).toEqual({});
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

describe('“No initiative” copy, empty containers and quiet boxes', () => {
  const { page, pageOf } = fixture();

  test('“No initiative” reads as a group of projects, not a name', () => {
    const projects = page({ level: 'project', initiativeId: 'none' });
    expect(projects.heading).toBe('Projects with no initiative');
    expect(projects.receipts).toBe(
      '1 project with no initiative; no blocking edges.'
    );
    expect(projects.emptyMessage).toBe('No projects with no initiative.');
    const milestones = page({ level: 'milestone', initiativeId: 'none' });
    expect(milestones.receipts).toBe(
      '2 milestones in projects with no initiative; no blocking edges.'
    );
    const issues = page({ level: 'issue', initiativeId: 'none' });
    expect(issues.receipts).toBe(
      '6 issues in projects with no initiative, 4 of them in 1 milestone; no blocking relations.'
    );
    expect(issues.emptyMessage).toBe(
      'No issues in projects with no initiative.'
    );
  });

  test('a box on no relation is drawn, its own graph a click away', () => {
    // Garnet, the one project with no initiative, waits on nothing.
    const model = page({ level: 'project', initiativeId: 'none' });
    expect(model.nodes.map((n) => [n.id, n.label, n.cluster])).toEqual([
      ['proj-garnet', 'Garnet mobile app', 'initiative:none'],
    ]);
    expect(
      model.details['proj-garnet']?.links.map((l) => [l.label, l.href])
    ).toEqual(
      expect.arrayContaining([
        ['Issues of Garnet mobile app', '/graph?project=proj-garnet'],
      ])
    );
    // The paused Fjord's open issues are drawn too: quiet in Status, with
    // the word that says why.
    const fjord = page({ level: 'issue', projectId: 'proj-fjord' });
    expect(
      fjord.nodes.map((n) => [n.id, n.readiness?.tone, n.tags?.at(-1)])
    ).toEqual([
      ['iss-ops-8', 'muted', 'INACTIVE'],
      ['iss-ops-9', 'muted', 'INACTIVE'],
    ]);
    expect(fjord.receipts).toBe(
      '2 issues in Fjord analytics, in 1 milestone; no blocking relations.'
    );
  });

  test('an inactive project’s boxes are quiet: no status hue on a date or assignee', () => {
    // Dashboards (Fjord analytics, paused) is 5 days overdue.
    const model = page({ level: 'milestone', initiativeId: 'init-platform' });
    const dashboards = model.nodes.find((n) => n.id === 'ms-fjord-1');
    expect(dashboards).toMatchObject({
      tone: 'muted',
      status: 'overdue',
      statusLabel: 'Overdue · inactive project',
      tags: ['UNASSIGNED', 'INACTIVE'],
      cluster: 'project:proj-fjord',
    });
    expect(dashboards?.readiness?.tone).toBe('muted');
    expect(model.clusters.find((c) => c.id === 'project:proj-fjord')).toEqual({
      id: 'project:proj-fjord',
      label: 'Fjord analytics',
      muted: true,
      drillHref: '/graph?project=proj-fjord&level=milestone',
    });
    expect(model.details['ms-fjord-1']?.alert).toBeNull();
    expect(
      model.details['ms-fjord-1']?.properties.find((p) => p.label === 'Due')
    ).toMatchObject({ value: 'Oct 16 · 5 days overdue', tone: 'default' });
    // An unassigned, overdue issue of a paused project, drawn beside two
    // related ones: the same facts, in ink.
    const graph = synthetic(
      { level: 'issue', projectId: 'proj-fjord' },
      [
        node({ id: 'a', projectId: 'proj-fjord', active: false }),
        node({ id: 'b', projectId: 'proj-fjord', active: false }),
        node({
          id: 'iss-ops-8',
          projectId: 'proj-fjord',
          milestoneId: 'ms-fjord-1',
          active: false,
          unassigned: true,
          overdue: true,
        }),
      ],
      [edge({ from: 'a', to: 'b' })]
    );
    const paused = pageOf(graph);
    expect(paused.nodes.find((n) => n.id === 'iss-ops-8')?.tone).toBe(
      'default'
    );
    expect(
      paused.details['iss-ops-8']?.properties
        .filter((p) => p.label === 'Assignee' || p.label === 'Milestone')
        .map((p) => p.tone)
    ).toEqual(['default', 'default']);
  });

  test('the workspace issue legend has no External swatch; an initiative’s has', () => {
    const marks = (scope: GraphScope) =>
      page(scope).legends.risk.map((l) => l.mark);
    expect(marks({ level: 'issue' })).not.toContain('node-external');
    expect(marks({ level: 'issue', initiativeId: 'init-growth' })).toContain(
      'node-external'
    );
  });
});

describe('?node= on arrival', () => {
  const { page } = fixture();

  test('selects the box, and keys the island by it', () => {
    // Harbor's Public beta is on no relation: drawn all the same.
    const model = page({ level: 'milestone' }, { nodeId: 'ms-harbor-1' });
    expect(model.initialSelectedId).toBe('ms-harbor-1');
    expect(model.nodes.some((n) => n.id === 'ms-harbor-1')).toBe(true);
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
    expect(issue.pageKey).toBe('/graph?project=proj-atlas');
    const open = page(
      { level: 'milestone' },
      { nodeId: 'ms-harbor-1', issueKey: 'ENG-24' }
    );
    expect(open.initialSelectedId).toBeNull();
    expect(open.pageKey).toBe('/graph');
    expect(
      page({ level: 'milestone' }, { nodeId: 'nope' }).initialSelectedId
    ).toBeNull();
  });

  test('an open issue slide-over finds its box among every issue drawn', () => {
    // ENG-11 has no relation: its box is drawn, so the screen marks it
    // while its slide-over is open.
    const model = page(
      { level: 'issue', milestoneId: 'ms-atlas-2' },
      { issueKey: 'ENG-11' }
    );
    expect(model.nodes.some((n) => n.id === 'iss-eng-11')).toBe(true);
    expect(model.details['iss-eng-11']?.issueKey).toBe('ENG-11');
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
    expect(model.legends.risk.map((item) => item.mark)).toEqual([
      'node',
      'node-focus',
      'node-overdue',
      'node-warning',
      'node-cycle',
      'node-muted',
      'edge-default',
      'edge-risk',
      'edge-cycle',
      'edge-cross',
      'edge-resolved',
      'path-active',
      'path-locked',
      'path-up',
      'path-down',
      'path-next',
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
    // No Initiatives tab; the others stay.
    expect(model.tabs.map((tab) => [tab.id, tab.current])).toEqual([
      ['project', true],
      ['milestone', false],
      ['issue', false],
    ]);
    // He sees no relation, but the projects he can see are drawn, with
    // no initiative to frame them by.
    expect(model.nodes.map((n) => n.id)).toEqual([
      'proj-compass',
      'proj-delta',
      'proj-fjord',
      'proj-juniper',
    ]);
    expect(model.edges).toEqual([]);
    expect(model.clusters).toEqual([]);
    expect(model.receipts).toBe(
      '4 projects; no blocking edges. Select a project to see its milestones and issues.'
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
    // Without initiatives nothing crosses one, and nothing is framed: the
    // project level packs its boxes loose.
    expect(model.edges.map((e) => e.kind)).toEqual(['risk', 'risk']);
    expect(model.nodes.every((n) => n.cluster === undefined)).toBe(true);
    expect(model.clusters).toEqual([]);
    expect(model.layout?.clustered).toBe(true);
    expect(model.legends.risk.some((item) => item.mark === 'edge-cross')).toBe(
      false
    );
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

// GRAPH_DRAW_LIMITS is 700 boxes and 1,000 arrows (every item is drawn,
// so a workspace's issue level holds every issue): past either, nothing
// is drawn and narrower graphs are offered.
describe('the draw limits', () => {
  const { pageOf } = fixture();

  test('750 boxes are too many: no data, layout or Mermaid, narrower graphs instead', () => {
    // s0…s699 spread over init-0…init-59 (12 boxes for the first 40, 11
    // for the rest); s700…s749 all in init-late, met last in node order.
    const nodes = Array.from({ length: 750 }, (_, i) =>
      node({
        id: `s${i}`,
        initiativeId: i >= 700 ? 'init-late' : `init-${i % 60}`,
      })
    );
    const edges = Array.from({ length: 125 }, (_, i) =>
      edge({ from: `s${2 * i}`, to: `s${2 * i + 1}` })
    );
    const model = pageOf(synthetic({ level: 'issue' }, nodes, edges));
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.clusters).toEqual([]);
    expect(model.details).toEqual({});
    expect(model.layout).toBeNull();
    expect(model.mermaid).toBeNull();
    expect(model.meta).toBe('750 issues · 125 edges · too many to draw');
    expect(model.receipts).toBe(
      'Every issue in the workspace, and which wait on which, from Linear’s blocking relations.'
    );
    expect(model.tooLarge?.message).toBe(
      'Too many to draw: 750 issues in the workspace with 125 blocking relations, and the graph draws at most 700 boxes and 1,000 arrows. Narrow it down:'
    );
    expect(model.ariaSummary).toBe(model.tooLarge?.message ?? '');
    expect(model.tooLarge?.title).toBe('Narrow to');
    expect(model.tooLarge?.note).toBeNull();
    const rows = model.tooLarge?.rows ?? [];
    // 61 initiatives, capped at 50, most boxes first: init-late (50) though
    // it is met last, then the ones holding 12, then 11, ties in node order.
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
        count: '12',
        href: '/graph?initiative=init-0&level=issue',
      },
    ]);
    expect(rows.slice(39, 42).map((r) => [r.id, r.count])).toEqual([
      ['init-38', '12'],
      ['init-39', '12'],
      ['init-40', '11'],
    ]);
    expect(rows[49]?.id).toBe('init-48');
    // The tabs stay: the screen shows them in the block bar.
    expect(model.tabs.length).toBe(4);
  });

  test('1,001 arrows are too many, even between few boxes', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => node({ id: `s${i}` }));
    const edges: GraphEdge[] = [];
    for (let a = 0; a < 40 && edges.length < 1001; a += 1) {
      for (let b = 0; b < 40 && edges.length < 1001; b += 1) {
        if (a !== b) edges.push(edge({ from: `s${a}`, to: `s${b}` }));
      }
    }
    const model = pageOf(synthetic({ level: 'issue' }, nodes, edges));
    expect(model.tooLarge).not.toBeNull();
    expect(model.nodes).toEqual([]);
    expect(model.meta).toBe('40 issues · 1001 edges · too many to draw');
  });

  test('700 boxes are drawn, every one of them, with no relation at all', () => {
    // At the limit, and none of them on an edge: all drawn, packed loose
    // in the one project's milestone frames.
    const nodes = Array.from({ length: 700 }, (_, i) =>
      node({
        id: `s${i}`,
        milestoneId: `m${i % 7}`,
        clusterId: `milestone:m${i % 7}`,
        readiness: 'independent',
      })
    );
    const graph: DependencyGraph = {
      ...synthetic({ level: 'issue', projectId: 'p1' }, nodes, []),
      clusters: Array.from({ length: 7 }, (_, i) => ({
        id: `milestone:m${i}`,
        kind: 'milestone' as const,
        refId: `m${i}`,
        label: `M${i}`,
        parentId: null,
        projectId: 'p1',
        active: true,
        external: false,
      })),
    };
    const model = pageOf(graph);
    expect(model.tooLarge).toBeNull();
    expect(model.nodes).toHaveLength(700);
    expect(model.layout?.nodes).toHaveLength(700);
    expect(model.clusters).toHaveLength(7);
    expect(model.meta).toBe('700 issues · 0 edges');
    expect(model.readouts.status).toBe('700 with no dependencies');
    // One more is past the limit.
    const over = pageOf({
      ...graph,
      nodes: [...nodes, node({ id: 's700', clusterId: 'milestone:m0' })],
    });
    expect(over.tooLarge).not.toBeNull();
    expect(over.nodes).toEqual([]);
  });

  test('issues with no smaller container offer the most connected ones', () => {
    // A project's 750 related issues, none in a milestone: there is no
    // milestone to narrow to, so the page lists the busiest issues.
    const nodes = Array.from({ length: 750 }, (_, i) =>
      node({ id: `s${i}`, projectId: 'proj-atlas', milestoneId: null })
    );
    const edges = Array.from({ length: 749 }, (_, i) =>
      edge({ from: 's0', to: `s${i + 1}` })
    );
    const model = pageOf(
      synthetic({ level: 'issue', projectId: 'proj-atlas' }, nodes, edges)
    );
    expect(model.tooLarge?.message).toBe(
      'Too many to draw: 750 issues in Atlas billing migration with 749 blocking relations, and the graph draws at most 700 boxes and 1,000 arrows. Narrow it down:'
    );
    expect(model.tooLarge?.title).toBe('Most connected issues');
    expect(model.tooLarge?.note).toBe('Open one’s chain to follow it.');
    const rows = model.tooLarge?.rows ?? [];
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 2).map((r) => [r.id, r.count, r.href])).toEqual([
      ['s0', '749', '/graph?chain=s0'],
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
    const nodes = Array.from({ length: 710 }, (_, i) =>
      node({
        id: `s${i}`,
        kind: 'milestone',
        label: `M${i}`,
        status: 'on_track',
        projectId: i === 0 ? 'proj-atlas' : 'p1',
      })
    );
    const edges = Array.from({ length: 355 }, (_, i) =>
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
        count: '710',
        href: '/graph?initiative=i1&level=milestone',
      },
    ]);
  });

  test('inside a milestone: its most connected issues, each opening its chain', () => {
    const nodes = Array.from({ length: 702 }, (_, i) =>
      node({ id: `s${i}`, milestoneId: 'ms-atlas-2' })
    );
    // s0 blocks everything; s1 blocks issues s103…s201 too.
    const edges = [
      ...Array.from({ length: 701 }, (_, i) =>
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
      ['s0', '701', '/graph?chain=s0'],
      ['s1', '100', '/graph?chain=s1'],
      ['s103', '2', '/graph?chain=s103'],
    ]);
  });
});

describe('a chain past the draw limits', () => {
  const { pageOf } = fixture();

  test('lists the focus’s direct neighbours, each opening its own chain', () => {
    // 33 issues all blocking each other: 1,056 relations between 33 boxes.
    const nodes = Array.from({ length: 33 }, (_, i) =>
      node({ id: `c${i}`, distance: i === 0 ? 0 : 1 })
    );
    const edges: GraphEdge[] = [];
    for (let a = 0; a < 33; a += 1) {
      for (let b = 0; b < 33; b += 1) {
        if (a !== b) edges.push(edge({ from: `c${a}`, to: `c${b}` }));
      }
    }
    const graph: DependencyGraph = {
      ...synthetic({ level: 'issue', issueId: 'c0' }, nodes, edges),
      chain: { focusId: 'c0', upstream: 32, downstream: 32, hidden: 0 },
    };
    const model = pageOf(graph);
    expect(model.nodes).toEqual([]);
    expect(model.focusId).toBeNull();
    expect(model.tooLarge?.message).toBe(
      'Too many to draw: the nearest 33 issues on c0’s chain are joined by 1056 blocking relations.'
    );
    expect(model.tooLarge?.title).toBe('Its direct neighbours');
    const rows = model.tooLarge?.rows ?? [];
    expect(rows).toHaveLength(32);
    expect(rows[0]).toEqual({
      id: 'c1',
      label: 'Backfill orders',
      kind: 'Issue',
      count: '64',
      href: '/graph?chain=c1',
    });
  });
});

describe('status colours (architecture §8.2)', () => {
  const { page } = fixture();

  /** The non-default tones of a node's panel, as [label, tone]. */
  function panelTones(
    model: ReturnType<typeof page>,
    id: string
  ): [string, string | undefined][] {
    return (model.details[id]?.properties ?? [])
      .filter((p) => p.tone !== undefined && p.tone !== 'default')
      .map((p) => [p.label, p.tone]);
  }

  test('milestone boxes: overdue red, at risk amber, never the accent', () => {
    const model = page({ level: 'milestone' });
    expect(model.nodes.map((n) => [n.id, n.tone])).toEqual([
      // Paused, complete and empty work is faint.
      ['ms-fjord-1', 'muted'],
      ['ms-atlas-2', 'danger'],
      ['ms-juniper-1', 'default'],
      ['ms-atlas-1', 'muted'],
      ['ms-beacon-1', 'warning'],
      ['ms-harbor-1', 'warning'],
      ['ms-compass-1', 'warning'],
      ['ms-garnet-1', 'warning'],
      ['ms-ember-1', 'default'],
      ['ms-delta-1', 'default'],
      ['ms-garnet-2', 'muted'],
      ['ms-atlas-3', 'default'],
      ['ms-harbor-2', 'default'],
      ['ms-beacon-2', 'default'],
      ['ms-juniper-2', 'default'],
      ['ms-compass-2', 'default'],
      ['ms-compass-3', 'default'],
    ]);
    const tones = [
      ...model.nodes.flatMap((n) => [n.tone, n.readiness?.tone]),
      ...Object.values(model.details).flatMap((d) =>
        d.properties.map((p) => p.tone)
      ),
    ];
    expect(tones).not.toContain('accent');
  });

  test('a milestone’s dates follow dueTone: overdue red, undated amber', () => {
    const model = page({ level: 'milestone' });
    expect(panelTones(model, 'ms-atlas-2')).toEqual([
      ['Due', 'danger'],
      ['Progress', 'warning'],
      // Nothing outside Dual-write holds it up: Clear, in the green.
      ['Readiness', 'success'],
      ['Risk reasons', 'warning'],
    ]);
    // No target date is a missing input: amber in the panel.
    expect(model.details['ms-compass-3']?.properties[0]).toEqual({
      label: 'Due',
      value: 'No target date',
      tone: 'warning',
    });
    // An at-risk box carries the amber rule; its later date stays ink,
    // and with no relation its Readiness row has no hue.
    expect(model.nodes.find((n) => n.id === 'ms-harbor-1')?.tone).toBe(
      'warning'
    );
    expect(panelTones(model, 'ms-harbor-1')).toEqual([
      ['Progress', 'warning'],
      ['Risk reasons', 'warning'],
      ['Missing', 'warning'],
    ]);
  });

  test('project panels: the next milestone’s date, progress, allocation', () => {
    const model = page({ level: 'project' });
    expect(model.nodes.map((n) => [n.id, n.tone])).toEqual([
      ['proj-atlas', 'danger'],
      ['proj-harbor', 'warning'],
      ['proj-delta', 'default'],
      ['proj-fjord', 'muted'],
      ['proj-juniper', 'default'],
      ['proj-beacon', 'warning'],
      ['proj-compass', 'warning'],
      ['proj-ember', 'default'],
      ['proj-garnet', 'warning'],
    ]);
    expect(panelTones(model, 'proj-atlas')).toEqual([
      ['Next milestone', 'danger'],
      ['Progress', 'warning'],
      ['Readiness', 'success'],
      ['Allocation', 'info'],
    ]);
    // Blocked allocation and a missing lead are amber; Delta is on no
    // relation, so its Readiness ("No dependencies") has no hue.
    expect(panelTones(model, 'proj-delta')).toEqual([
      ['Lead', 'warning'],
      ['Progress', 'warning'],
      ['Allocation', 'warning'],
    ]);
  });

  test('issues: overdue red, unassigned amber, closed muted', () => {
    const model = page({ level: 'issue', milestoneId: 'ms-atlas-2' });
    expect(model.nodes.map((n) => [n.id, n.tone])).toEqual([
      ['iss-eng-10', 'danger'],
      ['iss-eng-12', 'danger'],
      ['iss-eng-11', 'danger'],
      ['iss-eng-13', 'danger'],
      ['iss-eng-23', 'default'],
      ['iss-eng-16', 'default'],
    ]);
    expect(panelTones(model, 'iss-eng-12')).toEqual([
      ['Assignee', 'warning'],
      ['Milestone', 'danger'],
    ]);
    // The two on no relation keep their own facts' hues.
    expect(panelTones(model, 'iss-eng-11')).toEqual([['Milestone', 'danger']]);
    expect(panelTones(model, 'iss-eng-13')).toEqual([
      ['Assignee', 'warning'],
      ['Milestone', 'danger'],
    ]);
    // Closed: a muted box, its date and empty assignee quiet.
    const closed = page({ level: 'issue', projectId: 'proj-atlas' });
    expect(closed.nodes.find((n) => n.id === 'iss-eng-1')?.tone).toBe('muted');
    expect(panelTones(closed, 'iss-eng-1')).toEqual([]);
  });
});

// The graph highlights (architecture §2.10 "Readiness", §8.4 "Graph"):
// readiness on every node, the per-highlight legends and idle readouts,
// the readout words, the critical path the server names (the same walk
// the canvas runs), Mermaid per highlight, and the box panel's rows, on
// the demo workspace (spec §11's acceptance at the model level).
describe('graph highlights', () => {
  const { page } = fixture();
  const byKey = (model: GraphPageModel, key: string) =>
    model.nodes.find((n) => n.key === key || n.label === key);

  test('readiness maps core facts: chip word, Status tone, counts, canStart for boxes', () => {
    expect(READINESS_TONE).toEqual({
      ready: 'success',
      blocked: 'warning',
      stuck: 'danger',
      independent: 'default',
      quiet: 'muted',
    });
    expect(nodeReadiness(node())).toEqual({
      state: 'ready',
      label: 'Ready',
      tone: 'success',
      blockedBy: 0,
      unblocks: 0,
    });
    expect(
      nodeReadiness(node({ readiness: 'blocked', blockedBy: 2, unblocks: 1 }))
    ).toEqual({
      state: 'blocked',
      label: 'Blocked by 2',
      tone: 'warning',
      blockedBy: 2,
      unblocks: 1,
    });
    // An issue on an open cycle is stuck; paused or done work is quiet.
    expect(
      nodeReadiness(
        node({ readiness: 'blocked', blockedBy: 1, holdsCycle: true })
      ).tone
    ).toBe('danger');
    expect(nodeReadiness(node({ active: false })).tone).toBe('muted');
    expect(
      nodeReadiness(node({ readiness: 'done', open: false, openIssues: 0 }))
    ).toEqual({
      state: 'done',
      label: '',
      tone: 'muted',
      blockedBy: 0,
      unblocks: 0,
    });
    // A clear box with none ready (a cycle inside) can start nothing.
    const box = node({
      kind: 'milestone',
      openIssues: 2,
      readyIssues: 0,
      holdsCycle: true,
    });
    expect(nodeReadiness(box)).toEqual({
      state: 'ready',
      label: 'None ready',
      tone: 'danger',
      blockedBy: 0,
      unblocks: 0,
      canStart: false,
    });
    expect(nodeReadiness({ ...box, readyIssues: 1 }).canStart).toBe(true);
    // On no relation at all: "No dependencies", neutral, so a graph of
    // every issue is not a sea of green.
    expect(nodeReadiness(node({ readiness: 'independent' }))).toEqual({
      state: 'independent',
      label: 'No dependencies',
      tone: 'default',
      blockedBy: 0,
      unblocks: 0,
    });
    // Paused work stays quiet whatever its readiness.
    expect(
      nodeReadiness(node({ readiness: 'independent', active: false })).tone
    ).toBe('muted');
  });

  test('an edge that no longer blocks is unblocked, whichever end is done; cross by level', () => {
    // Into a closed issue: the blocker is open, so not resolved, but it no
    // longer blocks anything.
    expect(edgeKind(edge({ blocking: false, onRiskChain: true }))).toBe(
      'resolved'
    );
    expect(crossesBoundary(edge({ crossProject: true }), 'issue')).toBe(true);
    expect(crossesBoundary(edge({ crossProject: true }), 'project')).toBe(
      false
    );
    // Every drawn edge says whether it crosses, whatever its kind: the
    // Status and Critical path highlights dash it while it blocks.
    const model = page({ level: 'issue', milestoneId: 'ms-atlas-2' });
    const crossing = model.edges.filter((e) => e.cross === true);
    expect(crossing.length).toBeGreaterThan(0);
    expect(crossing.some((e) => e.kind !== 'cross')).toBe(true);
    expect(model.edges.every((e) => typeof e.cross === 'boolean')).toBe(true);
  });

  test('/graph?chain=ENG-23: readiness, unblocks, the critical path through the focus', () => {
    const model = page({ level: 'issue', issueId: 'ENG-23' });
    expect(
      model.nodes.map((n) => [n.key, n.readiness?.label, n.readiness?.unblocks])
    ).toEqual([
      ['ENG-23', 'Blocked by 1', 1],
      ['ENG-12', 'Ready', 1],
      ['OPS-20', 'Blocked by 1', 0],
    ]);
    // ENG-12 is Backlog and still dependency-ready, with its own chips.
    expect(byKey(model, 'ENG-12')?.tags).toEqual(['UNASSIGNED', 'OVERDUE']);
    expect(model.readouts).toEqual({
      status: '1 ready · 2 blocked',
      risk: '2 relations on a risk chain · no cycles',
      critical:
        'Critical path through ENG-23: 3 issues: ENG-12 → ENG-23 → OPS-20. Start with ENG-12 (ready).',
    });
    expect(model.ariaSummary).toBe(
      'Blocking chain of ENG-23: 3 issues joined by 2 blocking relations, 2 on a risk chain and 0 unblocked; no cycles. ENG-23 is the focus. 1 ready, 2 blocked. Critical path: 3 issues: ENG-12, ENG-23, OPS-20.'
    );
    expect(model.pathWords).toEqual({
      unit: ['issue', 'issues'],
      ...GESTURE_WORDS,
    });
    expect(model.legends.status.map((i) => `${i.label} — ${i.note}`)).toEqual([
      'Ready — nothing open blocks it',
      'Blocked — an open issue blocks it',
      'Stuck — on a blocking cycle (it may run outside this graph)',
      'In a cycle — waits on itself',
      'Done or paused — closed, or in a paused project (Inactive)',
      'Focus — the issue this chain is about',
      'Blocks — the blocker is still open',
      'Unblocked — one end is done: no longer blocking',
      'Cycle — both ends wait',
      'Cross-project — leaves its project',
      'Reading — the box you point at or focus',
      'Locked — the box you click or tap: its paths stay lit, Open beside it',
      'Waits on — what the box you point at waits on',
      'Holds up — what waits on it',
      'Ready next — ready once it is done',
    ]);
    expect(model.legends.status.map((i) => i.mark)).toEqual([
      'node-ready',
      'node-blocked',
      'node-stuck',
      'node-cycle',
      'node-muted',
      'node-focus',
      'edge-default',
      'edge-unblocked',
      'edge-cycle',
      'edge-cross',
      'path-active',
      'path-locked',
      'path-up',
      'path-down',
      'path-next',
    ]);
    expect(
      model.legends.critical.map((i) => `${i.mark}: ${i.label} — ${i.note}`)
    ).toEqual([
      'node-chain: Critical path — numbered in order; each waits on the one before',
      'node-faded: Off the path — faded',
      'node-cycle: In a cycle — waits on itself',
      'node-focus: Focus — the issue this chain is about',
      'edge-chain: Critical path — the longest chain of open blockers, counted in issues',
      'edge-default: Blocks — the blocker is still open',
      'edge-cycle: Cycle — both ends wait',
      'edge-resolved: Unblocked — one end is done',
      'path-active: Reading — the box you point at or focus',
      'path-locked: Locked — the box you click or tap: its paths stay lit, Open beside it',
      'path-chain: Critical path — through the box you point at: the longest chain it is on',
    ]);
    // Risk is today's legend, then the paths.
    expect(model.legends.risk.at(-1)).toEqual({
      mark: 'path-next',
      label: 'Ready next',
      note: 'ready once it is done',
    });
  });

  test('/graph?chain=ENG-26: a done blocker is drawn unblocked, nothing to number', () => {
    const model = page({ level: 'issue', issueId: 'ENG-26' });
    expect(model.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ['iss-eng-2', 'iss-eng-26', 'resolved'],
    ]);
    expect(byKey(model, 'ENG-26')?.readiness?.label).toBe('Ready');
    expect(byKey(model, 'ENG-2')?.readiness?.state).toBe('done');
    expect(model.readouts.critical).toBe(
      'No open chain: nothing drawn waits on anything open.'
    );
    expect(model.receipts).toContain('1 blocking relation: 1 unblocked.');
    expect(model.mermaid?.styles.critical).not.toContain('Critical path');
  });

  test('/graph: the workspace milestones, Tokens and type stuck', () => {
    const model = page({ level: 'milestone' });
    expect(
      model.nodes
        .filter((n) => n.readiness?.state !== 'independent')
        .map((n) => [n.label, n.readiness?.label, n.readiness?.tone])
    ).toEqual([
      ['Dual-write', 'Clear', 'success'],
      // Its open issues are ENG-70 ⇄ ENG-71 and OPS-20 (waiting on
      // ENG-23): nothing in it can start, so it is red, with its word.
      ['Tokens and type', 'Waiting on 1', 'danger'],
      // Complete (and the empty Push notifications): faint, no word.
      ['Schema cutover', '', 'muted'],
      ['Search v2 beta', 'Waiting on 1', 'warning'],
      ['Push notifications', '', 'muted'],
      ['Read path switch', 'Waiting on 1', 'warning'],
    ]);
    // The other eleven are on no relation: neutral, no chip word drawn.
    expect(
      model.nodes.filter((n) => n.readiness?.state === 'independent')
    ).toHaveLength(11);
    expect(byKey(model, 'Tokens and type')?.tags).toContain('CYCLE INSIDE');
    expect(byKey(model, 'Dual-write')?.readiness?.unblocks).toBe(2);
    expect(model.readouts).toEqual({
      // Push notifications has no issues: counted apart, never complete.
      status:
        '1 clear · 3 waiting · 11 with no dependencies · 1 complete · 1 with no issues · 38 open issues: 33 can start, 5 blocked',
      risk: '3 edges on a risk chain · no cycles',
      critical:
        'Critical path: 3 milestones, each waiting on the one before: Dual-write → Search v2 beta → Tokens and type. Start with Dual-write (clear).',
    });
    expect(model.ariaSummary).toBe(
      'Milestone dependency graph: 17 milestones in 9 projects, with 3 blocking edges, 3 on a risk chain and 2 across projects; no cycles. 1 clear, 3 waiting, 11 with no dependencies, 1 complete, 1 with no issues. Critical path: 3 milestones: Dual-write, Search v2 beta, Tokens and type.'
    );
    expect(model.pathWords).toEqual({
      ...GESTURE_WORDS,
      unit: ['milestone', 'milestones'],
      waitsOn: 'Waits on {n}',
      waitsOnNone: 'Nothing outside it holds it up',
      waitsOnOutside: 'Waits on {n} outside this graph',
      unblock: 'Finishing it would clear {n}: {names}',
      next: 'Clear next',
      done: 'Complete',
    });
    expect(model.legends.status.map((i) => `${i.label} — ${i.note}`)).toEqual([
      'Clear — nothing outside it holds it up',
      'No dependencies — it neither waits on nor holds up another milestone',
      'Waiting — an open issue in it waits on another milestone',
      'Stuck — nothing inside can start: a cycle inside holds it',
      'In a cycle — they wait on each other',
      'Complete or inactive — nothing open, or a paused project',
      'Blocks — an open issue blocks one',
      'Cycle — both ends wait',
      'Cross-project — leaves its project',
      'Count — issue relations on one edge',
      'Reading — the box you point at or focus',
      'Locked — the box you click or tap: its paths stay lit, Open beside it',
      'Waits on — what the box you point at waits on',
      'Holds up — what waits on it, through box arrows',
      'Clear next — clear once it is finished',
      // The frames, last in the Nodes row: projects, the paused one hatched.
      'Project — a frame of its milestones',
      'Inactive — a hatched frame of paused work',
    ]);
    expect(model.legends.critical.map((i) => i.note)).toContain(
      'the longest chain of open blockers, counted in milestones'
    );
    expect(model.legends.critical.some((i) => i.mark === 'edge-resolved')).toBe(
      false
    );
  });

  test('the box panel: Readiness and Open issues, toned by where the box stands', () => {
    const model = page({ level: 'milestone' });
    const rows = (id: string) =>
      model.details[id]?.properties.filter(
        (p) => p.label === 'Readiness' || p.label === 'Open issues'
      );
    expect(rows('ms-beacon-1')).toEqual([
      {
        label: 'Readiness',
        value: 'Waiting on 1 milestone: Dual-write',
        tone: 'warning',
      },
      { label: 'Open issues', value: '4 open · 3 can start · 1 blocked' },
    ]);
    expect(rows('ms-juniper-1')).toEqual([
      {
        label: 'Readiness',
        value:
          'Waiting on 1 milestone: Search v2 beta. None of its open issues can start: a cycle inside holds some of them',
        tone: 'danger',
      },
      { label: 'Open issues', value: '3 open · 0 can start · 3 blocked' },
    ]);
    expect(rows('ms-atlas-2')?.[0]).toEqual({
      label: 'Readiness',
      value: 'Clear: nothing outside it holds it up',
      tone: 'success',
    });
    // The rows follow Progress, before the risk reasons.
    expect(
      model.details['ms-beacon-1']?.properties.map((p) => p.label)
    ).toEqual(expect.arrayContaining(['Progress', 'Readiness', 'Open issues']));
    const labels =
      model.details['ms-beacon-1']?.properties.map((p) => p.label) ?? [];
    expect(labels.indexOf('Readiness')).toBe(labels.indexOf('Progress') + 1);
    const initiative = page({ level: 'initiative' }).details['init-platform'];
    expect(
      initiative?.properties.find((p) => p.label === 'Open issues')?.value
    ).toMatch(/^20 open · 16 can start · 4 blocked/);
  });

  test('/graph?level=initiative: a box cycle stays amber and is worded as box arrows', () => {
    const model = page({ level: 'initiative' });
    expect(
      model.nodes.map((n) => [n.label, n.readiness?.label, n.readiness?.tone])
    ).toEqual([
      ['Platform reliability', 'Waiting on 1', 'warning'],
      ['Customer growth', 'Waiting on 1', 'warning'],
      ['No initiative', 'No dependencies', 'default'],
    ]);
    expect(model.readouts.critical).toBe(
      'Critical path: 2 initiatives: Platform reliability + Customer growth. It runs through boxes that wait on each other (Platform reliability and Customer growth); the Issues level shows whether their issues form a real cycle.'
    );
    expect(model.readouts.critical).not.toContain('cannot finish');
    expect(model.readouts.status).toBe(
      '2 waiting · 1 with no dependencies · 41 open issues: 36 can start, 5 blocked'
    );
    expect(model.readouts.risk).toBe('no risk chains · 1 cycle');
  });

  test('/graph?project=proj-juniper: the deadlock is stuck and the path runs through it', () => {
    const model = page({ level: 'issue', projectId: 'proj-juniper' });
    for (const key of ['ENG-70', 'ENG-71']) {
      const n = byKey(model, key);
      expect([n?.readiness?.label, n?.readiness?.tone, n?.tags]).toEqual([
        'Blocked by 1',
        'danger',
        ['CYCLE'],
      ]);
      expect(n?.readiness?.unblocks).toBe(1);
    }
    expect(model.readouts.critical).toBe(
      'Critical path: 2 issues: ENG-70 + ENG-71. It runs through a cycle (ENG-70 and ENG-71 wait on each other), so it cannot finish until the cycle is broken.'
    );
    expect(model.readouts.status).toBe('4 blocked · 2 with no dependencies');
  });

  test('the server names the critical path the canvas draws, on every level', () => {
    const scopes: GraphScope[] = [
      { level: 'initiative' },
      { level: 'project' },
      { level: 'milestone' },
      { level: 'issue' },
      { level: 'project', initiativeId: 'init-growth' },
      { level: 'milestone', initiativeId: 'init-platform' },
      { level: 'issue', initiativeId: 'init-platform' },
      { level: 'milestone', projectId: 'proj-atlas' },
      { level: 'issue', projectId: 'proj-juniper' },
      { level: 'issue', milestoneId: 'ms-atlas-2' },
      { level: 'issue', issueId: 'ENG-23' },
    ];
    for (const scope of scopes) {
      const model = page(scope);
      const chain = longestChain(
        longestChains(model.nodes, model.edges),
        model.focusId
      );
      const ids = model.nodes.map((n) => n.id);
      const classLine = (model.mermaid?.styles.critical ?? '')
        .split('\n')
        .find((line) => line.endsWith(' critical'));
      const named =
        classLine
          ?.trim()
          .split(' ')[1]
          ?.split(',')
          .map((n) => ids[Number(n.slice(1))]) ?? [];
      expect([...named].sort(), JSON.stringify(scope)).toEqual(
        [...(chain?.nodeIds ?? [])].sort()
      );
      if (chain !== null) {
        expect(model.ariaSummary, JSON.stringify(scope)).toContain(
          'Critical path: '
        );
      }
    }
  });

  test('Mermaid: one body for every highlight, its styles per highlight', () => {
    const model = page({ level: 'issue', issueId: 'ENG-23' });
    const mermaid = model.mermaid;
    expect(mermaid?.body.split('\n').slice(0, 4)).toEqual([
      'flowchart LR',
      '  n0["Typo tolerance<br/>ENG-23 · Dev Patel · Blocked by 1"]',
      '  n1["Reconcile dual-write drift<br/>ENG-12 · Unassigned · Ready"]',
      '  n2["Brand review sign-off<br/>OPS-20 · Grace Lin · Blocked by 1"]',
    ]);
    expect(mermaid?.styles.status).toContain('  class n1 ready\n');
    expect(mermaid?.styles.risk).toContain('  linkStyle 0,1 stroke:#bd790a\n');
    expect(mermaid?.styles.critical).toBe(
      [
        '  %% Critical path: n1 → n0 → n2 (3 issues)',
        '  classDef critical stroke-width:3px',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  classDef focus stroke-width:3px',
        '  class n0,n1,n2 critical',
        '  class n0 focus',
        '  linkStyle 0,1 stroke-width:3px',
        '',
      ].join('\n')
    );
    // The selection purple is never a status, in any export.
    for (const style of Object.values(mermaid?.styles ?? {})) {
      expect(style).not.toContain('#9747ff');
    }
  });

  test('path words per level', () => {
    expect(pathWordsFor('issue')).toEqual({
      unit: ['issue', 'issues'],
      ...GESTURE_WORDS,
    });
    expect(pathWordsFor('project').unit).toEqual(['project', 'projects']);
    expect(pathWordsFor('initiative').next).toBe('Clear next');
  });

  test('nothing drawn: no readouts, no Mermaid; the legends are still there', () => {
    const model = page({ level: 'issue', milestoneId: 'ms-garnet-2' });
    expect(model.readouts).toEqual({ status: '', risk: '', critical: '' });
    expect(model.mermaid).toBeNull();
    expect(model.legends.status.length).toBeGreaterThan(0);
  });
});

describe('review fixes: empty boxes, paused arrows, blockers with no box', () => {
  const data = createFixtureWorkspace(TODAY);

  test('a milestone with no issues reads "No issues", never "Complete"', () => {
    const model = fixture().page({ level: 'milestone' });
    // Push notifications (ms-garnet-2) has no issue in the mirror.
    expect(
      model.nodes.find((n) => n.id === 'ms-garnet-2')?.readiness?.state
    ).toBe('empty');
    expect(
      model.details['ms-garnet-2']?.properties.filter((p) =>
        ['Readiness', 'Open issues'].includes(p.label)
      )
    ).toEqual([
      { label: 'Readiness', value: 'No issues', tone: 'default' },
      { label: 'Open issues', value: 'None open' },
    ]);
    // Schema cutover is done: it has issues, none open.
    expect(
      model.details['ms-atlas-1']?.properties.find(
        (p) => p.label === 'Readiness'
      )?.value
    ).toBe('Complete');
    expect(model.readouts.status).toContain('1 complete · 1 with no issues');
  });

  test('blockers with no milestone are counted as issues, apart from the milestones', () => {
    // ENG-18 (Atlas) and ENG-54 (Garnet) have no milestone; both now block
    // ENG-16 in Read path switch, which already waits on Dual-write.
    const model = fixture({
      ...data,
      relations: [
        ...data.relations,
        { id: 'rel-x1', blockerId: 'iss-eng-18', blockedId: 'iss-eng-16' },
        { id: 'rel-x2', blockerId: 'iss-eng-54', blockedId: 'iss-eng-16' },
      ],
    }).page({ level: 'milestone' });
    expect(
      model.details['ms-atlas-3']?.properties.find(
        (p) => p.label === 'Readiness'
      )
    ).toEqual({
      label: 'Readiness',
      value:
        'Waiting on 1 milestone: Dual-write, and 2 issues with no milestone',
      tone: 'warning',
    });
  });

  test('a relation between two paused projects is an arrow between their drawn boxes', () => {
    // Harbor paused too; Dashboards (paused Fjord) now blocks Public beta.
    const model = fixture({
      ...data,
      projects: data.projects.map((p) =>
        p.id === 'proj-harbor' ? { ...p, statusType: 'paused' } : p
      ),
      relations: [
        ...data.relations,
        { id: 'rel-x3', blockerId: 'iss-ops-8', blockedId: 'iss-eng-60' },
      ],
    }).page({ level: 'milestone' });
    expect(model.edges.map((e) => `${e.from}>${e.to}`)).toContain(
      'ms-fjord-1>ms-harbor-1'
    );
    // Its blocker is drawn, so nothing says "not drawn" or "outside".
    expect(
      model.details['ms-harbor-1']?.properties.find(
        (p) => p.label === 'Readiness'
      )?.value
    ).toBe('Waiting on 1 milestone: Dashboards');
  });
});
