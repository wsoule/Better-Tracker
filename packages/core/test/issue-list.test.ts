import { describe, expect, test } from 'bun:test';

import {
  buildIssueList,
  buildIssueListOptions,
  DEFAULT_ISSUE_LIST_QUERY,
  ISSUE_LIST_MAX_GROUPS,
  ISSUE_LIST_PRESETS,
  issueListSectionsAllowed,
  normalizeIssueListQuery,
  OPEN_STATE_TYPES,
  planAllocation,
  sameIssueListFilters,
  stateNameKey,
} from '../src/index';
import type {
  IssueListFilters,
  IssueListPresetId,
  IssueListQuery,
  IssueListView,
  Issue,
  Milestone,
  WorkspaceData,
} from '../src/index';
import {
  ago,
  day,
  evaluate,
  initiative,
  issue,
  meta,
  milestone,
  project,
  STATE,
  team,
  TEAM,
  teamStates,
  user,
  workspace,
} from './helpers';

const OPS = 'team-ops';

// Two teams (both with an "In Progress" state; OPS also has "Blocked"),
// initiatives Alpha (priority 1) and Bravo, and four projects: Atlas and
// Beacon (Alpha first; Beacon is in Bravo too), Compass (Bravo) and the
// paused Zephyr. Atlas has an overdue milestone (Dual-write), an upcoming
// one (Cutover), a complete one (Prep) and an empty one (Cleanup).
function scenario(): WorkspaceData {
  const at = (
    id: string,
    identifier: string,
    overrides: Partial<Issue>
  ): Issue => issue(id, { identifier, title: `Issue ${id}`, ...overrides });
  return workspace({
    users: [
      user('lead'),
      user('wyat'),
      user('ana', { name: 'Ana' }),
      user('hugo', { active: false }),
      user('bot', { app: true }),
    ],
    teams: [team(TEAM, 'ENG', 'Engineering'), team(OPS, 'OPS', 'Operations')],
    states: [
      ...teamStates(),
      ...teamStates(OPS),
      {
        id: 'ops-blocked',
        teamId: OPS,
        name: 'Blocked',
        type: 'started',
        position: 9,
      },
    ],
    initiatives: [
      initiative('init-a', { name: 'Alpha', priority: 1 }),
      initiative('init-b', { name: 'Bravo', priority: 2 }),
    ],
    projects: [
      project('pa', { name: 'Atlas', priority: 2, initiativeIds: ['init-a'] }),
      project('pb', {
        name: 'Beacon',
        priority: 3,
        sortOrder: 1,
        initiativeIds: ['init-b', 'init-a'],
        teamIds: [TEAM, OPS],
      }),
      project('pc', {
        name: 'Compass',
        priority: 2,
        sortOrder: 2,
        initiativeIds: ['init-b'],
        teamIds: [OPS],
      }),
      project('pz', {
        name: 'Zephyr',
        priority: 1,
        statusType: 'paused',
        statusName: 'Paused',
      }),
    ],
    milestones: [
      milestone('pa-m1', 'pa', { name: 'Dual-write', targetDate: day(-2) }),
      milestone('pa-m2', 'pa', { name: 'Cutover', targetDate: day(10) }),
      milestone('pa-m3', 'pa', { name: 'Prep', targetDate: day(-10) }),
      milestone('pa-m4', 'pa', { name: 'Cleanup', targetDate: day(30) }),
      milestone('pb-m1', 'pb', { name: 'Index', targetDate: day(10) }),
      milestone('pc-m1', 'pc', { name: 'Routing', targetDate: null }),
      milestone('pz-m1', 'pz', { name: 'Paused work', targetDate: day(-5) }),
    ],
    issues: [
      at('e1', 'ENG-1', {
        projectId: 'pa',
        milestoneId: 'pa-m1',
        assigneeId: 'lead',
        priority: 2,
        stateId: STATE.started,
        createdAt: ago(20),
      }),
      at('e2', 'ENG-2', {
        projectId: 'pa',
        milestoneId: 'pa-m1',
        priority: 1,
        createdAt: ago(25),
      }),
      at('e10', 'ENG-10', {
        projectId: 'pa',
        milestoneId: 'pa-m1',
        priority: 1,
        createdAt: ago(25),
      }),
      at('e3', 'ENG-3', {
        projectId: 'pa',
        milestoneId: 'pa-m1',
        assigneeId: 'lead',
        priority: 1,
        stateId: STATE.done,
        createdAt: ago(40),
      }),
      at('e4', 'ENG-4', {
        projectId: 'pa',
        milestoneId: 'pa-m2',
        assigneeId: 'wyat',
        priority: 3,
        stateId: STATE.todo,
        createdAt: ago(10),
        updatedAt: 'not a date',
        dueDate: day(3),
      }),
      at('e5', 'ENG-5', {
        projectId: 'pa',
        milestoneId: 'pa-m3',
        assigneeId: 'wyat',
        priority: 2,
        stateId: STATE.done,
      }),
      at('e6', 'ENG-6', {
        projectId: 'pa',
        title: 'Résumé export',
        createdAt: ago(5),
        dueDate: day(1),
      }),
      at('o1', 'OPS-1', {
        teamId: OPS,
        projectId: 'pb',
        milestoneId: 'pb-m1',
        assigneeId: 'hugo',
        priority: 2,
        stateId: `${OPS}:${STATE.started}`,
        createdAt: ago(15),
      }),
      at('e7', 'ENG-7', {
        assigneeId: 'ana',
        priority: 3,
        stateId: STATE.todo,
        createdAt: ago(8),
        updatedAt: ago(1),
      }),
      at('o2', 'OPS-2', {
        teamId: OPS,
        projectId: 'pc',
        milestoneId: 'pc-m1',
        assigneeId: 'wyat',
        priority: 4,
        stateId: 'ops-blocked',
        createdAt: ago(12),
        dueDate: day(3),
      }),
      at('o3', 'OPS-3', {
        teamId: OPS,
        projectId: 'pc',
        assigneeId: 'lead',
        stateId: `${OPS}:${STATE.started}`,
        createdAt: ago(3),
      }),
      at('e8', 'ENG-8', {
        projectId: 'pz',
        milestoneId: 'pz-m1',
        assigneeId: 'lead',
        priority: 1,
        stateId: STATE.todo,
        createdAt: ago(30),
      }),
      at('e9', 'ENG-9', { projectId: 'pz', priority: 2, createdAt: ago(40) }),
      at('e11', 'ENG-11', { stateId: STATE.done }),
    ],
    relations: [
      // ENG-7 (open) blocks ENG-2 in the overdue Dual-write.
      { id: 'r1', blockerId: 'e7', blockedId: 'e2' },
      // ENG-3 is done: ENG-4 is not blocked by it.
      { id: 'r2', blockerId: 'e3', blockedId: 'e4' },
    ],
  });
}

