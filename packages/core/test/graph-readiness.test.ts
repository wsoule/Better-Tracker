// Readiness (architecture §2.10 "Readiness"): whether each graph node can
// start, how many open blockers hold it up, what finishing it alone would
// free, and whether an edge still blocks. Facts are mirror-wide (the
// viewer's whole snapshot), never limited to what one graph draws.

import { describe, expect, test } from 'bun:test';

import { readinessClass, readinessLabel } from '../src/index';
import type { GraphNode, GraphScope } from '../src/index';
import {
  at,
  blocks,
  CROSS,
  CYCLES,
  edge,
  graph,
  type GraphParts,
  inM1,
  LEVELS,
  M1,
  node,
} from './graph-fixtures';
import { initiative, milestone, project, STATE } from './helpers';

// The five readiness fields of a node, for compact assertions.
function readinessOf(n: GraphNode): Record<string, unknown> {
  return {
    readiness: n.readiness,
    blockedBy: n.blockedBy,
    unblocks: n.unblocks,
    openIssues: n.openIssues,
    readyIssues: n.readyIssues,
  };
}

const READY_ISSUE = {
  readiness: 'ready',
  blockedBy: 0,
  unblocks: 0,
  openIssues: 1,
  readyIssues: 1,
};

const DONE_ISSUE = {
  readiness: 'done',
  blockedBy: 0,
  unblocks: 0,
  openIssues: 0,
  readyIssues: 0,
};

const MILESTONES: GraphScope = { level: 'milestone' };

// Nodes sorted by id, for assertions that do not depend on display order.
function byId(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => a.id.localeCompare(b.id));
}

describe('issue readiness', () => {
  test('ready with no blocker, and with only a closed blocker', () => {
    const g = graph(
      {
        issues: [inM1('A'), inM1('B', { stateId: STATE.done }), inM1('C')],
        relations: blocks(['B', 'C']),
      },
      M1
    );
    expect(readinessOf(node(g, 'A'))).toEqual(READY_ISSUE);
    expect(readinessOf(node(g, 'C'))).toEqual(READY_ISSUE);
    expect(readinessOf(node(g, 'B'))).toEqual(DONE_ISSUE);
    expect(readinessLabel(node(g, 'C'))).toBe('Ready');
    expect(edge(g, 'B', 'C')).toMatchObject({
      resolved: true,
      blocking: false,
    });
  });

  test('distinct open blockers: a repeated relation counts once', () => {
    const g = graph(
      {
        issues: [inM1('X'), inM1('Y'), inM1('W'), inM1('V')],
        relations: blocks(
          ['X', 'W'],
          ['X', 'W'],
          ['Y', 'W'],
          ['X', 'V'],
          ['X', 'V']
        ),
      },
      M1
    );
    expect(readinessOf(node(g, 'W'))).toEqual({
      readiness: 'blocked',
      blockedBy: 2,
      unblocks: 0,
      openIssues: 1,
      readyIssues: 0,
    });
    expect(readinessLabel(node(g, 'W'))).toBe('Blocked by 2');
    expect(node(g, 'V').blockedBy).toBe(1);
    // X alone holds up V, not W (Y holds W up too).
    expect(node(g, 'X').unblocks).toBe(1);
    expect(node(g, 'Y').unblocks).toBe(0);
    expect(g.edges.every((e) => e.blocking)).toBe(true);
  });

  test('done when completed or canceled, whatever still blocks it', () => {
    const g = graph(
      {
        issues: [
          inM1('O'),
          inM1('D', { stateId: STATE.done }),
          inM1('K', { stateId: STATE.canceled }),
          inM1('U', { stateId: STATE.duplicate }),
        ],
        relations: blocks(['O', 'D'], ['O', 'K'], ['O', 'U']),
      },
      M1
    );
    for (const id of ['D', 'K', 'U']) {
      expect(readinessOf(node(g, id))).toEqual(DONE_ISSUE);
      expect(readinessLabel(node(g, id))).toBe('');
      // An open blocker into a closed issue no longer blocks.
      expect(edge(g, 'O', id)).toMatchObject({
        resolved: false,
        blocking: false,
      });
    }
    // O blocks only closed issues: finishing it frees nothing.
    expect(readinessOf(node(g, 'O'))).toEqual(READY_ISSUE);
  });

  test('blockers count even when they are not drawn: a chain side blocker', () => {
    // F's chain walks F → D but not D's side blocker SB.
    const g = graph(
      {
        issues: [inM1('F'), inM1('D'), inM1('SB')],
        relations: blocks(['F', 'D'], ['SB', 'D']),
      },
      { level: 'issue', issueId: 'F' }
    );
    expect(g.nodes.map((n) => n.id)).toEqual(['F', 'D']);
    expect(node(g, 'D')).toMatchObject({ readiness: 'blocked', blockedBy: 2 });
    expect(node(g, 'F').unblocks).toBe(0);
  });
});

