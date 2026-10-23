import type {
  ProjectAllocationPlan,
  Progress,
  TimelineBar,
  TimelineLane,
  TimelineView,
  User,
  WeekIssueRow,
  WeekSection,
  WeekView,
} from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  atRiskInLedProjects,
  buildAttention,
  buildWeekPage,
  localHour,
  noMilestoneIssueProjects,
  resolveWeekUserId,
  WEEK_TASK_COLUMNS,
  weekPeopleOptions,
} from '../lib/adapters/week';

// Hand-built WeekView / TimelineView: Chloe leads Atlas (an overdue next
// milestone with unassigned issues) and Harbor (blocked: missing "done
// means…"), and has issues in Beacon (at risk, due in 2 days) and in a
// later Atlas milestone, plus one issue with no milestone in Garnet.

const TODAY = '2026-10-21';

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

function issue(overrides: Partial<WeekIssueRow> = {}): WeekIssueRow {
  return {
    issueId: 'iss-1',
    identifier: 'ENG-1',
    title: 'Backfill invoices',
    url: 'https://linear.app/northwind/issue/ENG-1',
    priority: 2,
    stateName: 'In Progress',
    stateType: 'started',
    newBecauseLeadOf: null,
    ...overrides,
  };
}

function section(overrides: Partial<WeekSection> = {}): WeekSection {
  return {
    milestoneId: 'ms-atlas-2',
    milestoneName: 'Dual-write',
    projectId: 'proj-atlas',
    projectName: 'Atlas billing migration',
    projectUrl: 'https://linear.app/northwind/project/atlas',
    targetDate: '2026-10-18',
    daysLeft: -3,
    status: 'overdue',
    progress: progress({ completed: 0, scope: 4, openUnassigned: 2 }),
    thisWeek: true,
    rows: [issue()],
    ...overrides,
  };
}

function bar(overrides: Partial<TimelineBar> = {}): TimelineBar {
  return {
    milestoneId: 'ms-atlas-2',
    name: 'Dual-write',
    projectId: 'proj-atlas',
    start: '2026-10-01',
    end: '2026-10-18',
    status: 'overdue',
    reasons: ['unassigned_open', 'behind_pace'],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both stores agree', source: 'planner' },
    progress: progress({ completed: 0, scope: 4, openUnassigned: 2 }),
    isNext: true,
    daysLeft: -3,
    weight: null,
    ...overrides,
  };
}

function plan(
  overrides: Partial<ProjectAllocationPlan> = {}
): ProjectAllocationPlan {
  return {
    projectId: 'proj-atlas',
    outcome: 'allocate',
    nextMilestoneId: 'ms-atlas-2',
    blockReason: null,
    gaps: [],
    actions: [],
    skipped: [],
    ...overrides,
  };
}

function lane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    projectId: 'proj-atlas',
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

const atlas = lane({
  bars: [
    bar({
      milestoneId: 'ms-atlas-1',
      name: 'Schema cutover',
      status: 'complete',
      isNext: false,
      end: '2026-10-01',
      daysLeft: -20,
      reasons: [],
      progress: progress({ completed: 2, scope: 2, open: 0, total: 2 }),
    }),
    bar(),
    bar({
      milestoneId: 'ms-atlas-3',
      name: 'Read path switch',
      status: 'on_track',
      isNext: false,
      end: '2026-11-15',
      daysLeft: 25,
      reasons: [],
      progress: progress({ completed: 0, scope: 2, open: 2 }),
    }),
  ],
  unplannedIssueIds: ['iss-a9'],
});

const harbor = lane({
  projectId: 'proj-harbor',
  name: 'Harbor API v3',
  bars: [
    bar({
      milestoneId: 'ms-harbor-1',
      projectId: 'proj-harbor',
      name: 'Public beta',
      status: 'on_track',
      reasons: [],
      end: '2026-10-22',
      daysLeft: 1,
      rubric: { valid: false, gaps: ['no_done_means'] },
      progress: progress({
        completed: 0,
        scope: 3,
        open: 3,
        openUnassigned: 1,
      }),
    }),
  ],
  allocation: plan({
    projectId: 'proj-harbor',
    outcome: 'blocked',
    blockReason: 'next_milestone_invalid',
    nextMilestoneId: 'ms-harbor-1',
    gaps: ['no_done_means'],
  }),
});

