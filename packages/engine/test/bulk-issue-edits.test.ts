// Bulk issue edits (owner request 2026-10-22, architecture §7.3) over the
// demo workspace: moves, status by name across teams, whole-request
// refusals that write nothing, per-issue outcomes, the person's gateway at
// most ISSUE_BULK_CONCURRENCY at a time, one mirror patch per call, one
// shared audit instant, the issue locks, and the allocation effects.

import type { Issue, IssuePatch } from '@better-tracker/core';
import { LinearApiError, type LinearGateway } from '@better-tracker/linear';
import type { AuditEntry } from '@better-tracker/store';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  ISSUE_BULK_CONCURRENCY,
  ISSUE_BULK_MAX,
  normalizeIssueBulkPatch,
} from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  fixtureIssue,
  rejection,
  WORKSPACE_ID,
} from './helpers';

/**
 * Per-test control over the person's gateway: every updateIssueFields call
 * is recorded with who made it, may be delayed, may fail, and may run a
 * hook after Linear accepted it (to play a webhook landing mid-run).
 */
interface Hooks {
  calls: string[];
  inFlight: number;
  maxInFlight: number;
  delayMs: number;
  fail: (issueId: string, call: number) => Error | null;
  afterWrite: (issueId: string, written: Issue) => Promise<Issue>;
}

let h: DemoHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup(): Promise<{
  harness: DemoHarness;
  chloe: Actor;
  hooks: Hooks;
}> {
  const hooks: Hooks = {
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    delayMs: 0,
    fail: () => null,
    afterWrite: (_id, written) => Promise.resolve(written),
  };
  const harness = await createDemoHarness({
    wrap: (gateway, actor): LinearGateway => ({
      ...gateway,
      updateIssueFields: async (id: string, patch: IssuePatch) => {
        const who = actor === 'app' ? 'app' : actor.userId;
        hooks.calls.push(`${who}:${id}`);
        const call = hooks.calls.length;
        hooks.inFlight += 1;
        hooks.maxInFlight = Math.max(hooks.maxInFlight, hooks.inFlight);
        try {
          // A refusal comes back at once; accepted writes take delayMs.
          const failure = hooks.fail(id, call);
          if (failure !== null) throw failure;
          await new Promise((resolve) => setTimeout(resolve, hooks.delayMs));
          const written = await gateway.updateIssueFields(id, patch);
          return await hooks.afterWrite(id, written);
        } finally {
          hooks.inFlight -= 1;
        }
      },
    }),
  });
  h = harness;
  return { harness, chloe: await actorFor(harness, 'user-chloe'), hooks };
}

async function mirrored(harness: DemoHarness, id: string): Promise<Issue> {
  const issue = (await harness.engine.load(WORKSPACE_ID)).snapshot.issues.get(
    id
  );
  if (issue === undefined) throw new Error(`${id} is not mirrored`);
  return issue;
}

async function version(harness: DemoHarness): Promise<number> {
  return (await harness.engine.load(WORKSPACE_ID)).mirrorVersion;
}

// The audit entries in the order they were appended (listAudit is newest
// first, then by id descending).
async function appended(harness: DemoHarness): Promise<AuditEntry[]> {
  return (await harness.store.listAudit(WORKSPACE_ID, 500)).reverse();
}

