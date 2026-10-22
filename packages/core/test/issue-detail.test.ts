import { describe, expect, test } from 'bun:test';

import {
  buildIssueDetail,
  buildIssueEditOptions,
  COMMENT_MAX_LENGTH,
  ISSUE_DESCRIPTION_MAX_LENGTH,
  ISSUE_FIELD_LABEL,
  ISSUE_TITLE_MAX_LENGTH,
} from '../src/index';
import type { IssueDetail, WorkspaceData } from '../src/index';
import {
  ago,
  day,
  evaluate,
  issue,
  milestone,
  project,
  STATE,
  team,
  TEAM,
  teamStates,
  user,
  workspace,
} from './helpers';

// pA: overdue next milestone mA1 holding T (unassigned, Backlog, last moved
// 10 days ago) and a later mA2. pB: mB1 due in 3 days with an unassigned
// issue (at risk). pP: a paused project. T is blocked by B1 (done) and B2
// (open, in the paused project), blocks X (in mB1) and C (closed), and
// has one relation to an issue the mirror does not hold.
function scenario(overrides: Partial<WorkspaceData> = {}): WorkspaceData {
  return workspace({
    users: [
      user('lead'),
      user('ana', { name: 'Ana' }),
      user('bob', { name: 'Bob' }),
      user('ghost', { name: 'Ghost', active: false }),
      user('robot', { name: 'Robot', app: true }),
    ],
    teams: [
      team(TEAM, 'ENG', 'Engineering'),
      team('team-ops', 'OPS', 'Operations'),
    ],
    states: [...teamStates(), ...teamStates('team-ops')],
    projects: [
      project('pA', { name: 'Alpha', priority: 1, sortOrder: 1 }),
      project('pB', {
        name: 'Bravo',
        leadId: 'ghost',
        priority: 2,
        sortOrder: 2,
        teamIds: ['team-ops'],
      }),
      project('pP', {
        name: 'Paused',
        statusType: 'paused',
        statusName: 'Paused',
        priority: 1,
        sortOrder: 0,
      }),
    ],
    milestones: [
      milestone('mA1', 'pA', { name: 'First', targetDate: day(-2) }),
      milestone('mA2', 'pA', { name: 'Second', targetDate: day(20) }),
      milestone('mB1', 'pB', { name: 'Beta', targetDate: day(3) }),
      milestone('mP1', 'pP', { name: 'Parked', targetDate: day(-5) }),
    ],
    issues: [
      issue('T', {
        identifier: 'ENG-1',
        title: 'Target',
        projectId: 'pA',
        milestoneId: 'mA1',
        priority: 2,
        lastStateChangeAt: ago(10),
      }),
      issue('B1', {
        identifier: 'ENG-2',
        projectId: 'pA',
        milestoneId: 'mA2',
        stateId: STATE.done,
        assigneeId: 'ana',
      }),
      issue('B2', {
        identifier: 'ENG-3',
        projectId: 'pP',
        milestoneId: 'mP1',
        stateId: STATE.started,
        assigneeId: 'bob',
      }),
      issue('X', {
        identifier: 'ENG-4',
        projectId: 'pB',
        milestoneId: 'mB1',
        stateId: STATE.todo,
      }),
      issue('C', {
        identifier: 'ENG-5',
        projectId: 'pA',
        milestoneId: 'mA2',
        stateId: STATE.canceled,
        assigneeId: 'ana',
      }),
    ],
    relations: [
      { id: 'r-b1', blockerId: 'B1', blockedId: 'T' },
      { id: 'r-b2', blockerId: 'B2', blockedId: 'T' },
      { id: 'r-x', blockerId: 'T', blockedId: 'X' },
      { id: 'r-x-dup', blockerId: 'T', blockedId: 'X' },
      { id: 'r-c', blockerId: 'T', blockedId: 'C' },
      { id: 'r-gone', blockerId: 'gone', blockedId: 'T' },
    ],
    ...overrides,
  });
}

function detailOf(data: WorkspaceData, issueId: string): IssueDetail {
  const evaluated = evaluate(data);
  const detail = buildIssueDetail({ ...evaluated, issueId });
  if (detail === null) throw new Error(`no detail for ${issueId}`);
  return detail;
}

