import {
  assessWorkspace,
  buildDependencyGraph,
  DEFAULT_TUNING,
  type EvalContext,
  type GraphEdge,
  type GraphNode,
  type GraphScope,
  indexWorkspace,
  type MilestoneMeta,
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
  graphHref,
  ISOLATED_COLLAPSE_AFTER,
  isolatedNodeIds,
  issueMark,
  levelTabs,
  listPhrase,
  nodeTags,
  nodeTone,
  parseGraphScope,
} from '../lib/adapters/graph';

// Unit tables for the small mappings, then the whole page built from the
// demo workspace through core's real graph builder (the same path the
// page takes), so counts, cycles and links are checked against real data.

const TODAY = '2026-10-21';

function fixture() {
  const snapshot = indexWorkspace(createFixtureWorkspace(TODAY));
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
  const page = (scope: GraphScope, keep?: string[]) =>
    buildGraphPage({
      graph: buildDependencyGraph(snapshot, ctx, assessments, scope),
      snapshot,
      assessments,
      today: TODAY,
      keep,
    });
  return { snapshot, page };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    kind: 'issue',
    label: 'Backfill orders',
    sublabel: 'ENG-1 · Ana Moreno',
    url: 'https://linear.app/x/issue/ENG-1',
    projectId: 'p1',
    milestoneId: 'm1',
    ownerId: 'u1',
    external: false,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
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
      expect(detail?.issuesHref).toBe(
        `/graph?milestone=${encodeURIComponent(n.id)}`
      );
      expect(detail?.links.map((l) => l.label)).toContain(
        'Open on the timeline'
      );
    }
    expect(model.mermaid.startsWith('flowchart LR\n')).toBe(true);
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
    expect(model.scopeLabel).toBe('Dual-write');
    const external = model.nodes.filter((n) => n.external === true);
    expect(external.length).toBeGreaterThan(0);
    for (const n of model.nodes) {
      const detail = model.details[n.id];
      expect(detail?.kind).toBe('issue');
      const linear = detail?.links.find((l) => l.label === 'Open in Linear');
      expect(linear?.external).toBe(true);
      expect(linear?.href).toBe(snapshot.issues.get(n.id)?.url);
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
    const nodeLines = model.mermaid
      .split('\n')
      .filter((line) => /^ {2}n\d+\["/.test(line));
    expect(nodeLines).toHaveLength(model.nodes.length);
  });

  test('a kept node is drawn even without an edge', () => {
    const plain = page({ level: 'milestone' });
    const first = plain.isolated?.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const kept = page({ level: 'milestone' }, [first.id]);
    expect(kept.nodes.some((n) => n.id === first.id)).toBe(true);
    expect(kept.isolated?.rows.some((r) => r.id === first.id)).toBe(false);
  });

  test('issue level lists unrelated issues, opening them in Linear', () => {
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
      expect(row.href).toBe(issue?.url ?? '');
      expect(row.external).toBe(true);
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

describe('levelTabs', () => {
  test('milestone level waits for a selection, then links to its issues', () => {
    const model = {
      level: 'milestone' as const,
      scopeLabel: null,
      scopeHref: '/graph',
    };
    const idle = levelTabs(model, null);
    expect(idle[0]).toMatchObject({ href: '/graph', current: true });
    expect(idle[1]?.href).toBeUndefined();
    expect(idle[1]?.note).toBe('select a milestone');
    const picked = levelTabs(model, {
      issuesHref: '/graph?milestone=m1',
      issuesLabel: 'Issues in Dual-write',
    });
    expect(picked[1]).toMatchObject({
      label: 'Issues in Dual-write',
      href: '/graph?milestone=m1',
    });
  });

  test('issue level marks the scope tab current', () => {
    const tabs = levelTabs(
      { level: 'issue', scopeLabel: 'Atlas', scopeHref: '/graph?project=p' },
      null
    );
    expect(tabs[0]?.current).toBe(false);
    expect(tabs[1]).toMatchObject({
      label: 'Issues in Atlas',
      href: '/graph?project=p',
      current: true,
    });
  });
});