describe('moves', () => {
  test('into another milestone of the same project', async () => {
    const { harness, chloe, hooks } = await setup();
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-54', 'iss-eng-55'],
      { move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-2' } }
    );
    expect(result.counts).toEqual({
      changed: 2,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(result.stopped).toBeNull();
    expect(result.outcomes).toEqual([
      {
        status: 'changed',
        issueId: 'iss-eng-54',
        identifier: 'ENG-54',
        changed: ['projectMilestoneId'],
        before: {
          projectId: 'proj-garnet',
          milestoneId: null,
          assigneeId: 'user-ben',
          priority: 1,
          stateType: 'unstarted',
          stateName: 'Todo',
        },
      },
      {
        status: 'changed',
        issueId: 'iss-eng-55',
        identifier: 'ENG-55',
        changed: ['projectMilestoneId'],
        before: {
          projectId: 'proj-garnet',
          milestoneId: null,
          assigneeId: null,
          priority: 4,
          stateType: 'backlog',
          stateName: 'Backlog',
        },
      },
    ]);
    // With the person's own gateway.
    expect(hooks.calls).toEqual([
      'user-chloe:iss-eng-54',
      'user-chloe:iss-eng-55',
    ]);
    expect((await mirrored(harness, 'iss-eng-54')).milestoneId).toBe(
      'ms-garnet-2'
    );
    expect(fixtureIssue(harness.fixture, 'iss-eng-55').milestoneId).toBe(
      'ms-garnet-2'
    );
    expect(
      (await appended(harness)).map((e) => [
        e.action,
        e.subjectId,
        e.before,
        e.after,
        e.at,
        e.actorUserId,
      ])
    ).toEqual([
      [
        'issue.milestone',
        'iss-eng-54',
        null,
        'ms-garnet-2',
        result.at,
        'user-chloe',
      ],
      [
        'issue.milestone',
        'iss-eng-55',
        null,
        'ms-garnet-2',
        result.at,
        'user-chloe',
      ],
    ]);
  });

  test('across projects: the project comes with the milestone; audit by field, then request order', async () => {
    const { harness, chloe } = await setup();
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-18', 'iss-eng-55'],
      { move: { projectId: 'proj-harbor', milestoneId: 'ms-harbor-2' } }
    );
    expect(
      result.outcomes.map((o) => o.status === 'changed' && o.changed)
    ).toEqual([
      ['projectId', 'projectMilestoneId'],
      ['projectId', 'projectMilestoneId'],
    ]);
    expect(await mirrored(harness, 'iss-eng-18')).toMatchObject({
      projectId: 'proj-harbor',
      milestoneId: 'ms-harbor-2',
    });
    expect(
      (await appended(harness)).map((e) => [
        e.action,
        e.subjectId,
        e.before,
        e.after,
      ])
    ).toEqual([
      ['issue.project', 'iss-eng-18', 'proj-atlas', 'proj-harbor'],
      ['issue.project', 'iss-eng-55', 'proj-garnet', 'proj-harbor'],
      ['issue.milestone', 'iss-eng-18', null, 'ms-harbor-2'],
      ['issue.milestone', 'iss-eng-55', null, 'ms-harbor-2'],
    ]);
    const at = new Set((await appended(harness)).map((e) => e.at));
    expect([...at]).toEqual([result.at]);
  });

  test('"No milestone in P", "No project", and no-ops left unchanged', async () => {
    const { harness, chloe, hooks } = await setup();
    const unplanned = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-50', 'iss-eng-54'],
      { move: { projectId: 'proj-garnet', milestoneId: null } }
    );
    expect(unplanned.outcomes).toMatchObject([
      {
        status: 'changed',
        identifier: 'ENG-50',
        changed: ['projectMilestoneId'],
      },
      // Already in Garnet with no milestone.
      { status: 'unchanged', issueId: 'iss-eng-54', identifier: 'ENG-54' },
    ]);
    expect(hooks.calls).toEqual(['user-chloe:iss-eng-50']);
    const loose = await harness.engine.updateIssues(chloe, ['iss-eng-16'], {
      move: { projectId: null, milestoneId: null },
    });
    expect(loose.outcomes).toMatchObject([
      { status: 'changed', changed: ['projectId', 'projectMilestoneId'] },
    ]);
    expect(await mirrored(harness, 'iss-eng-16')).toMatchObject({
      projectId: null,
      milestoneId: null,
    });
    const versionBefore = await version(harness);
    const auditBefore = (await appended(harness)).length;
    const again = await harness.engine.updateIssues(chloe, ['iss-eng-16'], {
      move: { projectId: null, milestoneId: null },
    });
    expect(again.counts).toEqual({
      changed: 0,
      unchanged: 1,
      skipped: 0,
      failed: 0,
    });
    expect(await version(harness)).toBe(versionBefore);
    expect((await appended(harness)).length).toBe(auditBefore);
  });
});