type QueryInput = Omit<Partial<IssueListQuery>, 'filters'> & {
  filters?: Partial<IssueListFilters>;
};

function query(input: QueryInput = {}): IssueListQuery {
  return normalizeIssueListQuery({
    ...input,
    filters: { ...DEFAULT_ISSUE_LIST_QUERY.filters, ...input.filters },
  });
}

function build(
  input: QueryInput = {},
  options: {
    data?: WorkspaceData;
    viewerId?: string | null;
    weights?: Record<string, number>;
  } = {}
): IssueListView {
  const evaluated = evaluate(options.data ?? scenario(), {
    meta: Object.entries(options.weights ?? {}).map(([id, weight]) =>
      meta(id, { weight })
    ),
  });
  return buildIssueList({
    ...evaluated,
    allocationPlan: planAllocation(
      evaluated.snapshot,
      evaluated.ctx,
      evaluated.assessments
    ),
    query: query(input),
    viewerId: options.viewerId === undefined ? 'lead' : options.viewerId,
  });
}

/** Identifiers in display order. */
function keys(view: IssueListView): string[] {
  return view.sections.flatMap((section) =>
    section.groups.flatMap((group) => group.rows.map((row) => row.identifier))
  );
}

/** Group keys in display order, with their row identifiers. */
function layout(view: IssueListView): [string, string[]][] {
  return view.sections.flatMap((section) =>
    section.groups.map((group): [string, string[]] => [
      group.key,
      group.rows.map((row) => row.identifier),
    ])
  );
}

const WEIGHT_ORDER = [
  'ENG-2',
  'ENG-10',
  'ENG-1',
  'ENG-4',
  'OPS-1',
  'OPS-2',
  'ENG-6',
  'OPS-3',
  'ENG-7',
  'ENG-8',
  'ENG-9',
];

describe('the default view', () => {
  test('milestone groups under tier dividers, in the weight order', () => {
    const view = build();
    expect(view.sections.map((section) => section.key)).toEqual([
      't:overdue',
      't:upcoming',
      't:unplanned',
      't:inactive',
    ]);
    expect(layout(view)).toEqual([
      ['t:overdue/m:pa-m1', ['ENG-2', 'ENG-10', 'ENG-1']],
      ['t:upcoming/m:pa-m2', ['ENG-4']],
      ['t:upcoming/m:pb-m1', ['OPS-1']],
      ['t:upcoming/m:pc-m1', ['OPS-2']],
      ['t:unplanned/nm:pa', ['ENG-6']],
      ['t:unplanned/nm:pc', ['OPS-3']],
      ['t:unplanned/np', ['ENG-7']],
      ['t:inactive/m:pz-m1', ['ENG-8']],
      ['t:inactive/nm:pz', ['ENG-9']],
    ]);
    expect(view.sections.map((section) => section.count)).toEqual([3, 3, 3, 2]);
    expect(view.total).toBe(11);
    expect(view.shown).toBe(11);
    expect(view.moreGroups).toEqual({ groups: 0, issues: 0 });
    expect(view.projectCount).toBe(4);
    expect(view.fallback).toBeNull();
    expect(view.includesClosed).toBe(false);
    expect(view.today).toBe('2026-10-21');
    expect(view.query).toEqual(DEFAULT_ISSUE_LIST_QUERY);
  });

  test('rows carry the flags the list draws', () => {
    const view = build();
    const rows = new Map(
      view.sections.flatMap((s) =>
        s.groups.flatMap((g) => g.rows.map((r) => [r.identifier, r] as const))
      )
    );
    expect(rows.get('ENG-2')).toMatchObject({
      id: 'e2',
      projectId: 'pa',
      milestoneId: 'pa-m1',
      stateName: 'Backlog',
      stateType: 'backlog',
      open: true,
      blockedBy: 1,
      holdsUpMilestoneId: null,
      unassignedInNext: true,
      projectActive: true,
      dueDate: null,
    });
    // ENG-7 has no project, blocks ENG-2 in the overdue Dual-write.
    expect(rows.get('ENG-7')).toMatchObject({
      projectId: null,
      milestoneId: null,
      blockedBy: 0,
      holdsUpMilestoneId: 'pa-m1',
      unassignedInNext: false,
      projectActive: true,
    });
    // A closed blocker does not count.
    expect(rows.get('ENG-4')?.blockedBy).toBe(0);
    expect(rows.get('ENG-6')?.dueDate).toBe(day(1));
    // Paused Zephyr: not active, never "unassigned in next".
    expect(rows.get('ENG-9')).toMatchObject({
      projectActive: false,
      unassignedInNext: false,
    });
  });

  test('the preset counts, over open issues', () => {
    expect(build().counts).toEqual({
      all: 11,
      mine: 3,
      unplanned: 4,
      unassigned: 4,
      blocked: 1,
      at_risk: 3,
    });
  });
});