const beacon = lane({
  projectId: 'proj-beacon',
  name: 'Beacon search',
  leadId: 'user-dev',
  leadName: 'Dev Patel',
  bars: [
    bar({
      milestoneId: 'ms-beacon-1',
      projectId: 'proj-beacon',
      name: 'Search v2 beta',
      status: 'at_risk',
      reasons: ['behind_pace'],
      end: '2026-10-23',
      daysLeft: 2,
      progress: progress({ completed: 3, scope: 7, open: 4 }),
    }),
  ],
  allocation: plan({ projectId: 'proj-beacon', outcome: 'nothing_to_do' }),
});

const garnet = lane({
  projectId: 'proj-garnet',
  name: 'Garnet mobile app',
  leadId: 'user-ben',
  leadName: 'Ben Carter',
  bars: [
    bar({
      milestoneId: 'ms-garnet-1',
      projectId: 'proj-garnet',
      name: 'Offline mode',
      status: 'on_track',
      reasons: [],
      end: '2026-10-21',
      daysLeft: 0,
      progress: progress(),
    }),
  ],
  unplannedIssueIds: ['iss-g1', 'iss-g2'],
  allocation: plan({ projectId: 'proj-garnet', outcome: 'nothing_to_do' }),
});

const timeline: TimelineView = {
  today: TODAY,
  windowStart: '2026-10-07',
  windowEnd: '2026-12-30',
  groups: [
    {
      initiativeId: 'init-platform',
      name: 'Platform reliability',
      lanes: [atlas, harbor],
    },
    { initiativeId: 'init-growth', name: 'Customer growth', lanes: [beacon] },
    { initiativeId: null, name: 'No initiative', lanes: [garnet] },
  ],
  banners: {
    projectsWithoutLead: [],
    milestonesWithoutDate: [],
    issuesWithoutMilestone: { count: 0, byProject: [] },
    blockedProjects: [],
  },
};

const week: WeekView = {
  userId: 'user-chloe',
  userName: 'Chloe Diaz',
  today: TODAY,
  sections: [
    section({
      rows: [
        issue(),
        issue({
          issueId: 'iss-2',
          identifier: 'ENG-2',
          title: 'Shadow writes',
          priority: 1,
          stateName: 'Todo',
          stateType: 'unstarted',
          newBecauseLeadOf: 'Atlas billing migration',
        }),
      ],
    }),
    section({
      milestoneId: 'ms-beacon-1',
      milestoneName: 'Search v2 beta',
      projectId: 'proj-beacon',
      projectName: 'Beacon search',
      targetDate: '2026-10-23',
      daysLeft: 2,
      status: 'at_risk',
      progress: progress({ completed: 3, scope: 7, open: 4 }),
      rows: [issue({ issueId: 'iss-3', identifier: 'ENG-23' })],
    }),
    section({
      milestoneId: 'ms-atlas-3',
      milestoneName: 'Read path switch',
      targetDate: '2026-11-15',
      daysLeft: 25,
      status: 'on_track',
      thisWeek: false,
      progress: progress({ completed: 0, scope: 2, open: 2 }),
      rows: [issue({ issueId: 'iss-4', identifier: 'ENG-16', priority: 0 })],
    }),
    section({
      milestoneId: null,
      milestoneName: null,
      projectId: null,
      projectName: null,
      projectUrl: null,
      targetDate: null,
      daysLeft: null,
      status: null,
      progress: null,
      thisWeek: false,
      rows: [
        issue({ issueId: 'iss-g1', identifier: 'ENG-54' }),
        issue({ issueId: 'iss-a9', identifier: 'ENG-18' }),
        issue({ issueId: 'iss-g2', identifier: 'ENG-55' }),
        issue({ issueId: 'iss-loose', identifier: 'OPS-99' }),
      ],
    }),
  ],
  totals: { open: 5, thisWeek: 3, overdue: 1, new: 1 },
};

const page = buildWeekPage({
  week,
  timeline,
  viewerId: 'user-chloe',
  hour: 9,
  newBadgeDays: 7,
});

