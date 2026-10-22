import type {
  ProjectAllocationPlan,
  Progress,
  TimelineBar,
  TimelineLane,
  TimelineView,
} from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  allocationCell,
  barMark,
  buildProjectsPage,
  dueTone,
  filterProjectGroups,
  parseProjectFilter,
  parseProjectsSearch,
  progressTone,
} from '../lib/adapters/projects';
import { blockedReasonLine } from '../lib/adapters/status';

// Hand-built TimelineView pieces: only the fields the register reads are
// meaningful; the rest are plausible defaults.

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
    isNext: true,
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

function timeline(lanes: TimelineLane[][]): TimelineView {
  return {
    today: TODAY,
    windowStart: '2026-10-07',
    windowEnd: '2026-12-30',
    groups: lanes.map((group, i) => ({
      initiativeId: i === lanes.length - 1 ? null : `init-${i}`,
      name: i === lanes.length - 1 ? 'No initiative' : `Initiative ${i}`,
      lanes: group,
    })),
    banners: {
      projectsWithoutLead: [],
      milestonesWithoutDate: [],
      issuesWithoutMilestone: { count: 0, byProject: [] },
      blockedProjects: [],
    },
  };
}

describe('barMark and progressTone', () => {
  test('on track but failing the rubric reads as a missing input', () => {
    expect(barMark(bar())).toEqual({ status: 'on_track', label: 'On track' });
    expect(
      barMark(bar({ rubric: { valid: false, gaps: ['no_done_means'] } }))
    ).toEqual({ status: 'missing', label: 'Missing input' });
    expect(
      barMark(
        bar({
          status: 'at_risk',
          rubric: { valid: false, gaps: ['no_done_means'] },
        })
      )
    ).toEqual({ status: 'at_risk', label: 'At risk' });
    expect(barMark(bar({ status: 'overdue' }))).toEqual({
      status: 'overdue',
      label: 'Overdue',
    });
    expect(barMark(bar({ status: 'complete' })).status).toBe('done');
    expect(barMark(bar({ status: 'empty' })).status).toBe('missing');
  });

  test('progress is danger when overdue, warning when behind pace', () => {
    expect(progressTone(bar())).toBe('default');
    expect(progressTone(bar({ status: 'overdue' }))).toBe('danger');
    expect(
      progressTone(
        bar({ status: 'overdue', reasons: ['behind_pace', 'stalled'] })
      )
    ).toBe('danger');
    expect(
      progressTone(bar({ status: 'at_risk', reasons: ['behind_pace'] }))
    ).toBe('warning');
    expect(progressTone(bar({ status: 'at_risk', reasons: ['stalled'] }))).toBe(
      'default'
    );
  });

  test('a due date is danger overdue, a warning today, tomorrow or undated', () => {
    expect(dueTone('overdue', -3, false)).toBe('danger');
    expect(dueTone('on_track', 0, false)).toBe('warning');
    expect(dueTone('at_risk', 1, false)).toBe('warning');
    expect(dueTone('on_track', 2, false)).toBe('default');
    expect(dueTone('unscheduled', null, true)).toBe('warning');
    // A complete milestone is never late or due.
    expect(dueTone('complete', 0, false)).toBe('default');
    expect(dueTone(null, null, false)).toBe('default');
  });
});

