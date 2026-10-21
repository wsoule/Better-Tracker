import { describe, expect, test } from 'bun:test';

import {
  buildDependencyGraph,
  escapeMermaidLabel,
  findCycles,
  toMermaid,
} from '../src/index';
import type {
  BlockingRelation,
  DependencyGraph,
  GraphEdge,
  GraphNode,
  GraphScope,
  Issue,
  Milestone,
  Project,
} from '../src/index';
import {
  day,
  evaluate,
  issue,
  milestone,
  project,
  STATE,
  user,
  workspace,
} from './helpers';

// Builds `blocks` relations from `[blocker, blocked]` pairs.
function blocks(...pairs: [string, string][]): BlockingRelation[] {
  return pairs.map(([blockerId, blockedId], i) => ({
    id: `r${i}`,
    blockerId,
    blockedId,
  }));
}

function graph(
  parts: {
    projects?: Project[];
    milestones?: Milestone[];
    issues: Issue[];
    relations: BlockingRelation[];
  },
  scope: GraphScope
): DependencyGraph {
  const evaluated = evaluate(
    workspace({
      users: [user('lead'), user('bob'), user('ana'), user('cy')],
      projects: parts.projects ?? [project('p1', { name: 'Orion' })],
      milestones: parts.milestones ?? [
        milestone('m1', 'p1', { targetDate: day(30), name: 'Beta' }),
      ],
      issues: parts.issues,
      relations: parts.relations,
    })
  );
  return buildDependencyGraph(
    evaluated.snapshot,
    evaluated.ctx,
    evaluated.assessments,
    scope
  );
}

function node(g: DependencyGraph, id: string): GraphNode {
  const found = g.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
}

function edge(g: DependencyGraph, from: string, to: string): GraphEdge {
  const found = g.edges.find((e) => e.from === from && e.to === to);
  if (found === undefined) throw new Error(`no edge ${from} → ${to}`);
  return found;
}