describe('buildWeekPage header and stats', () => {
  test('greets the viewer and writes the receipts line', () => {
    expect(page.isSelf).toBe(true);
    expect(page.heading).toBe('Good morning, Chloe');
    expect(page.receipts).toBe(
      'Wednesday, October 21 · 3 issues due this week · 1 milestone overdue'
    );
    // The header's way to every one of your issues (the Issues page).
    expect(page.allIssuesLabel).toBe('All my issues');
    expect(page.allIssuesHref).toBe('/issues?assignee=me');
  });

  test('anyone looking at someone else gets their name, not a greeting', () => {
    const other = buildWeekPage({
      week,
      timeline,
      viewerId: 'user-ana',
      hour: 19,
      newBadgeDays: 7,
    });
    expect(other.isSelf).toBe(false);
    expect(other.heading).toBe("Chloe Diaz's week");
    expect(other.allIssuesLabel).toBe("All of Chloe's issues");
    expect(other.allIssuesHref).toBe(`/issues?assignee=${week.userId}`);
    expect(other.stats.map((s) => s.label)).toEqual([
      'Open issues',
      'Overdue milestones',
      'New to Chloe',
      "At risk in Chloe's projects",
    ]);
    expect(other.emptyMessage).toBe('Nothing assigned to Chloe Diaz is open.');
    const chip = other.sections[0]?.groups[0]?.rows[1]?.chips?.[0]?.label;
    expect(chip).toBe(
      'New — given to Chloe because they lead Atlas billing migration'
    );
  });

  test('stats count open, overdue, new and at-risk-in-led-projects', () => {
    expect(
      page.stats.map((s) => [s.id, s.value, s.note, s.tone ?? 'default'])
    ).toEqual([
      ['open', 5, '3 this week', 'default'],
      ['overdue', 1, 'Atlas billing migration · Dual-write', 'accent'],
      ['new', 1, 'Because you lead Atlas billing migration', 'default'],
      ['risk', 1, 'Atlas billing migration · Dual-write', 'default'],
    ]);
    expect(page.stats[1]?.href).toBe('/timeline?milestone=ms-atlas-2');
    // One milestone at risk or overdue: the cell links to it.
    expect(page.stats[3]?.href).toBe('/timeline?milestone=ms-atlas-2');
  });

  test('nothing due, nothing new, nothing led', () => {
    const quiet = buildWeekPage({
      week: {
        ...week,
        userId: 'user-zed',
        userName: 'Zed Park',
        sections: [],
        totals: { open: 0, thisWeek: 0, overdue: 0, new: 0 },
      },
      timeline,
      viewerId: 'user-zed',
      hour: 15,
      newBadgeDays: 7,
    });
    expect(quiet.heading).toBe('Good afternoon, Zed');
    expect(quiet.receipts).toBe(
      'Wednesday, October 21 · Nothing due this week'
    );
    expect(quiet.sections).toEqual([]);
    expect(quiet.emptyMessage).toBe(
      "Nothing assigned to you is open. Work in your projects' next milestones lands here when the daily run assigns it."
    );
    expect(quiet.stats.map((s) => s.note)).toEqual([
      '0 this week',
      'None',
      'None in the last 7 days',
      'You lead no projects',
    ]);
    expect(quiet.stats[1]?.tone).toBe('default');
    expect(quiet.attention).toEqual([]);
    expect(quiet.attentionEmpty).toBe('You lead no projects');
    expect(quiet.deadlines.map((g) => g.items.length)).toEqual([0, 0, 0, 0]);
    // Nothing overdue: the group is not painted in the accent.
    expect(quiet.deadlines[0]?.tone).toBe('default');
  });
});