describe('status by name', () => {
  test("resolves each issue's own team's state; a team without it is skipped", async () => {
    const { harness, chloe } = await setup();
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-13', 'iss-ops-1'],
      { state: { type: 'started', name: ' in review ' } }
    );
    expect(result.counts.changed).toBe(2);
    expect((await mirrored(harness, 'iss-eng-13')).stateId).toBe(
      'st-eng-review'
    );
    expect((await mirrored(harness, 'iss-ops-1')).stateId).toBe(
      'st-ops-review'
    );

    // Operations gets a "Waiting" state Engineering does not have.
    harness.fixture.data.states.push({
      id: 'st-ops-waiting',
      teamId: 'team-ops',
      name: 'Waiting',
      type: 'started',
      position: 9,
    });
    await harness.engine.fullSync(WORKSPACE_ID);
    const waiting = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-13', 'iss-ops-1'],
      { state: { type: 'started', name: 'Waiting' } }
    );
    expect(waiting.outcomes).toEqual([
      {
        status: 'skipped',
        issueId: 'iss-eng-13',
        identifier: 'ENG-13',
        reason: 'state_not_in_team',
        message:
          'Engineering has no Waiting status; ENG-13 was left as it was.',
      },
      {
        status: 'changed',
        issueId: 'iss-ops-1',
        identifier: 'OPS-1',
        changed: ['stateId'],
        before: {
          projectId: 'proj-compass',
          milestoneId: 'ms-compass-1',
          assigneeId: null,
          priority: 3,
          stateType: 'started',
          stateName: 'In Review',
        },
      },
    ]);
    // A name is never guessed by type.
    expect((await mirrored(harness, 'iss-eng-13')).stateId).toBe(
      'st-eng-review'
    );
  });
});

describe('whole-request refusals write nothing', () => {
  test.each([
    ['no issues', [], { priority: 1 }, 'invalid'],
    [
      'more than the cap',
      Array.from({ length: 101 }, (_, i) => `iss-${i}`),
      { priority: 1 },
      'invalid',
    ],
    ['an empty change', ['iss-eng-55'], {}, 'invalid'],
    ['an unknown field', ['iss-eng-55'], { title: 'Renamed' }, 'invalid'],
    [
      'a milestone of another project',
      ['iss-eng-55'],
      { move: { projectId: 'proj-atlas', milestoneId: 'ms-garnet-1' } },
      'invalid',
    ],
    [
      'a deactivated assignee',
      ['iss-eng-55'],
      { assigneeId: 'user-hugo' },
      'invalid',
    ],
    [
      'an app as assignee',
      ['iss-eng-55'],
      { assigneeId: 'user-app' },
      'invalid',
    ],
    [
      'an unknown milestone',
      ['iss-eng-55'],
      { move: { projectId: 'proj-garnet', milestoneId: 'ms-gone' } },
      'not_found',
    ],
    [
      'an unknown project',
      ['iss-eng-55'],
      { move: { projectId: 'proj-gone', milestoneId: null } },
      'not_found',
    ],
    [
      'an unknown person',
      ['iss-eng-55'],
      { assigneeId: 'user-ghost' },
      'not_found',
    ],
  ] as const)('%s', async (_label, ids, patch, code) => {
    const { harness, chloe, hooks } = await setup();
    const versionBefore = await version(harness);
    const error = await rejection(
      harness.engine.updateIssues(chloe, ids, patch as never)
    );
    expect(error).toBeInstanceOf(EngineInputError);
    expect((error as EngineInputError).code).toBe(code);
    expect(hooks.calls).toEqual([]);
    expect(await version(harness)).toBe(versionBefore);
    expect(await appended(harness)).toEqual([]);
  });

  test('normalizeIssueBulkPatch checks the shape', () => {
    expect(
      normalizeIssueBulkPatch({
        state: { type: 'started', name: '  In Review ' },
        priority: 0,
      })
    ).toEqual({ state: { type: 'started', name: 'In Review' }, priority: 0 });
    for (const bad of [
      null,
      [],
      { move: { projectId: 'p' } },
      { move: { projectId: null, milestoneId: 'm' } },
      { move: { projectId: 'p', milestoneId: null, extra: 1 } },
      { priority: 5 },
      { priority: 1.5 },
      { state: { type: 'duplicate', name: 'Dup' } },
      { state: { type: 'started', name: '   ' } },
      { state: { type: 'started', name: 'x'.repeat(101) } },
      { state: { type: 'started', name: 'In\nReview' } },
      { assigneeId: '' },
    ]) {
      expect(() => normalizeIssueBulkPatch(bad)).toThrow(EngineInputError);
    }
    expect(ISSUE_BULK_MAX).toBe(100);
    expect(ISSUE_BULK_CONCURRENCY).toBe(4);
  });

  test('without write scope, nothing is read or written', async () => {
    const { harness, chloe, hooks } = await setup();
    const error = await rejection(
      harness.engine.updateIssues(
        { ...chloe, canWriteLinear: false },
        ['iss-eng-55'],
        {
          priority: 1,
        }
      )
    );
    expect(error).toBeInstanceOf(EngineAuthError);
    expect((error as EngineAuthError).code).toBe('needs_write_scope');
    expect(hooks.calls).toEqual([]);
  });
});