describe('filters', () => {
  test('project, milestone and assignee with none and me; team; priority', () => {
    expect(keys(build({ filters: { projectIds: ['none'] } }))).toEqual([
      'ENG-7',
    ]);
    expect(keys(build({ filters: { milestoneIds: ['none'] } }))).toEqual([
      'ENG-6',
      'OPS-3',
      'ENG-7',
      'ENG-9',
    ]);
    expect(keys(build({ filters: { assigneeIds: ['me'] } }))).toEqual([
      'ENG-1',
      'OPS-3',
      'ENG-8',
    ]);
    // Without a viewer, "me" matches nothing.
    expect(
      build({ filters: { assigneeIds: ['me'] } }, { viewerId: null }).total
    ).toBe(0);
    expect(keys(build({ filters: { assigneeIds: ['none'] } }))).toEqual([
      'ENG-2',
      'ENG-10',
      'ENG-6',
      'ENG-9',
    ]);
    expect(keys(build({ filters: { teamIds: [OPS] } }))).toEqual([
      'OPS-1',
      'OPS-2',
      'OPS-3',
    ]);
    expect(keys(build({ filters: { priorities: [1] } }))).toEqual([
      'ENG-2',
      'ENG-10',
      'ENG-8',
    ]);
    expect(keys(build({ filters: { milestoneIds: ['pa-m2'] } }))).toEqual([
      'ENG-4',
    ]);
  });

  test('OR within a field, AND across fields', () => {
    expect(keys(build({ filters: { assigneeIds: ['me', 'ana'] } }))).toEqual([
      'ENG-1',
      'OPS-3',
      'ENG-7',
      'ENG-8',
    ]);
    expect(
      keys(build({ filters: { assigneeIds: ['me'], teamIds: [OPS] } }))
    ).toEqual(['OPS-3']);
    expect(
      keys(build({ filters: { projectIds: ['pa', 'none'], priorities: [0] } }))
    ).toEqual(['ENG-6']);
  });

  test('open by default; every status with all six types', () => {
    const all = build({
      filters: {
        stateTypes: [
          'triage',
          'backlog',
          'unstarted',
          'started',
          'completed',
          'canceled',
        ],
      },
    });
    expect(all.total).toBe(14);
    expect(all.includesClosed).toBe(true);
    expect(keys(build({ filters: { stateTypes: ['completed'] } }))).toEqual([
      'ENG-3',
      'ENG-5',
      'ENG-11',
    ]);
    // An empty status list reads as the open types.
    expect(
      build({ filters: { stateTypes: [] } }).query.filters.stateTypes
    ).toEqual([...OPEN_STATE_TYPES]);
  });

  test('initiatives by the first initiative; no project matches none; also in', () => {
    const bravo = build({ filters: { initiativeIds: ['init-b'] } });
    // Beacon is in Bravo too, but counts under Alpha, its first initiative.
    expect(keys(bravo)).toEqual(['OPS-2', 'OPS-3']);
    expect(bravo.alsoIn).toEqual([
      {
        projectId: 'pb',
        projectName: 'Beacon',
        homeInitiativeName: 'Alpha',
        chosenInitiativeName: 'Bravo',
      },
    ]);
    expect(bravo.refs.projects['pb']?.name).toBe('Beacon');
    expect(keys(build({ filters: { initiativeIds: ['init-a'] } }))).toEqual([
      'ENG-2',
      'ENG-10',
      'ENG-1',
      'ENG-4',
      'OPS-1',
      'ENG-6',
    ]);
    expect(build({ filters: { initiativeIds: ['init-a'] } }).alsoIn).toEqual(
      []
    );
    // "No initiative": Zephyr's issues; ENG-7 (no project) matches no value.
    expect(keys(build({ filters: { initiativeIds: ['none'] } }))).toEqual([
      'ENG-8',
      'ENG-9',
    ]);
  });

  test('quick filters; a paused project is never at risk', () => {
    expect(keys(build({ filters: { quick: ['blocked'] } }))).toEqual(['ENG-2']);
    // ENG-8 is in Zephyr's overdue milestone, but Zephyr is paused.
    expect(keys(build({ filters: { quick: ['at_risk'] } }))).toEqual([
      'ENG-2',
      'ENG-10',
      'ENG-1',
    ]);
    expect(keys(build({ filters: { quick: ['next'] } }))).toEqual([
      'ENG-2',
      'ENG-10',
      'ENG-1',
      'OPS-1',
      'OPS-2',
    ]);
    expect(keys(build({ filters: { quick: ['next', 'blocked'] } }))).toEqual([
      'ENG-2',
    ]);
  });

  test('text search: title words, accent-folded; identifiers only with a digit', () => {
    expect(keys(build({ filters: { q: 'resume' } }))).toEqual(['ENG-6']);
    expect(keys(build({ filters: { q: 'ENG-1' } }))).toEqual([
      'ENG-10',
      'ENG-1',
    ]);
    // "eng" holds no digit: it matches titles only, not every ENG issue.
    expect(build({ filters: { q: 'eng' } }).total).toBe(0);
    expect(keys(build({ filters: { q: 'issue o' } }))).toEqual([
      'OPS-1',
      'OPS-2',
      'OPS-3',
    ]);
  });

  test('unknown ids are reported and match nothing', () => {
    const view = build({
      filters: {
        projectIds: ['nope'],
        milestoneIds: ['gone'],
        assigneeIds: ['me', 'ghost'],
        teamIds: ['team-x'],
        initiativeIds: ['init-x'],
      },
    });
    expect(view.total).toBe(0);
    expect(view.unknownIds).toEqual([
      { facet: 'initiative', id: 'init-x' },
      { facet: 'project', id: 'nope' },
      { facet: 'milestone', id: 'gone' },
      { facet: 'assignee', id: 'ghost' },
      { facet: 'team', id: 'team-x' },
    ]);
    expect(view.sections).toEqual([]);
    // A known id next to an unknown one still matches.
    expect(keys(build({ filters: { projectIds: ['nope', 'pc'] } }))).toEqual([
      'OPS-2',
      'OPS-3',
    ]);
  });

  test('without initiatives, every initiative id gets the same answer', () => {
    const data = { ...scenario(), initiatives: [] };
    const named = build(
      { filters: { initiativeIds: ['init-a'] }, group: 'initiative' },
      { data }
    );
    const other = build(
      { filters: { initiativeIds: ['made-up'] }, sections: 'initiative' },
      { data }
    );
    expect(named.fallback).toEqual({ reason: 'no_initiatives' });
    expect(other.fallback).toEqual({ reason: 'no_initiatives' });
    expect(named.query.filters.initiativeIds).toEqual([]);
    expect(named.query.group).toBe('project');
    expect(other.query.sections).toBe('none');
    expect(named.unknownIds).toEqual([]);
    expect(other.unknownIds).toEqual([]);
    expect(named.total).toBe(11);
    expect(other.total).toBe(11);
    // Nothing names initiatives: no fallback.
    expect(build({}, { data }).fallback).toBeNull();
  });
});

