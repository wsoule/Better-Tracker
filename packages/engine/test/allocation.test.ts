import { addDays, allocationComment } from '@better-tracker/core';
import {
  type FixtureStore,
  LinearApiError,
  type LinearGateway,
} from '@better-tracker/linear';
import type { RunEntry } from '@better-tracker/store';
import { afterEach, describe, expect, test } from 'bun:test';

import { EngineAuthError, EngineInputError } from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  fixtureIssue,
  type GatewayWrapper,
  WORKSPACE_ID,
  rejectionMessage,
  rejection,
} from './helpers';

let harness: DemoHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** The five assignments the fixture plans (§2.8 against the scenario table). */
const PLANNED: Record<
  string,
  { assigneeId: string; toStateId: string | null }
> = {
  'iss-eng-12': { assigneeId: 'user-chloe', toStateId: 'st-eng-todo' },
  'iss-eng-13': { assigneeId: 'user-chloe', toStateId: null },
  'iss-eng-31': { assigneeId: 'user-ana', toStateId: 'st-eng-todo' },
  'iss-ops-1': { assigneeId: 'user-ana', toStateId: 'st-ops-todo' },
  'iss-eng-32': { assigneeId: 'user-ana', toStateId: null },
};

function byAction(entries: RunEntry[], action: RunEntry['action']): RunEntry[] {
  return entries.filter((entry) => entry.action === action);
}

async function runEntries(h: DemoHarness, runId: string): Promise<RunEntry[]> {
  const detail = await h.engine.getRun(WORKSPACE_ID, runId);
  if (detail === null) throw new Error('run not found');
  return detail.entries;
}

// Wraps every gateway so each Linear write, by the app or a person, is
// recorded (and still applied).
function recordWrites(writes: string[]): GatewayWrapper {
  return (gateway, actor): LinearGateway => {
    const who = actor === 'app' ? 'app' : actor.userId;
    return {
      ...gateway,
      updateIssue: (id, input) => {
        writes.push(`${who}:updateIssue:${id}`);
        return gateway.updateIssue(id, input);
      },
      createComment: (id, body) => {
        writes.push(`${who}:createComment:${id}`);
        return gateway.createComment(id, body);
      },
      updateMilestoneTargetDate: (id, date) => {
        writes.push(`${who}:updateMilestoneTargetDate:${id}`);
        return gateway.updateMilestoneTargetDate(id, date);
      },
      updateProjectLead: (id, leadId) => {
        writes.push(`${who}:updateProjectLead:${id}`);
        return gateway.updateProjectLead(id, leadId);
      },
    };
  };
}