describe("targets and issues come from the viewer's snapshot", () => {
  test('a hidden issue, milestone or project is answered like an unknown one, and nothing is written', async () => {
    const { harness, hooks } = await setup();
    // Operations becomes private; Chloe is in Engineering only.
    const ops = harness.fixture.data.teams.find((t) => t.id === 'team-ops');
    if (ops === undefined) throw new Error('no team-ops');
    ops.visibility = 'private';
    await harness.engine.fullSync(WORKSPACE_ID);
    const chloe = await actorFor(harness, 'user-chloe');
    const versionBefore = await version(harness);

    const hidden = await harness.engine.updateIssues(chloe, ['iss-ops-5'], {
      priority: 1,
    });
    const unknown = await harness.engine.updateIssues(chloe, ['iss-nope'], {
      priority: 1,
    });
    expect(hidden.outcomes).toEqual([
      {
        status: 'failed',
        issueId: 'iss-ops-5',
        identifier: null,
        code: 'not_found',
        message: 'iss-ops-5 is not in the planner any more.',
      },
    ]);
    expect(unknown.outcomes).toEqual([
      {
        status: 'failed',
        issueId: 'iss-nope',
        identifier: null,
        code: 'not_found',
        message: 'iss-nope is not in the planner any more.',
      },
    ]);
    for (const [move, message] of [
      [
        { projectId: 'proj-delta', milestoneId: 'ms-delta-1' },
        'That project is not in the planner.',
      ],
      [
        { projectId: 'proj-delta', milestoneId: null },
        'That project is not in the planner.',
      ],
      [
        { projectId: 'proj-gone', milestoneId: null },
        'That project is not in the planner.',
      ],
      [
        { projectId: 'proj-garnet', milestoneId: 'ms-delta-1' },
        'That milestone is not in the planner.',
      ],
    ] as const) {
      const error = await rejection(
        harness.engine.updateIssues(chloe, ['iss-eng-55'], { move })
      );
      expect(error).toBeInstanceOf(EngineInputError);
      expect(error).toMatchObject({ code: 'not_found', message });
    }
    expect(hooks.calls).toEqual([]);
    expect(await version(harness)).toBe(versionBefore);
    expect(await appended(harness)).toEqual([]);
  });
});