describe('the weight order', () => {
  test('tiers A to E; inside a milestone, priority then oldest then ENG-2 before ENG-10', () => {
    expect(keys(build({ group: 'none' }))).toEqual(WEIGHT_ORDER);
  });

  test("a paused project's overdue milestone sorts in tier D, not on top", () => {
    const view = build({ group: 'none' });
    expect(keys(view).indexOf('ENG-8')).toBe(9);
  });

  test('a weight bump moves a milestone up; planAllocation is unchanged', () => {
    const data = scenario();
    const plain = evaluate(data);
    const weighted = evaluate(data, { meta: [meta('pb-m1', { weight: 2 })] });
    const view = build({}, { weights: { 'pb-m1': 2 } });
    expect(layout(view).map(([key]) => key)).toEqual([
      't:overdue/m:pa-m1',
      't:upcoming/m:pb-m1',
      't:upcoming/m:pa-m2',
      't:upcoming/m:pc-m1',
      't:unplanned/nm:pa',
      't:unplanned/nm:pc',
      't:unplanned/np',
      't:inactive/m:pz-m1',
      't:inactive/nm:pz',
    ]);
    expect(view.refs.milestones['pb-m1']?.weight).toBe(2);
    expect(
      planAllocation(weighted.snapshot, weighted.ctx, weighted.assessments)
    ).toEqual(planAllocation(plain.snapshot, plain.ctx, plain.assessments));
  });

  test('date ascending, undated last; then project priority, sortOrder, id', () => {
    // Beacon's Index and Atlas's Cutover share a date: Atlas (high) first.
    // Compass's Routing has no date: last of tier A.
    expect(
      layout(build())
        .slice(1, 4)
        .map(([key]) => key)
    ).toEqual([
      't:upcoming/m:pa-m2',
      't:upcoming/m:pb-m1',
      't:upcoming/m:pc-m1',
    ]);
    const ties: Milestone[] = [
      milestone('m-b', 'p1', { targetDate: day(4), sortOrder: 1 }),
      milestone('m-c', 'p1', { targetDate: day(4), sortOrder: 0 }),
      milestone('m-a', 'p1', { targetDate: day(4), sortOrder: 1 }),
    ];
    const data = workspace({
      projects: [project('p1')],
      milestones: ties,
      issues: ties.map((m, i) =>
        issue(`t${i}`, {
          identifier: `T-${i}`,
          projectId: 'p1',
          milestoneId: m.id,
        })
      ),
    });
    expect(layout(build({}, { data })).map(([key]) => key)).toEqual([
      't:upcoming/m:m-c',
      't:upcoming/m:m-a',
      't:upcoming/m:m-b',
    ]);
  });

  test('complete milestones last in their tier; open rows before closed', () => {
    const view = build({
      filters: { stateTypes: ['backlog', 'unstarted', 'started', 'completed'] },
    });
    expect(layout(view).slice(0, 5)).toEqual([
      ['t:overdue/m:pa-m1', ['ENG-2', 'ENG-10', 'ENG-1', 'ENG-3']],
      ['t:upcoming/m:pa-m2', ['ENG-4']],
      ['t:upcoming/m:pb-m1', ['OPS-1']],
      ['t:upcoming/m:pc-m1', ['OPS-2']],
      ['t:upcoming/m:pa-m3', ['ENG-5']],
    ]);
    // The mirror's loose closed issue sits with "No project".
    expect(layout(view)).toContainEqual([
      't:unplanned/np',
      ['ENG-7', 'ENG-11'],
    ]);
  });
});

describe('the weight order outside milestone groups', () => {
  test("a complete milestone's closed rows sort after open work in a person's group", () => {
    const view = build({
      group: 'assignee',
      filters: {
        stateTypes: [
          'triage',
          'backlog',
          'unstarted',
          'started',
          'completed',
          'canceled',
        ],
      },
    });
    // Wyat: ENG-5 is done in the complete Prep (dated before Cutover), so
    // it follows ENG-4 (Cutover) and OPS-2 (undated Routing).
    expect(layout(view).find(([key]) => key === 'all/a:wyat')).toEqual([
      'all/a:wyat',
      ['ENG-4', 'OPS-2', 'ENG-5'],
    ]);
  });

  test("a blocker of a paused project's overdue milestone holds up nothing", () => {
    const data = scenario();
    // ENG-6 (open, Atlas) blocks ENG-8 in Zephyr's overdue Paused work.
    data.relations.push({ id: 'r-paused', blockerId: 'e6', blockedId: 'e8' });
    const view = build({ group: 'none' }, { data });
    const row = view.sections
      .flatMap((section) => section.groups.flatMap((group) => group.rows))
      .find((candidate) => candidate.identifier === 'ENG-6');
    expect(row?.holdsUpMilestoneId).toBeNull();
    expect(view.refs.milestones['pz-m1']?.status).toBe('overdue');
  });
});