describe('CYCLES: loops, a self-loop and a loop through a closed issue', () => {
  const g = graph(CYCLES, M1);

  test('everything on or behind an open loop is blocked; a self-loop blocks itself', () => {
    for (const id of ['C-1', 'C-2', 'C-3', 'D-1', 'S-1']) {
      expect(node(g, id).readiness).toBe('blocked');
      expect(node(g, id).blockedBy).toBe(1);
    }
    expect(readinessLabel(node(g, 'S-1'))).toBe('Blocked by 1');
    expect(readinessOf(node(g, 'E-2'))).toEqual(READY_ISSUE);
    expect(readinessOf(node(g, 'E-1'))).toEqual(DONE_ISSUE);
  });

  test('unblocks is exact inside loops and never counts the issue itself', () => {
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.unblocks]))).toEqual({
      'C-1': 1, // C-2
      'C-2': 1, // C-3
      'C-3': 2, // C-1 and D-1
      'D-1': 0,
      'S-1': 0, // it never unblocks itself
      'E-1': 0,
      'E-2': 0, // E-1 is closed
    });
  });

  test('blocking needs both ends open', () => {
    expect(edge(g, 'E-2', 'E-1')).toMatchObject({
      resolved: false,
      blocking: false,
    });
    expect(edge(g, 'E-1', 'E-2')).toMatchObject({
      resolved: true,
      blocking: false,
    });
    expect(
      g.edges
        .filter((e) => e.blocking)
        .map((e) => `${e.from}>${e.to}`)
        .sort()
    ).toEqual(['C-1>C-2', 'C-2>C-3', 'C-3>C-1', 'C-3>D-1', 'S-1>S-1']);
  });

  test('loop members are stuck; an issue behind a loop is only blocked', () => {
    expect(
      Object.fromEntries(g.nodes.map((n) => [n.id, readinessClass(n)]))
    ).toEqual({
      'C-1': 'stuck',
      'C-2': 'stuck',
      'C-3': 'stuck',
      'D-1': 'blocked',
      'S-1': 'stuck',
      'E-1': 'quiet',
      'E-2': 'ready',
    });
  });
});

describe('CROSS: externals carry their mirror-wide facts', () => {
  const g = graph(CROSS, M1);

  test('an external waits on a blocker the graph does not draw', () => {
    // H-1 waits on H-4, two hops from m1.
    expect(node(g, 'H-1')).toMatchObject({
      external: true,
      readiness: 'blocked',
      blockedBy: 1,
      unblocks: 1, // O-1
    });
    expect(g.nodes.some((n) => n.id === 'H-4')).toBe(false);
    expect(g.edges.some((e) => e.to === 'H-1')).toBe(false);
  });

  test('two blockers: neither alone frees it', () => {
    expect(node(g, 'O-3').blockedBy).toBe(2);
    expect(node(g, 'H-3').unblocks).toBe(0);
    expect(node(g, 'O-2').unblocks).toBe(0);
    expect(node(g, 'O-1')).toMatchObject({
      readiness: 'blocked',
      blockedBy: 1,
      unblocks: 1, // N-1
    });
  });

  test('an issue reads the same in every graph that draws it', () => {
    const inside = graph(CROSS, { level: 'issue', milestoneId: 'm2' });
    const own = graph(CROSS, { level: 'issue', issueId: 'H-1' });
    expect(readinessOf(node(inside, 'H-1'))).toEqual(
      readinessOf(node(g, 'H-1'))
    );
    expect(readinessOf(node(own, 'H-1'))).toEqual(readinessOf(node(g, 'H-1')));
  });
});

