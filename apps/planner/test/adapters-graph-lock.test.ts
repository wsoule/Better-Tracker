import {
  assessWorkspace,
  buildDependencyGraph,
  DEFAULT_TUNING,
  type EvalContext,
  type GraphScope,
  indexWorkspace,
  type MilestoneMeta,
  NO_INITIATIVE_ID,
  planAllocation,
  type Snapshot,
  type WorkspaceData,
} from '@better-tracker/core';
import {
  createFixtureWorkspace,
  createShowcaseWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';
import type { GraphNodeData } from '@better-tracker/ui';
import { describe, expect, test } from 'bun:test';

import {
  addressHref,
  buildGraphPage,
  carryHighlight,
  carryLock,
  lockedNodeId,
  lockParam,
  parseLockParam,
  scopeQuery,
  withLockParam,
} from '../lib/adapters/graph';
import { DrillSizes, drillTargets } from '../lib/adapters/graph-drill';
import { GRAPH_DRAW_LIMITS } from '../lib/adapters/graph-scope';

// Lock on and drill down (owner request 2026-10-23; architecture §8.4
// Graph "Lock on", "Drill down"): ?lock= read, written in place, carried
// on the graph's own links and dropped when the box is not drawn; each
// box's and frame's drill-down graph one level down, with the panel's
// next link when that graph is empty or past the draw limits; and the
// drill-down sizes counted exactly as core builds those graphs.

const TODAY = '2026-10-21';

/** A workspace through core's real graph builder, as the page builds it. */
function workspace(data: WorkspaceData) {
  const snapshot = indexWorkspace(data);
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
  const page = (scope: GraphScope) =>
    buildGraphPage({
      graph: graphOf(scope),
      snapshot,
      assessments,
      allocationPlan,
      today: TODAY,
    });
  return { snapshot, graphOf, page };
}

const demo = workspace(createFixtureWorkspace(TODAY));

/** Each drawn box's drill-down, by id (absent: none). */
function drills(model: { nodes: GraphNodeData[] }): Record<string, string> {
  return Object.fromEntries(
    model.nodes.flatMap((n) =>
      n.drillHref === undefined ? [] : [[n.id, n.drillHref]]
    )
  );
}

describe('?lock= in the URL', () => {
  test('withLockParam replaces in place, appends, drops repeats and removes', () => {
    expect(withLockParam('/graph', 'ENG-23')).toBe('/graph?lock=ENG-23');
    expect(withLockParam('/graph?level=issue', 'ENG-23')).toBe(
      '/graph?level=issue&lock=ENG-23'
    );
    // In place, every other parameter kept with its own encoding.
    expect(
      withLockParam('/graph?lock=A&issue=ENG-23&q=a%20b&lock=B#top', 'ms 1')
    ).toBe('/graph?lock=ms%201&issue=ENG-23&q=a%20b#top');
    expect(
      withLockParam('/graph?level=issue&lock=A&highlight=risk', null)
    ).toBe('/graph?level=issue&highlight=risk');
    expect(withLockParam('/graph?lock=A', null)).toBe('/graph');
  });

  test('parseLockParam: first value, trimmed; blank or too long is none', () => {
    expect(parseLockParam(' ENG-23 ')).toBe('ENG-23');
    expect(parseLockParam(['a', 'b'])).toBe('a');
    expect(parseLockParam('')).toBeNull();
    expect(parseLockParam(null)).toBeNull();
    expect(parseLockParam('x'.repeat(201))).toBeNull();
  });

  test('the address bar writes the lock before the highlight, or drops it', () => {
    expect(
      addressHref('/graph?chain=ENG-23', 'critical', 'status', 'ENG-12')
    ).toBe('/graph?chain=ENG-23&lock=ENG-12&highlight=critical');
    // A lock moved keeps its place; the highlight stays last.
    expect(
      addressHref(
        '/graph?chain=ENG-23&lock=ENG-12&issue=ENG-12&highlight=critical',
        'critical',
        'status',
        'OPS-20'
      )
    ).toBe('/graph?chain=ENG-23&lock=OPS-20&issue=ENG-12&highlight=critical');
    // Unlocked (or a box that is not drawn): dropped.
    expect(
      addressHref('/graph?level=issue&lock=nope', 'status', 'status', null)
    ).toBe('/graph?level=issue');
    // undefined leaves ?lock= as it is (callers that know nothing of it).
    expect(addressHref('/graph?lock=A', 'status', 'status')).toBe(
      '/graph?lock=A'
    );
  });

  test('the graph links the screen draws carry the lock; others do not', () => {
    expect(
      carryLock('/graph?project=proj-atlas&level=milestone', 'ms-atlas-2')
    ).toBe('/graph?project=proj-atlas&level=milestone&lock=ms-atlas-2');
    expect(carryLock('/graph', 'ENG-23')).toBe('/graph?lock=ENG-23');
    expect(carryLock('/issues?milestone=ms-atlas-2', 'ENG-23')).toBe(
      '/issues?milestone=ms-atlas-2'
    );
    expect(carryLock('/graphs', 'ENG-23')).toBe('/graphs');
    expect(carryLock('/graph?level=issue', null)).toBe('/graph?level=issue');
    // As the screen composes them: the lock, then the mode.
    expect(
      carryHighlight(
        carryLock('/graph?level=issue', 'ENG-23'),
        'risk',
        'status'
      )
    ).toBe('/graph?level=issue&lock=ENG-23&highlight=risk');
  });

  test('scopeQuery keeps the scope, leaving out the view parameters', () => {
    expect(
      scopeQuery('level=issue&lock=ENG-23&issue=ENG-23&highlight=risk')
    ).toBe('level=issue');
    expect(
      scopeQuery('?project=proj-atlas&node=ms-atlas-2&level=milestone')
    ).toBe('project=proj-atlas&level=milestone');
    expect(scopeQuery('lock=ms-beacon-1')).toBe('');
    expect(scopeQuery('')).toBe('');
    // The island tells its own page from one it is leaving for by it.
    expect(scopeQuery('milestone=ms-beacon-1')).not.toBe(
      scopeQuery('lock=ms-beacon-1')
    );
  });

  test('the box a lock names: by id, an issue by its key in any case, else none', () => {
    const model = demo.page({ level: 'issue', milestoneId: 'ms-beacon-1' });
    expect(lockedNodeId(model.nodes, 'iss-eng-23')).toBe('iss-eng-23');
    expect(lockedNodeId(model.nodes, 'ENG-23')).toBe('iss-eng-23');
    expect(lockedNodeId(model.nodes, 'eng-23')).toBe('iss-eng-23');
    // Not drawn here (another milestone's issue), unknown, or none.
    expect(lockedNodeId(model.nodes, 'ENG-60')).toBeNull();
    expect(lockedNodeId(model.nodes, 'nope')).toBeNull();
    expect(lockedNodeId(model.nodes, null)).toBeNull();
    // Written back as the key for an issue, the id for any other box.
    expect(lockParam(model.nodes, 'iss-eng-23')).toBe('ENG-23');
    expect(lockParam(model.nodes, 'not-drawn')).toBeNull();
    expect(lockParam(model.nodes, null)).toBeNull();
    const milestones = demo.page({ level: 'milestone' });
    expect(lockParam(milestones.nodes, 'ms-beacon-1')).toBe('ms-beacon-1');
    expect(lockedNodeId(milestones.nodes, 'ms-beacon-1')).toBe('ms-beacon-1');
  });
});

describe('drill down: each box’s own graph, one level down', () => {
  test('an initiative opens its projects', () => {
    expect(drills(demo.page({ level: 'initiative' }))).toEqual({
      'init-platform': '/graph?initiative=init-platform',
      'init-growth': '/graph?initiative=init-growth',
      none: '/graph?initiative=none',
    });
  });

  test('a project opens its milestones', () => {
    const model = demo.page({ level: 'project' });
    const all = drills(model);
    expect(all['proj-atlas']).toBe('/graph?project=proj-atlas&level=milestone');
    expect(all['proj-garnet']).toBe(
      '/graph?project=proj-garnet&level=milestone'
    );
    expect(Object.keys(all)).toHaveLength(model.nodes.length);
  });

  test('a milestone opens its issues; one with no issues its project’s milestones', () => {
    const all = drills(demo.page({ level: 'milestone' }));
    expect(all['ms-beacon-1']).toBe('/graph?milestone=ms-beacon-1');
    expect(all['ms-atlas-2']).toBe('/graph?milestone=ms-atlas-2');
    // Push notifications has no issue: its panel's next link, with it
    // selected there.
    expect(all['ms-garnet-2']).toBe(
      '/graph?project=proj-garnet&level=milestone&node=ms-garnet-2'
    );
  });

  test('an issue opens its blocking chain; one on no relation its milestone’s issues', () => {
    const model = demo.page({ level: 'issue' });
    const all = drills(model);
    expect(all['iss-eng-23']).toBe('/graph?chain=ENG-23');
    expect(all['iss-eng-12']).toBe('/graph?chain=ENG-12');
    // ENG-24 waits on nothing and blocks nothing.
    expect(all['iss-eng-24']).toBe('/graph?milestone=ms-beacon-1');
    // An issue in no milestone, on no relation: nowhere to go.
    expect(all['iss-eng-80']).toBeUndefined();
    // Inside its milestone's own graph the fallback is the page itself.
    const own = drills(
      demo.page({ level: 'issue', milestoneId: 'ms-beacon-1' })
    );
    expect(own['iss-eng-23']).toBe('/graph?chain=ENG-23');
    expect(own['iss-eng-24']).toBeUndefined();
  });

  test('in a chain, the focus opens its milestone’s issues, the rest their own chains', () => {
    const all = drills(demo.page({ level: 'issue', issueId: 'ENG-23' }));
    expect(all['iss-eng-23']).toBe('/graph?milestone=ms-beacon-1');
    expect(all['iss-eng-12']).toBe('/graph?chain=ENG-12');
    expect(all['iss-ops-20']).toBe('/graph?chain=OPS-20');
  });

  test('frame titles open what they stand for at the level drawn', () => {
    const issues = demo.page({ level: 'issue' });
    const frames = Object.fromEntries(
      issues.clusters.map((c) => [c.id, c.drillHref ?? null])
    );
    // A milestone frame: its issues.
    expect(frames['milestone:ms-beacon-1']).toBe(
      '/graph?milestone=ms-beacon-1'
    );
    // A project frame around issues: the project's issues (the level kept).
    expect(frames['project:proj-atlas']).toBe('/graph?project=proj-atlas');
    // "No milestone": its project's issues; "No project": nowhere.
    expect(frames['milestone:none:proj-atlas']).toBe(
      '/graph?project=proj-atlas'
    );
    expect(frames['project:none']).toBeNull();
    // A project frame around milestones: its milestones.
    const milestones = demo.page({ level: 'milestone' });
    expect(
      milestones.clusters.find((c) => c.id === 'project:proj-beacon')?.drillHref
    ).toBe('/graph?project=proj-beacon&level=milestone');
    // An initiative frame around projects: its projects.
    const projects = demo.page({ level: 'project' });
    expect(
      projects.clusters.find((c) => c.id === 'initiative:init-growth')
        ?.drillHref
    ).toBe('/graph?initiative=init-growth');
  });

  test('nothing is drawn, nothing drills', () => {
    const model = demo.page({ level: 'issue', milestoneId: 'ms-garnet-2' });
    expect(model.nodes).toEqual([]);
    expect(model.clusters).toEqual([]);
  });
});

describe('drill down past the draw limits', () => {
  /** The demo with `extra` more open issues in Dual-write (ms-atlas-2). */
  function crowded(extra: number) {
    const data = createFixtureWorkspace(TODAY);
    const model = data.issues.find((issue) => issue.id === 'iss-eng-13');
    if (model === undefined) throw new Error('iss-eng-13');
    for (let i = 0; i < extra; i++) {
      data.issues.push({
        ...model,
        id: `iss-extra-${i}`,
        identifier: `XTR-${i}`,
        title: `Extra ${i}`,
      });
    }
    return workspace(data);
  }

  test('a milestone too big to draw opens its project’s milestones instead', () => {
    const big = crowded(GRAPH_DRAW_LIMITS.nodes);
    const all = drills(big.page({ level: 'milestone' }));
    expect(all['ms-atlas-2']).toBe(
      '/graph?project=proj-atlas&level=milestone&node=ms-atlas-2'
    );
    expect(all['ms-atlas-1']).toBe('/graph?milestone=ms-atlas-1');
  });

  test('with no other way that draws, the too-large page itself (it lists narrower graphs)', () => {
    const big = crowded(GRAPH_DRAW_LIMITS.nodes);
    // In Atlas's own milestone graph the fallback would be this page.
    const all = drills(
      big.page({ level: 'milestone', projectId: 'proj-atlas' })
    );
    expect(all['ms-atlas-2']).toBe('/graph?milestone=ms-atlas-2');
  });
});

/** Every graph a drill-down can open in `snapshot`, with its scope. */
function drillScopes(snapshot: Snapshot): GraphScope[] {
  const scopes: GraphScope[] = [];
  for (const id of snapshot.milestones.keys()) {
    scopes.push({ level: 'issue', milestoneId: id });
  }
  for (const id of snapshot.projects.keys()) {
    scopes.push({ level: 'issue', projectId: id });
    scopes.push({ level: 'milestone', projectId: id });
  }
  for (const id of [...snapshot.initiatives.keys(), NO_INITIATIVE_ID]) {
    for (const level of ['issue', 'milestone', 'project'] as const) {
      scopes.push({ level, initiativeId: id });
    }
  }
  return scopes;
}

describe('drill-down sizes count what core draws', () => {
  for (const [name, data] of [
    ['the demo', createFixtureWorkspace(TODAY)],
    ['the showcase', createShowcaseWorkspace(TODAY)],
  ] as const) {
    test(`${name}: every container's boxes and arrows, and every chain`, () => {
      const { snapshot, graphOf } = workspace(data);
      const sizes = new DrillSizes(snapshot);
      const wrong: string[] = [];
      for (const scope of drillScopes(snapshot)) {
        const graph = graphOf(scope);
        const want = { nodes: graph.nodes.length, edges: graph.edges.length };
        const got = sizes.sizeOf(scope);
        if (got?.nodes !== want.nodes || got.edges !== want.edges) {
          wrong.push(
            `${JSON.stringify(scope)}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`
          );
        }
      }
      for (const issue of snapshot.issues.values()) {
        const draws =
          graphOf({ level: 'issue', issueId: issue.id }).edges.length > 0;
        if (sizes.hasChain(issue.id) !== draws) {
          wrong.push(`chain ${issue.identifier}: ${!draws}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  test('drillTargets never offers the page itself', () => {
    const { snapshot, graphOf } = workspace(createShowcaseWorkspace(TODAY));
    for (const scope of [
      { level: 'milestone' } as GraphScope,
      { level: 'project' } as GraphScope,
      { level: 'initiative' } as GraphScope,
    ]) {
      const graph = graphOf(scope);
      const page = '/graph?level=x';
      const { nodes, clusters } = drillTargets({
        snapshot,
        nodes: graph.nodes,
        clusters: graph.clusters,
        level: scope.level,
        pageHref: page,
      });
      expect([...nodes.values(), ...clusters.values()]).not.toContain(page);
      expect(nodes.size).toBeGreaterThan(0);
    }
  });
});