describe('buildWeekPage sections', () => {
  test('splits THIS WEEK / LATER / NO MILESTONE in display order', () => {
    expect(
      page.sections.map((s) => [s.id, s.label, s.groups.map((g) => g.id)])
    ).toEqual([
      ['this-week', 'This week', ['ms-atlas-2', 'ms-beacon-1']],
      ['later', 'Later', ['ms-atlas-3']],
      [
        'no-milestone',
        'No milestone',
        [
          'no-milestone:proj-garnet',
          'no-milestone:proj-atlas',
          'no-milestone:none',
        ],
      ],
    ]);
  });

  test('a group is PROJECT › MILESTONE with due, days left, progress, mark', () => {
    const overdue = page.sections[0]?.groups[0];
    expect(overdue).toMatchObject({
      eyebrow: 'Atlas billing migration',
      title: 'Dual-write',
      href: '/timeline?milestone=ms-atlas-2',
      status: 'overdue',
      statusLabel: 'Overdue',
      dueLabel: 'Oct 18',
      daysLeftLabel: '3 days overdue',
      dueTone: 'accent',
      progress: { done: 0, total: 4, tone: 'accent' },
    });
    const atRisk = page.sections[0]?.groups[1];
    expect(atRisk).toMatchObject({
      status: 'at_risk',
      dueLabel: 'Oct 23',
      daysLeftLabel: 'in 2 days',
      progress: { done: 3, total: 7, tone: 'accent' },
    });
    expect(atRisk?.dueTone).toBeUndefined();
  });

  test('rows open the planner\'s issue view, Linear beside, and carry the "new" chip', () => {
    const [first, second] = page.sections[0]?.groups[0]?.rows ?? [];
    expect(first).toMatchObject({
      id: 'iss-1',
      key: 'ENG-1',
      title: 'Backfill invoices',
      // Without an issueHref the title goes to the issue's page.
      href: '/issues/ENG-1',
      externalHref: 'https://linear.app/northwind/issue/ENG-1',
      externalLabel: 'Open ENG-1 in Linear',
      project: 'Atlas billing migration',
      state: 'In Progress',
      stateKind: 'started',
      priority: 2,
      priorityLabel: 'High',
      due: 'Oct 18',
      dueTone: 'accent',
    });
    expect(first?.chips).toBeUndefined();
    expect(second?.priorityLabel).toBe('Urgent');
    expect(second?.chips).toEqual([
      {
        label: 'New — given to you because you lead Atlas billing migration',
        tone: 'accent',
      },
    ]);
    expect(first?.external).toBeUndefined();
    const later = page.sections[1]?.groups[0]?.rows[0];
    expect(later?.priorityLabel).toBe('No priority');
    expect(later?.dueTone).toBeUndefined();
  });

  test('the host decides where a row title goes (the ?issue= drawer)', () => {
    const drawer = buildWeekPage({
      week,
      timeline,
      viewerId: 'user-chloe',
      hour: 9,
      newBadgeDays: 7,
      issueHref: (key) => `/week?user=user-chloe&issue=${key}`,
    });
    const row = drawer.sections[0]?.groups[0]?.rows[0];
    expect(row?.href).toBe('/week?user=user-chloe&issue=ENG-1');
    expect(row?.externalHref).toBe('https://linear.app/northwind/issue/ENG-1');
  });

  test('no-milestone rows are grouped per project, from the timeline lanes', () => {
    const [garnet, atlasGroup, loose] = page.sections[2]?.groups ?? [];
    expect(garnet).toMatchObject({
      eyebrow: 'Garnet mobile app',
      title: 'Issues without a milestone',
      href: '/timeline?project=proj-garnet',
    });
    expect(garnet?.status).toBeUndefined();
    expect(garnet?.dueLabel).toBeUndefined();
    expect(garnet?.rows.map((r) => r.key)).toEqual(['ENG-54', 'ENG-55']);
    expect(garnet?.rows[0]?.project).toBe('Garnet mobile app');
    expect(garnet?.rows[0]?.due).toBeUndefined();
    expect(atlasGroup?.eyebrow).toBe('Atlas billing migration');
    expect(atlasGroup?.rows.map((r) => r.key)).toEqual(['ENG-18']);
    expect(loose).toMatchObject({
      id: 'no-milestone:none',
      title: 'Issues without a project or milestone',
    });
    expect(loose?.eyebrow).toBeUndefined();
    expect(loose?.href).toBeUndefined();
    expect(loose?.rows.map((r) => r.key)).toEqual(['OPS-99']);
  });

  test('an issue in a completed project is grouped under it, without a lane link', () => {
    // OPS-99's project (Kestrel) is completed: no timeline lane, but the
    // mirror still knows the project, so it is not "without a project".
    const issueProjects = noMilestoneIssueProjects(
      week,
      new Map([
        ['iss-g1', { projectId: 'proj-garnet' }],
        ['iss-loose', { projectId: 'proj-kestrel' }],
        ['iss-1', { projectId: 'proj-atlas' }],
      ]),
      new Map([
        ['proj-garnet', { id: 'proj-garnet', name: 'Garnet mobile app' }],
        ['proj-kestrel', { id: 'proj-kestrel', name: 'Kestrel status page' }],
      ])
    );
    // Only "No milestone" rows are looked up; unknown projects are skipped.
    expect([...issueProjects.keys()]).toEqual(['iss-g1', 'iss-loose']);
    const withProjects = buildWeekPage({
      week,
      timeline,
      viewerId: 'user-chloe',
      hour: 9,
      newBadgeDays: 7,
      issueProjects,
    });
    const groups = withProjects.sections[2]?.groups ?? [];
    expect(groups.map((g) => [g.id, g.eyebrow, g.title, g.href])).toEqual([
      [
        'no-milestone:proj-garnet',
        'Garnet mobile app',
        'Issues without a milestone',
        '/timeline?project=proj-garnet',
      ],
      [
        'no-milestone:proj-atlas',
        'Atlas billing migration',
        'Issues without a milestone',
        '/timeline?project=proj-atlas',
      ],
      [
        'no-milestone:proj-kestrel',
        'Kestrel status page',
        'Issues without a milestone',
        undefined,
      ],
    ]);
    expect(groups[2]?.rows.map((r) => r.key)).toEqual(['OPS-99']);
  });

  test('the table drops the project column: group headings name it', () => {
    expect(WEEK_TASK_COLUMNS).toEqual(['state', 'priority', 'due']);
  });

  test('an empty THIS WEEK section stays, so "nothing this week" is said', () => {
    const laterOnly = buildWeekPage({
      week: { ...week, sections: [week.sections[2]] },
      timeline,
      viewerId: 'user-chloe',
      hour: 9,
      newBadgeDays: 7,
    });
    expect(laterOnly.sections.map((s) => [s.id, s.groups.length])).toEqual([
      ['this-week', 0],
      ['later', 1],
    ]);
    // In the planner's words, not the table's generic line.
    expect(laterOnly.sections[0]?.emptyLabel).toBe(
      'Nothing of yours is due this week.'
    );
    const theirs = buildWeekPage({
      week: { ...week, sections: [week.sections[2]] },
      timeline,
      viewerId: 'user-ana',
      hour: 9,
      newBadgeDays: 7,
    });
    expect(theirs.sections[0]?.emptyLabel).toBe(
      "Nothing of Chloe's is due this week."
    );
  });

  test('an on-track milestone missing an input is hatched, as on the timeline', () => {
    const invalid = buildWeekPage({
      week: {
        ...week,
        sections: [
          section({
            milestoneId: 'ms-harbor-1',
            milestoneName: 'Public beta',
            projectName: 'Harbor API v3',
            status: 'on_track',
            daysLeft: 1,
            targetDate: '2026-10-22',
          }),
        ],
      },
      timeline,
      viewerId: 'user-chloe',
      hour: 9,
      newBadgeDays: 7,
    });
    const group = invalid.sections[0]?.groups[0];
    expect(group?.status).toBe('missing');
    expect(group?.statusLabel).toBe('Missing input');
  });

  test('an undated milestone says so in the accent', () => {
    const undated = buildWeekPage({
      week: {
        ...week,
        sections: [
          section({
            milestoneId: 'ms-x',
            status: 'unscheduled',
            targetDate: null,
            daysLeft: null,
            thisWeek: false,
          }),
        ],
      },
      timeline,
      viewerId: 'user-chloe',
      hour: 9,
      newBadgeDays: 7,
    });
    const group = undated.sections[1]?.groups[0];
    expect(group?.dueLabel).toBe('No target date');
    expect(group?.daysLeftLabel).toBeUndefined();
    expect(group?.dueTone).toBe('accent');
    expect(group?.status).toBe('missing');
    expect(group?.rows[0]?.due).toBeUndefined();
  });
});