describe('writes', () => {
  test(`at most ${ISSUE_BULK_CONCURRENCY} in flight; one mirror patch per call`, async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.delayMs = 5;
    const ids = [
      'iss-eng-12',
      'iss-eng-13',
      'iss-eng-17',
      'iss-eng-18',
      'iss-eng-28',
      'iss-eng-31',
      'iss-eng-32',
      'iss-eng-35',
      'iss-eng-36',
      'iss-eng-55',
    ];
    const versionBefore = await version(harness);
    const result = await harness.engine.updateIssues(chloe, ids, {
      assigneeId: 'user-dev',
    });
    expect(result.counts.changed).toBe(10);
    expect(hooks.maxInFlight).toBe(ISSUE_BULK_CONCURRENCY);
    // Demo mode runs no webhooks: the only mirror write is the call's own.
    expect(await version(harness)).toBe(versionBefore + 1);
    for (const id of ids) {
      expect((await mirrored(harness, id)).assigneeId).toBe('user-dev');
    }
    expect((await appended(harness)).map((e) => e.subjectId)).toEqual(ids);
  });

  test('a newer copy that landed mid-run is kept; an identical echo is not written again', async () => {
    const { harness, chloe, hooks } = await setup();
    let laterAt = '';
    hooks.afterWrite = async (id, written) => {
      if (id === 'iss-eng-54') {
        // Someone renamed it right after (a webhook applies that copy).
        laterAt = new Date(
          Date.parse(written.updatedAt) + 60_000
        ).toISOString();
        await harness.store.applyMirrorChanges(WORKSPACE_ID, {
          upsert: [
            {
              kind: 'issue',
              entity: {
                ...written,
                title: 'Renamed in Linear',
                updatedAt: laterAt,
              },
            },
          ],
          remove: [],
        });
      } else {
        // The write's own echo, already applied.
        await harness.store.applyMirrorChanges(WORKSPACE_ID, {
          upsert: [{ kind: 'issue', entity: written }],
          remove: [],
        });
      }
      return written;
    };
    const versionBefore = await version(harness);
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-54', 'iss-eng-55'],
      { priority: 2 }
    );
    expect(result.counts.changed).toBe(2);
    // The two webhook writes only: the call itself wrote nothing over them.
    expect(await version(harness)).toBe(versionBefore + 2);
    expect(await mirrored(harness, 'iss-eng-54')).toMatchObject({
      title: 'Renamed in Linear',
      updatedAt: laterAt,
      priority: 2,
    });
    expect((await mirrored(harness, 'iss-eng-55')).priority).toBe(2);
    // The audit still records both changes.
    expect((await appended(harness)).map((e) => e.subjectId)).toEqual([
      'iss-eng-54',
      'iss-eng-55',
    ]);
  });

  test('an issue a webhook took out of the mirror mid-run is not brought back', async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.afterWrite = async (id, written) => {
      if (id === 'iss-eng-54') {
        // Deleted in Linear right after the write: the Issue webhook's
        // refetch is null, so it leaves the mirror.
        await harness.store.applyMirrorChanges(WORKSPACE_ID, {
          upsert: [],
          remove: [{ kind: 'issue', id: 'iss-eng-54' }],
        });
      }
      return written;
    };
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-54', 'iss-eng-55'],
      { priority: 2 }
    );
    expect(result.outcomes.map((o) => [o.issueId, o.status])).toEqual([
      ['iss-eng-54', 'changed'],
      ['iss-eng-55', 'changed'],
    ]);
    const after = (await harness.engine.load(WORKSPACE_ID)).snapshot;
    expect(after.issues.has('iss-eng-54')).toBe(false);
    expect(after.issues.get('iss-eng-55')?.priority).toBe(2);
    // The audit still records both changes Linear accepted.
    expect(
      (await appended(harness)).map((e) => [e.action, e.subjectId, e.after])
    ).toEqual([
      ['issue.priority', 'iss-eng-54', 2],
      ['issue.priority', 'iss-eng-55', 2],
    ]);
  });

  test('a failed mirror read after the writes still audits them and answers the result', async () => {
    const { harness, chloe, hooks } = await setup();
    // Load once so the failure below hits the read after the writes.
    await harness.engine.load(WORKSPACE_ID, chloe);
    const store = harness.store as { getSyncState: (id: string) => unknown };
    const realGetSyncState = store.getSyncState.bind(harness.store);
    let failing = false;
    hooks.afterWrite = (_id, written) => {
      failing = true;
      return Promise.resolve(written);
    };
    store.getSyncState = (id: string) => {
      if (failing) return Promise.reject(new Error('statement timeout'));
      return realGetSyncState(id);
    };
    let result;
    try {
      result = await harness.engine.updateIssues(
        chloe,
        ['iss-eng-54', 'iss-eng-55'],
        { priority: 2 }
      );
    } finally {
      store.getSyncState = realGetSyncState;
    }
    expect(result.counts).toEqual({
      changed: 2,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(fixtureIssue(harness.fixture, 'iss-eng-54').priority).toBe(2);
    expect(fixtureIssue(harness.fixture, 'iss-eng-55').priority).toBe(2);
    expect(
      (await appended(harness)).map((e) => [e.action, e.subjectId, e.after])
    ).toEqual([
      ['issue.priority', 'iss-eng-54', 2],
      ['issue.priority', 'iss-eng-55', 2],
    ]);
    expect(
      harness.logs.some((line) =>
        line.includes('could not re-read the mirror after a bulk issue edit')
      )
    ).toBe(true);
  });

  test('lastStateChangeAt is kept when the state did not change', async () => {
    const { harness, chloe, hooks } = await setup();
    const before = await mirrored(harness, 'iss-eng-55');
    // The write answers with the timestamp approximation (creation time).
    hooks.afterWrite = (_id, written) =>
      Promise.resolve({ ...written, lastStateChangeAt: written.createdAt });
    await harness.engine.updateIssues(chloe, ['iss-eng-55'], { priority: 1 });
    const after = await mirrored(harness, 'iss-eng-55');
    expect(after.priority).toBe(1);
    expect(after.lastStateChangeAt).toBe(before.lastStateChangeAt);
  });
});

