import type {
  DependencyGraph,
  GraphEdge,
  MilestoneAssessment,
  MilestoneDetail,
  ProjectAllocationPlan,
  Progress,
  TimelineBar,
  TimelineLane,
  TimelineView,
  User,
} from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  barTags,
  buildMilestoneDrawer,
  buildTimelineBanners,
  buildTimelinePage,
  chartDependencies,
  DEFAULT_TIMELINE_STATE,
  filterTimelineGroups,
  laneSublabel,
  leadOptions,
  laneNeedsAction,
  needsWriteGrant,
  parseTimelineSearch,
  parseTimelineSelection,
  parseTimelineState,
  SHOW_OPTIONS,
  showFilters,
  timelineHref,
  timelineReceipts,
  timelineShow,
  toChartBar,
  toChartGroups,
  visibleDependencies,
  weightLabel,
  weightTag,
} from '../lib/adapters/timeline';

// Hand-built engine view models: only the fields the timeline reads are
// meaningful; the rest are plausible defaults (Wed Oct 21, 2026).

const TODAY = '2026-10-21';
const PM = { isPm: true, canWriteLinear: true };
const PM_READ_ONLY = { isPm: true, canWriteLinear: false };
const MEMBER = { isPm: false, canWriteLinear: true };

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    total: 4,
    completed: 1,
    canceled: 0,
    scope: 4,
    open: 3,
    openUnassigned: 0,
    openTriage: 0,
    ...overrides,
  };
}

function bar(overrides: Partial<TimelineBar> = {}): TimelineBar {
  return {
    milestoneId: 'ms-1',
    name: 'Dual-write',
    projectId: 'proj-1',
    start: '2026-10-01',
    end: '2026-10-28',
    status: 'on_track',
    reasons: [],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both stores agree', source: 'planner' },
    progress: progress(),
    isNext: false,
    daysLeft: 7,
    weight: null,
    ...overrides,
  };
}

function plan(
  overrides: Partial<ProjectAllocationPlan> = {}
): ProjectAllocationPlan {
  return {
    projectId: 'proj-1',
    outcome: 'nothing_to_do',
    nextMilestoneId: 'ms-1',
    blockReason: null,
    gaps: [],
    actions: [],
    skipped: [],
    ...overrides,
  };
}

function lane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    projectId: 'proj-1',
    name: 'Atlas billing migration',
    url: 'https://linear.app/northwind/project/atlas',
    leadId: 'user-chloe',
    leadName: 'Chloe Diaz',
    priority: 1,
    statusType: 'started',
    active: true,
    bars: [bar()],
    undated: [],
    unplannedIssueIds: [],
    allocation: plan(),
    ...overrides,
  };
}

function view(
  groups: { id: string | null; name: string; lanes: TimelineLane[] }[],
  banners: Partial<TimelineView['banners']> = {}
): TimelineView {
  return {
    today: TODAY,
    windowStart: '2026-10-07',
    windowEnd: '2026-12-30',
    groups: groups.map((g) => ({
      initiativeId: g.id,
      name: g.name,
      lanes: g.lanes,
    })),
    banners: {
      projectsWithoutLead: [],
      milestonesWithoutDate: [],
      issuesWithoutMilestone: { count: 0, byProject: [] },
      blockedProjects: [],
      ...banners,
    },
  };
}

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: 'ms-a',
    to: 'ms-b',
    resolved: false,
    crossProject: true,
    crossOwner: true,
    inCycle: false,
    onRiskChain: false,
    weight: 1,
    ...overrides,
  };
}