describe('deadlines and needs attention', () => {
  test('deadlines: led or with issues, grouped Overdue / Today / Tomorrow / This week', () => {
    expect(page.deadlines.map((g) => [g.id, g.items.map((i) => i.id)])).toEqual(
      [
        ['overdue', ['ms-atlas-2']],
        ['today', []],
        ['tomorrow', ['ms-harbor-1']],
        ['this-week', ['ms-beacon-1']],
      ]
    );
    // Complete milestones and ones more than six days out are left out;
    // Garnet's milestone is due today but Chloe neither leads it nor has
    // an issue in it.
    expect(page.deadlines[0]?.tone).toBe('accent');
    expect(page.deadlines[0]?.items[0]).toEqual({
      id: 'ms-atlas-2',
      label: 'Dual-write',
      sublabel: '2 unassigned · Atlas billing migration',
      href: '/timeline?milestone=ms-atlas-2',
      status: 'overdue',
      statusLabel: 'Overdue',
      dueLabel: 'Oct 18',
    });
    expect(page.deadlines[2]?.items[0]?.status).toBe('missing');
    // Without unassigned issues the sublabel counts the open ones.
    expect(page.deadlines[3]?.items[0]?.sublabel).toBe(
      '4 open · Beacon search'
    );
  });

  test('needs attention: blocked first with the reason, then unassigned', () => {
    expect(buildAttention(timeline, 'user-chloe')).toEqual([
      {
        id: 'proj-harbor',
        projectName: 'Harbor API v3',
        detail: 'Next milestone is missing: done means…',
        flag: 'Blocked',
        href: '/timeline?milestone=ms-harbor-1',
        rowLabel:
          'Harbor API v3: allocation blocked. Next milestone is missing: done means…',
      },
      {
        id: 'proj-atlas',
        projectName: 'Atlas billing migration',
        detail: 'Next: Dual-write',
        flag: '2 unassigned',
        href: '/timeline?milestone=ms-atlas-2',
        rowLabel:
          'Atlas billing migration: 2 open issues unassigned in Dual-write',
      },
    ]);
    expect(page.attentionEmpty).toBe(
      'Nothing needs attention in the projects you lead'
    );
  });

  test('a deactivated lead: blocked shows under attention, not as at risk', () => {
    // Ember-like: allocation blocked (lead_inactive), next milestone on
    // track and nine days out, the lead has no open issues of their own.
    const ember = lane({
      projectId: 'proj-ember',
      name: 'Ember notifications',
      leadId: 'user-hugo',
      leadName: 'Hugo Laurent',
      bars: [
        bar({
          milestoneId: 'ms-ember-1',
          projectId: 'proj-ember',
          name: 'Email digests',
          status: 'on_track',
          reasons: [],
          end: '2026-10-30',
          daysLeft: 9,
        }),
      ],
      allocation: plan({
        projectId: 'proj-ember',
        outcome: 'blocked',
        blockReason: 'lead_inactive',
        nextMilestoneId: 'ms-ember-1',
      }),
    });
    const hugo = buildWeekPage({
      week: {
        ...week,
        userId: 'user-hugo',
        userName: 'Hugo Laurent',
        sections: [],
        totals: { open: 0, thisWeek: 0, overdue: 0, new: 0 },
      },
      timeline: {
        ...timeline,
        groups: [{ initiativeId: null, name: 'No initiative', lanes: [ember] }],
      },
      viewerId: 'user-ana',
      hour: 9,
      newBadgeDays: 7,
    });
    const risk = hugo.stats.find((cell) => cell.id === 'risk');
    expect(risk?.value).toBe(0);
    expect(risk?.note).toBe('Nothing at risk or overdue');
    expect(risk?.href).toBeUndefined();
    expect(hugo.attention.map((item) => [item.projectName, item.flag])).toEqual(
      [['Ember notifications', 'Blocked']]
    );
    // Nine days out is beyond "this week": no deadline either.
    expect(hugo.deadlines.flatMap((group) => group.items)).toEqual([]);
  });

  test('a blocked project without a next milestone links to its lane', () => {
    const noNext = buildAttention(
      {
        ...timeline,
        groups: [
          {
            initiativeId: null,
            name: 'No initiative',
            lanes: [
              lane({
                bars: [],
                allocation: plan({
                  outcome: 'blocked',
                  blockReason: 'lead_inactive',
                  nextMilestoneId: null,
                }),
              }),
            ],
          },
        ],
      },
      'user-chloe'
    );
    expect(noNext).toEqual([
      {
        id: 'proj-atlas',
        projectName: 'Atlas billing migration',
        detail: 'Project lead is deactivated',
        flag: 'Blocked',
        href: '/timeline?project=proj-atlas',
        rowLabel:
          'Atlas billing migration: allocation blocked. Project lead is deactivated',
      },
    ]);
  });

  test('at risk in led projects: overdue, then at risk; blocked is not at risk', () => {
    // Chloe also leads Harbor, whose allocation is blocked, but its next
    // milestone's status is on_track: it is listed under "Needs
    // attention", never counted as at risk (§2.5).
    expect(atRiskInLedProjects(timeline, 'user-chloe')).toEqual([
      {
        milestoneId: 'ms-atlas-2',
        project: 'Atlas billing migration',
        milestone: 'Dual-write',
      },
    ]);
    const twoLeads = {
      ...timeline,
      groups: [
        {
          initiativeId: null,
          name: 'No initiative',
          lanes: [
            lane({
              leadId: 'user-dev',
              bars: [
                bar({ status: 'at_risk', name: 'Beta', milestoneId: 'ms-b' }),
                bar({ status: 'overdue', name: 'Alpha', milestoneId: 'ms-a' }),
                bar({ status: 'on_track', name: 'GA', milestoneId: 'ms-c' }),
              ],
            }),
          ],
        },
      ],
    };
    expect(
      atRiskInLedProjects(twoLeads, 'user-dev').map((m) => m.milestone)
    ).toEqual(['Alpha', 'Beta']);
    expect(atRiskInLedProjects(timeline, 'user-dev')).toEqual([
      {
        milestoneId: 'ms-beacon-1',
        project: 'Beacon search',
        milestone: 'Search v2 beta',
      },
    ]);
    expect(atRiskInLedProjects(timeline, 'user-ben')).toEqual([]);
  });
});