describe('failures', () => {
  test('Linear forbidding one issue fails that issue only', async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.fail = (id) =>
      id === 'iss-eng-55'
        ? new LinearApiError('forbidden', 'You cannot edit issues in this team')
        : null;
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-54', 'iss-eng-55', 'iss-eng-gone'],
      { priority: 2 }
    );
    expect(result.outcomes).toMatchObject([
      { status: 'changed', identifier: 'ENG-54' },
      {
        status: 'failed',
        identifier: 'ENG-55',
        code: 'linear_forbidden',
        message:
          'Linear does not let you update ENG-55 (You cannot edit issues in this team).',
      },
      {
        status: 'failed',
        issueId: 'iss-eng-gone',
        identifier: null,
        code: 'not_found',
        message: 'iss-eng-gone is not in the planner any more.',
      },
    ]);
    expect(result.counts).toEqual({
      changed: 1,
      unchanged: 0,
      skipped: 0,
      failed: 2,
    });
    expect((await mirrored(harness, 'iss-eng-55')).priority).toBe(4);
    expect((await appended(harness)).map((e) => e.subjectId)).toEqual([
      'iss-eng-54',
    ]);
  });

  test("a failure that is not Linear's answer is a fixed sentence; Linear's own words otherwise", async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.fail = (id) =>
      id === 'iss-eng-54'
        ? new TypeError(
            "Cannot read properties of undefined (reading 'nodes') at decrypt(key=SECRET)"
          )
        : id === 'iss-eng-55'
          ? new LinearApiError('server', 'Linear answered 503')
          : null;
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-54', 'iss-eng-55'],
      { priority: 2 }
    );
    expect(result.outcomes).toEqual([
      {
        status: 'failed',
        issueId: 'iss-eng-54',
        identifier: 'ENG-54',
        code: 'linear_error',
        message: 'Linear could not update ENG-54. It was logged.',
      },
      {
        status: 'failed',
        issueId: 'iss-eng-55',
        identifier: 'ENG-55',
        code: 'linear_error',
        message: 'Linear could not update ENG-55: Linear answered 503',
      },
    ]);
    // The raw error is in the log, not in the answer.
    expect(
      harness.logs.some((line) => line.includes('decrypt(key=SECRET)'))
    ).toBe(true);
  });

  test('a rate limit on the third write: in-flight writes finish, the rest are not attempted', async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.delayMs = 5;
    const retryAt = '2026-10-21T15:05:00.000Z';
    hooks.fail = (_id, call) =>
      call === 3
        ? new LinearApiError('rate_limited', 'Rate limit exceeded', { retryAt })
        : null;
    const ids = [
      'iss-eng-12',
      'iss-eng-13',
      'iss-eng-17',
      'iss-eng-18',
      'iss-eng-27',
      'iss-eng-28',
    ];
    // None of them has "no priority" yet: six writes are due.
    const result = await harness.engine.updateIssues(chloe, ids, {
      priority: 0,
    });
    expect(result.stopped).toEqual({ code: 'rate_limited', retryAt });
    expect(result.outcomes.map((o) => o.status)).toEqual([
      'changed',
      'changed',
      'skipped',
      'changed',
      'skipped',
      'skipped',
    ]);
    expect(result.outcomes[4]).toMatchObject({
      reason: 'not_attempted',
      message: "Not attempted: Linear's rate limit was reached.",
    });
    expect(hooks.calls).toHaveLength(4);
  });

  test('a rejected sign-in before any change throws not_signed_in', async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.fail = () => new LinearApiError('unauthorized', 'token rejected');
    const versionBefore = await version(harness);
    const error = await rejection(
      harness.engine.updateIssues(chloe, ['iss-eng-54', 'iss-eng-55'], {
        priority: 2,
      })
    );
    expect(error).toBeInstanceOf(EngineAuthError);
    expect((error as EngineAuthError).code).toBe('not_signed_in');
    expect(await version(harness)).toBe(versionBefore);
    expect(await appended(harness)).toEqual([]);
  });

  test('a rate limit before any change throws rate_limited with its time', async () => {
    const { harness, chloe, hooks } = await setup();
    const retryAt = '2026-10-21T15:10:00.000Z';
    hooks.fail = () =>
      new LinearApiError('rate_limited', 'Rate limit exceeded', { retryAt });
    const error = await rejection(
      harness.engine.updateIssues(chloe, ['iss-eng-54'], { priority: 2 })
    );
    expect(error).toBeInstanceOf(EngineInputError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAt });
  });
});