describe('allocationCell', () => {
  test('says what the plan would do', () => {
    expect(
      allocationCell(
        plan({
          outcome: 'allocate',
          actions: [
            {
              issueId: 'i1',
              identifier: 'ENG-1',
              title: 'One',
              projectId: 'proj-1',
              milestoneId: 'ms-1',
              assigneeId: 'user-chloe',
              fromStateId: 's1',
              toStateId: null,
            },
            {
              issueId: 'i2',
              identifier: 'ENG-2',
              title: 'Two',
              projectId: 'proj-1',
              milestoneId: 'ms-1',
              assigneeId: 'user-chloe',
              fromStateId: 's1',
              toStateId: 's2',
            },
          ],
        })
      )
    ).toEqual({ label: 'Allocating 2', tone: 'info' });
    expect(allocationCell(plan())).toEqual({
      label: 'Nothing to do',
      tone: 'default',
    });
    expect(allocationCell(plan({ outcome: 'no_open_milestone' }))).toEqual({
      label: 'No open milestone',
      tone: 'muted',
    });
    expect(allocationCell(plan({ outcome: 'inactive' }))).toEqual({
      label: 'Inactive',
      tone: 'muted',
    });
    expect(allocationCell(null).tone).toBe('muted');
  });

  test('blocked is a short chip; the reason and missing items go under it', () => {
    expect(
      allocationCell(plan({ outcome: 'blocked', blockReason: 'no_lead' }))
    ).toEqual({
      label: 'Blocked',
      detail: 'Project has no lead',
      tone: 'warning',
    });
    expect(
      allocationCell(
        plan({
          outcome: 'blocked',
          blockReason: 'next_milestone_invalid',
          gaps: ['no_done_means', 'no_issues'],
        })
      )
    ).toEqual({
      label: 'Blocked',
      detail: 'Next milestone is missing: done means…, issues',
      tone: 'warning',
    });
    // Without a recorded reason the chip still says Blocked.
    expect(
      allocationCell(plan({ outcome: 'blocked', blockReason: null }))
    ).toEqual({ label: 'Blocked', tone: 'warning' });
  });
});