describe('LEVELS: milestones in the workspace', () => {
  const g = graph(LEVELS, MILESTONES);

  test('a clear box frees the box it alone holds up', () => {
    expect(readinessOf(node(g, 'mB'))).toEqual({
      readiness: 'ready',
      blockedBy: 0,
      unblocks: 1, // mA
      openIssues: 2,
      readyIssues: 2,
    });
    expect(readinessLabel(node(g, 'mB'))).toBe('Clear');
  });

  test('a waiting box still holds ready issues of its own', () => {
    // a3's blocker b3 is closed; a1 and a2 wait on mB (Bravo) (a2 also on
    // a1, inside the box, which does not count).
    expect(readinessOf(node(g, 'mA'))).toEqual({
      readiness: 'blocked',
      blockedBy: 1,
      unblocks: 0,
      openIssues: 3,
      readyIssues: 1,
    });
    expect(readinessLabel(node(g, 'mA'))).toBe('Waiting on 1');
    expect(readinessClass(node(g, 'mA'))).toBe('blocked');
    expect(node(g, 'mC')).toMatchObject({ readiness: 'blocked', blockedBy: 2 });
  });

  test('facts are mirror-wide: mP frees mP2, which this graph does not draw', () => {
    expect(node(g, 'mP').unblocks).toBe(1);
    expect(g.nodes.some((n) => n.id === 'mP2')).toBe(false);
    // Paused work is never loud.
    expect(readinessClass(node(g, 'mP'))).toBe('quiet');
  });

  test('aggregate edges always block', () => {
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges.every((e) => e.blocking && !e.resolved)).toBe(true);
  });

  test('a unit reads the same as an external of a project container', () => {
    const alpha = graph(LEVELS, { level: 'milestone', projectId: 'pA' });
    const externals = alpha.nodes.filter((n) => n.external);
    expect(externals.map((n) => n.id).sort()).toEqual(['mB', 'mC']);
    for (const n of alpha.nodes) {
      expect(readinessOf(n)).toEqual(readinessOf(node(g, n.id)));
    }
    // mC still waits on 2 although only mA → mC is drawn here.
    expect(alpha.edges.filter((e) => e.to === 'mC').length).toBe(1);
  });

  test('an unplaced blocker makes a box wait, so its other blocker no longer frees it alone', () => {
    const parts: GraphParts = {
      ...LEVELS,
      issues: [
        ...LEVELS.issues,
        inM1('u1', { projectId: 'pA', milestoneId: null }),
      ],
      relations: [
        ...LEVELS.relations,
        { id: 'r-u1', blockerId: 'u1', blockedId: 'a1' },
      ],
    };
    const withUnplaced = graph(parts, MILESTONES);
    expect(node(withUnplaced, 'mA').blockedBy).toBe(2); // mB and u1
    expect(readinessLabel(node(withUnplaced, 'mA'))).toBe('Waiting on 2');
    expect(node(withUnplaced, 'mB').unblocks).toBe(0);
  });

  test('unplaced blockers count once each, however many issues they hold up', () => {
    // u1 blocks a1 and a2 (once), u2 blocks a2: mB, u1 and u2.
    const parts: GraphParts = {
      ...LEVELS,
      issues: [
        ...LEVELS.issues,
        inM1('u1', { projectId: 'pA', milestoneId: null }),
        inM1('u2', { projectId: 'pA', milestoneId: null }),
      ],
      relations: [
        ...LEVELS.relations,
        { id: 'r-u1-a1', blockerId: 'u1', blockedId: 'a1' },
        { id: 'r-u1-a2', blockerId: 'u1', blockedId: 'a2' },
        { id: 'r-u2-a2', blockerId: 'u2', blockedId: 'a2' },
      ],
    };
    const g = graph(parts, MILESTONES);
    expect(node(g, 'mA').blockedBy).toBe(3);
    expect(readinessLabel(node(g, 'mA'))).toBe('Waiting on 3');
    expect(node(g, 'mB').unblocks).toBe(0);
  });
});

