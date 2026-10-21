import { describe, expect, test } from 'bun:test';

import * as core from '../src/index';
import {
  BLOCK_REASON_LABEL,
  buildDependencyGraph,
  buildDigests,
  buildTimelineView,
  buildWeekView,
  countLabel,
  daysLeftLabel,
  missingLine,
  paceLine,
  planAllocation,
  planWarnings,
  PRIORITY_LABEL,
  RISK_REASON_LABEL,
  stalledLine,
  STATUS_LABEL,
  unassignedLine,
} from '../src/index';
import type { Issue, Milestone, Project } from '../src/index';
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

describe('public API (docs/architecture.md §3)', () => {
  test.each([
    'defaultSettings',
    'todayIn',
    'addDays',
    'diffDays',
    'isValidIsoDate',
    'isValidTimeZone',
    'indexWorkspace',
    'isOpenState',
    'priorityRank',
    'resolveDoneMeans',
    'milestoneProgress',
    'evaluateRubric',
    'assessWorkspace',
    'nextMilestoneId',
    'compareMilestones',
    'compareIssues',
    'orderProjects',
    'resolveTodoState',
    'planAllocation',
    'allocationComment',
    'planWarnings',
    'buildDigests',
    'buildDependencyGraph',
    'toMermaid',
    'buildWeekView',
    'buildTimelineView',
    'buildMilestoneDetail',
    'buildIssueDetail',
    'buildIssueEditOptions',
    'estimateOptions',
    'estimateLabel',
    'isAllowedEstimate',
  ])('exports function %s', (name) => {
    expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
  });

  test.each([
    'DEFAULT_TUNING',
    'RUBRIC_GAP_LABEL',
    'RISK_REASON_LABEL',
    'STATUS_LABEL',
    'BLOCK_REASON_LABEL',
    'PRIORITY_LABEL',
    'ISSUE_FIELD_LABEL',
  ])('exports constant %s', (name) => {
    expect(typeof (core as Record<string, unknown>)[name]).toBe('object');
  });
});

describe('defaultSettings', () => {
  test('starts safe: dry run, preview, default tuning', () => {
    expect(core.defaultSettings('ws-1', 'America/Chicago')).toEqual({
      workspaceId: 'ws-1',
      pmUserIds: [],
      watcherUserIds: [],
      allocationMode: 'dry_run',
      warningsMode: 'preview',
      timezone: 'America/Chicago',
      tuning: core.DEFAULT_TUNING,
    });
  });

  test('editing one workspace in place never changes the defaults', () => {
    const settings = core.defaultSettings('ws-1', 'UTC');
    settings.tuning.activeProjectStatuses.push('paused');
    settings.tuning.warnLeadDays = 3;
    expect(core.DEFAULT_TUNING.activeProjectStatuses).toEqual([
      'planned',
      'started',
    ]);
    expect(core.DEFAULT_TUNING.warnLeadDays).toBe(7);
    expect(
      core.defaultSettings('ws-2', 'UTC').tuning.activeProjectStatuses
    ).toEqual(['planned', 'started']);
  });
});

describe('labels', () => {
  test('plain copy for every status, reason, block reason and priority', () => {
    expect(STATUS_LABEL).toEqual({
      empty: 'No issues yet',
      complete: 'Complete',
      unscheduled: 'No target date',
      overdue: 'Overdue',
      at_risk: 'At risk',
      on_track: 'On track',
    });
    expect(Object.keys(RISK_REASON_LABEL)).toEqual([
      'unassigned_open',
      'stalled',
      'behind_pace',
    ]);
    expect(BLOCK_REASON_LABEL.no_lead).toBe('Project has no lead');
    expect(PRIORITY_LABEL).toEqual({
      0: 'No priority',
      1: 'Urgent',
      2: 'High',
      3: 'Medium',
      4: 'Low',
    });
  });

  test.each([
    [countLabel(1, 'issue'), '1 issue'],
    [countLabel(2, 'issue'), '2 issues'],
    [countLabel(0, 'day'), '0 days'],
    [unassignedLine(2), '2 open issues unassigned'],
    [unassignedLine(1), '1 open issue unassigned'],
    [stalledLine(9), 'no state change in 9 days'],
    [stalledLine(1), 'no state change in 1 day'],
    [paceLine(2, 7, 2), '2/7 done with 2 days left'],
    [paceLine(2, 7, 1), '2/7 done with 1 day left'],
    [paceLine(2, 7, 0), '2/7 done, due today'],
    [paceLine(2, 7, -3), '2/7 done, 3 days overdue'],
    [daysLeftLabel(null), 'no target date'],
    [missingLine(['no_done_means']), 'missing: done means…'],
    [
      missingLine(['no_target_date', 'no_project_lead', 'no_issues']),
      'missing: target date, project lead, issues',
    ],
  ])('%s', (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('scale', () => {
  // 2,000 milestones × 25 issues with a blocks chain through every
  // milestone: quadratic code would take far longer than the test timeout.
  test('50k issues assess, plan, warn, graph and view quickly', () => {
    const projects: Project[] = [];
    const milestones: Milestone[] = [];
    const issues: Issue[] = [];
    for (let p = 0; p < 200; p++) {
      projects.push(project(`p${p}`, { sortOrder: p }));
      for (let m = 0; m < 10; m++) {
        const id = `p${p}-m${m}`;
        milestones.push(
          milestone(id, `p${p}`, { targetDate: day(m * 3 - 2), sortOrder: m })
        );
        for (let i = 0; i < 25; i++) {
          issues.push(
            issue(`${id}-i${i}`, {
              identifier: `ENG-${issues.length + 1}`,
              projectId: `p${p}`,
              milestoneId: id,
              assigneeId: i % 3 === 0 ? null : 'lead',
              stateId: i % 4 === 0 ? STATE.done : STATE.started,
            })
          );
        }
      }
    }
    const relations = issues.slice(1).map((blocked, i) => ({
      id: `r${i}`,
      blockerId: issues[i]?.id ?? '',
      blockedId: blocked.id,
    }));
    const started = performance.now();
    const evaluated = evaluate(
      workspace({
        users: [user('lead'), user('wyat')],
        projects,
        milestones,
        issues,
        relations,
      })
    );
    const allocationPlan = planAllocation(
      evaluated.snapshot,
      evaluated.ctx,
      evaluated.assessments
    );
    const warnings = planWarnings({
      ...evaluated,
      allocationPlan,
      memory: [],
      watcherUserIds: ['wyat'],
    });
    const digests = buildDigests({
      ...evaluated,
      notices: warnings.notices,
      appUrl: 'https://x.test',
    });
    const graph = buildDependencyGraph(
      evaluated.snapshot,
      evaluated.ctx,
      evaluated.assessments,
      { level: 'milestone' }
    );
    buildTimelineView({ ...evaluated, allocationPlan });
    buildWeekView({ ...evaluated, userId: 'lead', recentAllocations: [] });
    const elapsed = performance.now() - started;

    expect(evaluated.assessments.size).toBe(2000);
    expect(allocationPlan.projects).toHaveLength(200);
    expect(digests.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBeGreaterThan(0);
    // Generous bound; on a laptop this runs in well under a second.
    expect(elapsed).toBeLessThan(4000);
  });
});
