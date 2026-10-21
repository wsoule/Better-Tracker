import {
  assessWorkspace,
  buildTimelineView,
  buildWeekView,
  DEFAULT_TUNING,
  type EvalContext,
  indexWorkspace,
  type MilestoneMeta,
  planAllocation,
  type TimelineBar,
  type TimelineLane,
} from '@better-tracker/core';
import {
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';
import { describe, expect, mock, test } from 'bun:test';

import {
  buildPaletteIndex,
  buildShellFrame,
  crumbsFor,
  isCurrentPath,
  isPaletteIndex,
  laneMark,
  paletteItemsFromIndex,
  projectSectionItems,
  runIdFrom,
  syncFailureMessage,
  weekNavCount,
} from '../lib/adapters/shell';

// Real view models from the fixture workspace (what demo mode serves), so
// the frame adapters are tested against the shapes the engine produces.
const TODAY = '2026-10-21';

function fixtureViews() {
  const snapshot = indexWorkspace(createFixtureWorkspace(TODAY));
  const meta = new Map<string, MilestoneMeta>(
    FIXTURE_MILESTONE_META.map((m) => [
      m.milestoneId,
      { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
    ])
  );
  const ctx: EvalContext = {
    today: TODAY,
    now: '2026-10-21T12:00:00.000Z',
    tuning: DEFAULT_TUNING,
    meta,
  };
  const assessments = assessWorkspace(snapshot, ctx);
  const allocationPlan = planAllocation(snapshot, ctx, assessments);
  return {
    timeline: buildTimelineView({ snapshot, ctx, assessments, allocationPlan }),
    week: buildWeekView({
      snapshot,
      ctx,
      assessments,
      userId: 'user-ana',
      recentAllocations: [],
    }),
  };
}

const { timeline, week } = fixtureViews();
const lanes = timeline.groups.flatMap((group) => group.lanes);

function bar(overrides: Partial<TimelineBar>): TimelineBar {
  return {
    milestoneId: 'm1',
    name: 'M1',
    projectId: 'p1',
    start: TODAY,
    end: '2026-10-30',
    status: 'on_track',
    reasons: [],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Done.', source: 'planner' },
    progress: {
      total: 1,
      completed: 0,
      canceled: 0,
      scope: 1,
      open: 1,
      openUnassigned: 0,
      openTriage: 0,
    },
    isNext: false,
    daysLeft: 9,
    weight: null,
    ...overrides,
  };
}

function lane(overrides: Partial<TimelineLane>): TimelineLane {
  return {
    projectId: 'p1',
    name: 'Project',
    url: 'https://linear.app/x/project/p1',
    leadId: null,
    leadName: null,
    priority: 0,
    statusType: 'started',
    active: true,
    bars: [],
    undated: [],
    unplannedIssueIds: [],
    allocation: null,
    ...overrides,
  };
}

describe('sidebar PROJECTS', () => {
  test('lists active lanes only, linking to their timeline lane', () => {
    const items = projectSectionItems(timeline);
    const active = lanes.filter((l) => l.active);
    expect(items.map((i) => i.id)).toEqual(active.map((l) => l.projectId));
    expect(lanes.some((l) => !l.active)).toBe(true);
    for (const item of items) {
      expect(item.href).toBe(`/timeline?project=${item.id}`);
      expect(['done', 'on_track', 'at_risk', 'overdue', 'missing']).toContain(
        item.status
      );
      expect(item.statusLabel).not.toBe('');
    }
  });

  test("marks a lane with its next milestone's status", () => {
    const overdue = lane({
      bars: [
        bar({ status: 'complete', isNext: false }),
        bar({ milestoneId: 'm2', status: 'overdue', isNext: true }),
      ],
    });
    expect(laneMark(overdue)).toEqual({ status: 'overdue', label: 'Overdue' });
    const invalid = lane({
      undated: [
        bar({
          status: 'on_track',
          isNext: true,
          rubric: { valid: false, gaps: ['no_done_means'] },
        }),
      ],
    });
    expect(laneMark(invalid)).toEqual({
      status: 'missing',
      label: 'Missing input',
    });
  });

  test('a lane without a next milestone is complete, or missing milestones', () => {
    expect(laneMark(lane({ bars: [bar({ status: 'complete' })] }))).toEqual({
      status: 'done',
      label: 'All milestones complete',
    });
    expect(laneMark(lane({}))).toEqual({
      status: 'missing',
      label: 'No milestones',
    });
  });
});

describe('shell frame', () => {
  test('counts this week’s issues for the My week row', () => {
    const count = weekNavCount(week);
    expect(count.count).toBe(week.totals.thisWeek);
    expect(count.label).toMatch(/^\d+ issues? due this week$/);
  });

  test('says why the project list is empty', () => {
    const base = {
      appName: 'Milestone Planner',
      workspaceName: null,
      userName: 'Ana Moreno',
      isPm: true,
      timeline: null,
      week: null,
    };
    const notInstalled = buildShellFrame({
      ...base,
      installed: false,
      loadFailed: false,
    });
    expect(notInstalled.projects).toEqual([]);
    expect(notInstalled.weekCount).toBeNull();
    expect(notInstalled.projectsEmptyLabel).toBe(
      'Install the app to see projects'
    );
    expect(
      buildShellFrame({ ...base, installed: true, loadFailed: true })
        .projectsEmptyLabel
    ).toBe('Projects could not be loaded');
    const full = buildShellFrame({
      ...base,
      installed: true,
      loadFailed: false,
      timeline,
      week,
    });
    expect(full.projects.length).toBeGreaterThan(0);
    expect(full.weekCount).toBe(week.totals.thisWeek);
    // Plain data: it crosses the server → client boundary as JSON.
    expect(JSON.parse(JSON.stringify(full))).toEqual(full);
  });
});

describe('breadcrumbs', () => {
  test('the section comes from the path; a page may add its own crumb', () => {
    expect(crumbsFor('/week', null)).toEqual([{ label: 'My week' }]);
    expect(crumbsFor('/timeline', 'Atlas billing migration')).toEqual([
      { label: 'Timeline', href: '/timeline' },
      { label: 'Atlas billing migration' },
    ]);
    expect(crumbsFor('/runs/run-1', null)).toEqual([
      { label: 'Runs', href: '/runs' },
    ]);
    expect(crumbsFor('/setup', null)).toEqual([{ label: 'Setup' }]);
    expect(crumbsFor('/', null)).toEqual([]);
    expect(crumbsFor('/nowhere', 'Not found')).toEqual([
      { label: 'Not found' },
    ]);
  });

  test('a nav row is current on its page and the pages below it', () => {
    expect(isCurrentPath('/runs', '/runs')).toBe(true);
    expect(isCurrentPath('/runs/abc', '/runs')).toBe(true);
    expect(isCurrentPath('/runsabc', '/runs')).toBe(false);
  });
});

describe('palette index (GET /api/palette)', () => {
  const index = buildPaletteIndex({ timeline, week });

  test('has exactly projects, milestones and issues, as plain JSON', () => {
    expect(Object.keys(index).sort()).toEqual([
      'issues',
      'milestones',
      'projects',
    ]);
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
    expect(isPaletteIndex(index)).toBe(true);
  });

  test('projects and milestones link into the timeline', () => {
    expect(index.projects).toHaveLength(lanes.length);
    const atlas = index.projects.find((p) => p.id === 'project:proj-atlas');
    expect(atlas?.href).toBe('/timeline?project=proj-atlas');
    const milestoneCount = lanes.reduce(
      (n, l) => n + l.bars.length + l.undated.length,
      0
    );
    expect(index.milestones).toHaveLength(milestoneCount);
    for (const entry of [...index.projects, ...index.milestones]) {
      expect(entry.external).toBe(false);
      expect(entry.href.startsWith('/timeline?')).toBe(true);
      expect(entry.status).toBeDefined();
    }
    expect(
      index.milestones.every((m) => / · (due |no target date)/.test(m.hint))
    ).toBe(true);
  });

  test("issues are the person's open issues, opening in Linear", () => {
    const rows = week.sections.flatMap((s) => s.rows);
    expect(index.issues.map((i) => i.id)).toEqual(
      rows.map((r) => `issue:${r.issueId}`)
    );
    for (const issue of index.issues) {
      expect(issue.external).toBe(true);
      expect(issue.href.startsWith('https://linear.app/')).toBe(true);
      expect(issue.hint).toMatch(/^[A-Z]+-\d+ · /);
    }
  });

  test('the client maps entries to palette rows in "Jump to"', () => {
    const openExternal = mock((url: string) => url);
    const items = paletteItemsFromIndex(index, { openExternal });
    expect(items).toHaveLength(
      index.projects.length + index.milestones.length + index.issues.length
    );
    expect(new Set(items.map((i) => i.section))).toEqual(new Set(['Jump to']));
    const project = items.find((i) => i.id.startsWith('project:'));
    expect(project?.href).toBeDefined();
    expect(project?.onSelect).toBeUndefined();
    const issue = items.find((i) => i.id.startsWith('issue:'));
    expect(issue?.href).toBeUndefined();
    issue?.onSelect?.();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  test('rejects payloads of another shape', () => {
    expect(isPaletteIndex(null)).toBe(false);
    expect(isPaletteIndex({ projects: [], milestones: [] })).toBe(false);
    expect(
      isPaletteIndex({ projects: [{ id: 1 }], milestones: [], issues: [] })
    ).toBe(false);
  });
});

describe('palette actions', () => {
  test('finds the run id in a POST /api/runs answer', () => {
    expect(runIdFrom({ run: { id: 'run-1' } })).toBe('run-1');
    expect(runIdFrom({ id: 'run-2', status: 'succeeded' })).toBe('run-2');
    expect(runIdFrom({ run: {} })).toBeNull();
    expect(runIdFrom(null)).toBeNull();
  });

  test('reads a failed sync out of a 200 answer', () => {
    expect(syncFailureMessage({ ok: true })).toBeNull();
    expect(syncFailureMessage(null)).toBeNull();
    expect(syncFailureMessage({ ok: false, error: 'rate limited' })).toBe(
      'Linear sync failed: rate limited'
    );
    expect(syncFailureMessage({ sync: { ok: false, error: null } })).toBe(
      'Linear sync failed; the screens still show the previous data.'
    );
  });
});