describe('buildIssueDetail', () => {
  test('null for an issue the mirror does not hold', () => {
    expect(buildIssueDetail({ ...evaluate(scenario()), issueId: 'nope' })).toBe(
      null
    );
  });

  test('the issue with its state, team, project and milestone context', () => {
    const detail = detailOf(scenario(), 'T');
    expect(detail.issue.id).toBe('T');
    expect(detail.state).toEqual({
      id: STATE.backlog,
      name: 'Backlog',
      type: 'backlog',
    });
    expect(detail.team).toEqual({ id: TEAM, key: 'ENG', name: 'Engineering' });
    expect(detail.assignee).toBe(null);
    expect(detail.priority).toBe(2);
    expect(detail.project).toEqual({
      id: 'pA',
      name: 'Alpha',
      url: 'https://linear.app/acme/project/pA',
      statusType: 'started',
      statusName: 'In Progress',
      active: true,
      lead: { id: 'lead', name: 'Lead', active: true },
    });
    expect(detail.milestone).toMatchObject({
      id: 'mA1',
      name: 'First',
      targetDate: day(-2),
      daysLeft: -2,
      status: 'overdue',
      isNext: true,
      rubric: { valid: true, gaps: [] },
    });
    expect(detail.milestone?.reasons).toContain('unassigned_open');
    expect(detail.milestone?.progress.openUnassigned).toBe(1);
  });

  test('a deactivated assignee or lead is named and marked inactive', () => {
    const data = scenario();
    const x = data.issues.find((i) => i.id === 'X');
    if (x !== undefined) x.assigneeId = 'ghost';
    const detail = detailOf(data, 'X');
    expect(detail.assignee).toEqual({
      id: 'ghost',
      name: 'Ghost',
      active: false,
    });
    expect(detail.project?.lead).toEqual({
      id: 'ghost',
      name: 'Ghost',
      active: false,
    });
  });

  test('blocked-by and blocks rows with relation ids, open first', () => {
    const detail = detailOf(scenario(), 'T');
    expect(detail.blockedBy.map((r) => [r.relationId, r.issueId])).toEqual([
      ['r-b2', 'B2'],
      ['r-b1', 'B1'],
    ]);
    const [b2, b1] = detail.blockedBy;
    // B2 is open and lives in a paused project: outside active work.
    expect(b2).toMatchObject({
      identifier: 'ENG-3',
      stateName: 'In Progress',
      stateType: 'started',
      assigneeId: 'bob',
      assigneeName: 'Bob',
      projectName: 'Paused',
      milestoneName: 'Parked',
      external: true,
      resolved: false,
    });
    // B1 is done: the relation no longer holds T up.
    expect(b1).toMatchObject({ external: false, resolved: true });

    // The duplicate pair counts once; the closed blocked issue sorts last.
    expect(detail.blocks.map((r) => [r.relationId, r.issueId])).toEqual([
      ['r-x', 'X'],
      ['r-c', 'C'],
    ]);
    // T (the blocker) is open, so neither row is resolved.
    expect(detail.blocks.map((r) => r.resolved)).toEqual([false, false]);
    expect(detail.blocks[0]).toMatchObject({
      assigneeId: null,
      assigneeName: null,
      projectName: 'Bravo',
      milestoneName: 'Beta',
    });
    expect(detail.hiddenRelations).toBe(1);
  });

  test('timing: days in state and stalled per tuning.stallDays', () => {
    const detail = detailOf(scenario(), 'T');
    expect(detail.timing).toMatchObject({
      lastStateChangeAt: ago(10),
      daysInState: 10,
      stalled: true,
    });
    const evaluated = evaluate(scenario(), { tuning: { stallDays: 14 } });
    expect(
      buildIssueDetail({ ...evaluated, issueId: 'T' })?.timing.stalled
    ).toBe(false);
    // A closed issue is never stalled.
    const closed = detailOf(scenario(), 'C');
    expect(closed.timing.stalled).toBe(false);
    expect(closed.timing.canceledAt).toBe(null);
  });

  test('why it matters: next-milestone unassigned, at-risk milestones held, risk chain', () => {
    const detail = detailOf(scenario(), 'T');
    expect(detail.why).toEqual({
      unassignedInNextMilestone: true,
      blocksAtRiskMilestones: [
        {
          milestoneId: 'mB1',
          name: 'Beta',
          projectName: 'Bravo',
          status: 'at_risk',
        },
      ],
      waitsOnUnassigned: false,
      // B2's milestone is overdue; like the graph (§2.10), the transitive
      // waits do not look at project status.
      waitsOnOverdue: true,
      // T itself is unassigned (and overdue) and blocks an open issue.
      onRiskChain: true,
    });
    // X waits on T, which is unassigned and in an overdue milestone.
    expect(detailOf(scenario(), 'X').why).toMatchObject({
      unassignedInNextMilestone: true,
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
      onRiskChain: true,
    });
  });

  test('why it matters stays quiet for triage, later milestones and inactive projects', () => {
    const data = scenario();
    const t = data.issues.find((i) => i.id === 'T');
    if (t === undefined) throw new Error('no T');
    t.stateId = STATE.triage;
    expect(detailOf(data, 'T').why.unassignedInNextMilestone).toBe(false);

    t.stateId = STATE.backlog;
    t.milestoneId = 'mA2';
    expect(detailOf(data, 'T').why.unassignedInNextMilestone).toBe(false);

    // An at-risk milestone of a paused project is not loud.
    const paused = scenario({
      projects: scenario().projects.map((p) =>
        p.id === 'pB' ? { ...p, statusType: 'paused' as const } : p
      ),
    });
    expect(detailOf(paused, 'T').why.blocksAtRiskMilestones).toEqual([]);

    // A closed issue holds nothing up.
    const done = scenario();
    const doneT = done.issues.find((i) => i.id === 'T');
    if (doneT !== undefined) doneT.stateId = STATE.done;
    expect(detailOf(done, 'T').why).toEqual({
      unassignedInNextMilestone: false,
      blocksAtRiskMilestones: [],
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      onRiskChain: false,
    });
  });

  test('an issue without a project or milestone', () => {
    const data = scenario({
      issues: [issue('L', { identifier: 'ENG-9', assigneeId: 'ana' })],
      relations: [],
    });
    const detail = detailOf(data, 'L');
    expect(detail.project).toBe(null);
    expect(detail.milestone).toBe(null);
    expect(detail.assignee).toEqual({ id: 'ana', name: 'Ana', active: true });
    expect(detail.blockedBy).toEqual([]);
    expect(detail.blocks).toEqual([]);
    expect(detail.hiddenRelations).toBe(0);
    expect(detail.why.onRiskChain).toBe(false);
  });
});