describe('field sorts', () => {
  test.each([
    [
      'priority',
      'asc',
      [
        'ENG-2',
        'ENG-10',
        'ENG-8',
        'ENG-1',
        'OPS-1',
        'ENG-9',
        'ENG-4',
        'ENG-7',
        'OPS-2',
        'ENG-6',
        'OPS-3',
      ],
    ],
    [
      'priority',
      'desc',
      [
        'OPS-2',
        'ENG-4',
        'ENG-7',
        'ENG-1',
        'OPS-1',
        'ENG-9',
        'ENG-2',
        'ENG-10',
        'ENG-8',
        'ENG-6',
        'OPS-3',
      ],
    ],
    [
      'due',
      'asc',
      [
        'ENG-6',
        'ENG-4',
        'OPS-2',
        'ENG-2',
        'ENG-10',
        'ENG-1',
        'OPS-1',
        'OPS-3',
        'ENG-7',
        'ENG-8',
        'ENG-9',
      ],
    ],
    [
      'due',
      'desc',
      [
        'ENG-4',
        'OPS-2',
        'ENG-6',
        'ENG-2',
        'ENG-10',
        'ENG-1',
        'OPS-1',
        'OPS-3',
        'ENG-7',
        'ENG-8',
        'ENG-9',
      ],
    ],
    [
      'created',
      'desc',
      [
        'OPS-3',
        'ENG-6',
        'ENG-7',
        'ENG-4',
        'OPS-2',
        'OPS-1',
        'ENG-1',
        'ENG-2',
        'ENG-10',
        'ENG-8',
        'ENG-9',
      ],
    ],
    [
      'created',
      'asc',
      [
        'ENG-9',
        'ENG-8',
        'ENG-2',
        'ENG-10',
        'ENG-1',
        'OPS-1',
        'OPS-2',
        'ENG-4',
        'ENG-7',
        'ENG-6',
        'OPS-3',
      ],
    ],
    [
      'updated',
      'desc',
      [
        'ENG-2',
        'ENG-10',
        'ENG-1',
        'OPS-1',
        'OPS-2',
        'ENG-6',
        'OPS-3',
        'ENG-8',
        'ENG-9',
        'ENG-7',
        'ENG-4',
      ],
    ],
    [
      'updated',
      'asc',
      [
        'ENG-7',
        'ENG-2',
        'ENG-10',
        'ENG-1',
        'OPS-1',
        'OPS-2',
        'ENG-6',
        'OPS-3',
        'ENG-8',
        'ENG-9',
        'ENG-4',
      ],
    ],
    [
      'title',
      'asc',
      [
        'ENG-1',
        'ENG-10',
        'ENG-2',
        'ENG-4',
        'ENG-7',
        'ENG-8',
        'ENG-9',
        'OPS-1',
        'OPS-2',
        'OPS-3',
        'ENG-6',
      ],
    ],
    [
      'title',
      'desc',
      [
        'ENG-6',
        'OPS-3',
        'OPS-2',
        'OPS-1',
        'ENG-9',
        'ENG-8',
        'ENG-7',
        'ENG-4',
        'ENG-2',
        'ENG-10',
        'ENG-1',
      ],
    ],
  ] as const)(
    '%s %s; nulls last; ties by the weight key',
    (sort, dir, order) => {
      expect(keys(build({ group: 'none', sort, dir }))).toEqual([...order]);
    }
  );

  test("each sort's default direction; weight has none", () => {
    expect(query({ sort: 'updated' }).dir).toBe('desc');
    expect(query({ sort: 'created' }).dir).toBe('desc');
    expect(query({ sort: 'due' }).dir).toBe('asc');
    expect(query({ sort: 'weight', dir: 'desc' }).dir).toBe('asc');
  });

  test('a field sort orders rows inside groups; groups keep their order', () => {
    expect(layout(build({ sort: 'created' })).slice(0, 1)).toEqual([
      ['t:overdue/m:pa-m1', ['ENG-1', 'ENG-2', 'ENG-10']],
    ]);
  });
});