describe('projects and initiatives', () => {
  // Shared ranks in Apex first (priority 1), so it counts toward Apex only.
  const parts: GraphParts = {
    initiatives: [
      initiative('iA', { name: 'Apex', priority: 1 }),
      initiative('iB', { name: 'Beam', priority: 2 }),
    ],
    projects: [
      project('pA', { initiativeIds: ['iA'], sortOrder: 1 }),
      project('pS', { initiativeIds: ['iB', 'iA'], sortOrder: 2 }),
      project('pB', { initiativeIds: ['iB'], sortOrder: 3 }),
    ],
    milestones: [],
    issues: [
      inM1('a', { projectId: 'pA', milestoneId: null }),
      inM1('s', { projectId: 'pS', milestoneId: null }),
      inM1('b', { projectId: 'pB', milestoneId: null }),
    ],
    relations: blocks(['a', 's'], ['s', 'b']),
  };

  test('a project in two initiatives counts once, toward its first', () => {
    const g = graph(parts, { level: 'initiative' });
    expect(readinessOf(node(g, 'iA'))).toEqual({
      readiness: 'ready',
      blockedBy: 0,
      unblocks: 1, // Beam
      openIssues: 2, // a and s
      readyIssues: 1, // a (s waits on a, inside Apex)
    });
    expect(readinessOf(node(g, 'iB'))).toEqual({
      readiness: 'blocked',
      blockedBy: 1,
      unblocks: 0,
      openIssues: 1, // b only
      readyIssues: 0,
    });
    // Nothing in Beam can start, but no cycle holds it: waiting, not stuck.
    expect(readinessClass(node(g, 'iB'))).toBe('blocked');
  });

  test('projects', () => {
    const g = graph(parts, { level: 'project' });
    expect(
      g.nodes.map((n) => [n.id, n.readiness, n.blockedBy, n.unblocks])
    ).toEqual([
      ['pA', 'ready', 0, 1],
      ['pS', 'blocked', 1, 1],
      ['pB', 'blocked', 1, 0],
    ]);
  });
});