describe('chart bars', () => {
  test('a rubric-invalid on-track bar is a missing input with its gaps', () => {
    const out = toChartBar(
      bar({ rubric: { valid: false, gaps: ['no_done_means', 'no_issues'] } }),
      true
    );
    expect(out.status).toBe('missing');
    expect(out.statusLabel).toBe('Missing input');
    expect(out.missing).toBe('Missing: done means…, issues');
  });

  test('overdue and at-risk keep their marks and still say what is missing', () => {
    const overdue = toChartBar(
      bar({
        status: 'overdue',
        daysLeft: -3,
        rubric: { valid: false, gaps: ['no_project_lead'] },
      }),
      true
    );
    expect(overdue.status).toBe('overdue');
    expect(overdue.missing).toBe('Missing: project lead');
    const atRisk = toChartBar(bar({ status: 'at_risk' }), true);
    expect(atRisk.status).toBe('at_risk');
    expect(atRisk.missing).toBeUndefined();
  });

  test('NEXT and the weight override are tags; progress is completed/scope', () => {
    const out = toChartBar(
      bar({
        isNext: true,
        weight: 2,
        progress: progress({ completed: 3, scope: 7 }),
      }),
      false
    );
    expect(out.tags).toEqual(['Next', '↑2']);
    expect(out.progressLabel).toBe('3/7');
    expect(barTags(bar({ weight: -3 }))).toEqual(['↓3']);
    expect(barTags(bar({ weight: 0 }))).toEqual([]);
    expect(weightTag(null)).toBeNull();
  });

  test('only open bars get the re-date handle, and only when editing is allowed', () => {
    expect(toChartBar(bar(), true).editable).toBe(true);
    expect(toChartBar(bar(), false).editable).toBeUndefined();
    const done = toChartBar(
      bar({
        status: 'complete',
        rubric: { valid: false, gaps: ['no_done_means'] },
      }),
      true
    );
    expect(done.editable).toBeUndefined();
    expect(done.status).toBe('done');
    // A finished milestone needs no action, so no missing line either.
    expect(done.missing).toBeUndefined();
  });

  test('the editable flag follows the actor: PM with Linear write access only', () => {
    const v = view([{ id: 'init-1', name: 'Platform', lanes: [lane()] }]);
    const editable = (p: typeof PM) =>
      toChartGroups(v, p)[0]?.lanes[0]?.bars[0]?.editable === true;
    expect(editable(PM)).toBe(true);
    expect(editable(PM_READ_ONLY)).toBe(false);
    expect(editable(MEMBER)).toBe(false);
    expect(needsWriteGrant(PM_READ_ONLY)).toBe(true);
    expect(needsWriteGrant(PM)).toBe(false);
    expect(needsWriteGrant({ isPm: false, canWriteLinear: false })).toBe(false);
  });
});

describe('lanes', () => {
  test('sublabel: lead, NO LEAD in the accent, deactivated, inactive', () => {
    expect(laneSublabel(lane())).toEqual({
      sublabel: 'Chloe Diaz',
      tone: 'default',
    });
    expect(laneSublabel(lane({ leadId: null, leadName: null }))).toEqual({
      sublabel: 'No lead',
      tone: 'accent',
    });
    expect(
      laneSublabel(
        lane({
          allocation: plan({
            outcome: 'blocked',
            blockReason: 'lead_inactive',
          }),
        })
      )
    ).toEqual({ sublabel: 'Chloe Diaz · deactivated', tone: 'accent' });
    expect(laneSublabel(lane({ active: false }))).toEqual({
      sublabel: 'Inactive · Chloe Diaz',
      tone: 'default',
    });
  });

  test('groups map initiatives (and none) with muted inactive lanes and undated chips', () => {
    const groups = toChartGroups(
      view([
        { id: 'init-1', name: 'Platform', lanes: [lane()] },
        {
          id: null,
          name: 'No initiative',
          lanes: [
            lane({
              projectId: 'proj-2',
              active: false,
              bars: [],
              undated: [
                bar({
                  milestoneId: 'ms-u',
                  name: 'Localization',
                  end: null,
                  status: 'unscheduled',
                  rubric: { valid: false, gaps: ['no_target_date'] },
                }),
              ],
            }),
          ],
        },
      ]),
      PM
    );
    expect(groups.map((g) => g.id)).toEqual(['init-1', 'none']);
    const inactive = groups[1]?.lanes[0];
    expect(inactive?.muted).toBe(true);
    expect(inactive?.undated).toEqual([
      {
        id: 'ms-u',
        label: 'Localization',
        status: 'missing',
        statusLabel: 'No target date',
      },
    ]);
    expect(groups[0]?.lanes[0]?.muted).toBeUndefined();
  });
});