describe('groups', () => {
  test('by project: active in project order, then No project, then inactive', () => {
    const view = build({ group: 'project' });
    expect(layout(view)).toEqual([
      ['all/p:pa', ['ENG-2', 'ENG-10', 'ENG-1', 'ENG-4', 'ENG-6']],
      ['all/p:pb', ['OPS-1']],
      ['all/p:pc', ['OPS-2', 'OPS-3']],
      ['all/np', ['ENG-7']],
      ['all/p:pz', ['ENG-8', 'ENG-9']],
    ]);
    const groups = view.sections[0]?.groups ?? [];
    expect(groups.map((g) => g.patch)).toEqual([
      { move: { projectId: 'pa', milestoneId: null } },
      { move: { projectId: 'pb', milestoneId: null } },
      { move: { projectId: 'pc', milestoneId: null } },
      { move: { projectId: null, milestoneId: null } },
      { move: { projectId: 'pz', milestoneId: null } },
    ]);
    expect(groups.map((g) => g.muted)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    // The header's facts: lead, next milestone, allocation outcome.
    expect(view.refs.projects['pa']).toEqual({
      name: 'Atlas',
      url: 'https://linear.app/acme/project/pa',
      active: true,
      statusName: 'In Progress',
      leadId: 'lead',
      homeInitiativeId: 'init-a',
      nextMilestoneId: 'pa-m1',
      allocation: { outcome: 'allocate', blockReason: null, gaps: [] },
    });
    expect(view.refs.milestones['pa-m1']).toMatchObject({
      name: 'Dual-write',
      status: 'overdue',
      isNext: true,
      daysLeft: -2,
    });
  });

  test('by milestone: drop patches and muted inactive groups', () => {
    const groups = build().sections.flatMap((s) => s.groups);
    expect(groups.map((g) => [g.key, g.patch, g.muted, g.emptyTarget])).toEqual(
      [
        [
          't:overdue/m:pa-m1',
          { move: { projectId: 'pa', milestoneId: 'pa-m1' } },
          false,
          false,
        ],
        [
          't:upcoming/m:pa-m2',
          { move: { projectId: 'pa', milestoneId: 'pa-m2' } },
          false,
          false,
        ],
        [
          't:upcoming/m:pb-m1',
          { move: { projectId: 'pb', milestoneId: 'pb-m1' } },
          false,
          false,
        ],
        [
          't:upcoming/m:pc-m1',
          { move: { projectId: 'pc', milestoneId: 'pc-m1' } },
          false,
          false,
        ],
        [
          't:unplanned/nm:pa',
          { move: { projectId: 'pa', milestoneId: null } },
          false,
          false,
        ],
        [
          't:unplanned/nm:pc',
          { move: { projectId: 'pc', milestoneId: null } },
          false,
          false,
        ],
        [
          't:unplanned/np',
          { move: { projectId: null, milestoneId: null } },
          false,
          false,
        ],
        [
          't:inactive/m:pz-m1',
          { move: { projectId: 'pz', milestoneId: 'pz-m1' } },
          true,
          false,
        ],
        [
          't:inactive/nm:pz',
          { move: { projectId: 'pz', milestoneId: null } },
          true,
          false,
        ],
      ]
    );
  });

  test('by initiative: initiative order, No initiative, then No project; no drop', () => {
    const view = build({ group: 'initiative' });
    expect(layout(view)).toEqual([
      ['all/i:init-a', ['ENG-2', 'ENG-10', 'ENG-1', 'ENG-4', 'OPS-1', 'ENG-6']],
      ['all/i:init-b', ['OPS-2', 'OPS-3']],
      ['all/i:none', ['ENG-8', 'ENG-9']],
      ['all/np', ['ENG-7']],
    ]);
    expect(view.sections[0]?.groups.map((g) => g.patch)).toEqual([
      null,
      null,
      null,
      { move: { projectId: null, milestoneId: null } },
    ]);
    expect(view.refs.initiatives).toEqual({
      'init-a': { name: 'Alpha' },
      'init-b': { name: 'Bravo' },
    });
  });

  test('by assignee: you, people by name, deactivated, then Unassigned', () => {
    const view = build({ group: 'assignee' });
    expect(layout(view)).toEqual([
      ['all/a:lead', ['ENG-1', 'OPS-3', 'ENG-8']],
      ['all/a:ana', ['ENG-7']],
      ['all/a:wyat', ['ENG-4', 'OPS-2']],
      ['all/a:hugo', ['OPS-1']],
      ['all/a:none', ['ENG-2', 'ENG-10', 'ENG-6', 'ENG-9']],
    ]);
    // A deactivated person's group is no drop target.
    expect(view.sections[0]?.groups.map((g) => g.patch)).toEqual([
      { assigneeId: 'lead' },
      { assigneeId: 'ana' },
      { assigneeId: 'wyat' },
      null,
      { assigneeId: null },
    ]);
    expect(view.refs.people['hugo']).toEqual({ name: 'Hugo', active: false });
  });

  test("an app user's group is no drop target", () => {
    const data = scenario();
    data.issues.push(issue('e12', { identifier: 'ENG-12', assigneeId: 'bot' }));
    const groups = build({ group: 'assignee' }, { data }).sections[0]?.groups;
    expect(groups?.find((g) => g.key === 'all/a:bot')?.patch).toBeNull();
  });

  test('by status: (type, name) across teams, by type then position', () => {
    const view = build({ group: 'state' });
    expect(layout(view)).toEqual([
      ['all/s:backlog:backlog', ['ENG-2', 'ENG-10', 'ENG-6', 'ENG-9']],
      ['all/s:unstarted:todo', ['ENG-4', 'ENG-7', 'ENG-8']],
      // ENG's and OPS's "In Progress" are one group.
      ['all/s:started:in progress', ['ENG-1', 'OPS-1', 'OPS-3']],
      ['all/s:started:blocked', ['OPS-2']],
    ]);
    expect(view.sections[0]?.groups.map((g) => [g.value, g.patch])).toEqual([
      [
        { kind: 'state', stateType: 'backlog', stateName: 'Backlog' },
        { state: { type: 'backlog', name: 'Backlog' } },
      ],
      [
        { kind: 'state', stateType: 'unstarted', stateName: 'Todo' },
        { state: { type: 'unstarted', name: 'Todo' } },
      ],
      [
        { kind: 'state', stateType: 'started', stateName: 'In Progress' },
        { state: { type: 'started', name: 'In Progress' } },
      ],
      [
        { kind: 'state', stateType: 'started', stateName: 'Blocked' },
        { state: { type: 'started', name: 'Blocked' } },
      ],
    ]);
    expect(stateNameKey('  In Review ')).toBe('in review');
  });

  test('by priority: all five groups, even when empty', () => {
    const view = build({ group: 'priority', filters: { teamIds: [OPS] } });
    expect(layout(view)).toEqual([
      ['all/pr:1', []],
      ['all/pr:2', ['OPS-1']],
      ['all/pr:3', []],
      ['all/pr:4', ['OPS-2']],
      ['all/pr:0', ['OPS-3']],
    ]);
    const groups = view.sections[0]?.groups ?? [];
    expect(groups.map((g) => [g.count, g.emptyTarget, g.patch])).toEqual([
      [0, true, { priority: 1 }],
      [1, false, { priority: 2 }],
      [0, true, { priority: 3 }],
      [1, false, { priority: 4 }],
      [1, false, { priority: 0 }],
    ]);
  });

  test('no grouping: one group of every match', () => {
    const view = build({ group: 'none' });
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]?.groups.map((g) => [g.key, g.patch])).toEqual([
      ['all/all', null],
    ]);
  });
});