describe('stuck boxes: nothing in them can start and a cycle inside holds them', () => {
  test('a clear box with an internal 2-cycle and nothing else', () => {
    const g = graph(
      {
        issues: [inM1('t1'), inM1('t2')],
        relations: blocks(['t1', 't2'], ['t2', 't1']),
      },
      MILESTONES
    );
    expect(readinessOf(node(g, 'm1'))).toEqual({
      readiness: 'ready',
      blockedBy: 0,
      unblocks: 0,
      openIssues: 2,
      readyIssues: 0,
    });
    expect(node(g, 'm1').holdsCycle).toBe(true);
    expect(readinessLabel(node(g, 'm1'))).toBe('None ready');
    expect(readinessClass(node(g, 'm1'))).toBe('stuck');
  });

  // t1 ⇄ t2 and t3 in m1; t3 waits on s1 in m2 and, optionally, on t1.
  function loopBox(s1Done: boolean, t3WaitsOnT1: boolean): GraphNode {
    const relations = blocks(
      ['t1', 't2'],
      ['t2', 't1'],
      ['s1', 't3'],
      ...(t3WaitsOnT1 ? [['t1', 't3'] as [string, string]] : [])
    );
    const g = graph(
      {
        milestones: [milestone('m1', 'p1'), milestone('m2', 'p1')],
        issues: [
          inM1('t1'),
          inM1('t2'),
          inM1('t3'),
          inM1('s1', {
            milestoneId: 'm2',
            ...(s1Done ? { stateId: STATE.done } : {}),
          }),
        ],
        relations,
      },
      MILESTONES
    );
    return node(g, 'm1');
  }

  test('finishing the outside blocker never makes a stuck box look better than it is', () => {
    const waiting = loopBox(false, true);
    expect(waiting).toMatchObject({
      readiness: 'blocked',
      blockedBy: 1,
      readyIssues: 0,
    });
    expect(readinessClass(waiting)).toBe('stuck');
    // t3 still waits on t1: the box is clear of outside blockers, and
    // still nothing in it can start.
    const cleared = loopBox(true, true);
    expect(cleared).toMatchObject({ readiness: 'ready', readyIssues: 0 });
    expect(readinessLabel(cleared)).toBe('None ready');
    expect(readinessClass(cleared)).toBe('stuck');
  });

  test('once the outside blocker is done, the issue it alone held starts', () => {
    expect(readinessClass(loopBox(false, false))).toBe('stuck');
    const cleared = loopBox(true, false);
    expect(cleared).toMatchObject({ readiness: 'ready', readyIssues: 1 });
    expect(readinessLabel(cleared)).toBe('Clear');
    expect(readinessClass(cleared)).toBe('ready');
  });

  test('boxes whose arrows form a cycle, each holding ready work, wait and are not stuck', () => {
    // mX (project P) → mY → mZ (both project Q) → mX, through different
    // issues: x1 → y1, y2 → z1, z2 → x2.
    const parts: GraphParts = {
      projects: [
        project('P', { sortOrder: 1 }),
        project('Q', { sortOrder: 2 }),
      ],
      milestones: [
        milestone('mX', 'P', { name: 'X' }),
        milestone('mY', 'Q', { name: 'Y' }),
        milestone('mZ', 'Q', { name: 'Z' }),
      ],
      issues: [
        at('x1', 'mX', 'P'),
        at('x2', 'mX', 'P'),
        at('y1', 'mY', 'Q'),
        at('y2', 'mY', 'Q'),
        at('z1', 'mZ', 'Q'),
        at('z2', 'mZ', 'Q'),
      ],
      relations: blocks(['x1', 'y1'], ['y2', 'z1'], ['z2', 'x2']),
    };
    const workspace = graph(parts, MILESTONES);
    expect(
      byId(workspace.nodes).map((n) => [n.id, n.inCycle, readinessClass(n)])
    ).toEqual([
      ['mX', true, 'blocked'],
      ['mY', true, 'blocked'],
      ['mZ', true, 'blocked'],
    ]);
    for (const n of workspace.nodes) {
      expect(readinessOf(n)).toEqual({
        readiness: 'blocked',
        blockedBy: 1,
        unblocks: 1,
        openIssues: 2,
        readyIssues: 1,
      });
    }
    // P's milestones draw mX → mY and mZ → mX, not mY → mZ: no cycle is
    // drawn, and every class stays the same.
    const inP = graph(parts, { level: 'milestone', projectId: 'P' });
    expect(inP.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      'mX>mY',
      'mZ>mX',
    ]);
    expect(
      byId(inP.nodes).map((n) => [n.id, n.inCycle, readinessClass(n)])
    ).toEqual([
      ['mX', false, 'blocked'],
      ['mY', false, 'blocked'],
      ['mZ', false, 'blocked'],
    ]);
  });
});

test('an issue on a cycle the graph does not draw is stuck', () => {
  // A (in m1) → X → Y → A: m1's graph draws A → X and Y → A, not X → Y.
  const g = graph(
    {
      milestones: [milestone('m1', 'p1'), milestone('m2', 'p1')],
      issues: [inM1('A'), at('X', 'm2', 'p1'), at('Y', 'm2', 'p1')],
      relations: blocks(['A', 'X'], ['X', 'Y'], ['Y', 'A']),
    },
    M1
  );
  expect(g.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
    'A>X',
    'Y>A',
  ]);
  expect(node(g, 'A')).toMatchObject({
    inCycle: false,
    holdsCycle: true,
    readiness: 'blocked',
    blockedBy: 1,
  });
  expect(readinessClass(node(g, 'A'))).toBe('stuck');
});

// A node with every field set, open and ready unless overridden.
function flowNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'n',
    kind: 'milestone',
    label: 'n',
    sublabel: '',
    url: null,
    initiativeId: null,
    projectId: null,
    milestoneId: 'n',
    ownerId: null,
    external: false,
    active: true,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
    holdsCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'on_track',
    readiness: 'ready',
    blockedBy: 0,
    unblocks: 0,
    openIssues: 1,
    readyIssues: 1,
    ...overrides,
  };
}