describe('dependencies', () => {
  test('milestone edges become connectors, one per pair', () => {
    const graph: DependencyGraph = {
      scope: { level: 'milestone' },
      nodes: [],
      edges: [
        edge(),
        edge({ onRiskChain: true }),
        edge({ from: 'ms-c', to: 'ms-c' }),
        edge({ from: 'ms-c', to: 'ms-b' }),
      ],
      cycles: [],
    };
    expect(chartDependencies(graph)).toEqual([
      { from: 'ms-a', to: 'ms-b', onRiskChain: true },
      { from: 'ms-c', to: 'ms-b', onRiskChain: false },
    ]);
    expect(
      chartDependencies({
        ...graph,
        scope: { level: 'issue', milestoneId: 'ms-a' },
      })
    ).toEqual([]);
  });

  test('connectors whose ends are filtered out are dropped', () => {
    const groups = toChartGroups(
      view([
        {
          id: 'i',
          name: 'I',
          lanes: [
            lane({
              bars: [
                bar({ milestoneId: 'ms-a' }),
                bar({ milestoneId: 'ms-b' }),
              ],
            }),
          ],
        },
      ]),
      PM
    );
    const deps = [
      { from: 'ms-a', to: 'ms-b', onRiskChain: false },
      { from: 'ms-x', to: 'ms-b', onRiskChain: true },
    ];
    expect(visibleDependencies(deps, groups)).toEqual([deps[0]]);
  });
});

describe('filters and the URL', () => {
  const groups = toChartGroups(
    view([
      {
        id: 'init-1',
        name: 'Platform',
        lanes: [
          lane({ projectId: 'p-atlas', name: 'Atlas billing migration' }),
          lane({
            projectId: 'p-harbor',
            name: 'Harbor API',
            bars: [bar({ milestoneId: 'ms-h', status: 'at_risk' })],
          }),
        ],
      },
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            projectId: 'p-fjord',
            name: 'Fjord analytics',
            active: false,
            bars: [bar({ milestoneId: 'ms-f', status: 'overdue' })],
          }),
        ],
      },
    ]),
    PM
  );
  const ids = (out: ReturnType<typeof filterTimelineGroups>) =>
    out.flatMap((g) => g.lanes.map((l) => l.id));

  test('search, initiative, only active and only at risk / overdue', () => {
    const base = DEFAULT_TIMELINE_STATE;
    expect(ids(filterTimelineGroups(groups, base))).toEqual([
      'p-atlas',
      'p-harbor',
      'p-fjord',
    ]);
    expect(
      ids(filterTimelineGroups(groups, { ...base, query: 'HARB' }))
    ).toEqual(['p-harbor']);
    expect(
      ids(filterTimelineGroups(groups, { ...base, initiative: 'none' }))
    ).toEqual(['p-fjord']);
    expect(
      ids(filterTimelineGroups(groups, { ...base, activeOnly: true }))
    ).toEqual(['p-atlas', 'p-harbor']);
    // An inactive lane is never "at risk / overdue" (§2.8), whatever its
    // milestones' status: Fjord's overdue bar does not count.
    expect(
      ids(filterTimelineGroups(groups, { ...base, riskOnly: true }))
    ).toEqual(['p-harbor']);
    // Empty groups are dropped.
    expect(
      filterTimelineGroups(groups, { ...base, query: 'atlas' }).map((g) => g.id)
    ).toEqual(['init-1']);
  });

  test('laneNeedsAction: an at-risk or overdue bar in an active lane only', () => {
    const lanes = groups.flatMap((g) => g.lanes);
    expect(lanes.map((l) => [l.id, laneNeedsAction(l)])).toEqual([
      ['p-atlas', false],
      ['p-harbor', true],
      ['p-fjord', false],
    ]);
  });

  test('Show is one choice over the two nested URL filters', () => {
    expect(SHOW_OPTIONS.map((o) => o.id)).toEqual(['all', 'active', 'at_risk']);
    const base = DEFAULT_TIMELINE_STATE;
    expect(timelineShow(base)).toBe('all');
    expect(timelineShow({ ...base, activeOnly: true })).toBe('active');
    expect(timelineShow({ ...base, riskOnly: true })).toBe('at_risk');
    // Both set (an old link) reads as At risk, which only keeps active lanes.
    expect(timelineShow({ ...base, activeOnly: true, riskOnly: true })).toBe(
      'at_risk'
    );
    expect(showFilters('all')).toEqual({ activeOnly: false, riskOnly: false });
    expect(showFilters('active')).toEqual({
      activeOnly: true,
      riskOnly: false,
    });
    expect(showFilters('at_risk')).toEqual({
      activeOnly: false,
      riskOnly: true,
    });
    expect(showFilters('nonsense')).toEqual({
      activeOnly: false,
      riskOnly: false,
    });
    expect(timelineHref({ ...base, ...showFilters('at_risk') })).toBe(
      '/timeline?risk=1'
    );
  });

  test('parseTimelineSearch reads the address bar as the server does', () => {
    const href =
      '/timeline?project=p-1&milestone=ms-1&q=atlas+api&initiative=init-1&risk=1&zoom=months&deps=1';
    const search = new URL(href, 'http://x').searchParams;
    expect(parseTimelineSearch(search)).toEqual(
      parseTimelineState(Object.fromEntries(search.entries()))
    );
    expect(parseTimelineSearch(search)).toEqual({
      query: 'atlas api',
      initiative: 'init-1',
      activeOnly: false,
      riskOnly: true,
      zoom: 'months',
      showDependencies: true,
    });
    // A plain /timeline (the sidebar link) is the default state.
    expect(parseTimelineSearch(new URLSearchParams(''))).toEqual(
      DEFAULT_TIMELINE_STATE
    );
    // The first of a repeated key wins, and long values are capped.
    const repeated = new URLSearchParams(
      `q=a&q=b&initiative=${'x'.repeat(300)}`
    );
    expect(parseTimelineSearch(repeated).query).toBe('a');
    expect(parseTimelineSearch(repeated).initiative).toHaveLength(200);
    // What the island writes reads back as the same state.
    const state = {
      ...DEFAULT_TIMELINE_STATE,
      query: 'harbor',
      activeOnly: true,
    };
    const written = timelineHref(state, { projectId: 'p-2' });
    expect(
      parseTimelineSearch(new URL(written, 'http://x').searchParams)
    ).toEqual(state);
  });

  test('state round-trips through the URL and defaults are left out', () => {
    expect(timelineHref(DEFAULT_TIMELINE_STATE)).toBe('/timeline');
    const state = {
      query: 'atlas',
      initiative: 'init-1',
      activeOnly: true,
      riskOnly: true,
      zoom: 'months' as const,
      showDependencies: true,
    };
    const href = timelineHref(state, {
      projectId: 'p-atlas',
      milestoneId: 'ms-1',
    });
    expect(href).toBe(
      '/timeline?project=p-atlas&milestone=ms-1&q=atlas&initiative=init-1&active=1&risk=1&zoom=months&deps=1'
    );
    const params = Object.fromEntries(
      new URL(href, 'http://x').searchParams.entries()
    );
    expect(parseTimelineState(params)).toEqual(state);
    expect(parseTimelineSelection(params)).toEqual({
      milestoneId: 'ms-1',
      projectId: 'p-atlas',
    });
    expect(
      parseTimelineState({ zoom: 'decades', deps: 'yes', q: ['a', 'b'] })
    ).toEqual({ ...DEFAULT_TIMELINE_STATE, query: 'a' });
    expect(parseTimelineSelection({ milestone: '  ' })).toEqual({
      milestoneId: null,
      projectId: null,
    });
  });
});