describe('dry run', () => {
  test('records the plan and writes nothing to Linear', async () => {
    const writes: string[] = [];
    harness = await createDemoHarness({ wrap: recordWrites(writes) });
    const h = harness;
    const before = structuredClone(h.fixture.data);
    const pm = await actorFor(h, 'user-ana');

    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'manual',
      actor: pm,
    });
    expect(run.status).toBe('succeeded');
    expect(run.mode).toBe('dry_run');
    expect(run.startedByUserId).toBe('user-ana');
    expect(run.summary).toEqual({
      assigned: 0,
      wouldAssign: 5,
      failed: 0,
      blockedProjects: 3,
      skippedIssues: expect.any(Number),
    });

    const entries = await runEntries(h, run.id);
    const planned = byAction(entries, 'assign');
    expect(planned.every((e) => e.outcome === 'planned')).toBe(true);
    expect(
      Object.fromEntries(
        planned.map((e) => [
          e.issueId,
          { assigneeId: e.assigneeId, toStateId: e.detail['toStateId'] },
        ])
      )
    ).toEqual(PLANNED);
    // The Compass-like project: its unassigned Backlog issues go to its
    // lead and move to Todo; its Todo issue keeps its state.
    const compass = planned.filter((e) => e.projectId === 'proj-compass');
    expect(
      compass
        .map((e) => e.issueIdentifier ?? '')
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(['ENG-31', 'ENG-32', 'OPS-1']);
    expect(compass.every((e) => e.milestoneId === 'ms-compass-1')).toBe(true);

    const blocks = byAction(entries, 'block');
    expect(
      Object.fromEntries(blocks.map((e) => [e.projectId, e.reason]))
    ).toEqual({
      'proj-delta': 'no_lead',
      'proj-ember': 'lead_inactive',
      'proj-harbor': 'next_milestone_invalid',
    });
    expect(blocks.find((e) => e.projectId === 'proj-harbor')?.detail).toEqual({
      gaps: ['no_done_means'],
    });

    const skips = byAction(entries, 'skip');
    expect(run.summary?.skippedIssues).toBe(skips.length);
    expect(skips.find((e) => e.issueId === 'iss-eng-33')?.reason).toBe(
      'triage'
    );
    expect(skips.find((e) => e.issueId === 'iss-eng-30')?.reason).toBe(
      'already_assigned'
    );

    expect(h.fixture.data).toEqual(before);
    expect(h.fixture.comments).toEqual([]);
    // Not one write call reached any gateway.
    expect(writes).toEqual([]);
    expect((await h.engine.listRuns(WORKSPACE_ID, 5)).map((r) => r.id)).toEqual(
      [run.id]
    );
  });

  test('a public caller cannot skip the fresh sync before planning', async () => {
    let fetches = 0;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () => {
        fetches += 1;
        return gateway.fetchWorkspace();
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    fetches = 0;
    // syncFirst is internal to runDaily; a caller smuggling it in is ignored.
    const input = {
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run' as const,
      trigger: 'manual' as const,
      actor: await actorFor(h, 'user-ana'),
      syncFirst: false,
    };
    await h.engine.runAllocation(input);
    expect(fetches).toBe(1);
  });

  test('the schedule may dry-run; non-PMs may not', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const scheduled = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'schedule',
      actor: null,
    });
    expect(scheduled.status).toBe('succeeded');
    expect(scheduled.startedByUserId).toBeNull();

    const member = await actorFor(h, 'user-chloe');
    for (const mode of ['dry_run', 'live'] as const) {
      expect(
        await rejection(
          h.engine.runAllocation({
            workspaceId: WORKSPACE_ID,
            mode,
            trigger: 'manual',
            actor: member,
          })
        )
      ).toMatchObject({ name: 'EngineAuthError', code: 'not_pm' });
    }
    expect(
      await rejection(
        h.engine.runAllocation({
          workspaceId: WORKSPACE_ID,
          mode: 'everything' as 'live',
          trigger: 'manual',
          actor: null,
        })
      )
    ).toBeInstanceOf(EngineInputError);
    // Refusals never start a run.
    expect(await h.engine.listRuns(WORKSPACE_ID, 10)).toHaveLength(1);
  });
});