describe('sections', () => {
  test('by initiative: initiative order, No initiative, No project', () => {
    const view = build({ sections: 'initiative' });
    expect(layout(view)).toEqual([
      ['i:init-a/m:pa-m1', ['ENG-2', 'ENG-10', 'ENG-1']],
      ['i:init-a/m:pa-m2', ['ENG-4']],
      ['i:init-a/m:pb-m1', ['OPS-1']],
      ['i:init-a/nm:pa', ['ENG-6']],
      ['i:init-b/m:pc-m1', ['OPS-2']],
      ['i:init-b/nm:pc', ['OPS-3']],
      ['i:none/m:pz-m1', ['ENG-8']],
      ['i:none/nm:pz', ['ENG-9']],
      ['p:none/np', ['ENG-7']],
    ]);
    expect(view.sections.map((s) => [s.key, s.value, s.count])).toEqual([
      ['i:init-a', { kind: 'initiative', initiativeId: 'init-a' }, 6],
      ['i:init-b', { kind: 'initiative', initiativeId: 'init-b' }, 2],
      ['i:none', { kind: 'initiative', initiativeId: 'none' }, 2],
      ['p:none', { kind: 'no_project' }, 1],
    ]);
  });

  test('by project: active, No project, inactive', () => {
    const view = build({ sections: 'project', group: 'priority' });
    expect(view.sections.map((s) => [s.key, s.count])).toEqual([
      ['p:pa', 5],
      ['p:pb', 1],
      ['p:pc', 2],
      ['p:none', 1],
      ['p:pz', 2],
    ]);
    // Inside sections, only the priorities with matches.
    expect(view.sections[0]?.groups.map((g) => g.key)).toEqual([
      'p:pa/pr:1',
      'p:pa/pr:2',
      'p:pa/pr:3',
      'p:pa/pr:0',
    ]);
  });

  test('invalid pairs reset sections to none', () => {
    expect(
      query({ group: 'initiative', sections: 'initiative' }).sections
    ).toBe('none');
    expect(query({ group: 'project', sections: 'project' }).sections).toBe(
      'none'
    );
    expect(query({ group: 'initiative', sections: 'project' }).sections).toBe(
      'none'
    );
    expect(query({ group: 'project', sections: 'initiative' }).sections).toBe(
      'initiative'
    );
    expect(issueListSectionsAllowed('assignee', 'project')).toBe(true);
    expect(issueListSectionsAllowed('project', 'project')).toBe(false);
    // Another group kind than milestone has one section with no label.
    expect(build({ group: 'assignee' }).sections.map((s) => s.value)).toEqual([
      { kind: 'all' },
    ]);
  });
});

describe('empty milestones as drop targets', () => {
  test("a named project's open milestones are listed with no matches", () => {
    const view = build({
      filters: { projectIds: ['pa'], milestoneIds: ['none'] },
    });
    expect(
      view.sections.flatMap((s) =>
        s.groups.map((g) => [g.key, g.count, g.emptyTarget])
      )
    ).toEqual([
      ['t:overdue/m:pa-m1', 0, true],
      ['t:upcoming/m:pa-m2', 0, true],
      ['t:upcoming/m:pa-m4', 0, true],
      ['t:unplanned/nm:pa', 1, false],
    ]);
    // The complete Prep is not a target. The header knows how much open
    // work each milestone has (the body's two sentences).
    expect(view.refs.milestones['pa-m3']).toBeUndefined();
    expect(view.refs.milestones['pa-m1']?.progress.open).toBe(3);
    expect(view.refs.milestones['pa-m4']?.progress.open).toBe(0);
    expect(view.total).toBe(1);
  });

  test('named milestones are listed; more than five projects list none', () => {
    const named = build({
      filters: { milestoneIds: ['pz-m1', 'pa-m3'], assigneeIds: ['ana'] },
    });
    expect(
      named.sections.flatMap((s) =>
        s.groups.map((g) => [g.key, g.emptyTarget, g.muted])
      )
    ).toEqual([
      ['t:upcoming/m:pa-m3', true, false],
      ['t:inactive/m:pz-m1', true, true],
    ]);
    const many = build({
      filters: {
        projectIds: ['pa', 'pb', 'pc', 'pz', 'p5', 'p6'],
        assigneeIds: ['ana'],
      },
    });
    expect(many.sections).toEqual([]);
    // Only with group by milestone.
    expect(
      build({
        group: 'project',
        filters: { milestoneIds: ['pz-m1'], assigneeIds: ['ana'] },
      }).sections
    ).toEqual([]);
  });
});

describe('budgets', () => {
  // `groups` milestones of one active project with `perGroup` issues each.
  function crowded(groups: number, perGroup: number): WorkspaceData {
    const milestones: Milestone[] = [];
    const issues: Issue[] = [];
    for (let m = 0; m < groups; m++) {
      milestones.push(
        milestone(`m${m}`, 'p1', { targetDate: day(m + 1), sortOrder: m })
      );
      for (let i = 0; i < perGroup; i++) {
        issues.push(
          issue(`m${m}-i${i}`, {
            identifier: `B-${m * perGroup + i + 1}`,
            projectId: 'p1',
            milestoneId: `m${m}`,
            assigneeId: 'lead',
          })
        );
      }
    }
    return workspace({ projects: [project('p1')], milestones, issues });
  }

  test('the row budget walks the groups in order', () => {
    const view = build({}, { data: crowded(3, 300) });
    expect(
      view.sections.flatMap((s) =>
        s.groups.map((g) => [g.count, g.rows.length])
      )
    ).toEqual([
      [300, 300],
      [300, 200],
      [300, 0],
    ]);
    expect(view.total).toBe(900);
    expect(view.shown).toBe(500);
    const more = build({ limit: 1000 }, { data: crowded(3, 300) });
    expect(more.shown).toBe(900);
  });

  test('at most 200 groups; the rest are counted', () => {
    const view = build({}, { data: crowded(250, 1) });
    const groups = view.sections.flatMap((s) => s.groups);
    expect(groups).toHaveLength(ISSUE_LIST_MAX_GROUPS);
    expect(view.moreGroups).toEqual({ groups: 50, issues: 50 });
    expect(view.total).toBe(250);
    expect(view.shown).toBe(200);
    // Refs only for what is shown.
    expect(Object.keys(view.refs.milestones)).toHaveLength(200);
    expect(view.refs.milestones['m249']).toBeUndefined();
  });

  test('the limit is stepped and clamped', () => {
    expect(query({ limit: 7 }).limit).toBe(500);
    expect(query({ limit: 501 }).limit).toBe(1000);
    expect(query({ limit: 1500 }).limit).toBe(1500);
    expect(query({ limit: 99_999 }).limit).toBe(2000);
    expect(query({ limit: Number.NaN }).limit).toBe(500);
    expect(normalizeIssueListQuery({ limit: '1000' }).limit).toBe(1000);
  });
});