describe('locks', () => {
  test('a single edit of the same issue waits for the bulk edit; audit before values chain', async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.delayMs = 10;
    const [bulk, single] = await Promise.all([
      harness.engine.updateIssues(chloe, ['iss-eng-55'], { priority: 1 }),
      harness.engine.updateIssue(chloe, 'iss-eng-55', { priority: 3 }),
    ]);
    expect(bulk.counts.changed).toBe(1);
    expect(single.changed).toEqual(['priority']);
    expect(
      (await appended(harness)).map((e) => [e.action, e.before, e.after])
    ).toEqual([
      ['issue.priority', 4, 1],
      ['issue.priority', 1, 3],
    ]);
    expect((await mirrored(harness, 'iss-eng-55')).priority).toBe(3);
  });

  test('two overlapping bulk edits finish without deadlock', async () => {
    const { harness, chloe, hooks } = await setup();
    hooks.delayMs = 5;
    const results = await Promise.all([
      harness.engine.updateIssues(chloe, ['iss-eng-54', 'iss-eng-55'], {
        priority: 3,
      }),
      harness.engine.updateIssues(chloe, ['iss-eng-55', 'iss-eng-54'], {
        priority: 2,
      }),
    ]);
    expect(results.map((r) => r.counts.changed)).toEqual([2, 2]);
    expect((await mirrored(harness, 'iss-eng-54')).priority).toBe(2);
    expect((await mirrored(harness, 'iss-eng-55')).priority).toBe(2);
  });
});

describe('allocation effects', () => {
  test("an unassigned issue moved into an active project's next milestone is handed over", async () => {
    const { harness, chloe } = await setup();
    const result = await harness.engine.updateIssues(chloe, ['iss-eng-55'], {
      move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-1' },
    });
    expect(result.allocation).toEqual({
      handedOver: [
        {
          projectId: 'proj-garnet',
          projectName: 'Garnet mobile app',
          leadName: 'Ben Carter',
          issueIds: ['iss-eng-55'],
          // The demo runs allocation as a dry run.
          live: false,
        },
      ],
      stopped: [],
    });
  });

  test('a change to an issue allocation already planned is not news', async () => {
    const { harness, chloe } = await setup();
    const plan = (await harness.engine.load(WORKSPACE_ID)).allocationPlan;
    expect(
      plan.projects.some((p) =>
        p.actions.some((a) => a.issueId === 'iss-eng-12')
      )
    ).toBe(true);
    const result = await harness.engine.updateIssues(chloe, ['iss-eng-12'], {
      priority: 3,
    });
    expect(result.allocation).toEqual({ handedOver: [], stopped: [] });
  });

  test('a project whose allocation was already stopped is not reported as stopped by the move', async () => {
    const { harness, chloe } = await setup();
    const before = (await harness.engine.load(WORKSPACE_ID)).allocationPlan;
    // Harbor's next milestone has no "done means…" yet.
    expect(
      before.projects.find((p) => p.projectId === 'proj-harbor')
    ).toMatchObject({
      outcome: 'blocked',
      blockReason: 'next_milestone_invalid',
    });
    const result = await harness.engine.updateIssues(chloe, ['iss-eng-55'], {
      move: { projectId: 'proj-harbor', milestoneId: 'ms-harbor-2' },
    });
    expect(result.counts.changed).toBe(1);
    expect(result.allocation.stopped).toEqual([]);
  });

  test("emptying Garnet's next milestone stops its allocation", async () => {
    const { harness, chloe } = await setup();
    const before = (await harness.engine.load(WORKSPACE_ID)).allocationPlan;
    expect(
      before.projects.find((p) => p.projectId === 'proj-garnet')?.outcome
    ).toBe('nothing_to_do');
    const result = await harness.engine.updateIssues(
      chloe,
      ['iss-eng-50', 'iss-eng-51', 'iss-eng-53'],
      { move: { projectId: 'proj-garnet', milestoneId: null } }
    );
    expect(result.counts.changed).toBe(3);
    // Offline mode is complete now (ENG-52 is done); the empty Push
    // notifications is next and fails the rubric.
    expect(result.allocation.stopped).toEqual([
      {
        projectId: 'proj-garnet',
        projectName: 'Garnet mobile app',
        reason: 'next_milestone_invalid',
        gaps: ['no_issues'],
      },
    ]);
    expect(result.allocation.handedOver).toEqual([]);
  });
});
