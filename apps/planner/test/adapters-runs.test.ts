import { indexWorkspace, type WorkspaceData } from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  alreadyAssignedLine,
  type AllocationRun,
  buildRunDetail,
  buildRunsPage,
  formatDuration,
  groupRunEntries,
  parseRunId,
  type RunEntry,
  runRow,
  startedByLabel,
  stateMoveLabel,
} from '../lib/adapters/runs';

// A two-project workspace, hand-built so every name the run log looks up
// (people, projects, milestones, issues, states) is known.

const data: WorkspaceData = {
  workspaceId: 'org-1',
  users: [
    {
      id: 'u-ana',
      name: 'Ana Moreno',
      displayName: 'ana',
      email: 'ana@example.com',
      avatarUrl: null,
      active: true,
      app: false,
    },
    {
      id: 'u-hugo',
      name: 'Hugo Laurent',
      displayName: 'hugo',
      email: null,
      avatarUrl: null,
      active: false,
      app: false,
    },
  ],
  teams: [{ id: 't1', key: 'ENG', name: 'Engineering' }],
  states: [
    {
      id: 's-backlog',
      teamId: 't1',
      name: 'Backlog',
      type: 'backlog',
      position: 0,
    },
    {
      id: 's-todo',
      teamId: 't1',
      name: 'Todo',
      type: 'unstarted',
      position: 1,
    },
    {
      id: 's-prog',
      teamId: 't1',
      name: 'In Progress',
      type: 'started',
      position: 2,
    },
  ],
  initiatives: [],
  projects: [
    {
      id: 'p-atlas',
      name: 'Atlas',
      url: 'https://linear.app/x/project/atlas',
      leadId: 'u-ana',
      priority: 1,
      sortOrder: 1,
      statusType: 'started',
      statusName: 'In Progress',
      initiativeIds: [],
      teamIds: ['t1'],
      startDate: null,
      targetDate: null,
    },
    {
      id: 'p-beacon',
      name: 'Beacon',
      url: 'https://linear.app/x/project/beacon',
      leadId: null,
      priority: 2,
      sortOrder: 2,
      statusType: 'started',
      statusName: 'In Progress',
      initiativeIds: [],
      teamIds: ['t1'],
      startDate: null,
      targetDate: null,
    },
  ],
  milestones: [
    {
      id: 'm-atlas',
      projectId: 'p-atlas',
      name: 'Dual-write',
      description: null,
      targetDate: '2026-10-28',
      sortOrder: 1,
    },
    {
      id: 'm-beacon',
      projectId: 'p-beacon',
      name: 'Search beta',
      description: null,
      targetDate: null,
      sortOrder: 1,
    },
  ],
  issues: [
    {
      id: 'i1',
      identifier: 'ENG-1',
      title: 'Backfill orders',
      url: 'https://linear.app/x/issue/ENG-1',
      teamId: 't1',
      projectId: 'p-atlas',
      milestoneId: 'm-atlas',
      assigneeId: null,
      stateId: 's-backlog',
      priority: 2,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      lastStateChangeAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  relations: [],
};

const snapshot = indexWorkspace(data);
const TZ = 'UTC';

function run(overrides: Partial<AllocationRun> = {}): AllocationRun {
  return {
    id: 'run-1',
    workspaceId: 'org-1',
    mode: 'dry_run',
    trigger: 'manual',
    startedByUserId: 'u-ana',
    status: 'succeeded',
    startedAt: '2026-10-21T15:04:00.000Z',
    finishedAt: '2026-10-21T15:04:01.250Z',
    summary: {
      assigned: 0,
      wouldAssign: 1,
      failed: 0,
      blockedProjects: 1,
      skippedIssues: 2,
    },
    error: null,
    ...overrides,
  };
}

let seq = 0;
function entry(overrides: Partial<RunEntry>): RunEntry {
  seq += 1;
  return {
    runId: 'run-1',
    seq,
    action: 'assign',
    outcome: 'planned',
    projectId: 'p-atlas',
    milestoneId: 'm-atlas',
    issueId: 'i1',
    issueIdentifier: 'ENG-1',
    assigneeId: 'u-ana',
    reason: null,
    detail: {
      title: 'Backfill orders',
      fromStateId: 's-backlog',
      toStateId: 's-todo',
    },
    error: null,
    createdAt: '2026-10-21T15:04:01.000Z',
    ...overrides,
  };
}

describe('small helpers', () => {
  test('durations', () => {
    expect(formatDuration('2026-10-21T15:04:00.000Z', null)).toBeNull();
    expect(
      formatDuration('2026-10-21T15:04:00.000Z', '2026-10-21T15:04:00.040Z')
    ).toBe('under 0.1 s');
    expect(
      formatDuration('2026-10-21T15:04:00.000Z', '2026-10-21T15:04:01.250Z')
    ).toBe('1.3 s');
    expect(
      formatDuration('2026-10-21T15:04:00.000Z', '2026-10-21T15:04:42.000Z')
    ).toBe('42 s');
    expect(
      formatDuration('2026-10-21T15:04:00.000Z', '2026-10-21T15:07:04.000Z')
    ).toBe('3 min 4 s');
  });

  test('who started it', () => {
    expect(
      startedByLabel({ trigger: 'schedule', startedByUserId: null }, snapshot)
    ).toBe('Daily schedule');
    expect(
      startedByLabel({ trigger: 'manual', startedByUserId: 'u-ana' }, snapshot)
    ).toBe('Ana Moreno');
    expect(
      startedByLabel({ trigger: 'manual', startedByUserId: null }, snapshot)
    ).toBe('Worker command line');
  });

  test('state moves read from the mirror', () => {
    expect(
      stateMoveLabel(snapshot, {
        fromStateId: 's-backlog',
        toStateId: 's-todo',
      })
    ).toBe('Backlog → Todo');
    expect(
      stateMoveLabel(snapshot, { fromStateId: 's-prog', toStateId: null })
    ).toBe('Stays In Progress');
    expect(stateMoveLabel(snapshot, {})).toBeNull();
  });

  test('run ids from the URL', () => {
    expect(parseRunId(' abc ')).toBe('abc');
    expect(parseRunId('')).toBeNull();
    expect(parseRunId('x'.repeat(201))).toBeNull();
  });
});

describe('runs register', () => {
  test('a dry run row: hollow chip, counts, workspace-time stamps', () => {
    const row = runRow(run(), snapshot, TZ);
    expect(row.modeLabel).toBe('Dry run');
    expect(row.modeTone).toBe('default');
    expect(row.href).toBe('/runs/run-1');
    expect(row.title).toBe('Oct 21, 3:04 PM UTC');
    expect(row.startedBy).toBe('Ana Moreno');
    expect(row.byline).toBe('Manual · Ana Moreno');
    expect(row.counts).toEqual({
      assigned: 0,
      wouldAssign: 1,
      failed: 0,
      blocked: 1,
      skipped: 2,
    });
    expect(row.took).toBe('took 1.3 s');
    expect(row.rowTone).toBe('default');
    // Succeeded is green (architecture §8.2 "run status"), and both
    // chips stay the outlines they always were.
    expect(row.statusTone).toBe('success');
    expect([row.modeFilled, row.statusFilled]).toEqual([false, false]);
  });

  test('a partly failed live run is amber; a running one is blue, without counts', () => {
    const live = runRow(
      run({ mode: 'live', status: 'partial', trigger: 'schedule' }),
      snapshot,
      TZ
    );
    // Live is the blue info chip; partly failed is a warning, in the
    // chip and the row's rule.
    expect(live.modeTone).toBe('info');
    expect(live.statusLabel).toBe('Partly failed');
    expect(live.statusTone).toBe('warning');
    expect(live.rowTone).toBe('warning');
    // LIVE and a failed status keep their filled chips (blue and amber
    // slabs): only the colour changed.
    expect([live.modeFilled, live.statusFilled]).toEqual([true, true]);
    expect(live.trigger).toBe('Scheduled');
    // The trigger is not repeated in front of "Daily schedule".
    expect(live.byline).toBe('Daily schedule');
    const running = runRow(
      run({ status: 'running', finishedAt: null, summary: null }),
      snapshot,
      TZ
    );
    expect(running.counts).toBeNull();
    expect(running.finished).toBe('Still running');
    expect(running.took).toBeNull();
    expect(running.statusTone).toBe('info');
    expect(running.statusFilled).toBe(false);
    // A failed run, or a succeeded one whose writes failed, is red.
    const failed = runRow(run({ status: 'failed' }), snapshot, TZ);
    expect([failed.statusTone, failed.rowTone]).toEqual(['danger', 'danger']);
    expect(failed.statusFilled).toBe(true);
  });

  // Owner decision 2026-10-22: no PM role. The page model names nobody
  // who "can" run: everyone signed in gets the controls, and only the
  // saved allocation mode decides whether Run now is offered.
  test('page copy follows the allocation mode; nobody is singled out', () => {
    const dry = buildRunsPage({
      runs: [],
      snapshot,
      timeZone: TZ,
      allocationMode: 'dry_run',
    });
    expect(dry.liveRunsOn).toBe(false);
    expect(dry.receipts).toContain('Allocation is in dry run');
    expect(dry.receipts).toContain('No runs logged yet.');
    expect(Object.keys(dry).sort()).toEqual(['liveRunsOn', 'receipts', 'rows']);
    const live = buildRunsPage({
      runs: [run()],
      snapshot,
      timeZone: TZ,
      allocationMode: 'live',
    });
    expect(live.liveRunsOn).toBe(true);
    expect(live.receipts).toContain('1 run logged');
  });
});

describe('run detail', () => {
  const entries: RunEntry[] = [
    entry({
      action: 'block',
      outcome: 'noted',
      projectId: 'p-beacon',
      milestoneId: 'm-beacon',
      issueId: null,
      issueIdentifier: null,
      assigneeId: null,
      reason: 'next_milestone_invalid',
      detail: { gaps: ['no_target_date', 'no_project_lead', 'bogus'] },
    }),
    entry({
      action: 'skip',
      outcome: 'noted',
      assigneeId: null,
      reason: 'already_assigned',
      issueId: 'i-gone',
      issueIdentifier: 'ENG-9',
      detail: {},
    }),
    entry({
      action: 'skip',
      outcome: 'noted',
      assigneeId: null,
      reason: 'triage',
      issueIdentifier: 'ENG-1',
      detail: {},
    }),
    entry({}),
  ];

  test('groups by project in timeline order; blocks carry their gaps', () => {
    const groups = groupRunEntries(entries, snapshot);
    expect(groups.map((g) => g.name)).toEqual(['Atlas', 'Beacon']);
    const [atlas, beacon] = groups;
    expect(atlas?.alreadyAssigned).toBe(1);
    expect(atlas?.rows.map((r) => r.outcome)).toEqual(['planned', 'skipped']);
    expect(atlas?.rows[0]).toMatchObject({
      identifier: 'ENG-1',
      title: 'Backfill orders',
      assignee: 'Ana Moreno',
      stateMove: 'Backlog → Todo',
      outcomeLabel: 'Would assign',
      href: 'https://linear.app/x/issue/ENG-1',
    });
    expect(atlas?.rows[1]?.reason).toBe('Still in Triage');
    expect(atlas?.meta).toBe('1 would assign · 2 skipped');
    expect(beacon?.block).toEqual({
      reason: 'Next milestone is missing required details',
      sentence: 'Next milestone Search beta is missing required details.',
      gaps: 'missing: target date, project lead',
      gapLines: ['Missing a target date', 'Project has no lead'],
      milestone: 'Search beta',
    });
    // A blocked project is a warning (architecture §8.2). Its heading
    // carries the tinted Blocked chip, so the counts do not repeat it.
    expect(beacon?.tone).toBe('warning');
    expect(beacon?.meta).toBe('');
    expect(atlas?.tone).toBe('default');
    expect(beacon?.href).toBe('/timeline?project=p-beacon');
  });

  test('other block reasons name the next milestone in brackets', () => {
    const [group] = groupRunEntries(
      [
        entry({
          action: 'block',
          outcome: 'noted',
          issueId: null,
          issueIdentifier: null,
          assigneeId: null,
          reason: 'no_lead',
          detail: {},
        }),
      ],
      snapshot
    );
    expect(group?.block?.sentence).toBe(
      'Project has no lead (next milestone: Dual-write).'
    );
    expect(alreadyAssignedLine(1)).toBe(
      'Skipped 1 issue that already has an assignee: allocation never reassigns.'
    );
    expect(alreadyAssignedLine(3)).toBe(
      'Skipped 3 issues that already have an assignee: allocation never reassigns.'
    );
  });

  test('live outcomes: applied with comment, failed, stale', () => {
    const live = [
      entry({ outcome: 'applied', reason: 'comment-1' }),
      entry({ outcome: 'failed', error: 'Linear said no' }),
      entry({ outcome: 'stale', reason: 'now_assigned' }),
      entry({
        outcome: 'applied',
        error: 'Assigned, but the comment failed: boom',
      }),
    ];
    const [group] = groupRunEntries(live, snapshot);
    expect(group?.rows.map((r) => [r.outcome, r.reason])).toEqual([
      ['failed', 'Linear said no'],
      ['applied', 'Linear comment left on the issue'],
      ['applied', 'Assigned, but the comment failed: boom'],
      ['stale', 'Someone was assigned in Linear since the plan was made'],
    ]);
    // A failed write is danger, in the group and the outcome chips:
    // assigned green, failed red, not written grey.
    expect(group?.tone).toBe('danger');
    expect(group?.rows.map((r) => [r.outcomeTone, r.reasonTone])).toEqual([
      ['danger', 'danger'],
      ['success', 'muted'],
      ['success', 'danger'],
      ['muted', 'muted'],
    ]);
    // Assigned and failed keep their filled chips; not written stays
    // the outline.
    expect(group?.rows.map((r) => r.outcomeFilled)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(group?.meta).toBe('2 assigned · 1 failed · 1 not written');
  });

  test('the header and stats differ between dry and live runs', () => {
    const dry = buildRunDetail({ run: run(), entries, snapshot, timeZone: TZ });
    expect(dry.heading).toBe('Dry run · Oct 21, 3:04 PM UTC');
    expect(dry.receipts).toBe(
      'Started by Ana Moreno, succeeded in 1.3 s. 2 projects in the log, 2 issues skipped.'
    );
    expect(dry.stats.map((s) => [s.label, s.value])).toEqual([
      ['Would assign', 1],
      ['Skipped', 2],
      ['Blocked projects', 1],
    ]);
    expect(dry.note.label).toBe('Dry run');
    expect(dry.properties.find((p) => p.label === 'Duration')?.value).toBe(
      '1.3 s'
    );

    const live = buildRunDetail({
      run: run({ mode: 'live', error: '1 assignment(s) failed' }),
      entries: [entry({ outcome: 'applied' }), entry({ outcome: 'failed' })],
      snapshot,
      timeZone: TZ,
    });
    expect(live.modeTone).toBe('info');
    // Assigned green, failed red, nothing not written or blocked grey.
    expect(live.stats.map((s) => [s.label, s.value, s.tone])).toEqual([
      ['Assigned', 1, 'success'],
      ['Failed', 1, 'danger'],
      ['Not written', 0, 'muted'],
      ['Blocked projects', 0, 'muted'],
    ]);
    expect(live.note.label).toBe('Undo by hand');
    expect(live.note.body).toContain('delete that comment');
    expect(live.note.body).toContain('move it back to Backlog');
    expect(live.error).toBe('1 assignment(s) failed');
  });
});