describe('refs', () => {
  test('only what rows, groups and filter values reference', () => {
    const view = build({ filters: { projectIds: ['pc'] } });
    expect(Object.keys(view.refs.projects)).toEqual(['pc']);
    expect(Object.keys(view.refs.milestones).sort()).toEqual(['pc-m1']);
    expect(view.refs.people).toEqual({
      wyat: { name: 'Wyat', active: true },
      lead: { name: 'Lead', active: true },
    });
    expect(view.refs.teams).toEqual({
      [OPS]: { key: 'OPS', name: 'Operations' },
    });
    expect(view.refs.initiatives).toEqual({ 'init-b': { name: 'Bravo' } });
  });
});

describe('preset counts', () => {
  test('each equals its own preset total, whatever the current filters', () => {
    const narrowed = build({ filters: { teamIds: [OPS], q: 'issue' } });
    const counts = build().counts;
    expect(narrowed.counts).toEqual(counts);
    for (const [id, filters] of Object.entries(ISSUE_LIST_PRESETS) as [
      IssueListPresetId,
      IssueListFilters,
    ][]) {
      expect(build({ filters }).total).toBe(counts[id]);
      expect(
        sameIssueListFilters(build({ filters }).query.filters, filters)
      ).toBe(true);
    }
  });

  test('sameIssueListFilters compares each field as a set', () => {
    const base = ISSUE_LIST_PRESETS.all;
    expect(
      sameIssueListFilters(
        { ...base, stateTypes: ['started', 'triage', 'backlog', 'unstarted'] },
        base
      )
    ).toBe(true);
    expect(sameIssueListFilters({ ...base, q: 'x' }, base)).toBe(false);
    expect(
      sameIssueListFilters(
        ISSUE_LIST_PRESETS.mine,
        ISSUE_LIST_PRESETS.unassigned
      )
    ).toBe(false);
  });
});

describe('normalizeIssueListQuery', () => {
  test('drops bad values and never throws', () => {
    for (const raw of [null, undefined, 5, 'x', [], { filters: 'x' }]) {
      expect(normalizeIssueListQuery(raw)).toEqual(DEFAULT_ISSUE_LIST_QUERY);
    }
    const long = 'x'.repeat(201);
    const normalized = normalizeIssueListQuery({
      filters: {
        q: `  ${'é'.repeat(250)}  `,
        projectIds: [1, '', ' p1 ', 'p1', long, null, 'p2'],
        milestoneIds: 'm1, ,m2,m1',
        assigneeIds: Array.from({ length: 60 }, (_, i) => `u${i}`),
        stateTypes: ['bogus', 'completed', 'completed'],
        priorities: [9, '2', 2, 'x', 0, 1.5],
        quick: ['blocked', 'nope'],
        teamIds: {},
      },
      group: 'bogus',
      sections: 'project',
      sort: 'nope',
      dir: 'sideways',
      limit: 'many',
    });
    expect(normalized).toEqual({
      filters: {
        q: 'é'.repeat(200),
        initiativeIds: [],
        projectIds: ['p1', 'p2'],
        milestoneIds: ['m1', 'm2'],
        assigneeIds: Array.from({ length: 50 }, (_, i) => `u${i}`),
        teamIds: [],
        stateTypes: ['completed'],
        priorities: [2, 0],
        quick: ['blocked'],
      },
      group: 'milestone',
      sections: 'project',
      sort: 'weight',
      dir: 'asc',
      limit: 500,
    });
    expect(Object.isFrozen(DEFAULT_ISSUE_LIST_QUERY.filters.stateTypes)).toBe(
      true
    );
  });
});

describe('buildIssueListOptions', () => {
  test('initiatives, projects active first with milestones, people, teams', () => {
    const evaluated = evaluate(scenario(), {
      meta: [meta('pa-m2', { weight: 2 })],
    });
    const options = buildIssueListOptions(
      evaluated.snapshot,
      evaluated.ctx,
      evaluated.assessments
    );
    expect(options.initiatives).toEqual([
      { id: 'init-a', name: 'Alpha' },
      { id: 'init-b', name: 'Bravo' },
    ]);
    expect(
      options.projects.map((p) => [p.id, p.active, p.homeInitiativeId])
    ).toEqual([
      ['pa', true, 'init-a'],
      ['pb', true, 'init-a'],
      ['pc', true, 'init-b'],
      ['pz', false, null],
    ]);
    expect(options.projects[0]?.milestones).toEqual([
      {
        id: 'pa-m3',
        name: 'Prep',
        targetDate: day(-10),
        daysLeft: -10,
        status: 'complete',
        isNext: false,
        weight: null,
      },
      {
        id: 'pa-m1',
        name: 'Dual-write',
        targetDate: day(-2),
        daysLeft: -2,
        status: 'overdue',
        isNext: true,
        weight: null,
      },
      {
        id: 'pa-m2',
        name: 'Cutover',
        targetDate: day(10),
        daysLeft: 10,
        status: 'on_track',
        isNext: false,
        weight: 2,
      },
      {
        id: 'pa-m4',
        name: 'Cleanup',
        targetDate: day(30),
        daysLeft: 30,
        status: 'empty',
        isNext: false,
        weight: null,
      },
    ]);
    // People: no app users; active first, by folded name.
    expect(options.people.map((p) => [p.id, p.active])).toEqual([
      ['ana', true],
      ['lead', true],
      ['wyat', true],
      ['hugo', false],
    ]);
    expect(options.teams.map((t) => t.key)).toEqual(['ENG', 'OPS']);
    expect(options.teams[1]?.states.map((s) => s.name)).toEqual([
      'Triage',
      'Backlog',
      'Todo',
      'In Progress',
      'Blocked',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
  });
});