const BLOCKED_ISSUE: Partial<GraphNode> = {
  kind: 'issue',
  status: 'started',
  readiness: 'blocked',
  blockedBy: 1,
  readyIssues: 0,
};

describe('readinessClass', () => {
  test.each([
    [
      'a done issue',
      flowNode({
        kind: 'issue',
        readiness: 'done',
        open: false,
        openIssues: 0,
        readyIssues: 0,
      }),
      'quiet',
    ],
    [
      'a paused issue, even on a cycle',
      flowNode({ ...BLOCKED_ISSUE, active: false, holdsCycle: true }),
      'quiet',
    ],
    [
      'an inactive box',
      flowNode({ active: false, readiness: 'blocked', blockedBy: 1 }),
      'quiet',
    ],
    [
      'a complete box',
      flowNode({ readiness: 'done', openIssues: 0, readyIssues: 0 }),
      'quiet',
    ],
    [
      'an issue on an open cycle',
      flowNode({ ...BLOCKED_ISSUE, holdsCycle: true }),
      'stuck',
    ],
    [
      'a waiting box, none ready, a cycle inside',
      flowNode({
        readiness: 'blocked',
        blockedBy: 1,
        openIssues: 3,
        readyIssues: 0,
        holdsCycle: true,
      }),
      'stuck',
    ],
    [
      'a clear box, none ready, a cycle inside',
      flowNode({ openIssues: 2, readyIssues: 0, holdsCycle: true }),
      'stuck',
    ],
    [
      'a blocked issue',
      flowNode({ ...BLOCKED_ISSUE, blockedBy: 2 }),
      'blocked',
    ],
    [
      'a waiting box with a cycle inside and a ready issue',
      flowNode({
        readiness: 'blocked',
        blockedBy: 1,
        openIssues: 3,
        readyIssues: 1,
        holdsCycle: true,
      }),
      'blocked',
    ],
    [
      'a waiting box on a drawn box cycle (inCycle is never read)',
      flowNode({ readiness: 'blocked', blockedBy: 1, inCycle: true }),
      'blocked',
    ],
    [
      'a waiting box, none ready, no cycle',
      flowNode({ readiness: 'blocked', blockedBy: 1, readyIssues: 0 }),
      'blocked',
    ],
    ['a ready issue', flowNode({ kind: 'issue', status: 'backlog' }), 'ready'],
    [
      'a clear box with a cycle inside and a ready issue',
      flowNode({ openIssues: 3, readyIssues: 1, holdsCycle: true }),
      'ready',
    ],
    [
      'a clear external project',
      flowNode({ kind: 'project', external: true }),
      'ready',
    ],
  ] as const)('%s → %s', (_name, n, expected) => {
    expect(readinessClass(n)).toBe(expected);
  });
});

describe('readinessLabel', () => {
  test.each([
    ['issue, ready', flowNode({ kind: 'issue' }), 'Ready'],
    [
      'issue, blocked',
      flowNode({ ...BLOCKED_ISSUE, blockedBy: 2 }),
      'Blocked by 2',
    ],
    [
      'issue, done',
      flowNode({
        kind: 'issue',
        readiness: 'done',
        openIssues: 0,
        readyIssues: 0,
      }),
      '',
    ],
    ['milestone, clear', flowNode({}), 'Clear'],
    [
      'milestone, clear with none ready',
      flowNode({ openIssues: 2, readyIssues: 0, holdsCycle: true }),
      'None ready',
    ],
    [
      'project, waiting',
      flowNode({ kind: 'project', readiness: 'blocked', blockedBy: 3 }),
      'Waiting on 3',
    ],
    [
      'initiative, waiting with none ready',
      flowNode({
        kind: 'initiative',
        readiness: 'blocked',
        blockedBy: 1,
        readyIssues: 0,
      }),
      'Waiting on 1',
    ],
    [
      'initiative, complete',
      flowNode({
        kind: 'initiative',
        readiness: 'done',
        openIssues: 0,
        readyIssues: 0,
      }),
      '',
    ],
  ] as const)('%s → %j', (_name, n, expected) => {
    expect(readinessLabel(n)).toBe(expected);
  });
});
