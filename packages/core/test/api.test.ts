import { describe, expect, test } from 'bun:test';

import * as core from '../src/index';
import {
  BLOCK_REASON_LABEL,
  buildDependencyGraph,
  buildDigests,
  buildIssueList,
  buildIssueListOptions,
  DEFAULT_ISSUE_LIST_QUERY,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_GROUPS,
  normalizeIssueListQuery,
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
import type {
  BlockingRelation,
  DependencyGraph,
  GraphScope,
  Initiative,
  Issue,
  Milestone,
  Project,
} from '../src/index';
import {
  day,
  evaluate,
  initiative,
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
    'resolveGraphScope',
    'graphContainer',
    'graphScopeFor',
    'homeInitiativeIds',
    'findIssue',
    'isRiskNode',
    'toMermaid',
    'buildWeekView',
    'buildTimelineView',
    'buildMilestoneDetail',
    'buildIssueDetail',
    'buildIssueEditOptions',
    'estimateOptions',
    'estimateLabel',
    'isAllowedEstimate',
    'foldText',
    'issueSearchTerms',
    'issueSearchScore',
    'foldedTitles',
    'normalizeIssueListQuery',
    'sameIssueListFilters',
    'issueListSectionsAllowed',
    'stateNameKey',
    'buildIssueList',
    'buildIssueListOptions',
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
    'GRAPH_LEVELS_WITHIN',
    'DEFAULT_GRAPH_LEVEL',
    'OPEN_STATE_TYPES',
    'ALL_STATE_TYPES',
    'DEFAULT_ISSUE_LIST_QUERY',
    'ISSUE_LIST_PRESETS',
    'ISSUE_LIST_DEFAULT_DIR',
    'STATE_TYPE_LABEL',
    'ISSUE_LIST_GROUP_LABEL',
    'ISSUE_LIST_SECTION_LABEL',
    'ISSUE_LIST_SORT_LABEL',
    'ISSUE_LIST_SORT_HINT',
    'ISSUE_LIST_QUICK_LABEL',
    'ISSUE_LIST_TIER_LABEL',
    'ISSUE_LIST_PRESET_LABEL',
  ])('exports constant %s', (name) => {
    expect(typeof (core as Record<string, unknown>)[name]).toBe('object');
  });

  test('exports the graph constants', () => {
    expect(core.NO_INITIATIVE_ID).toBe('none');
    expect(core.CHAIN_MAX_NODES).toBe(150);
  });
});