describe('week helpers', () => {
  test('localHour reads the hour in the workspace timezone', () => {
    expect(localHour('2026-10-21T15:30:00.000Z', 'UTC')).toBe(15);
    expect(localHour('2026-10-21T15:30:00.000Z', 'America/Chicago')).toBe(10);
    expect(localHour('2026-10-21T23:30:00.000Z', 'Asia/Tokyo')).toBe(8);
    expect(localHour('2026-10-21T00:10:00.000Z', 'UTC')).toBe(0);
    expect(localHour('2026-10-21T15:30:00.000Z', 'Not/AZone')).toBe(15);
  });

  // Owner decision 2026-10-22: no PM role. A member (Chloe, never a PM)
  // may look at anyone's week; only unknown ids fall back to her own.
  test('anyone may look at someone else, but only at a known person', () => {
    const known = new Set(['user-ana', 'user-ben', 'user-chloe']);
    const base = { viewerId: 'user-chloe', knownUserIds: known };
    expect(resolveWeekUserId({ ...base, requested: 'user-ben' })).toBe(
      'user-ben'
    );
    expect(resolveWeekUserId({ ...base, requested: 'user-ana' })).toBe(
      'user-ana'
    );
    expect(resolveWeekUserId({ ...base, requested: 'user-ghost' })).toBe(
      'user-chloe'
    );
    expect(resolveWeekUserId({ ...base, requested: ['user-ben', 'x'] })).toBe(
      'user-ben'
    );
    expect(resolveWeekUserId({ ...base, requested: undefined })).toBe(
      'user-chloe'
    );
    expect(resolveWeekUserId({ ...base, requested: '' })).toBe('user-chloe');
  });

  test('the person picker lists people, deactivated last, never app users', () => {
    const user = (
      id: string,
      name: string,
      extra: Partial<User> = {}
    ): User => ({
      id,
      name,
      displayName: name.toLowerCase(),
      email: null,
      avatarUrl: null,
      active: true,
      app: false,
      ...extra,
    });
    expect(
      weekPeopleOptions(
        [
          user('user-hugo', 'Hugo Laurent', { active: false }),
          user('user-ben', 'Ben Carter'),
          user('user-app', 'Milestone Planner', { app: true }),
          user('user-ana', 'Ana Moreno'),
        ],
        'user-ana'
      )
    ).toEqual([
      { id: 'user-ana', label: 'Ana Moreno (you)' },
      { id: 'user-ben', label: 'Ben Carter' },
      { id: 'user-hugo', label: 'Hugo Laurent (deactivated)' },
    ]);
  });
});