// Open, assigned issues in p1/m1 with predictable order (identifier = id).
function inM1(id: string, overrides: Partial<Issue> = {}): Issue {
  return issue(id, {
    identifier: id,
    projectId: 'p1',
    milestoneId: 'm1',
    assigneeId: 'ana',
    stateId: STATE.started,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

const M1: GraphScope = { level: 'issue', milestoneId: 'm1' };

describe('issue level: transitive waits over open blockers', () => {
  const g = graph(
    {
      issues: [
        inM1('A-1', { assigneeId: null }), // unassigned root
        inM1('A-2'),
        inM1('A-3'),
        inM1('B-1', { assigneeId: null }), // unassigned root of a broken chain
        inM1('B-2', { stateId: STATE.done }), // closed middle
        inM1('B-3'),
        inM1('C-1', { assigneeId: null, stateId: STATE.done }), // closed and unassigned
        inM1('C-2'),
      ],
      relations: blocks(
        ['A-1', 'A-2'],
        ['A-2', 'A-3'],
        ['B-1', 'B-2'],
        ['B-2', 'B-3'],
        ['C-1', 'C-2']
      ),
    },
    M1
  );

  test.each([
    ['A-1', true, false],
    ['A-2', false, true],
    ['A-3', false, true],
    ['B-1', true, false],
    ['B-2', false, false], // closed issues never wait
    ['B-3', false, false], // its only blocker is closed
    ['C-1', false, false], // closed, so not "unassigned"
    ['C-2', false, false],
  ])('%s: unassigned %s, waitsOnUnassigned %s', (id, unassigned, waits) => {
    expect(node(g, id).unassigned).toBe(unassigned);
    expect(node(g, id).waitsOnUnassigned).toBe(waits);
  });

  test('closed blockers make edges resolved and off the risk chain', () => {
    expect(edge(g, 'B-2', 'B-3')).toMatchObject({
      resolved: true,
      onRiskChain: false,
    });
    expect(edge(g, 'C-1', 'C-2')).toMatchObject({
      resolved: true,
      onRiskChain: false,
    });
    expect(edge(g, 'A-1', 'A-2')).toMatchObject({
      resolved: false,
      onRiskChain: true,
    });
    // A-2 is assigned but waits on A-1, so its edge is on the chain too.
    expect(edge(g, 'A-2', 'A-3')).toMatchObject({
      resolved: false,
      onRiskChain: true,
    });
    expect(edge(g, 'B-1', 'B-2')).toMatchObject({
      resolved: false,
      onRiskChain: true,
    });
  });

  test('nodes come in issue order and carry issue fields', () => {
    expect(g.nodes.map((n) => n.id)).toEqual([
      'A-1',
      'A-2',
      'A-3',
      'B-1',
      'B-2',
      'B-3',
      'C-1',
      'C-2',
    ]);
    expect(node(g, 'A-2')).toMatchObject({
      kind: 'issue',
      label: 'Issue A-2',
      sublabel: 'A-2 · Ana',
      url: 'https://linear.app/acme/issue/A-2',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      status: 'started',
    });
    expect(node(g, 'A-1').sublabel).toBe('A-1 · Unassigned');
  });
});

describe('issue level: overdue chains', () => {
  test('an issue in an overdue milestone flags everything that waits on it', () => {
    const g = graph(
      {
        milestones: [
          milestone('late', 'p1', { targetDate: day(-3) }),
          milestone('m1', 'p1', { targetDate: day(30) }),
        ],
        issues: [
          inM1('L-1', { milestoneId: 'late' }),
          inM1('M-1'),
          inM1('M-2'),
        ],
        relations: blocks(['L-1', 'M-1'], ['M-1', 'M-2']),
      },
      M1
    );
    expect(node(g, 'L-1')).toMatchObject({
      external: true,
      overdue: true,
      waitsOnOverdue: false,
    });
    expect(node(g, 'M-1')).toMatchObject({
      overdue: false,
      waitsOnOverdue: true,
      waitsOnUnassigned: false,
    });
    expect(node(g, 'M-2').waitsOnOverdue).toBe(true);
    expect(edge(g, 'L-1', 'M-1').onRiskChain).toBe(true);
  });

  test('waits follow chains that leave the scope', () => {
    // M-1 waits on X-1 (outside), which waits on unassigned X-2 (two hops).
    const g = graph(
      {
        milestones: [milestone('m1', 'p1'), milestone('mx', 'p1')],
        issues: [
          inM1('M-1'),
          inM1('X-1', { milestoneId: 'mx' }),
          inM1('X-2', { milestoneId: 'mx', assigneeId: null }),
        ],
        relations: blocks(['X-2', 'X-1'], ['X-1', 'M-1']),
      },
      M1
    );
    expect(g.nodes.map((n) => [n.id, n.external])).toEqual([
      ['M-1', false],
      ['X-1', true],
    ]);
    expect(node(g, 'M-1').waitsOnUnassigned).toBe(true);
    expect(node(g, 'X-1').waitsOnUnassigned).toBe(true);
    // Only one hop is drawn.
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([['X-1', 'M-1']]);
  });
});

describe('issue level: cycles (Tarjan SCC)', () => {
  const g = graph(
    {
      issues: [
        inM1('C-1'),
        inM1('C-2'),
        inM1('C-3'),
        inM1('D-1'),
        inM1('S-1'),
        inM1('E-1', { stateId: STATE.done }),
        inM1('E-2'),
      ],
      relations: blocks(
        ['C-1', 'C-2'],
        ['C-2', 'C-3'],
        ['C-3', 'C-1'],
        ['C-3', 'D-1'],
        ['S-1', 'S-1'],
        // A "cycle" through a closed blocker is not a deadlock.
        ['E-1', 'E-2'],
        ['E-2', 'E-1']
      ),
    },
    M1
  );

  test('finds the three-cycle and the self-loop, in walk order', () => {
    expect(g.cycles).toEqual([['C-1', 'C-2', 'C-3'], ['S-1']]);
  });

  test('flags nodes and edges on cycles only', () => {
    expect(g.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual([
      'C-1',
      'C-2',
      'C-3',
      'S-1',
    ]);
    expect(
      g.edges.filter((e) => e.inCycle).map((e) => `${e.from}>${e.to}`)
    ).toEqual(['C-1>C-2', 'C-2>C-3', 'C-3>C-1', 'S-1>S-1']);
    expect(edge(g, 'C-3', 'D-1').inCycle).toBe(false);
  });

  test('findCycles handles long chains without recursion limits', () => {
    const n = 50_000;
    const successors = Array.from({ length: n }, (_, i) =>
      i + 1 < n ? [i + 1] : [0]
    );
    const cycles = findCycles(n, successors);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(n);
    expect(cycles[0]?.slice(0, 3)).toEqual([0, 1, 2]);
  });
});

describe('issue level: cross-project and cross-owner edges, external nodes', () => {
  const projects = [
    project('p1', { name: 'Orion' }),
    project('p2', { name: 'Halo', leadId: 'bob' }),
  ];
  const milestones = [milestone('m1', 'p1'), milestone('m2', 'p2')];
  const issues = [
    inM1('O-1'),
    inM1('O-2'),
    inM1('O-3'),
    inM1('H-1', { projectId: 'p2', milestoneId: 'm2', assigneeId: 'bob' }),
    inM1('H-2', { projectId: 'p2', milestoneId: 'm2', assigneeId: 'ana' }),
    inM1('H-3', { projectId: 'p2', milestoneId: 'm2', assigneeId: null }),
    inM1('H-4', { projectId: 'p2', milestoneId: 'm2' }),
    inM1('N-1', { projectId: null, milestoneId: null, assigneeId: 'cy' }),
  ];
  const relations = blocks(
    ['H-1', 'O-1'], // other project, other owner
    ['H-2', 'O-2'], // other project, same owner
    ['H-3', 'O-3'], // other project, blocker unassigned
    ['O-1', 'N-1'], // blocks an issue with no project
    ['H-4', 'H-1'], // two hops away: not drawn
    ['O-2', 'O-3'] // same project, same owner
  );

  test('milestone scope adds one hop of outside issues as externals', () => {
    const g = graph({ projects, milestones, issues, relations }, M1);
    expect(g.nodes.map((n) => [n.id, n.external])).toEqual([
      ['O-1', false],
      ['O-2', false],
      ['O-3', false],
      ['H-1', true],
      ['H-2', true],
      ['H-3', true],
      ['N-1', true],
    ]);
    expect(
      g.edges.map((e) => [e.from, e.to, e.crossProject, e.crossOwner])
    ).toEqual([
      ['O-1', 'N-1', true, true],
      ['O-2', 'O-3', false, false],
      ['H-1', 'O-1', true, true],
      ['H-2', 'O-2', true, false],
      ['H-3', 'O-3', true, false],
    ]);
  });

  test('project scope covers every issue in the project', () => {
    const g = graph(
      { projects, milestones, issues, relations },
      { level: 'issue', projectId: 'p2' }
    );
    expect(g.scope).toEqual({ level: 'issue', projectId: 'p2' });
    expect(g.nodes.filter((n) => !n.external).map((n) => n.id)).toEqual([
      'H-1',
      'H-2',
      'H-3',
      'H-4',
    ]);
    expect(g.nodes.filter((n) => n.external).map((n) => n.id)).toEqual([
      'O-1',
      'O-2',
      'O-3',
    ]);
  });

  test('an unknown scope gives an empty graph', () => {
    const g = graph(
      { projects, milestones, issues, relations },
      { level: 'issue', milestoneId: 'nope' }
    );
    expect(g).toEqual({
      scope: { level: 'issue', milestoneId: 'nope' },
      nodes: [],
      edges: [],
      cycles: [],
    });
  });
});

describe('milestone level', () => {
  const projects = [
    project('pA', { name: 'Alpha', leadId: 'lead', priority: 1 }),
    project('pB', { name: 'Bravo', leadId: 'bob', priority: 1 }),
    project('pC', { name: 'Charlie', leadId: 'lead', priority: 1 }),
    project('pP', {
      name: 'Paused',
      leadId: 'lead',
      statusType: 'paused',
      priority: 1,
    }),
  ];
  const milestones = [
    milestone('mA', 'pA', { name: 'A', targetDate: day(10) }),
    milestone('mB', 'pB', { name: 'B', targetDate: day(-2) }),
    milestone('mC', 'pC', { name: 'C', targetDate: day(20) }),
    milestone('mA2', 'pA', { name: 'A2', targetDate: day(40) }),
    milestone('mDone', 'pA', { name: 'Done', targetDate: day(5) }),
    milestone('mP', 'pP', { name: 'P', targetDate: day(15) }),
    milestone('mP2', 'pP', { name: 'P2', targetDate: day(16) }),
  ];
  const at = (
    id: string,
    milestoneId: string,
    projectId: string,
    overrides: Partial<Issue> = {}
  ): Issue => inM1(id, { milestoneId, projectId, ...overrides });
  const issues = [
    at('a1', 'mA', 'pA'),
    at('a2', 'mA', 'pA'),
    at('a3', 'mA', 'pA'),
    at('b1', 'mB', 'pB', { assigneeId: null }),
    at('b2', 'mB', 'pB'),
    at('b3', 'mB', 'pB', { stateId: STATE.done }),
    at('c1', 'mC', 'pC'),
    at('a2-1', 'mA2', 'pA'),
    at('d1', 'mDone', 'pA', { stateId: STATE.done }),
    at('p1', 'mP', 'pP'),
    at('p2', 'mP2', 'pP'),
  ];
  const relations = blocks(
    ['b1', 'a1'], // B → A
    ['b2', 'a2'], // B → A again: weight 2
    ['b3', 'a3'], // closed blocker: not counted
    ['a1', 'a2'], // same milestone: no edge
    ['a1', 'c1'], // A → C (same lead, other project)
    ['p1', 'c1'], // paused P → active C: shown
    ['p1', 'p2'], // paused → paused: not shown
    ['d1', 'a2-1'] // closed blocker
  );
  const g = graph(
    { projects, milestones, issues, relations },
    { level: 'milestone' }
  );

  test('nodes: active milestones with open issues plus edge endpoints, in display order', () => {
    expect(g.nodes.map((n) => n.id)).toEqual(['mB', 'mA', 'mP', 'mC', 'mA2']);
    expect(node(g, 'mB')).toMatchObject({
      kind: 'milestone',
      label: 'B',
      sublabel: 'Bravo',
      url: null,
      projectId: 'pB',
      milestoneId: 'mB',
      ownerId: 'bob',
      external: false,
      open: true,
      unassigned: true,
      overdue: true,
      status: 'overdue',
    });
  });

  test('edges aggregate open relations into weights', () => {
    expect(g.edges.map((e) => [e.from, e.to, e.weight])).toEqual([
      ['mB', 'mA', 2],
      ['mA', 'mC', 1],
      ['mP', 'mC', 1],
    ]);
  });

  test('cross-project and cross-owner use projects and leads', () => {
    expect(edge(g, 'mB', 'mA')).toMatchObject({
      crossProject: true,
      crossOwner: true,
      resolved: false,
    });
    expect(edge(g, 'mA', 'mC')).toMatchObject({
      crossProject: true,
      crossOwner: false,
    });
  });

  test('waits flags aggregate the issue-level chains', () => {
    expect(node(g, 'mA')).toMatchObject({
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
      unassigned: false,
      overdue: false,
    });
    expect(node(g, 'mC')).toMatchObject({
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
    });
    expect(node(g, 'mP')).toMatchObject({
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
    });
    expect(edge(g, 'mB', 'mA').onRiskChain).toBe(true);
    expect(edge(g, 'mA', 'mC').onRiskChain).toBe(true);
    expect(edge(g, 'mP', 'mC').onRiskChain).toBe(false);
  });

  test('milestone-level cycles', () => {
    const cyclic = graph(
      {
        projects,
        milestones,
        issues,
        relations: [...relations, ...blocks(['c1', 'b2'])].map((r, i) => ({
          ...r,
          id: `x${i}`,
        })),
      },
      { level: 'milestone' }
    );
    expect(cyclic.cycles).toEqual([['mB', 'mA', 'mC']]);
    expect(cyclic.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual([
      'mB',
      'mA',
      'mC',
    ]);
    expect(edge(cyclic, 'mP', 'mC').inCycle).toBe(false);
  });
});

describe('toMermaid', () => {
  test('stable output with positional ids, arrows, weights and classes', () => {
    const g = graph(
      {
        projects: [
          project('p1', { name: 'Orion' }),
          project('p2', { name: 'Halo' }),
        ],
        milestones: [milestone('m1', 'p1'), milestone('m2', 'p2')],
        issues: [
          inM1('ENG-1', { title: 'Ship "beta" [v2]', assigneeId: null }),
          inM1('ENG-2', { title: 'Docs <draft> #1' }),
          inM1('ENG-3', { title: 'Old work', stateId: STATE.done }),
          inM1('OPS-1', {
            title: 'Infra (prod)\nsetup',
            projectId: 'p2',
            milestoneId: 'm2',
          }),
        ],
        relations: blocks(
          ['ENG-1', 'ENG-2'],
          ['ENG-3', 'ENG-2'],
          ['OPS-1', 'ENG-1']
        ),
      },
      M1
    );
    expect(toMermaid(g)).toBe(
      [
        'flowchart LR',
        '  n0["Ship #34;beta#34; #91;v2#93;<br/>ENG-1 · Unassigned"]',
        '  n1["Docs #60;draft#62; #35;1<br/>ENG-2 · Ana"]',
        '  n2["Old work<br/>ENG-3 · Ana"]',
        '  n3["Infra #40;prod#41; setup<br/>OPS-1 · Ana"]',
        '  n0 --> n1',
        '  n2 -.-> n1',
        '  n3 --> n0',
        '  classDef risk stroke:#ee5a24,stroke-width:2px',
        '  classDef cycle stroke:#ee5a24,stroke-dasharray:5 3',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  class n0,n1 risk',
        '  class n3 external',
        '  linkStyle 0 stroke:#ee5a24',
        '',
      ].join('\n')
    );
  });

  test('milestone graphs show weights and cycle classes', () => {
    const g: DependencyGraph = {
      scope: { level: 'milestone' },
      nodes: [
        { ...baseNode('a'), label: 'Alpha', sublabel: 'P1', inCycle: true },
        { ...baseNode('b'), label: 'Beta', sublabel: '', inCycle: true },
      ],
      edges: [
        { ...baseEdge('a', 'b'), weight: 3, inCycle: true },
        { ...baseEdge('b', 'a'), inCycle: true },
      ],
      cycles: [['a', 'b']],
    };
    expect(toMermaid(g)).toMatchInlineSnapshot(`
      "flowchart LR
        n0["Alpha<br/>P1"]
        n1["Beta"]
        n0 -->|3| n1
        n1 --> n0
        classDef risk stroke:#ee5a24,stroke-width:2px
        classDef cycle stroke:#ee5a24,stroke-dasharray:5 3
        classDef external stroke-dasharray:3 3,opacity:0.7
        class n0,n1 cycle
      "
    `);
  });

  test('an empty graph is still valid Mermaid', () => {
    expect(
      toMermaid({
        scope: { level: 'milestone' },
        nodes: [],
        edges: [],
        cycles: [],
      })
    ).toBe(
      [
        'flowchart LR',
        '  classDef risk stroke:#ee5a24,stroke-width:2px',
        '  classDef cycle stroke:#ee5a24,stroke-dasharray:5 3',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '',
      ].join('\n')
    );
  });

  test.each([
    ['"quoted"', '#34;quoted#34;'],
    ['a[b]c', 'a#91;b#93;c'],
    ['f(x) {y} |z|', 'f#40;x#41; #123;y#125; #124;z#124;'],
    ['<script>&', '#60;script#62;#38;'],
    ['#34; already', '#35;34; already'],
    ['line\r\nbreak\nhere', 'line break here'],
    ['100% `code`', '100#37; #96;code#96;'],
    ['plain · text', 'plain · text'],
  ])('escapes %j', (input, expected) => {
    expect(escapeMermaidLabel(input)).toBe(expected);
  });
});

function baseNode(id: string): GraphNode {
  return {
    id,
    kind: 'milestone',
    label: id,
    sublabel: '',
    url: null,
    projectId: null,
    milestoneId: id,
    ownerId: null,
    external: false,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'on_track',
  };
}

function baseEdge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    resolved: false,
    crossProject: false,
    crossOwner: false,
    inCycle: false,
    onRiskChain: false,
    weight: 1,
  };
}