describe('buildProjectsPage', () => {
  const view = timeline([
    [
      lane(),
      lane({
        projectId: 'proj-2',
        name: 'Harbor API v3',
        leadId: 'user-elena',
        leadName: 'Elena Novak',
        bars: [
          bar({
            milestoneId: 'ms-h1',
            projectId: 'proj-2',
            name: 'Public beta',
            status: 'at_risk',
            reasons: ['unassigned_open', 'behind_pace'],
            rubric: { valid: false, gaps: ['no_done_means'] },
            end: '2026-10-25',
            daysLeft: 4,
            progress: progress({ completed: 0, scope: 3, openUnassigned: 1 }),
          }),
        ],
        allocation: plan({
          projectId: 'proj-2',
          outcome: 'blocked',
          blockReason: 'next_milestone_invalid',
          nextMilestoneId: 'ms-h1',
          gaps: ['no_done_means'],
        }),
      }),
    ],
    [
      lane({
        projectId: 'proj-3',
        name: 'Delta exports',
        leadId: null,
        leadName: null,
        bars: [],
        undated: [
          bar({
            milestoneId: 'ms-d1',
            projectId: 'proj-3',
            name: 'CSV exports',
            end: null,
            daysLeft: null,
            status: 'unscheduled',
          }),
        ],
        allocation: plan({
          projectId: 'proj-3',
          outcome: 'blocked',
          blockReason: 'no_lead',
          nextMilestoneId: 'ms-d1',
        }),
      }),
      lane({
        projectId: 'proj-4',
        name: 'Fjord analytics',
        statusType: 'paused',
        active: false,
        bars: [
          bar({
            milestoneId: 'ms-f1',
            projectId: 'proj-4',
            name: 'Dashboards',
            status: 'overdue',
            end: '2026-10-16',
            daysLeft: -5,
          }),
        ],
        allocation: plan({ projectId: 'proj-4', outcome: 'inactive' }),
      }),
      lane({
        projectId: 'proj-5',
        name: 'Juniper design system',
        bars: [
          bar({ milestoneId: 'ms-j1', isNext: false, status: 'complete' }),
        ],
        allocation: plan({
          projectId: 'proj-5',
          outcome: 'no_open_milestone',
          nextMilestoneId: null,
        }),
      }),
    ],
  ]);
  const page = buildProjectsPage({
    timeline: view,
    statusNames: new Map([['proj-1', 'Building']]),
  });
  const rows = page.groups.flatMap((g) => g.rows);
  const row = (id: string) => {
    const found = rows.find((r) => r.id === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  };

  test('groups rows by initiative in timeline order', () => {
    expect(page.groups.map((g) => [g.id, g.name, g.rows.length])).toEqual([
      ['init-0', 'Initiative 0', 2],
      ['none', 'No initiative', 3],
    ]);
    expect(row('proj-3').initiative).toBe('No initiative');
  });

  test('each group links to its initiative’s graph', () => {
    expect(page.groups.map((g) => g.graphHref)).toEqual([
      '/graph?initiative=init-0',
      '/graph?initiative=none',
    ]);
    // A guest's mirror has no initiatives, so the only group is "No
    // initiative" and its graph is the workspace's projects.
    const guest = buildProjectsPage({
      timeline: timeline([[lane({ projectId: 'proj-9' })]]),
      statusNames: new Map(),
    });
    expect(guest.groups.map((g) => [g.id, g.graphHref])).toEqual([
      ['none', '/graph?level=project'],
    ]);
  });

  test('uses the Linear status name, falling back to the default name', () => {
    expect(row('proj-1').linearStatus).toBe('Building');
    expect(row('proj-2').linearStatus).toBe('In Progress');
    expect(row('proj-4').linearStatus).toBe('Paused');
    // The Linear status as a dot pill (architecture §8.2): started info,
    // paused warning.
    expect(row('proj-1').linearStatusTone).toBe('info');
    expect(row('proj-4').linearStatusTone).toBe('warning');
  });

  test('describes the next milestone with lib/format wording', () => {
    expect(row('proj-1').next).toEqual({
      id: 'ms-1',
      name: 'Dual-write',
      href: '/timeline?milestone=ms-1',
      dueLabel: 'Oct 28 · in 7 days',
      dueTone: 'default',
      status: 'on_track',
      statusLabel: 'On track',
      done: 1,
      total: 4,
      progressTone: 'default',
      muted: false,
    });
    // Behind pace: the progress is a warning.
    expect(row('proj-2').next?.progressTone).toBe('warning');
    expect(row('proj-3').next?.dueLabel).toBe('No target date');
    // Undated: the missing date is a warning.
    expect(row('proj-3').next?.dueTone).toBe('warning');
    expect(row('proj-3').next?.status).toBe('missing');
    expect(row('proj-5').next).toBeNull();
  });

  test("an inactive project's overdue next milestone is drawn in greys", () => {
    expect(row('proj-4').next).toMatchObject({
      dueLabel: 'Oct 16 · 5 days overdue',
      dueTone: 'muted',
      status: 'overdue',
      statusLabel: 'Overdue · inactive project',
      progressTone: 'muted',
      muted: true,
    });
  });

  test('marks leads, tones and filter tags', () => {
    expect(row('proj-3').lead).toBeNull();
    expect(row('proj-3').rowTone).toBe('warning');
    expect(row('proj-4').rowTone).toBe('muted');
    expect(row('proj-1').rowTone).toBe('default');
    expect(row('proj-2').tags).toEqual(['blocked', 'at_risk']);
    expect(row('proj-3').tags).toEqual(['blocked']);
    // Overdue, but inactive: never counted as at risk (§2.8).
    expect(row('proj-4').tags).toEqual(['inactive']);
    expect(row('proj-1').tags).toEqual([]);
    expect(row('proj-3').allocation.label).toBe('Blocked');
    expect(row('proj-3').allocation.detail).toBe('Project has no lead');
    expect(row('proj-2').allocation.detail).toBe(
      'Next milestone is missing: done means…'
    );
  });

  test('links each row to its timeline lane, graph and Linear project', () => {
    expect(row('proj-2').timelineHref).toBe('/timeline?project=proj-2');
    expect(row('proj-2').graphHref).toBe('/graph?project=proj-2');
    expect(row('proj-2').linearUrl).toBe(
      'https://linear.app/northwind/project/atlas'
    );
  });

  test('counts every filter and writes the receipts line', () => {
    expect(page.filters).toEqual([
      { id: 'all', label: 'All', count: 5 },
      { id: 'blocked', label: 'Blocked', count: 2 },
      { id: 'at_risk', label: 'At risk', count: 1 },
      { id: 'inactive', label: 'Inactive', count: 1 },
    ]);
    expect(page.total).toBe(5);
    expect(page.receipts).toBe(
      '5 projects · 4 active · 2 blocked · 1 at risk or overdue'
    );
  });

  test('filterProjectGroups narrows by tag and by every search word', () => {
    const ids = (groups: ReturnType<typeof filterProjectGroups>) =>
      groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids(filterProjectGroups(page.groups, '', 'all'))).toEqual([
      'proj-1',
      'proj-2',
      'proj-3',
      'proj-4',
      'proj-5',
    ]);
    expect(ids(filterProjectGroups(page.groups, '', 'blocked'))).toEqual([
      'proj-2',
      'proj-3',
    ]);
    expect(ids(filterProjectGroups(page.groups, '', 'inactive'))).toEqual([
      'proj-4',
    ]);
    // Name, lead, next milestone and "no lead" are all searchable.
    expect(ids(filterProjectGroups(page.groups, 'HARBOR', 'all'))).toEqual([
      'proj-2',
    ]);
    expect(ids(filterProjectGroups(page.groups, 'elena beta', 'all'))).toEqual([
      'proj-2',
    ]);
    expect(ids(filterProjectGroups(page.groups, 'no lead', 'all'))).toEqual([
      'proj-3',
    ]);
    // The blocked reason under the chip is searchable too.
    expect(
      ids(filterProjectGroups(page.groups, 'missing: done', 'all'))
    ).toEqual(['proj-2']);
    // Groups left empty are dropped.
    const onlyInactive = filterProjectGroups(page.groups, '', 'inactive');
    expect(onlyInactive.map((g) => g.id)).toEqual(['none']);
    expect(filterProjectGroups(page.groups, 'nothing-matches', 'all')).toEqual(
      []
    );
  });

  test('parseProjectsSearch reads ?q= and ?filter= from a query string', () => {
    expect(
      parseProjectsSearch(new URLSearchParams('filter=blocked&q=har+b'))
    ).toEqual({ query: 'har b', filter: 'blocked' });
    expect(parseProjectsSearch(new URLSearchParams(''))).toEqual({
      query: '',
      filter: 'all',
    });
    expect(
      parseProjectsSearch(new URLSearchParams('filter=nope&q=a&q=b'))
    ).toEqual({ query: 'a', filter: 'all' });
    expect(
      parseProjectsSearch(new URLSearchParams(`q=${'x'.repeat(300)}`)).query
    ).toHaveLength(200);
  });

  test('parseProjectFilter accepts known ids only', () => {
    expect(parseProjectFilter('blocked')).toBe('blocked');
    expect(parseProjectFilter(['at_risk', 'all'])).toBe('at_risk');
    expect(parseProjectFilter('nope')).toBe('all');
    expect(parseProjectFilter(undefined)).toBe('all');
  });
});

describe('blockedReasonLine (shared by the timeline, My week and here)', () => {
  test('the reason alone, or what the next milestone lacks', () => {
    expect(blockedReasonLine('no_lead', [])).toBe('Project has no lead');
    expect(blockedReasonLine('lead_inactive', [])).toBe(
      'Project lead is deactivated'
    );
    expect(blockedReasonLine('next_milestone_invalid', [])).toBe(
      'Next milestone is missing required details'
    );
    expect(
      blockedReasonLine('next_milestone_invalid', [
        'no_target_date',
        'no_done_means',
      ])
    ).toBe('Next milestone is missing: target date, done means…');
    // Another reason with rubric gaps keeps its label and lists them.
    expect(blockedReasonLine('no_lead', ['no_project_lead'])).toBe(
      'Project has no lead · missing: project lead'
    );
  });
});