describe('defaultSettings', () => {
  test('starts safe: dry run, preview, default tuning', () => {
    expect(core.defaultSettings('ws-1', 'America/Chicago')).toEqual({
      workspaceId: 'ws-1',
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
  test('50k issues assess, plan, warn, graph, view and list quickly', () => {
    const projects: Project[] = [];
    const milestones: Milestone[] = [];
    const issues: Issue[] = [];
    const initiatives: Initiative[] = Array.from({ length: 10 }, (_, i) =>
      initiative(`init-${i}`, { sortOrder: i })
    );
    for (let p = 0; p < 200; p++) {
      projects.push(
        project(`p${p}`, { sortOrder: p, initiativeIds: [`init-${p % 10}`] })
      );
      for (let m = 0; m < 10; m++) {
        const id = `p${p}-m${m}`;
        milestones.push(
          milestone(id, `p${p}`, { targetDate: day(m * 3 - 2), sortOrder: m })
        );
        for (let i = 0; i < 25; i++) {
          issues.push(
            issue(`${id}-i${i}`, {
              identifier: `ENG-${issues.length + 1}`,
              title: `Work item ${issues.length + 1}`,
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
        initiatives,
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
    const graphOf = (scope: GraphScope): DependencyGraph =>
      buildDependencyGraph(
        evaluated.snapshot,
        evaluated.ctx,
        evaluated.assessments,
        scope
      );
    const graph = graphOf({ level: 'milestone' });
    // Every workspace level, and one initiative's issue level.
    const levels = [
      graphOf({ level: 'initiative' }),
      graphOf({ level: 'project' }),
      graphOf({ level: 'issue' }),
      graphOf({ level: 'issue', initiativeId: 'init-0' }),
    ];
    buildTimelineView({ ...evaluated, allocationPlan });
    buildWeekView({ ...evaluated, userId: 'lead', recentAllocations: [] });
    // The issue list (architecture §2.14) for the queries people use most.
    const listInput = { ...evaluated, allocationPlan, viewerId: 'lead' };
    const lists = [
      DEFAULT_ISSUE_LIST_QUERY,
      normalizeIssueListQuery({ filters: { q: 'item 4' } }),
      normalizeIssueListQuery({ group: 'assignee', sort: 'created' }),
      normalizeIssueListQuery({ sections: 'initiative' }),
      normalizeIssueListQuery({ filters: { quick: ['blocked'] } }),
    ].map((query) => buildIssueList({ ...listInput, query }));
    const options = buildIssueListOptions(
      evaluated.snapshot,
      evaluated.ctx,
      evaluated.assessments
    );
    const elapsed = performance.now() - started;

    for (const list of lists) {
      expect(list.shown).toBeLessThanOrEqual(ISSUE_LIST_DEFAULT_LIMIT);
      expect(
        list.sections.reduce((sum, section) => sum + section.groups.length, 0)
      ).toBeLessThanOrEqual(ISSUE_LIST_MAX_GROUPS);
    }
    const [defaultList] = lists;
    expect(defaultList?.total).toBe(36_000);
    expect(defaultList?.shown).toBe(500);
    // The default view's payload stays well under 600 KB of JSON.
    expect(JSON.stringify(defaultList).length).toBeLessThan(600_000);
    // Initiative sections: the first initiative's 200 milestones fill the
    // group budget; the rest are counted.
    expect(lists[3]?.sections.map((section) => section.key)).toEqual([
      'i:init-0',
    ]);
    expect(lists[3]?.moreGroups).toEqual({ groups: 1800, issues: 32_400 });
    expect(options.projects).toHaveLength(200);

    expect(evaluated.assessments.size).toBe(2000);
    expect(allocationPlan.projects).toHaveLength(200);
    expect(digests.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const level of levels) expect(level.nodes.length).toBeGreaterThan(0);
    // Generous bound; on a laptop this runs in well under a second.
    expect(elapsed).toBeLessThan(4000);
  });

  // The 50k fixture closes every fourth issue, so its blocks chain breaks
  // at each closed issue: no aggregate edges, and short chains. This one is
  // all open: one blocks chain through 20,000 issues in 400 milestones of
  // 40 projects (10 initiatives), plus a relation from each project into
  // the project two further on.
  test('a 20k-issue open chain: the chain cap and aggregate edges, quickly', () => {
    const projects: Project[] = [];
    const milestones: Milestone[] = [];
    const issues: Issue[] = [];
    const initiatives: Initiative[] = Array.from({ length: 10 }, (_, i) =>
      initiative(`init-${i}`, { sortOrder: i })
    );
    for (let p = 0; p < 40; p++) {
      projects.push(
        project(`p${p}`, { sortOrder: p, initiativeIds: [`init-${p % 10}`] })
      );
      for (let m = 0; m < 10; m++) {
        const id = `p${p}-m${m}`;
        milestones.push(
          milestone(id, `p${p}`, { targetDate: day(m * 3 + 1), sortOrder: m })
        );
        for (let i = 0; i < 50; i++) {
          issues.push(
            issue(`${id}-i${i}`, {
              identifier: `ENG-${issues.length + 1}`,
              projectId: `p${p}`,
              milestoneId: id,
              assigneeId: i % 7 === 0 ? null : 'lead',
              stateId: STATE.started,
            })
          );
        }
      }
    }
    const relations: BlockingRelation[] = issues.slice(1).map((blocked, i) => ({
      id: `r${i}`,
      blockerId: issues[i]?.id ?? '',
      blockedId: blocked.id,
    }));
    for (let p = 0; p + 2 < 40; p++) {
      relations.push({
        id: `x${p}`,
        blockerId: `p${p}-m5-i3`,
        blockedId: `p${p + 2}-m2-i7`,
      });
    }
    const started = performance.now();
    const evaluated = evaluate(
      workspace({
        users: [user('lead')],
        initiatives,
        projects,
        milestones,
        issues,
        relations,
      })
    );
    const graphOf = (scope: GraphScope): DependencyGraph =>
      buildDependencyGraph(
        evaluated.snapshot,
        evaluated.ctx,
        evaluated.assessments,
        scope
      );
    const chain = graphOf({ level: 'issue', issueId: 'ENG-10000' });
    const projectLevel = graphOf({ level: 'project' });
    const initiativeLevel = graphOf({ level: 'initiative' });
    const elapsed = performance.now() - started;

    expect(chain.nodes).toHaveLength(150);
    expect(chain.nodes[0]?.id).toBe('p19-m9-i49');
    // The walk is uncapped: every issue before and after the focus (the
    // cross relations only shorten paths).
    expect(chain.chain).toEqual({
      focusId: 'p19-m9-i49',
      upstream: 9999,
      downstream: 10000,
      hidden: 19850,
    });
    expect(projectLevel.edges.length).toBeGreaterThan(39);
    expect(initiativeLevel.edges.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(4000);
  });
});