describe('live run', () => {
  test('assigns, moves to Todo, comments once per issue and patches the mirror', async () => {
    const calls: string[] = [];
    const wrap: GatewayWrapper = (gateway) => ({
      ...gateway,
      updateIssue: (id, input) => {
        calls.push(`update:${id}`);
        return gateway.updateIssue(id, input);
      },
      createComment: (id, body) => {
        calls.push(`comment:${id}`);
        return gateway.createComment(id, body);
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    const today = h.clock.today();

    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'live',
      trigger: 'schedule',
      actor: null,
    });
    expect(run.status).toBe('succeeded');
    expect(run.summary?.assigned).toBe(5);
    expect(run.summary?.failed).toBe(0);
    expect(run.finishedAt).not.toBeNull();

    for (const [issueId, plan] of Object.entries(PLANNED)) {
      const issue = fixtureIssue(h.fixture, issueId);
      expect(issue.assigneeId).toBe(plan.assigneeId);
      if (plan.toStateId !== null) expect(issue.stateId).toBe(plan.toStateId);
      // Assign first, then comment.
      expect(calls.indexOf(`update:${issueId}`)).toBeLessThan(
        calls.indexOf(`comment:${issueId}`)
      );
    }
    expect(fixtureIssue(h.fixture, 'iss-eng-13').stateId).toBe('st-eng-todo');
    expect(fixtureIssue(h.fixture, 'iss-eng-32').stateId).toBe('st-eng-todo');

    const atlasComment = allocationComment({
      appName: 'Milestone Planner',
      projectName: 'Atlas billing migration',
      milestoneName: 'Dual-write',
      targetDate: addDays(today, -3),
    });
    const compassComment = allocationComment({
      appName: 'Milestone Planner',
      projectName: 'Compass onboarding',
      milestoneName: 'Guided setup',
      targetDate: addDays(today, 5),
    });
    expect(
      h.fixture.comments
        .map((c) => ({
          issueId: c.issueId,
          body: c.body,
          authorId: c.authorId,
        }))
        .sort((a, b) => a.issueId.localeCompare(b.issueId))
    ).toEqual([
      { issueId: 'iss-eng-12', body: atlasComment, authorId: 'user-app' },
      { issueId: 'iss-eng-13', body: atlasComment, authorId: 'user-app' },
      { issueId: 'iss-eng-31', body: compassComment, authorId: 'user-app' },
      { issueId: 'iss-eng-32', body: compassComment, authorId: 'user-app' },
      { issueId: 'iss-ops-1', body: compassComment, authorId: 'user-app' },
    ]);
    expect(compassComment).toContain('you lead Compass onboarding');

    const applied = byAction(await runEntries(h, run.id), 'assign');
    expect(applied.every((e) => e.outcome === 'applied')).toBe(true);
    expect(
      applied.every((e) => e.reason?.startsWith('comment-') === true)
    ).toBe(true);

    // The mirror has the writes without another sync.
    const loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.snapshot.issues.get('iss-ops-1')?.assigneeId).toBe(
      'user-ana'
    );
    expect(loaded.snapshot.issues.get('iss-ops-1')?.stateId).toBe(
      'st-ops-todo'
    );
    expect(loaded.allocationPlan.totals.actions).toBe(0);

    // My week marks the new ones for the lead.
    const week = await h.engine.getWeekView(WORKSPACE_ID, 'user-ana');
    const marked = week.sections
      .flatMap((s) => s.rows)
      .filter((row) => row.newBecauseLeadOf !== null);
    expect(marked.map((row) => row.issueId).sort()).toEqual([
      'iss-eng-31',
      'iss-eng-32',
      'iss-ops-1',
    ]);
    expect(marked[0]?.newBecauseLeadOf).toBe('Compass onboarding');
    expect(week.totals.new).toBe(3);

    // A second live run is idempotent: nothing assigned, nothing commented.
    calls.length = 0;
    const second = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'live',
      trigger: 'schedule',
      actor: null,
    });
    expect(second.status).toBe('succeeded');
    expect(second.summary?.assigned).toBe(0);
    expect(byAction(await runEntries(h, second.id), 'assign')).toEqual([]);
    expect(calls).toEqual([]);
    expect(h.fixture.comments).toHaveLength(5);
  });

  test('a PM can start a live run', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'live',
      trigger: 'manual',
      actor: await actorFor(h, 'user-ben'),
    });
    expect(run.summary?.assigned).toBe(5);
    expect(run.startedByUserId).toBe('user-ben');
  });

  test('re-checks each issue and records stale instead of writing', async () => {
    // Between plan and apply, people change things in Linear.
    const mutated = new Set<string>();
    const fixture = (): FixtureStore => {
      if (harness === null) throw new Error('no harness yet');
      return harness.fixture;
    };
    const mutate: Record<string, () => void> = {
      'iss-eng-12': () => {
        fixtureIssue(fixture(), 'iss-eng-12').assigneeId = 'user-dev';
      },
      'iss-eng-13': () => {
        fixtureIssue(fixture(), 'iss-eng-13').stateId = 'st-eng-done';
      },
      'iss-eng-31': () => {
        fixtureIssue(fixture(), 'iss-eng-31').milestoneId = 'ms-compass-2';
      },
      'iss-ops-1': () => {
        fixtureIssue(fixture(), 'iss-ops-1').stateId = 'st-ops-triage';
      },
      'iss-eng-32': () => {
        fixture().data.issues = fixture().data.issues.filter(
          (i) => i.id !== 'iss-eng-32'
        );
      },
    };
    const writes: string[] = [];
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchIssue: (id) => {
        if (!mutated.has(id)) {
          mutated.add(id);
          mutate[id]?.();
        }
        return gateway.fetchIssue(id);
      },
      updateIssue: (id, input) => {
        writes.push(id);
        return gateway.updateIssue(id, input);
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;

    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'live',
      trigger: 'schedule',
      actor: null,
    });
    expect(run.status).toBe('succeeded');
    expect(run.summary?.assigned).toBe(0);
    const assigns = byAction(await runEntries(h, run.id), 'assign');
    expect(assigns.every((e) => e.outcome === 'stale')).toBe(true);
    expect(
      Object.fromEntries(assigns.map((e) => [e.issueId, e.reason]))
    ).toEqual({
      'iss-eng-12': 'now_assigned',
      'iss-eng-13': 'closed',
      'iss-eng-31': 'moved_milestone',
      'iss-ops-1': 'now_triage',
      'iss-eng-32': 'not_found',
    });
    expect(writes).toEqual([]);
    expect(h.fixture.comments).toEqual([]);
    expect(fixtureIssue(h.fixture, 'iss-eng-12').assigneeId).toBe('user-dev');
  });

  test('a failing write is recorded, the run continues and ends partial', async () => {
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      updateIssue: (id, input) =>
        id === 'iss-eng-31'
          ? Promise.reject(
              new LinearApiError('server', 'Linear is having a moment')
            )
          : gateway.updateIssue(id, input),
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;

    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'live',
      trigger: 'schedule',
      actor: null,
    });
    expect(run.status).toBe('partial');
    expect(run.summary?.assigned).toBe(4);
    expect(run.summary?.failed).toBe(1);
    expect(run.error).toContain('1 assignment(s) failed');

    const assigns = byAction(await runEntries(h, run.id), 'assign');
    const failed = assigns.find((e) => e.issueId === 'iss-eng-31');
    expect(failed?.outcome).toBe('failed');
    expect(failed?.error).toBe('Linear is having a moment');
    expect(assigns.filter((e) => e.outcome === 'applied')).toHaveLength(4);
    expect(fixtureIssue(h.fixture, 'iss-eng-31').assigneeId).toBeNull();
    expect(h.fixture.comments.map((c) => c.issueId)).not.toContain(
      'iss-eng-31'
    );
    expect(h.fixture.comments).toHaveLength(4);
    const stored = (await h.engine.listRuns(WORKSPACE_ID, 1))[0];
    expect(stored?.status).toBe('partial');
  });

  test('a failure after startRun still finishes the run as failed', async () => {
    let failSync = false;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () =>
        failSync
          ? Promise.reject(new LinearApiError('network', 'offline'))
          : gateway.fetchWorkspace(),
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    failSync = true;
    expect(
      await rejectionMessage(
        h.engine.runAllocation({
          workspaceId: WORKSPACE_ID,
          mode: 'live',
          trigger: 'schedule',
          actor: null,
        })
      )
    ).toContain('offline');
    const [run] = await h.engine.listRuns(WORKSPACE_ID, 1);
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('offline');
    expect(run?.finishedAt).not.toBeNull();
    const state = (await h.engine.load(WORKSPACE_ID)).syncState;
    expect(state?.lastFullSyncStatus).toBe('failed');
    expect(state?.lastFullSyncError).toBe('offline');

    // Nothing is left "running": the next run starts.
    failSync = false;
    const next = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'schedule',
      actor: null,
    });
    expect(next.status).toBe('succeeded');
  });

  test('concurrent runs: the second is refused as a conflict', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const input = {
      workspaceId: WORKSPACE_ID,
      mode: 'live' as const,
      trigger: 'schedule' as const,
      actor: null,
    };
    const results = await Promise.allSettled([
      h.engine.runAllocation(input),
      h.engine.runAllocation(input),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]?.reason as EngineInputError;
    expect(reason).toBeInstanceOf(EngineInputError);
    expect(reason.code).toBe('conflict');
    expect(reason.message).toBe('An allocation run is already in progress.');
    // Only the winner wrote: one comment per issue.
    expect(h.fixture.comments).toHaveLength(5);
  });

  test('a run for another workspace or without an installation is refused', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const pm = await actorFor(h, 'user-ana');
    expect(
      await rejection(
        h.engine.runAllocation({
          workspaceId: 'org-other',
          mode: 'dry_run',
          trigger: 'manual',
          actor: pm,
        })
      )
    ).toMatchObject({ code: 'wrong_workspace' });
    expect(
      await rejection(
        h.engine.runAllocation({
          workspaceId: 'org-other',
          mode: 'dry_run',
          trigger: 'schedule',
          actor: null,
        })
      )
    ).toBeInstanceOf(EngineAuthError);
  });
});
