import {
  assessWorkspace,
  buildIssueList,
  buildIssueListOptions,
  DEFAULT_TUNING,
  type EvalContext,
  indexWorkspace,
  type IssueListOptions,
  type MilestoneMeta,
  planAllocation,
  type WorkspaceData,
} from '@better-tracker/core';
import {
  ISSUE_BULK_MAX,
  type IssueBulkOutcome,
  type IssueBulkResult,
} from '@better-tracker/engine';
import {
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';

import {
  buildIssueListPage,
  INITIATIVE_DROP_REASON,
  parseIssueListParams,
  PICKER_OPTION_LIMIT,
} from '../lib/adapters/issue-list';
import {
  ALREADY_THERE,
  allocationSentences,
  assigneeChange,
  BULK_CONFIRM_AT,
  bulkAssigneeOptions,
  bulkConfirm,
  type BulkConfirmNames,
  bulkPriorityOptions,
  bulkResultToast,
  bulkStateOptions,
  currentMoveChoice,
  dropPlan,
  failureNotes,
  type IssueChange,
  type IssueRowFacts,
  ISSUE_MOVE_MAX,
  leavesFilters,
  milestoneMenuOptions,
  moveChange,
  movePatch,
  moveTargetOptions,
  notChangedIds,
  ORDER_FROM_WEIGHT,
  priorityChange,
  rowMenuOptions,
  rowOverlay,
  stateChange,
  teamStateChoices,
  undoRequests,
  undoResultToast,
  UNDO_TOAST_MS,
  weightAfter,
  weightToast,
  wouldChange,
} from '../lib/adapters/issue-moves';

// Moving issues on the Issues page (architecture §8.4 "Issues", moving;
// §7.3): what a pick, a drop or a key sends, the pickers' options, the
// drop rule, the confirmation, the pending rows, every toast and Undo,
// over the demo workspace (Northwind, 2026-10-22) and literal results.

const TODAY = '2026-10-22';

function workspace(edit?: (data: WorkspaceData) => void) {
  const data = createFixtureWorkspace(TODAY);
  edit?.(data);
  const snapshot = indexWorkspace(data);
  const ctx: EvalContext = {
    today: TODAY,
    now: '2026-10-22T12:00:00.000Z',
    tuning: DEFAULT_TUNING,
    meta: new Map<string, MilestoneMeta>(
      FIXTURE_MILESTONE_META.map((m) => [
        m.milestoneId,
        { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
      ])
    ),
  };
  const assessments = assessWorkspace(snapshot, ctx);
  const allocationPlan = planAllocation(snapshot, ctx, assessments);
  return {
    page: (params: Record<string, string>, viewerId = 'user-chloe') => {
      const query = parseIssueListParams(params);
      const view = buildIssueList({
        snapshot,
        ctx,
        assessments,
        allocationPlan,
        query,
        viewerId,
      });
      return buildIssueListPage({
        view,
        query,
        viewerId,
        readOnly: false,
        canWriteLinear: true,
        canMove: true,
        related: (id) =>
          (snapshot.blockersOf.get(id)?.length ?? 0) > 0 ||
          (snapshot.blocking.get(id)?.length ?? 0) > 0,
      });
    },
    options: (): IssueListOptions =>
      buildIssueListOptions(snapshot, ctx, assessments),
  };
}

const demo = workspace();
const options = demo.options();

/** One row's facts, written out. */
function facts(over: Partial<IssueRowFacts> & { id: string }): IssueRowFacts {
  return {
    identifier: over.id.replace('iss-', '').toUpperCase(),
    teamId: 'team-eng',
    projectId: 'proj-garnet',
    milestoneId: null,
    assigneeId: null,
    priority: 3,
    stateId: 'st-eng-todo',
    stateType: 'unstarted',
    stateName: 'Todo',
    open: true,
    related: false,
    ...over,
  };
}

const NAMES: BulkConfirmNames = {
  project: (id) =>
    ({
      'proj-garnet': 'Garnet mobile app',
      'proj-atlas': 'Atlas billing migration',
      'proj-compass': 'Compass onboarding',
    })[id],
  projectTeamIds: (id) =>
    ({
      'proj-garnet': ['team-eng'],
      'proj-atlas': ['team-eng'],
      'proj-compass': ['team-eng', 'team-ops'],
    })[id],
  team: (id) => ({ 'team-eng': 'Engineering', 'team-ops': 'Operations' })[id],
};

/** A bulk result written out (only the fields under test vary). */
function result(over: Partial<IssueBulkResult>): IssueBulkResult {
  const outcomes = over.outcomes ?? [];
  const count = (status: string) =>
    outcomes.filter((o) => o.status === status).length;
  return {
    at: '2026-10-22T12:00:00.000Z',
    outcomes,
    counts: {
      changed: count('changed'),
      unchanged: count('unchanged'),
      skipped: count('skipped'),
      failed: count('failed'),
    },
    stopped: null,
    allocation: { handedOver: [], stopped: [] },
    ...over,
  };
}

const BEFORE_54 = {
  projectId: 'proj-garnet',
  milestoneId: null,
  assigneeId: 'user-ben',
  priority: 1 as const,
  stateType: 'unstarted' as const,
  stateName: 'Todo',
};

const TO_PUSH: IssueChange = {
  patch: { move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-2' } },
  label: 'Garnet mobile app › Push notifications',
  short: 'Push notifications',
};

describe('the cap', () => {
  test('the page caps a change where the engine does', () => {
    expect(ISSUE_MOVE_MAX).toBe(ISSUE_BULK_MAX);
    expect(ISSUE_MOVE_MAX).toBe(100);
    expect(BULK_CONFIRM_AT).toBe(20);
  });
});

describe('the move picker', () => {
  test('the moving issues’ projects first, other active projects, inactive last, then No project', () => {
    const list = moveTargetOptions(options, {
      projectIds: ['proj-garnet'],
      teamIds: ['team-eng'],
      today: TODAY,
      search: '',
    });
    expect(list.more).toBe(0);
    const groups = [...new Set(list.options.map((o) => o.group))];
    expect(groups[0]).toBe('Garnet mobile app');
    expect(groups.at(-2)).toBe('Fjord analytics · inactive');
    expect(groups.at(-1)).toBe('Other');
    const garnet = list.options.filter((o) => o.group === 'Garnet mobile app');
    expect(garnet.map((o) => [o.value, o.label, o.hint])).toEqual([
      ['m:ms-garnet-1', 'Offline mode', 'Oct 28 · next'],
      ['m:ms-garnet-2', 'Push notifications', 'Nov 11'],
      ['p:proj-garnet', 'No milestone', undefined],
    ]);
    expect(list.options.at(-1)).toEqual({
      value: 'p:none',
      label: 'No project',
      group: 'Other',
    });
  });

  test('a complete milestone comes last in its project, hinted "complete"; weights show', () => {
    const list = moveTargetOptions(options, {
      projectIds: [],
      teamIds: ['team-eng'],
      today: TODAY,
      search: 'atlas',
    });
    const atlas = list.options.filter(
      (o) => o.group === 'Atlas billing migration'
    );
    expect(atlas.map((o) => [o.label, o.hint])).toEqual([
      ['Dual-write', 'Oct 19 · next'],
      ['Read path switch', 'Nov 16'],
      ['Schema cutover', 'complete'],
      ['No milestone', undefined],
    ]);
    const juniper = moveTargetOptions(options, {
      projectIds: [],
      teamIds: ['team-eng'],
      today: TODAY,
      search: 'tokens',
    });
    expect(juniper.options[0]?.hint).toBe('Nov 5 · next · ↑5');
  });

  test('a project that does not include the issue’s team says so', () => {
    const list = moveTargetOptions(options, {
      projectIds: [],
      teamIds: ['team-ops'],
      today: TODAY,
      search: 'garnet',
    });
    expect(list.options.map((o) => o.hint)).toEqual([
      'Oct 28 · next · not OPS’s',
      'Nov 11 · not OPS’s',
      'not OPS’s',
    ]);
    const both = moveTargetOptions(options, {
      projectIds: [],
      teamIds: ['team-ops', 'team-eng'],
      today: TODAY,
      search: 'compass',
    });
    expect(both.options.some((o) => o.hint?.includes('not') === true)).toBe(
      false
    );
  });

  test('a long list is cut at 200 with the rest counted', () => {
    const many: IssueListOptions = {
      ...options,
      projects: [
        {
          id: 'proj-big',
          name: 'Big project',
          active: true,
          statusName: 'In Progress',
          homeInitiativeId: null,
          teamIds: ['team-eng'],
          leadId: null,
          milestones: Array.from({ length: 250 }, (_, i) => ({
            id: `ms-${i}`,
            name: `Milestone ${i}`,
            targetDate: null,
            daysLeft: null,
            status: 'on_track' as const,
            isNext: false,
            weight: null,
          })),
        },
      ],
    };
    const list = moveTargetOptions(many, {
      projectIds: [],
      teamIds: ['team-eng'],
      today: TODAY,
      search: '',
    });
    expect(list.options).toHaveLength(PICKER_OPTION_LIMIT);
    expect(list.more).toBe(52);
  });

  test('each choice as a cell’s single edit and as a bulk change', () => {
    expect(movePatch('m:ms-garnet-2', options)).toEqual({
      projectId: 'proj-garnet',
      projectMilestoneId: 'ms-garnet-2',
    });
    expect(movePatch('p:proj-garnet', options)).toEqual({
      projectId: 'proj-garnet',
      projectMilestoneId: null,
    });
    expect(movePatch('p:none', options)).toEqual({ projectId: null });
    expect(movePatch('m:ms-nowhere', options)).toBeNull();
    expect(movePatch('m:ms-garnet-2', null)).toBeNull();
    expect(moveChange('m:ms-garnet-2', options)).toEqual(TO_PUSH);
    expect(moveChange('p:proj-atlas', options)).toEqual({
      patch: { move: { projectId: 'proj-atlas', milestoneId: null } },
      label: 'Atlas billing migration › No milestone',
      short: 'No milestone',
    });
    expect(moveChange('p:none', options)).toEqual({
      patch: { move: { projectId: null, milestoneId: null } },
      label: 'No project',
      short: 'No project',
    });
    expect(
      currentMoveChoice(facts({ id: 'iss-eng-50', milestoneId: 'ms-garnet-1' }))
    ).toBe('m:ms-garnet-1');
    expect(currentMoveChoice(facts({ id: 'iss-eng-54' }))).toBe(
      'p:proj-garnet'
    );
    expect(currentMoveChoice(facts({ id: 'iss-x', projectId: null }))).toBe(
      'p:none'
    );
  });
});

describe('the bulk bar’s other pickers', () => {
  test('statuses across ENG and OPS are joined by type and name', () => {
    const states = bulkStateOptions(options, ['team-eng', 'team-ops']);
    expect(states.map((o) => o.label)).toEqual([
      'Triage',
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
    expect(states.every((o) => o.hint === undefined)).toBe(true);
    expect(stateChange('s:started:In Review')).toEqual({
      patch: { state: { type: 'started', name: 'In Review' } },
      label: 'In Review',
    });
    expect(stateChange('s:bogus:In Review')).toBeNull();
    expect(stateChange('nonsense')).toBeNull();
  });

  test('a status one team lacks is hinted "not in {team}"', () => {
    const custom: IssueListOptions = {
      ...options,
      teams: options.teams.map((team) =>
        team.id === 'team-ops'
          ? {
              ...team,
              states: team.states.filter((s) => s.name !== 'In Review'),
            }
          : team
      ),
    };
    const review = bulkStateOptions(custom, ['team-eng', 'team-ops']).find(
      (o) => o.label === 'In Review'
    );
    expect(review?.hint).toBe('not in Operations');
  });

  test('people: Unassign, you, then the other active people', () => {
    const people = bulkAssigneeOptions(options, 'user-chloe');
    expect(people.slice(0, 3).map((o) => [o.value, o.label, o.hint])).toEqual([
      ['none', 'Unassign', undefined],
      ['user-chloe', 'Chloe Diaz', 'You'],
      ['user-ana', 'Ana Moreno', undefined],
    ]);
    expect(people.some((o) => o.value === 'user-hugo')).toBe(false);
    expect(assigneeChange('none', options)).toEqual({
      patch: { assigneeId: null },
      label: 'Unassigned',
    });
    expect(assigneeChange('user-ben', options)).toEqual({
      patch: { assigneeId: 'user-ben' },
      label: 'Ben Carter',
    });
    expect(assigneeChange('user-nobody', options)).toBeNull();
  });

  test('priorities, Urgent first, No priority last', () => {
    expect(bulkPriorityOptions().map((o) => o.label)).toEqual([
      'Urgent',
      'High',
      'Medium',
      'Low',
      'No priority',
    ]);
    expect(priorityChange('2')).toEqual({
      patch: { priority: 2 },
      label: 'High',
    });
    expect(priorityChange('9')).toBeNull();
  });

  test('one issue’s status picker lists its own team’s statuses', () => {
    const ops = teamStateChoices(options, 'team-ops');
    expect(ops[0]).toEqual({
      id: 'st-ops-triage',
      name: 'Triage',
      kind: 'triage',
    });
    expect(ops.every((s) => s.id.startsWith('st-ops-'))).toBe(true);
    expect(teamStateChoices(null, 'team-ops')).toEqual([]);
  });
});

describe('the page model carries what moves need', () => {
  test('row facts, drop targets and the milestone menus', () => {
    const page = demo.page({ project: 'proj-garnet', milestone: 'none' });
    expect(page.rowFacts['iss-eng-54']).toEqual({
      id: 'iss-eng-54',
      identifier: 'ENG-54',
      teamId: 'team-eng',
      projectId: 'proj-garnet',
      milestoneId: null,
      assigneeId: 'user-ben',
      priority: 1,
      stateId: 'st-eng-todo',
      stateType: 'unstarted',
      stateName: 'Todo',
      open: true,
      related: false,
    });
    const push = Object.entries(page.targets).find(([key]) =>
      key.endsWith('m:ms-garnet-2')
    )?.[1];
    expect(push).toEqual({
      patch: {
        move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-2' },
      },
      projectOnly: false,
      reason: null,
      label: 'Garnet mobile app › Push notifications',
      short: 'Push notifications',
    });
    const menu = Object.entries(page.milestoneMenus).find(([key]) =>
      key.endsWith('m:ms-garnet-2')
    )?.[1];
    expect(menu).toEqual({
      milestoneId: 'ms-garnet-2',
      name: 'Push notifications',
      weight: null,
    });
    expect(page.projectNames['proj-garnet']).toBe('Garnet mobile app');
  });

  test('a blocked or blocking issue is related (the Blocking chain item)', () => {
    const page = demo.page({});
    expect(page.rowFacts['iss-eng-12']?.related).toBe(true);
    expect(page.rowFacts['iss-eng-54']?.related).toBe(false);
  });

  test('initiative groups take nothing and say why; deactivated people too', () => {
    const page = demo.page({ group: 'initiative' });
    // Initiative groups (`…/i:<id>`); the "No project" group under them
    // still takes issues (to no project).
    const targets = Object.entries(page.targets)
      .filter(([key]) => key.includes('/i:'))
      .map(([, target]) => target);
    expect(targets.length).toBeGreaterThan(0);
    const noProject = Object.entries(page.targets).find(([key]) =>
      key.endsWith('/np')
    )?.[1];
    expect(noProject?.patch).toEqual({
      move: { projectId: null, milestoneId: null },
    });
    for (const target of targets) {
      expect(target.patch).toBeNull();
      expect(target.reason).toBe(INITIATIVE_DROP_REASON);
    }
    const hugo = workspace((data) => {
      data.issues = data.issues.map((issue) =>
        issue.identifier === 'ENG-55'
          ? { ...issue, assigneeId: 'user-hugo' }
          : issue
      );
    }).page({ group: 'assignee' });
    const target = Object.entries(hugo.targets).find(([key]) =>
      key.endsWith('a:user-hugo')
    )?.[1];
    expect(target?.patch).toBeNull();
    expect(target?.reason).toBe('Hugo Laurent is deactivated in Linear.');
    const group = hugo.sections
      .flatMap((s) => s.groups)
      .find((g) => g.id.endsWith('a:user-hugo'));
    expect(group?.droppable).toBe(true);
  });
});

describe('drops', () => {
  const rows: Record<string, IssueRowFacts> = {
    'iss-eng-50': facts({ id: 'iss-eng-50', milestoneId: 'ms-garnet-1' }),
    'iss-eng-54': facts({ id: 'iss-eng-54' }),
    'iss-eng-10': facts({
      id: 'iss-eng-10',
      projectId: 'proj-atlas',
      milestoneId: 'ms-atlas-2',
    }),
  };

  test('a milestone takes every dragged issue; one row on its own milestone hears about the weight', () => {
    const target = {
      patch: TO_PUSH.patch,
      projectOnly: false,
      reason: null,
      label: TO_PUSH.label,
      short: 'Push notifications',
    };
    expect(dropPlan(target, ['iss-eng-50', 'iss-eng-54'], rows)).toEqual({
      ok: true,
      issueIds: ['iss-eng-50', 'iss-eng-54'],
      change: TO_PUSH,
    });
    const own = {
      ...target,
      patch: { move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-1' } },
    };
    expect(dropPlan(own, ['iss-eng-50'], rows)).toEqual({
      ok: false,
      reason: ORDER_FROM_WEIGHT,
    });
  });

  test('a project group sends only the issues from other projects, so the rest keep their milestones', () => {
    const garnet = {
      patch: { move: { projectId: 'proj-garnet', milestoneId: null } },
      projectOnly: true,
      reason: null,
      label: 'Garnet mobile app › No milestone',
    };
    expect(
      dropPlan(garnet, ['iss-eng-50', 'iss-eng-54', 'iss-eng-10'], rows)
    ).toEqual({
      ok: true,
      issueIds: ['iss-eng-10'],
      change: {
        patch: garnet.patch,
        label: 'Garnet mobile app › No milestone',
      },
    });
    expect(dropPlan(garnet, ['iss-eng-50', 'iss-eng-54'], rows)).toEqual({
      ok: false,
      reason: ALREADY_THERE,
    });
  });

  test('a status group of the same type but another name takes the row', () => {
    const progress: Record<string, IssueRowFacts> = {
      'iss-eng-13': facts({
        id: 'iss-eng-13',
        stateId: 'st-eng-progress',
        stateType: 'started',
        stateName: 'In Progress',
      }),
    };
    const review = {
      patch: { state: { type: 'started' as const, name: 'In Review' } },
      projectOnly: false,
      reason: null,
      label: 'In Review',
    };
    expect(dropPlan(review, ['iss-eng-13'], progress)).toEqual({
      ok: true,
      issueIds: ['iss-eng-13'],
      change: { patch: review.patch, label: 'In Review' },
    });
    expect(
      dropPlan(
        {
          ...review,
          patch: { state: { type: 'started', name: ' in progress ' } },
        },
        ['iss-eng-13'],
        progress
      )
    ).toEqual({ ok: false, reason: ALREADY_THERE });
  });

  test('a group that takes nothing gives its reason', () => {
    expect(
      dropPlan(
        {
          patch: null,
          projectOnly: false,
          reason: INITIATIVE_DROP_REASON,
          label: '',
        },
        ['iss-eng-54'],
        rows
      )
    ).toEqual({ ok: false, reason: INITIATIVE_DROP_REASON });
    expect(dropPlan(undefined, ['iss-eng-54'], rows)).toEqual({
      ok: false,
      reason: 'Nothing to change here.',
    });
  });

  test('wouldChange compares each field the patch sets', () => {
    const row = facts({ id: 'iss-eng-54', assigneeId: 'user-ben' });
    expect(wouldChange(row, { assigneeId: 'user-ben' })).toBe(false);
    expect(wouldChange(row, { assigneeId: null })).toBe(true);
    expect(wouldChange(row, { priority: 3 })).toBe(false);
    expect(
      wouldChange(row, { state: { type: 'unstarted', name: ' todo ' } })
    ).toBe(false);
    expect(wouldChange(row, { state: { type: 'started', name: 'Todo' } })).toBe(
      true
    );
    expect(
      wouldChange(row, {
        move: { projectId: 'proj-garnet', milestoneId: null },
      })
    ).toBe(false);
  });
});

describe('the confirmation', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `iss-${i}`);
  const sameProject = (n: number) =>
    Object.fromEntries(ids(n).map((id) => [id, facts({ id })]));

  test('nothing to ask under 20 issues; at 20 the bar asks', () => {
    expect(
      bulkConfirm({
        change: TO_PUSH,
        issueIds: ids(19),
        facts: sameProject(19),
        drag: false,
        names: NAMES,
      })
    ).toBeNull();
    expect(
      bulkConfirm({
        change: TO_PUSH,
        issueIds: ids(20),
        facts: sameProject(20),
        drag: false,
        names: NAMES,
      })
    ).toEqual({
      message:
        'Move 20 issues to Garnet mobile app › Push notifications? This changes them in Linear, as you.',
      confirmLabel: 'Move 20 issues',
    });
    expect(
      bulkConfirm({
        change: { patch: { priority: 2 }, label: 'High' },
        issueIds: ids(20),
        facts: sameProject(20),
        drag: false,
        names: NAMES,
      })
    ).toEqual({
      message:
        'Set 20 issues to High priority? This changes them in Linear, as you.',
      confirmLabel: 'Set 20 issues',
    });
    // No priority reads as the done toast does, not "No priority priority".
    expect(
      bulkConfirm({
        change: { patch: { priority: 0 }, label: 'No priority' },
        issueIds: ids(20),
        facts: sameProject(20),
        drag: false,
        names: NAMES,
      })
    ).toEqual({
      message:
        'Set 20 issues to no priority? This changes them in Linear, as you.',
      confirmLabel: 'Set 20 issues',
    });
  });

  test('a drag that changes a project asks even for one issue; the bar does not', () => {
    const rows = {
      'iss-eng-10': facts({
        id: 'iss-eng-10',
        identifier: 'ENG-10',
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-2',
      }),
      'iss-eng-54': facts({ id: 'iss-eng-54', identifier: 'ENG-54' }),
    };
    expect(
      bulkConfirm({
        change: TO_PUSH,
        issueIds: ['iss-eng-10'],
        facts: rows,
        drag: false,
        names: NAMES,
      })
    ).toBeNull();
    expect(
      bulkConfirm({
        change: TO_PUSH,
        issueIds: ['iss-eng-10'],
        facts: rows,
        drag: true,
        names: NAMES,
      })
    ).toEqual({
      message:
        'Move ENG-10 to Garnet mobile app › Push notifications? It moves from Atlas billing migration to Garnet mobile app. This changes it in Linear, as you.',
      confirmLabel: 'Move ENG-10',
    });
    expect(
      bulkConfirm({
        change: TO_PUSH,
        issueIds: ['iss-eng-10', 'iss-eng-54'],
        facts: rows,
        drag: true,
        names: NAMES,
      })?.message
    ).toBe(
      'Move 2 issues to Garnet mobile app › Push notifications? 1 of them moves from Atlas billing migration to Garnet mobile app. This changes them in Linear, as you.'
    );
  });

  test('issues of a team the project does not include are named', () => {
    const rows = {
      'iss-ops-1': facts({
        id: 'iss-ops-1',
        identifier: 'OPS-1',
        teamId: 'team-ops',
        projectId: 'proj-compass',
      }),
    };
    expect(
      bulkConfirm({
        change: TO_PUSH,
        issueIds: ['iss-ops-1'],
        facts: rows,
        drag: true,
        names: NAMES,
      })?.message
    ).toBe(
      'Move OPS-1 to Garnet mobile app › Push notifications? It moves from Compass onboarding to Garnet mobile app. 1 is in Operations, which Garnet mobile app does not include. This changes it in Linear, as you.'
    );
  });
});

describe('pending rows', () => {
  test('a move shows the new place and "Moving to …"; other fields "Saving…"', () => {
    expect(rowOverlay(TO_PUSH)).toEqual({
      values: { milestone: 'Push notifications', milestoneProject: undefined },
      note: 'Moving to Push notifications…',
    });
    expect(
      rowOverlay({
        patch: { move: { projectId: 'proj-garnet', milestoneId: null } },
        label: 'Garnet mobile app › No milestone',
        short: 'No milestone',
      })
    ).toEqual({
      values: { milestone: null, milestoneProject: undefined },
      note: 'Moving to No milestone…',
    });
    expect(
      rowOverlay({ patch: { assigneeId: 'user-ana' }, label: 'Ana Moreno' })
    ).toEqual({
      values: { assignee: 'Ana Moreno', assigneeTone: undefined },
      note: 'Saving…',
    });
    expect(
      rowOverlay({
        patch: { state: { type: 'completed', name: 'Done' } },
        label: 'Done',
      })
    ).toEqual({
      values: { state: 'Done', stateKind: 'completed' },
      note: 'Saving…',
    });
    expect(rowOverlay({ patch: { priority: 1 }, label: 'Urgent' })).toEqual({
      values: { priority: 1, priorityLabel: 'Urgent' },
      note: 'Saving…',
    });
  });

  test('a change that takes an issue out of the view’s filters', () => {
    const row = facts({ id: 'iss-eng-54', assigneeId: 'user-ben' });
    const context = {
      viewerId: 'user-chloe',
      homeInitiative: (id: string) =>
        ({ 'proj-garnet': 'init-mobile', 'proj-atlas': 'init-billing' })[id],
    };
    const unplanned = parseIssueListParams({
      project: 'proj-garnet',
      milestone: 'none',
    });
    expect(leavesFilters(unplanned, row, TO_PUSH.patch, context)).toBe(true);
    expect(
      leavesFilters(
        unplanned,
        row,
        { move: { projectId: 'proj-garnet', milestoneId: null } },
        context
      )
    ).toBe(false);
    const mine = parseIssueListParams({ assignee: 'me' });
    expect(
      leavesFilters(mine, row, { assigneeId: 'user-chloe' }, context)
    ).toBe(false);
    expect(leavesFilters(mine, row, { assigneeId: null }, context)).toBe(true);
    const open = parseIssueListParams({});
    expect(
      leavesFilters(
        open,
        row,
        { state: { type: 'completed', name: 'Done' } },
        context
      )
    ).toBe(true);
    const urgent = parseIssueListParams({ priority: 'urgent' });
    expect(leavesFilters(urgent, row, { priority: 2 }, context)).toBe(true);
    const billing = parseIssueListParams({ initiative: 'init-billing' });
    expect(leavesFilters(billing, row, TO_PUSH.patch, context)).toBe(true);
    expect(
      leavesFilters(
        billing,
        row,
        { move: { projectId: 'proj-atlas', milestoneId: null } },
        context
      )
    ).toBe(false);
  });
});

describe('toasts', () => {
  const changed = (id: string, identifier: string): IssueBulkOutcome => ({
    status: 'changed',
    issueId: id,
    identifier,
    changed: ['projectMilestoneId'],
    before: BEFORE_54,
  });

  test('all changed: the sentence, Undo for 8 seconds', () => {
    const toast = bulkResultToast(
      result({
        outcomes: [
          changed('iss-eng-54', 'ENG-54'),
          changed('iss-eng-55', 'ENG-55'),
        ],
      }),
      TO_PUSH
    );
    expect(toast).toEqual({
      kind: 'info',
      label: 'Saved',
      message: 'Moved 2 issues to Garnet mobile app › Push notifications.',
      action: 'undo',
      duration: UNDO_TOAST_MS,
    });
    expect(UNDO_TOAST_MS).toBe(8000);
  });

  test('one issue is named; some already had it; some left the view', () => {
    expect(
      bulkResultToast(
        result({
          outcomes: [
            changed('iss-eng-54', 'ENG-54'),
            {
              status: 'unchanged',
              issueId: 'iss-eng-55',
              identifier: 'ENG-55',
            },
          ],
        }),
        TO_PUSH,
        { leftView: 1 }
      ).message
    ).toBe(
      'Moved ENG-54 to Garnet mobile app › Push notifications. 1 already had that. 1 no longer matches these filters.'
    );
  });

  test('the other fields’ sentences', () => {
    const one = result({ outcomes: [changed('iss-eng-54', 'ENG-54')] });
    expect(
      bulkResultToast(one, {
        patch: { assigneeId: 'user-ana' },
        label: 'Ana Moreno',
      }).message
    ).toBe('Assigned ENG-54 to Ana Moreno.');
    expect(
      bulkResultToast(one, { patch: { assigneeId: null }, label: 'Unassigned' })
        .message
    ).toBe('Unassigned ENG-54.');
    expect(
      bulkResultToast(one, {
        patch: { state: { type: 'started', name: 'In Review' } },
        label: 'In Review',
      }).message
    ).toBe('Set ENG-54 to In Review.');
    expect(
      bulkResultToast(one, { patch: { priority: 2 }, label: 'High' }).message
    ).toBe('Set ENG-54 to High priority.');
    expect(
      bulkResultToast(one, { patch: { priority: 0 }, label: 'No priority' })
        .message
    ).toBe('Set ENG-54 to no priority.');
  });

  test('nothing to change', () => {
    expect(
      bulkResultToast(
        result({
          outcomes: [
            {
              status: 'unchanged',
              issueId: 'iss-eng-54',
              identifier: 'ENG-54',
            },
            {
              status: 'unchanged',
              issueId: 'iss-eng-55',
              identifier: 'ENG-55',
            },
            {
              status: 'unchanged',
              issueId: 'iss-eng-53',
              identifier: 'ENG-53',
            },
          ],
        }),
        TO_PUSH
      )
    ).toEqual({
      kind: 'info',
      label: 'No change',
      message: 'Nothing to change: the 3 issues already had that.',
      action: null,
      duration: 4000,
    });
  });

  test('partly saved: the first reason, "and N more", Select them', () => {
    const partial = result({
      outcomes: [
        changed('iss-eng-54', 'ENG-54'),
        {
          status: 'skipped',
          issueId: 'iss-ops-1',
          identifier: 'OPS-1',
          reason: 'state_not_in_team',
          message:
            'Operations has no In Review status; OPS-1 was left as it was.',
        },
        {
          status: 'failed',
          issueId: 'iss-ops-2',
          identifier: 'OPS-2',
          code: 'linear_forbidden',
          message: 'Linear refused: you cannot edit OPS-2.',
        },
      ],
    });
    expect(
      bulkResultToast(partial, {
        patch: { state: { type: 'started', name: 'In Review' } },
        label: 'In Review',
      })
    ).toEqual({
      kind: 'error',
      label: 'Partly saved',
      message:
        'Changed 1 of 3 issues. 2 not changed: Operations has no In Review status; OPS-1 was left as it was and 1 more.',
      action: 'select',
      duration: 12_000,
    });
    expect(notChangedIds(partial)).toEqual(['iss-ops-1', 'iss-ops-2']);
    expect([...failureNotes(partial, TO_PUSH)]).toEqual([
      [
        'iss-ops-1',
        'Not moved · Operations has no In Review status; OPS-1 was left as it was',
      ],
      ['iss-ops-2', 'Not moved · Linear refused: you cannot edit OPS-2'],
    ]);
  });

  test('stopped by Linear’s rate limit, or by the sign-in', () => {
    const outcomes = [
      changed('iss-eng-54', 'ENG-54'),
      {
        status: 'skipped' as const,
        issueId: 'iss-eng-55',
        identifier: 'ENG-55',
        reason: 'not_attempted' as const,
        message: 'Not attempted: Linear’s rate limit was reached.',
      },
    ];
    expect(
      bulkResultToast(
        result({
          outcomes,
          stopped: {
            code: 'rate_limited',
            retryAt: '2026-10-22T15:05:00.000Z',
          },
        }),
        TO_PUSH,
        { timeZone: 'UTC' }
      )
    ).toEqual({
      kind: 'error',
      label: 'Partly saved',
      message:
        'Linear’s rate limit: 1 of 2 changed. Try the rest after 3:05 PM.',
      action: 'select',
      duration: 12_000,
    });
    expect(
      bulkResultToast(
        result({ outcomes, stopped: { code: 'not_signed_in', retryAt: null } }),
        TO_PUSH
      ).message
    ).toBe(
      'Linear stopped accepting your sign-in after 1 of 2. Sign in again, then retry the rest.'
    );
  });

  test('the allocation sentences: handed over (live and dry run) and stopped', () => {
    expect(
      allocationSentences(
        {
          handedOver: [
            {
              projectId: 'proj-garnet',
              projectName: 'Garnet mobile app',
              leadName: 'Ben Carter',
              issueIds: ['iss-eng-55', 'iss-eng-56'],
              live: true,
            },
          ],
          stopped: [],
        },
        2
      )
    ).toEqual([
      '2 of them are unassigned in Garnet mobile app’s next milestone: the next allocation run gives them to Ben Carter.',
    ]);
    expect(
      allocationSentences(
        {
          handedOver: [
            {
              projectId: 'proj-garnet',
              projectName: 'Garnet mobile app',
              leadName: 'Ben Carter',
              issueIds: ['iss-eng-55'],
              live: false,
            },
          ],
          stopped: [
            {
              projectId: 'proj-garnet',
              projectName: 'Garnet mobile app',
              reason: 'next_milestone_invalid',
              gaps: ['no_issues'],
            },
          ],
        },
        1
      )
    ).toEqual([
      'It is unassigned in Garnet mobile app’s next milestone: a live allocation run would give it to Ben Carter (allocation is in dry run).',
      'Allocation is stopped for Garnet mobile app: Next milestone is missing: issues.',
    ]);
  });
});

describe('Undo', () => {
  test('one request per place the issues were', () => {
    const undo = undoRequests(
      result({
        outcomes: [
          {
            status: 'changed',
            issueId: 'iss-eng-54',
            identifier: 'ENG-54',
            changed: ['projectMilestoneId'],
            before: BEFORE_54,
          },
          {
            status: 'changed',
            issueId: 'iss-eng-55',
            identifier: 'ENG-55',
            changed: ['projectMilestoneId'],
            before: { ...BEFORE_54, assigneeId: null, priority: 4 },
          },
          {
            status: 'changed',
            issueId: 'iss-eng-10',
            identifier: 'ENG-10',
            changed: ['projectId', 'projectMilestoneId'],
            before: {
              ...BEFORE_54,
              projectId: 'proj-atlas',
              milestoneId: 'ms-atlas-2',
            },
          },
          { status: 'unchanged', issueId: 'iss-eng-53', identifier: 'ENG-53' },
        ],
      }),
      TO_PUSH.patch
    );
    expect(undo).toEqual([
      {
        issueIds: ['iss-eng-54', 'iss-eng-55'],
        patch: { move: { projectId: 'proj-garnet', milestoneId: null } },
      },
      {
        issueIds: ['iss-eng-10'],
        patch: { move: { projectId: 'proj-atlas', milestoneId: 'ms-atlas-2' } },
      },
    ]);
  });

  test('a two-field change goes back by the tuple of both fields', () => {
    const undo = undoRequests(
      result({
        outcomes: [
          {
            status: 'changed',
            issueId: 'iss-eng-54',
            identifier: 'ENG-54',
            changed: ['projectMilestoneId', 'assigneeId'],
            before: BEFORE_54,
          },
          {
            status: 'changed',
            issueId: 'iss-eng-55',
            identifier: 'ENG-55',
            changed: ['projectMilestoneId', 'assigneeId'],
            before: { ...BEFORE_54, assigneeId: null },
          },
          {
            status: 'changed',
            issueId: 'iss-eng-56',
            identifier: 'ENG-56',
            changed: ['projectMilestoneId', 'assigneeId'],
            before: BEFORE_54,
          },
        ],
      }),
      { ...TO_PUSH.patch, assigneeId: 'user-ana' }
    );
    expect(undo).toEqual([
      {
        issueIds: ['iss-eng-54', 'iss-eng-56'],
        patch: {
          move: { projectId: 'proj-garnet', milestoneId: null },
          assigneeId: 'user-ben',
        },
      },
      {
        issueIds: ['iss-eng-55'],
        patch: {
          move: { projectId: 'proj-garnet', milestoneId: null },
          assigneeId: null,
        },
      },
    ]);
  });

  test('status and priority go back by name and value', () => {
    const undo = undoRequests(
      result({
        outcomes: [
          {
            status: 'changed',
            issueId: 'iss-eng-54',
            identifier: 'ENG-54',
            changed: ['stateId', 'priority'],
            before: BEFORE_54,
          },
        ],
      }),
      { state: { type: 'completed', name: 'Done' }, priority: 4 }
    );
    expect(undo).toEqual([
      {
        issueIds: ['iss-eng-54'],
        patch: { priority: 1, state: { type: 'unstarted', name: 'Todo' } },
      },
    ]);
  });

  test('the Undo toast: back where they were, or which issue left the planner', () => {
    const back = result({
      outcomes: [
        {
          status: 'changed',
          issueId: 'iss-eng-54',
          identifier: 'ENG-54',
          changed: ['projectMilestoneId'],
          before: BEFORE_54,
        },
        { status: 'unchanged', issueId: 'iss-eng-55', identifier: 'ENG-55' },
      ],
    });
    expect(undoResultToast([back], 2)).toEqual({
      kind: 'info',
      label: 'Undone',
      message: '2 issues are back where they were.',
      action: null,
      duration: 4000,
    });
    const gone = result({
      outcomes: [
        {
          status: 'changed',
          issueId: 'iss-eng-54',
          identifier: 'ENG-54',
          changed: ['projectMilestoneId'],
          before: BEFORE_54,
        },
        {
          status: 'failed',
          issueId: 'iss-eng-12',
          identifier: null,
          code: 'not_found',
          message: 'iss-eng-12 is not in the planner any more.',
        },
      ],
    });
    // Reported, never retried: the toast has no action.
    expect(undoResultToast([gone], 2)).toEqual({
      kind: 'error',
      label: 'Partly undone',
      message: 'Undid 1 of 2: An issue left the planner; undo it in Linear.',
      action: null,
      duration: 12_000,
    });
    expect(
      undoResultToast([], 2, 'Your session ended. Sign in again.')
    ).toEqual({
      kind: 'error',
      label: 'Partly undone',
      message: 'Undid 0 of 2: Your session ended. Sign in again.',
      action: null,
      duration: 12_000,
    });
  });
});

describe('menus', () => {
  test('the row menu: the edits, disabled without the grant, gone for a guest', () => {
    const row = facts({ id: 'iss-eng-12', related: true });
    const member = rowMenuOptions({
      facts: row,
      readOnly: false,
      canWriteLinear: true,
      targets: 1,
    });
    expect(member.map((o) => [o.value, o.label, o.hint ?? null])).toEqual([
      ['open', 'Open', '↵'],
      ['move', 'Move to milestone…', 'M'],
      ['assign', 'Assign to…', 'A'],
      ['status', 'Status…', 'S'],
      ['priority', 'Priority…', 'P'],
      ['chain', 'Blocking chain', null],
      ['page', 'Open issue page', null],
      ['linear', 'Open in Linear ↗', null],
      ['copy', 'Copy link', null],
    ]);
    const noGrant = rowMenuOptions({
      facts: row,
      readOnly: false,
      canWriteLinear: false,
      targets: 1,
    });
    expect(
      noGrant.filter((o) => o.disabled === true).map((o) => [o.value, o.hint])
    ).toEqual([
      ['move', 'Needs Linear write access'],
      ['assign', 'Needs Linear write access'],
      ['status', 'Needs Linear write access'],
      ['priority', 'Needs Linear write access'],
    ]);
    const guest = rowMenuOptions({
      facts: facts({ id: 'iss-ops-1' }),
      readOnly: true,
      canWriteLinear: false,
      targets: 1,
    });
    expect(guest.map((o) => o.value)).toEqual([
      'open',
      'page',
      'linear',
      'copy',
    ]);
    const many = rowMenuOptions({
      facts: row,
      readOnly: false,
      canWriteLinear: true,
      targets: 3,
    });
    expect(many.find((o) => o.value === 'move')?.group).toBe(
      '3 selected issues'
    );
  });

  test('Blocking chain needs a relation, not a project (it opens the issue’s own chain)', () => {
    const menu = (over: Partial<IssueRowFacts>) =>
      rowMenuOptions({
        facts: facts({ id: 'iss-x', ...over }),
        readOnly: false,
        canWriteLinear: true,
        targets: 1,
      }).map((o) => o.value);
    expect(menu({ related: true, projectId: null })).toContain('chain');
    expect(menu({ related: true })).toContain('chain');
    expect(menu({ related: false })).not.toContain('chain');
  });

  test('the milestone menu: raise, lower, clear, its bounds, and what it toasts', () => {
    const menu = { milestoneId: 'ms-atlas-2', name: 'Dual-write', weight: 2 };
    expect(
      milestoneMenuOptions(menu, { min: -1000, max: 1000 }).map((o) => [
        o.value,
        o.label,
        o.hint ?? null,
        o.disabled === true,
      ])
    ).toEqual([
      ['raise', 'Raise weight', 'Becomes 3', false],
      ['lower', 'Lower weight', 'Becomes 1', false],
      ['clear', 'Clear weight', null, false],
      [
        'about',
        'Weight changes only the order on screen, never which milestone is next.',
        null,
        true,
      ],
      ['open', 'Open milestone', null, false],
    ]);
    // Below zero with a real minus sign.
    expect(
      milestoneMenuOptions({ ...menu, weight: null }, { min: -1000, max: 1000 })
        .filter((o) => o.value === 'raise' || o.value === 'lower')
        .map((o) => o.hint)
    ).toEqual(['Becomes 1', 'Becomes \u22121']);
    const top = milestoneMenuOptions(
      { ...menu, weight: 1000 },
      { min: -1000, max: 1000 }
    );
    expect(top.find((o) => o.value === 'raise')?.disabled).toBe(true);
    const none = milestoneMenuOptions(
      { ...menu, weight: null },
      { min: -1000, max: 1000 }
    );
    expect(none.some((o) => o.value === 'clear')).toBe(false);
    expect(weightAfter('raise', null)).toBe(1);
    expect(weightAfter('raise', 2)).toBe(3);
    expect(weightAfter('lower', 1)).toBeNull();
    expect(weightAfter('lower', null)).toBe(-1);
    expect(weightAfter('clear', 4)).toBeNull();
    expect(weightAfter('open', 4)).toBeUndefined();
    expect(weightToast('Dual-write', 2)).toBe('Dual-write has weight 2 now.');
    expect(weightToast('Dual-write', null)).toBe(
      'Dual-write has no weight now.'
    );
  });
});