describe('banners', () => {
  test('nothing missing → no banners', () => {
    expect(
      buildTimelineBanners(
        view([{ id: null, name: 'N', lanes: [lane()] }]),
        new Map()
      )
    ).toEqual([]);
  });

  test('counts expand to lists; blocked-by-rubric opens the next milestone', () => {
    const v = view(
      [
        {
          id: null,
          name: 'N',
          lanes: [
            lane({
              projectId: 'p-harbor',
              allocation: plan({
                projectId: 'p-harbor',
                outcome: 'blocked',
                blockReason: 'next_milestone_invalid',
                nextMilestoneId: 'ms-beta',
                gaps: ['no_done_means'],
              }),
            }),
          ],
        },
      ],
      {
        projectsWithoutLead: [{ projectId: 'p-delta', name: 'Delta exports' }],
        milestonesWithoutDate: [
          {
            milestoneId: 'ms-loc',
            name: 'Localization',
            projectId: 'p-compass',
            projectName: 'Compass onboarding',
          },
        ],
        issuesWithoutMilestone: {
          count: 3,
          byProject: [
            { projectId: 'p-atlas', name: 'Atlas', issueIds: ['i1', 'i2'] },
            { projectId: 'p-beacon', name: 'Beacon', issueIds: ['i3'] },
          ],
        },
        blockedProjects: [
          {
            projectId: 'p-harbor',
            name: 'Harbor API v3',
            reason: 'next_milestone_invalid',
            gaps: ['no_done_means'],
          },
          {
            projectId: 'p-delta',
            name: 'Delta exports',
            reason: 'no_lead',
            gaps: [],
          },
        ],
      }
    );
    const issues = new Map([
      ['i1', { identifier: 'ENG-1', url: 'https://linear.app/i/ENG-1' }],
      ['i2', { identifier: 'ENG-2', url: 'https://linear.app/i/ENG-2' }],
      ['i3', { identifier: 'OPS-3', url: 'https://linear.app/i/OPS-3' }],
    ]);
    const banners = buildTimelineBanners(v, issues);
    expect(banners.map((b) => [b.id, b.count])).toEqual([
      ['no_lead', 1],
      ['no_date', 1],
      ['unplanned', 3],
      ['blocked', 2],
    ]);
    expect(banners[0]?.text).toBe(
      '1 active project has no lead: nothing in it is allocated.'
    );
    expect(banners[1]?.items[0]).toEqual({
      id: 'ms-loc',
      label: 'Compass onboarding › Localization',
      target: { milestoneId: 'ms-loc', projectId: 'p-compass' },
    });
    expect(banners[2]?.text).toBe(
      '3 open issues in 2 projects have no milestone, so they are never allocated. Attach or cancel them in Linear.'
    );
    expect(banners[2]?.items[0]?.links?.map((l) => l.label)).toEqual([
      'ENG-1',
      'ENG-2',
    ]);
    expect(banners[3]?.items).toEqual([
      {
        id: 'p-harbor',
        label: 'Harbor API v3',
        detail: 'Next milestone is missing: done means…',
        target: { milestoneId: 'ms-beta', projectId: 'p-harbor' },
      },
      {
        id: 'p-delta',
        label: 'Delta exports',
        detail: 'Project has no lead',
        target: { projectId: 'p-delta' },
      },
    ]);
  });

  test('one of a kind reads in the singular', () => {
    const banners = buildTimelineBanners(
      view([{ id: null, name: 'N', lanes: [lane()] }], {
        milestonesWithoutDate: [
          {
            milestoneId: 'ms-loc',
            name: 'Localization',
            projectId: 'p-compass',
            projectName: 'Compass onboarding',
          },
        ],
        issuesWithoutMilestone: {
          count: 1,
          byProject: [{ projectId: 'p-a', name: 'Atlas', issueIds: ['gone'] }],
        },
        blockedProjects: [
          { projectId: 'p-a', name: 'Atlas', reason: 'no_lead', gaps: [] },
        ],
      }),
      new Map()
    );
    expect(banners.map((b) => b.text)).toEqual([
      '1 milestone has no target date, so it fails the rubric and gets no warnings.',
      '1 open issue has no milestone, so it is never allocated. Attach it to one in Linear, or cancel it.',
      'Allocation is stopped in 1 project until the missing input is fixed.',
    ]);
    // An issue the mirror no longer has is counted but not linked.
    expect(banners[1]?.items[0]?.links).toEqual([]);
  });

  test('receipts count lanes, milestones, overdue and at risk', () => {
    const v = view([
      {
        id: null,
        name: 'N',
        lanes: [
          lane({
            bars: [bar({ status: 'overdue' }), bar({ status: 'at_risk' })],
            undated: [bar({ end: null, status: 'unscheduled' })],
          }),
        ],
      },
    ]);
    expect(timelineReceipts(v)).toBe(
      '1 project · 3 milestones · 1 overdue · 1 at risk · Oct 7 – Dec 30'
    );
    // An inactive lane's milestones are listed but never counted overdue
    // or at risk; the project count says how many lanes are inactive.
    const withInactive = view([
      {
        id: null,
        name: 'N',
        lanes: [
          lane({
            bars: [bar({ status: 'overdue' }), bar({ status: 'at_risk' })],
          }),
          lane({
            projectId: 'p-fjord',
            active: false,
            bars: [bar({ status: 'overdue' }), bar({ status: 'at_risk' })],
          }),
        ],
      },
    ]);
    expect(timelineReceipts(withInactive)).toBe(
      '2 projects (1 inactive) · 4 milestones · 1 overdue · 1 at risk · Oct 7 – Dec 30'
    );
    const page = buildTimelinePage({
      view: v,
      graph: {
        scope: { level: 'milestone' },
        nodes: [],
        edges: [],
        cycles: [],
      },
      permissions: MEMBER,
      issues: new Map(),
    });
    expect(page.canEditLinear).toBe(false);
    expect(page.canEditMeta).toBe(false);
    expect(page.banners).toEqual([]);
  });
});