describe('inactive projects are never loud (§2.8)', () => {
  // Femi leads Fjord analytics (paused) and has an issue in its overdue
  // Dashboards milestone, which also has an unassigned issue; Femi also
  // has an issue in Beacon (active, at risk).
  const fjord = lane({
    projectId: 'proj-fjord',
    name: 'Fjord analytics',
    leadId: 'user-femi',
    leadName: 'Femi Adeyemi',
    statusType: 'paused',
    active: false,
    bars: [
      bar({
        milestoneId: 'ms-fjord-1',
        projectId: 'proj-fjord',
        name: 'Dashboards',
        status: 'overdue',
        end: '2026-10-16',
        daysLeft: -5,
        reasons: ['unassigned_open'],
        progress: progress({
          completed: 0,
          scope: 2,
          open: 2,
          openUnassigned: 1,
        }),
      }),
    ],
    allocation: plan({
      projectId: 'proj-fjord',
      outcome: 'inactive',
      nextMilestoneId: 'ms-fjord-1',
    }),
  });
  const view: TimelineView = {
    ...timeline,
    groups: [
      ...timeline.groups,
      { initiativeId: 'init-x', name: 'Paused', lanes: [fjord] },
    ],
  };
  const femiWeek: WeekView = {
    userId: 'user-femi',
    userName: 'Femi Adeyemi',
    today: TODAY,
    sections: [
      section({
        milestoneId: 'ms-fjord-1',
        milestoneName: 'Dashboards',
        projectId: 'proj-fjord',
        projectName: 'Fjord analytics',
        targetDate: '2026-10-16',
        daysLeft: -5,
        status: 'overdue',
        // As core builds it: an inactive project's milestone is never
        // due this week, nor counted overdue (§2.11).
        thisWeek: false,
        progress: progress({ completed: 0, scope: 2, open: 2 }),
        rows: [issue({ issueId: 'iss-f', identifier: 'OPS-8' })],
      }),
    ],
    totals: { open: 1, thisWeek: 0, overdue: 0, new: 0 },
  };
  const femi = buildWeekPage({
    week: femiWeek,
    timeline: view,
    viewerId: 'user-femi',
    hour: 18,
    newBadgeDays: 7,
  });

  test('the stats and receipts leave it out and say so', () => {
    expect(femi.receipts).toBe('Wednesday, October 21 · Nothing due this week');
    const cell = (id: string) => femi.stats.find((c) => c.id === id);
    expect(cell('open')).toMatchObject({ value: 1, note: '0 this week' });
    expect(cell('overdue')).toMatchObject({
      value: 0,
      note: '+1 in an inactive project',
      tone: 'default',
    });
    expect(cell('overdue')?.href).toBeUndefined();
    expect(cell('risk')).toMatchObject({
      value: 0,
      note: '+1 in an inactive project',
    });
    expect(cell('risk')?.href).toBeUndefined();
  });

  test('its group stays in the list, under Later, drawn quietly', () => {
    // Nothing of Femi's is due this week: the paused milestone's date is
    // not a deadline, so its group sits under Later.
    expect(femi.sections.map((s) => [s.id, s.groups.map((g) => g.id)])).toEqual(
      [
        ['this-week', []],
        ['later', ['ms-fjord-1']],
      ]
    );
    expect(femi.sections[0]?.emptyLabel).toBe(
      'Nothing of yours is due this week.'
    );
    const group = femi.sections[1]?.groups[0];
    expect(group).toMatchObject({
      id: 'ms-fjord-1',
      status: 'overdue',
      statusLabel: 'Overdue · inactive project',
      dueLabel: 'Oct 16',
      daysLeftLabel: 'Inactive project',
      muted: true,
      progress: { done: 0, total: 2, tone: 'default' },
    });
    expect(group?.dueTone).toBeUndefined();
    expect(group?.rows[0]?.dueTone).toBeUndefined();
    // Active groups are not muted.
    expect(page.sections[0]?.groups[0]?.muted).toBeUndefined();
  });

  test('no deadline and no "needs attention" row; the empty line says why', () => {
    expect(femi.deadlines.flatMap((group) => group.items)).toEqual([]);
    expect(buildAttention(view, 'user-femi')).toEqual([]);
    expect(femi.attention).toEqual([]);
    expect(femi.attentionEmpty).toBe(
      'Nothing needs attention in the projects you lead. Fjord analytics is inactive, so it is left out'
    );
    expect(atRiskInLedProjects(view, 'user-femi')).toEqual([]);
    expect(atRiskInLedProjects(view, 'user-femi', { inactive: true })).toEqual([
      {
        milestoneId: 'ms-fjord-1',
        project: 'Fjord analytics',
        milestone: 'Dashboards',
      },
    ]);
  });

  test('active ones are still named, with the inactive count after them', () => {
    const both = buildWeekPage({
      week: {
        ...femiWeek,
        sections: [...femiWeek.sections, week.sections[0]],
        // Atlas's overdue Dual-write (two issues) is due this week.
        totals: { open: 3, thisWeek: 2, overdue: 1, new: 1 },
      },
      timeline: view,
      viewerId: 'user-femi',
      hour: 18,
      newBadgeDays: 7,
    });
    expect(both.stats.find((c) => c.id === 'overdue')).toMatchObject({
      value: 1,
      note: 'Atlas billing migration · Dual-write · +1 in an inactive project',
      tone: 'accent',
      href: '/timeline?milestone=ms-atlas-2',
    });
    expect(both.receipts).toBe(
      'Wednesday, October 21 · 2 issues due this week · 1 milestone overdue'
    );
  });
});