describe('buildIssueEditOptions', () => {
  test("the team's states in order, active people, active projects first", () => {
    const { snapshot, ctx } = evaluate(scenario());
    const options = buildIssueEditOptions(snapshot, ctx, TEAM);
    expect(options.states.map((s) => s.name)).toEqual([
      'Triage',
      'Backlog',
      'Todo',
      'In Progress',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
    expect(options.states.every((s) => s.teamId === TEAM)).toBe(true);
    // Deactivated people and app users cannot be assigned.
    expect(options.assignees.map((a) => a.id)).toEqual(['ana', 'bob', 'lead']);
    expect(
      options.projects.map((p) => [p.id, p.active, p.includesTeam])
    ).toEqual([
      ['pA', true, true],
      ['pB', true, false],
      ['pP', false, true],
    ]);
    expect(options.projects[0]?.milestones).toEqual([
      { id: 'mA1', name: 'First', targetDate: day(-2) },
      { id: 'mA2', name: 'Second', targetDate: day(20) },
    ]);
  });

  test('states follow their type group first: position only orders within one', () => {
    const data = scenario();
    // Linear numbers positions per type group, so a backlog state added
    // later can carry a position above Done's.
    data.states.push({
      id: 'icebox',
      teamId: TEAM,
      name: 'Icebox',
      type: 'backlog',
      position: 50,
    });
    const { snapshot, ctx } = evaluate(data);
    expect(
      buildIssueEditOptions(snapshot, ctx, TEAM).states.map((s) => s.name)
    ).toEqual([
      'Triage',
      'Backlog',
      'Icebox',
      'Todo',
      'In Progress',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
  });

  test('the detail carries the options for its own team', () => {
    const detail = detailOf(scenario(), 'T');
    expect(detail.options.states).toHaveLength(7);
    expect(detail.options.states.every((s) => s.teamId === TEAM)).toBe(true);
  });
});

describe('issue edit limits and labels', () => {
  test('limits match architecture §7', () => {
    expect(ISSUE_TITLE_MAX_LENGTH).toBe(255);
    expect(ISSUE_DESCRIPTION_MAX_LENGTH).toBe(100_000);
    expect(COMMENT_MAX_LENGTH).toBe(10_000);
  });

  test('every patch field has a label', () => {
    expect(Object.keys(ISSUE_FIELD_LABEL).sort()).toEqual(
      [
        'assigneeId',
        'description',
        'dueDate',
        'estimate',
        'labelIds',
        'priority',
        'projectId',
        'projectMilestoneId',
        'stateId',
        'title',
      ].sort()
    );
    expect(ISSUE_FIELD_LABEL.stateId).toBe('Status');
  });
});