/* ---- drawer ------------------------------------------------------------ */

function user(id: string, name: string, extra: Partial<User> = {}): User {
  return {
    id,
    name,
    displayName: name.split(' ')[0] ?? name,
    email: null,
    avatarUrl: null,
    active: true,
    app: false,
    ...extra,
  };
}

const USERS: User[] = [
  user('user-chloe', 'Chloe Diaz'),
  user('user-ana', 'Ana Moreno'),
  user('user-old', 'Olga Old', { active: false }),
  user('user-app', 'Milestone Planner', { app: true }),
];

function assessment(
  overrides: Partial<MilestoneAssessment> = {}
): MilestoneAssessment {
  return {
    milestoneId: 'ms-1',
    projectId: 'proj-1',
    status: 'overdue',
    daysLeft: -3,
    reasons: ['unassigned_open', 'behind_pace'],
    progress: progress({
      completed: 0,
      canceled: 1,
      total: 5,
      scope: 4,
      open: 4,
    }),
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both ledgers agree', source: 'linear_description' },
    isNext: true,
    lastStateChangeAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<MilestoneDetail> = {}): MilestoneDetail {
  return {
    milestone: {
      id: 'ms-1',
      projectId: 'proj-1',
      name: 'Dual-write',
      description: 'Done means: Both ledgers agree',
      targetDate: '2026-10-18',
      sortOrder: 1,
    },
    project: {
      id: 'proj-1',
      name: 'Atlas billing migration',
      url: 'https://linear.app/northwind/project/atlas',
      leadId: 'user-chloe',
      priority: 1,
      sortOrder: 1,
      statusType: 'started',
      statusName: 'In Progress',
      initiativeIds: [],
      teamIds: [],
      startDate: null,
      targetDate: null,
    },
    leadName: 'Chloe Diaz',
    assessment: assessment(),
    meta: null,
    issues: [
      {
        issueId: 'i1',
        identifier: 'ENG-1',
        title: 'Write both ledgers',
        url: 'https://linear.app/i/ENG-1',
        priority: 2,
        stateName: 'In Progress',
        stateType: 'started',
        assigneeId: null,
        assigneeName: null,
        blockedByIds: ['i2', 'x9'],
      },
      {
        issueId: 'i2',
        identifier: 'ENG-2',
        title: 'Shadow reads',
        url: 'https://linear.app/i/ENG-2',
        priority: 3,
        stateName: 'Done',
        stateType: 'completed',
        assigneeId: 'user-chloe',
        assigneeName: 'Chloe Diaz',
        blockedByIds: [],
      },
    ],
    waitsOn: [
      {
        milestoneId: 'ms-schema',
        name: 'Schema cutover',
        projectName: 'Atlas',
      },
    ],
    ...overrides,
  };
}

const LIMITS = { doneMeansMax: 280, weightMin: -1000, weightMax: 1000 };
const ISSUES = new Map([
  ['x9', { identifier: 'OPS-9', url: 'https://linear.app/i/OPS-9' }],
]);

function drawer(
  d: MilestoneDetail = detail(),
  permissions: typeof PM = PM
): ReturnType<typeof buildMilestoneDrawer> {
  return buildMilestoneDrawer({
    detail: d,
    today: TODAY,
    permissions,
    users: USERS,
    issues: ISSUES,
    limits: LIMITS,
  });
}

describe('milestone drawer', () => {
  test('header, overdue strip, status lines and due label', () => {
    const m = drawer();
    expect(m.breadcrumb).toBe('Atlas billing migration / Dual-write');
    expect(m.linearUrl).toBe('https://linear.app/northwind/project/atlas');
    expect(m.path).toBe('/timeline?milestone=ms-1');
    expect(m.overdueText).toBe('Overdue by 3 days.');
    expect(m.status).toEqual({
      status: 'overdue',
      label: 'Overdue',
      lines: ['Open issues unassigned', 'More work left than time left'],
    });
    expect(m.due).toEqual({
      value: '2026-10-18',
      label: 'Oct 18 · 3 days overdue',
      tone: 'accent',
    });
    expect(m.progress).toEqual({
      done: 0,
      total: 4,
      canceled: 1,
      tone: 'accent',
    });
    expect(m.isNext).toBe(true);
    expect(m.graphHref).toBe('/graph?milestone=ms-1');
    expect(m.waitsOn).toEqual([
      { id: 'ms-schema', label: 'Atlas › Schema cutover' },
    ]);
    expect(
      drawer(detail({ assessment: assessment({ daysLeft: -1 }) })).overdueText
    ).toBe('Overdue by 1 day.');
    expect(
      drawer(
        detail({
          assessment: assessment({
            status: 'on_track',
            daysLeft: 3,
            reasons: [],
          }),
        })
      ).overdueText
    ).toBeNull();
  });

  test('issues carry state, assignee and blocker keys (in or out of the milestone)', () => {
    const [first, second] = drawer().issues;
    expect(first).toEqual({
      id: 'i1',
      key: 'ENG-1',
      title: 'Write both ledgers',
      url: 'https://linear.app/i/ENG-1',
      state: 'In Progress',
      stateKind: 'started',
      open: true,
      assignee: null,
      blockedBy: ['ENG-2', 'OPS-9'],
    });
    expect(second?.open).toBe(false);
  });

  test('edit controls follow permissions; leads are active people only', () => {
    expect(drawer().permissions).toEqual({
      canEditLinear: true,
      canEditMeta: true,
    });
    expect(drawer(detail(), PM_READ_ONLY).permissions).toEqual({
      canEditLinear: false,
      canEditMeta: true,
    });
    expect(drawer(detail(), MEMBER).permissions).toEqual({
      canEditLinear: false,
      canEditMeta: false,
    });
    expect(drawer(detail(), MEMBER).leadOptions).toEqual([]);
    expect(drawer().leadOptions).toEqual([
      { id: 'user-ana', label: 'Ana Moreno' },
      { id: 'user-chloe', label: 'Chloe Diaz' },
    ]);
    // A deactivated current lead stays listed, but cannot be picked again.
    expect(leadOptions(USERS, 'user-old')[0]).toEqual({
      id: 'user-old',
      label: 'Olga Old (deactivated)',
      disabled: true,
    });
  });

  test('weight and "done means…" with their sources', () => {
    const m = drawer();
    expect(m.weight).toEqual({ value: null, label: 'None · date order' });
    expect(m.doneMeans).toEqual({
      text: 'Both ledgers agree',
      sourceLabel: 'From the Linear description',
      plannerText: '',
    });
    const withMeta = drawer(
      detail({
        meta: {
          milestoneId: 'ms-1',
          weight: 2,
          doneMeans: 'Zero drift for a week',
          updatedAt: '2026-10-20T00:00:00.000Z',
          updatedBy: 'user-ana',
        },
        assessment: assessment({
          doneMeans: { text: 'Zero drift for a week', source: 'planner' },
        }),
      })
    );
    expect(withMeta.weight).toEqual({ value: 2, label: '↑2' });
    expect(withMeta.doneMeans.sourceLabel).toBe('Written in the planner');
    expect(withMeta.doneMeans.plannerText).toBe('Zero drift for a week');
    expect(weightLabel(-4)).toBe('↓4');
    expect(weightLabel(0)).toBe('0 · date order');
  });

  test('the rubric is four items worded with the gap labels when missing', () => {
    const met = drawer().rubric;
    expect(met.map((i) => [i.label, i.met, i.note])).toEqual([
      ['Target date', true, 'Oct 18'],
      ['"Done means…"', true, 'From the Linear description'],
      ['Project lead', true, 'Chloe Diaz'],
      ['At least one issue', true, '5 issues'],
    ]);
    const missing = drawer(
      detail({
        milestone: { ...detail().milestone, targetDate: null },
        leadName: null,
        project: { ...detail().project, leadId: null },
        assessment: assessment({
          status: 'empty',
          daysLeft: null,
          rubric: {
            valid: false,
            gaps: [
              'no_target_date',
              'no_done_means',
              'no_project_lead',
              'no_issues',
            ],
          },
        }),
      }),
      MEMBER
    ).rubric;
    expect(missing.map((i) => [i.met, i.note])).toEqual([
      [false, 'Missing a target date. Set it in Linear.'],
      [
        false,
        'Missing "done means…". Start a line of the Linear description with "Done means:".',
      ],
      [false, 'Project has no lead. Set a lead in Linear.'],
      [false, 'No issues yet. Add issues to this milestone in Linear.'],
    ]);
  });

  test('"Next milestone" says when allocation is stopped, or which one is next', () => {
    const next = bar({ milestoneId: 'ms-1', name: 'Dual-write', isNext: true });
    const later = bar({ milestoneId: 'ms-2', name: 'Read path switch' });
    const blocked = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            bars: [next, later],
            allocation: plan({
              outcome: 'blocked',
              blockReason: 'lead_inactive',
            }),
          }),
        ],
      },
    ]);
    const withView = (d: MilestoneDetail, v: TimelineView) =>
      buildMilestoneDrawer({
        detail: d,
        today: TODAY,
        permissions: PM,
        users: USERS,
        issues: ISSUES,
        limits: LIMITS,
        view: v,
      });
    expect(withView(detail(), blocked).next).toEqual({
      value: 'Yes',
      note: 'Allocation stopped · Project lead is deactivated',
      tone: 'accent',
    });
    // A later milestone names the next one.
    const notNext = detail({
      milestone: {
        ...detail().milestone,
        id: 'ms-2',
        name: 'Read path switch',
      },
      assessment: assessment({ milestoneId: 'ms-2', isNext: false }),
    });
    expect(withView(notNext, blocked).next).toEqual({
      value: 'No',
      note: 'Dual-write is next',
      tone: 'default',
    });
    // Allocating normally: nothing to add. Inactive: said quietly.
    const running = view([
      { id: null, name: 'No initiative', lanes: [lane({ bars: [next] })] },
    ]);
    expect(withView(detail(), running).next).toEqual({
      value: 'Yes',
      note: null,
      tone: 'default',
    });
    const paused = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            bars: [next],
            active: false,
            statusType: 'paused',
            allocation: plan({ outcome: 'inactive' }),
          }),
        ],
      },
    ]);
    expect(withView(detail(), paused).next).toEqual({
      value: 'Yes',
      note: 'Inactive project: no allocation or warnings',
      tone: 'default',
    });
    // Without the view (or the lane) the cell is a plain yes / no.
    expect(drawer().next).toEqual({
      value: 'Yes',
      note: null,
      tone: 'default',
    });
  });

  test('a deactivated lead is loud in the lead note and the checklist', () => {
    const m = drawer(
      detail({
        project: { ...detail().project, leadId: 'user-old' },
        leadName: 'Olga Old',
      })
    );
    expect(m.lead).toEqual({
      id: 'user-old',
      name: 'Olga Old',
      note: 'Deactivated in Linear: nothing in this project is allocated.',
    });
    const leadItem = m.rubric.find((item) => item.id === 'no_project_lead');
    expect(leadItem).toEqual({
      id: 'no_project_lead',
      label: 'Project lead',
      met: true,
      note: 'Olga Old · deactivated in Linear',
    });
    expect(drawer().lead.note).toBeNull();
  });

  test('a complete milestone is never overdue: its date has no countdown', () => {
    // Schema cutover: every issue done, due 20 days ago.
    const m = drawer(
      detail({
        milestone: { ...detail().milestone, targetDate: '2026-10-01' },
        assessment: assessment({
          status: 'complete',
          daysLeft: -20,
          reasons: [],
        }),
      })
    );
    expect(m.overdueText).toBeNull();
    expect(m.due).toEqual({
      value: '2026-10-01',
      label: 'Oct 1 · complete',
      tone: 'default',
    });
    expect(m.status.status).toBe('done');
  });

  test("an inactive project's milestone is drawn quietly (§2.8)", () => {
    const paused = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            bars: [bar({ isNext: true, status: 'overdue' })],
            active: false,
            statusType: 'paused',
            allocation: plan({ outcome: 'inactive' }),
          }),
        ],
      },
    ]);
    const m = buildMilestoneDrawer({
      detail: detail(),
      today: TODAY,
      permissions: PM,
      users: USERS,
      issues: ISSUES,
      limits: LIMITS,
      view: paused,
    });
    // Same facts, no accent: no overdue strip, a grey mark still named
    // with its status, a plain due date and progress.
    expect(m.muted).toBe(true);
    expect(m.overdueText).toBeNull();
    expect(m.status).toEqual({
      status: 'overdue',
      label: 'Overdue · inactive project',
      lines: ['Open issues unassigned', 'More work left than time left'],
    });
    expect(m.due).toEqual({
      value: '2026-10-18',
      label: 'Oct 18 · 3 days overdue',
      tone: 'default',
    });
    expect(m.progress.tone).toBe('default');
    // An active lane (or no view) keeps it loud.
    expect(drawer().muted).toBe(false);
    expect(drawer().overdueText).toBe('Overdue by 3 days.');
  });
});
