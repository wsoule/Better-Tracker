// The issue page (owner decision 2026-10-21) end to end over the fixture
// gateway and PGlite: getIssueDetail's mirror view and live extras, and a
// person's own edits (fields, comments, blocking relations), which need
// write scope and nothing else, are validated before Linear is called,
// go out with the person's token, patch the mirror at once and are audited.

import { LinearApiError, type LinearGateway } from '@better-tracker/linear';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  ISSUE_HISTORY_LIMIT,
  textSummary,
} from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  fixtureIssue,
  fixtureProvider,
  type GatewayWrapper,
  rejection,
  WORKSPACE_ID,
} from './helpers';

async function rejectsWith(
  promise: Promise<unknown>,
  type: typeof EngineAuthError | typeof EngineInputError,
  code: string
): Promise<Error> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(type);
  expect((error as { code: string }).code).toBe(code);
  return error as Error;
}

// Records every write a gateway makes, by actor, so tests can prove that a
// refused edit never reached Linear and that a write used the person's own
// token.
function recordWrites(log: string[]): GatewayWrapper {
  return (gateway, actor): LinearGateway => {
    const who = actor === 'app' ? 'app' : actor.userId;
    return {
      ...gateway,
      updateIssueFields: (id, patch) => {
        log.push(
          `${who}:updateIssueFields:${id}:${Object.keys(patch).join(',')}`
        );
        return gateway.updateIssueFields(id, patch);
      },
      createComment: (id, body) => {
        log.push(`${who}:createComment:${id}`);
        return gateway.createComment(id, body);
      },
      createBlockingRelation: (blocker, blocked) => {
        log.push(`${who}:createBlockingRelation:${blocker}>${blocked}`);
        return gateway.createBlockingRelation(blocker, blocked);
      },
      deleteRelation: (id) => {
        log.push(`${who}:deleteRelation:${id}`);
        return gateway.deleteRelation(id);
      },
    };
  };
}

describe('getIssueDetail', () => {
  let h: DemoHarness;
  let member: Actor;

  beforeAll(async () => {
    h = await createDemoHarness();
    member = await actorFor(h, 'user-dev');
  });
  afterAll(async () => {
    await h.close();
  });

  test('mirror view, live extras, team labels and the estimate scale', async () => {
    const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
    expect(page.detail.issue.identifier).toBe('ENG-12');
    expect(page.detail.project?.name).toBe('Atlas billing migration');
    expect(page.detail.milestone).toMatchObject({
      id: 'ms-atlas-2',
      status: 'overdue',
      isNext: true,
    });
    expect(page.detail.why.unassignedInNextMilestone).toBe(true);
    // ENG-12 blocks ENG-23 (Beacon's next milestone, due in 2 days).
    expect(page.detail.blocks.map((r) => r.identifier)).toEqual(['ENG-23']);
    expect(
      page.detail.why.blocksAtRiskMilestones.map((m) => m.milestoneId)
    ).toEqual(['ms-beacon-1']);

    expect(page.extraError).toBeNull();
    expect(page.extraSource).toBe('actor');
    expect(page.extra?.description).toContain('nightly reconciler');
    expect(page.extra?.labels.map((l) => l.name)).toEqual(['Backend', 'Bug']);
    expect(page.extra?.comments.map((c) => c.author?.name)).toEqual([
      'Chloe Diaz',
      'Ben Carter',
      'Ana Moreno',
    ]);
    expect(page.labels.map((l) => l.name)).toContain('Tech debt');
    expect(page.labels.map((l) => l.name)).not.toContain('Vendor');
    expect(page.estimateScale).toEqual({
      type: 'fibonacci',
      allowZero: false,
      extended: false,
    });
    expect(page.estimateOptions.map((o) => o.value)).toEqual([1, 2, 3, 5, 8]);
    expect(page.allocationHistory).toEqual([]);
    expect(page.canEdit).toBe(true);
  });

  test('lists the allocation history of the issue, newest first', async () => {
    const ana = await actorFor(h, 'user-ana');
    await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'manual',
      actor: ana,
    });
    h.clock.advanceDays(1);
    await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'manual',
      actor: ana,
    });
    const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
    expect(
      page.allocationHistory.map((e) => [e.action, e.outcome, e.runMode])
    ).toEqual([
      ['assign', 'planned', 'dry_run'],
      ['assign', 'planned', 'dry_run'],
    ]);
    const [newer, older] = page.allocationHistory;
    expect(Date.parse(newer?.createdAt ?? '')).toBeGreaterThan(
      Date.parse(older?.createdAt ?? '')
    );
    expect(ISSUE_HISTORY_LIMIT).toBe(20);
  });

  test('an unknown issue is not_found', async () => {
    await rejectsWith(
      h.engine.getIssueDetail(member, 'iss-nope'),
      EngineInputError,
      'not_found'
    );
  });

  test('a read-only person sees the page without edit controls', async () => {
    const page = await h.engine.getIssueDetail(
      { ...member, canWriteLinear: false },
      'iss-eng-31'
    );
    expect(page.canEdit).toBe(false);
    expect(page.extra?.issueId).toBe('iss-eng-31');
  });
});

describe('getIssueDetail when Linear cannot be read', () => {
  test('a failed live read keeps the mirror view and says why', async () => {
    const h = await createDemoHarness({
      wrap: (gateway): LinearGateway => ({
        ...gateway,
        fetchIssueDetail: () =>
          Promise.reject(new LinearApiError('server', 'Linear 503')),
      }),
    });
    try {
      const member = await actorFor(h, 'user-dev');
      const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
      expect(page.detail.issue.id).toBe('iss-eng-12');
      expect(page.extra).toBeNull();
      expect(page.labels).toEqual([]);
      expect(page.estimateScale).toBeNull();
      expect(page.estimateOptions).toEqual([]);
      expect(page.extraError).toBe(
        'Linear did not answer; the description, labels and comments could not be loaded.'
      );
    } finally {
      await h.close();
    }
  });

  test("falls back to the app's token when the person's cannot be refreshed right now", async () => {
    const h = await createDemoHarness({
      linear: (fixture) => {
        const base = fixtureProvider(fixture);
        return {
          ...base,
          // A transient failure of the token refresh (Linear's OAuth
          // endpoint unreachable): the grant itself is still good.
          forSession: () =>
            Promise.reject(
              new LinearApiError('network', 'token refresh timed out')
            ),
        };
      },
    });
    try {
      const member = await actorFor(h, 'user-dev');
      const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
      expect(page.extraSource).toBe('app');
      expect(page.extra?.labels).toHaveLength(2);
      expect(page.extraError).toBeNull();
    } finally {
      await h.close();
    }
  });

  // A grant Linear rejected for good (invalid_grant: the person revoked the
  // planner or lost access) must not be bridged with the app's token: the
  // page then shows the mirror only, and nothing is read as the app.
  test("a dead grant is never bridged with the app's token", async () => {
    const appReads: string[] = [];
    const recordAppReads: GatewayWrapper = (gateway, actor) =>
      actor === 'app'
        ? {
            ...gateway,
            fetchIssueDetail: (id) => {
              appReads.push(id);
              return gateway.fetchIssueDetail(id);
            },
          }
        : gateway;
    const h = await createDemoHarness({
      linear: (fixture) => {
        const base = fixtureProvider(fixture, { wrap: recordAppReads });
        return {
          ...base,
          forSession: () =>
            Promise.reject(
              new EngineAuthError('not_signed_in', 'Sign in again.')
            ),
        };
      },
    });
    try {
      const member = await actorFor(h, 'user-dev');
      appReads.length = 0;
      const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
      expect(page.extra).toBeNull();
      expect(page.extraSource).toBeNull();
      expect(page.labels).toEqual([]);
      expect(page.extraError).toBe(
        'Linear no longer accepts your sign-in; sign in again to see the description, labels and comments.'
      );
      expect(appReads).toEqual([]);
    } finally {
      await h.close();
    }
  });

  // Linear answers "not found" for an issue the person's token may not
  // see (a private team): the page must not claim the issue is gone.
  test('an issue Linear does not show to the person is not called deleted', async () => {
    const h = await createDemoHarness({
      wrap: (gateway, actor): LinearGateway =>
        actor === 'app'
          ? gateway
          : { ...gateway, fetchIssueDetail: () => Promise.resolve(null) },
    });
    try {
      const member = await actorFor(h, 'user-dev');
      const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
      expect(page.extra).toBeNull();
      expect(page.extraSource).toBe('actor');
      expect(page.extraError).toBe(
        'Linear does not show this issue to your account: it is in a team you cannot see, or it was deleted or archived.'
      );
    } finally {
      await h.close();
    }
  });
});

describe('issue edits: who may edit', () => {
  let h: DemoHarness;
  const writes: string[] = [];

  beforeAll(async () => {
    // 'linear' mode: sessions carry real scopes (no demo shortcut).
    h = await createDemoHarness({ mode: 'linear', wrap: recordWrites(writes) });
  });
  afterAll(async () => {
    await h.close();
  });

  test('a member with write scope edits with their own token', async () => {
    const member = await actorFor(h, 'user-dev');
    expect(member).not.toHaveProperty('isPm');
    expect(member.canWriteLinear).toBe(true);
    const before = (await h.store.getSyncState(WORKSPACE_ID))?.version ?? 0;
    const result = await h.engine.updateIssue(member, 'iss-eng-23', {
      title: 'Typo tolerance (two edits)',
      priority: 2,
    });
    expect(result.changed).toEqual(['title', 'priority']);
    expect(writes).toEqual([
      'user-dev:updateIssueFields:iss-eng-23:title,priority',
    ]);
    expect(fixtureIssue(h.fixture, 'iss-eng-23').title).toBe(
      'Typo tolerance (two edits)'
    );
    // The mirror moved on, so the next page render shows the edit.
    expect((await h.store.getSyncState(WORKSPACE_ID))?.version).toBeGreaterThan(
      before
    );
    const loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.snapshot.issues.get('iss-eng-23')?.title).toBe(
      'Typo tolerance (two edits)'
    );
    const audit = await h.engine.listAudit(WORKSPACE_ID, 10);
    expect(
      audit.slice(0, 2).map((e) => [e.action, e.actorUserId, e.before, e.after])
    ).toEqual(
      expect.arrayContaining([
        [
          'issue.title',
          'user-dev',
          'Typo tolerance',
          'Typo tolerance (two edits)',
        ],
        ['issue.priority', 'user-dev', 1, 2],
      ])
    );
  });

  test('a person without write scope is refused before Linear is called', async () => {
    const token = (
      await h.store.createSession({
        workspaceId: WORKSPACE_ID,
        userId: 'user-elena',
        userName: 'Elena Novak',
        tokens: {
          accessToken: 'read-only',
          refreshToken: null,
          expiresAt: null,
          scopes: ['read'],
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    ).token;
    const reader = await h.engine.authenticate(token);
    if (reader === null) throw new Error('no session');
    expect(reader.canWriteLinear).toBe(false);
    writes.length = 0;
    for (const attempt of [
      h.engine.updateIssue(reader, 'iss-eng-60', { title: 'Nope' }),
      h.engine.addComment(reader, 'iss-eng-60', 'Nope'),
      h.engine.addBlocker(reader, 'iss-eng-60', 'iss-eng-61'),
      h.engine.removeRelation(reader, 'rel-atlas'),
    ]) {
      await rejectsWith(attempt, EngineAuthError, 'needs_write_scope');
    }
    expect(writes).toEqual([]);
    // Reading still works.
    expect((await h.engine.getIssueDetail(reader, 'iss-eng-60')).canEdit).toBe(
      false
    );
  });
});

describe('issue edits: fields', () => {
  let h: DemoHarness;
  let member: Actor;
  const writes: string[] = [];

  beforeAll(async () => {
    h = await createDemoHarness({ wrap: recordWrites(writes) });
    member = await actorFor(h, 'user-chloe');
  });
  afterAll(async () => {
    await h.close();
  });

  test('every field round-trips to Linear and the mirror', async () => {
    const result = await h.engine.updateIssue(member, 'iss-eng-31', {
      title: '  Sample data import, with milestones  ',
      description: 'Import **one** sample project.',
      stateId: 'st-eng-progress',
      assigneeId: 'user-chloe',
      priority: 1,
      dueDate: '2026-10-25',
      estimate: 8,
      labelIds: ['lbl-feature', 'lbl-eng-backend', 'lbl-feature'],
    });
    expect(result.changed).toEqual([
      'title',
      'description',
      'stateId',
      'assigneeId',
      'priority',
      'dueDate',
      'estimate',
    ]);
    expect(result.issue).toMatchObject({
      title: 'Sample data import, with milestones',
      stateId: 'st-eng-progress',
      assigneeId: 'user-chloe',
      priority: 1,
    });
    const page = await h.engine.getIssueDetail(member, 'iss-eng-31');
    expect(page.detail.state?.name).toBe('In Progress');
    expect(page.detail.assignee?.name).toBe('Chloe Diaz');
    expect(page.extra).toMatchObject({
      description: 'Import **one** sample project.',
      dueDate: '2026-10-25',
      estimate: 8,
    });
    // The label set was already exactly that (duplicates dropped).
    expect(page.extra?.labels.map((l) => l.id)).toEqual([
      'lbl-eng-backend',
      'lbl-feature',
    ]);
  });

  test('values equal to the current ones write nothing', async () => {
    writes.length = 0;
    const issue = fixtureIssue(h.fixture, 'iss-eng-31');
    const result = await h.engine.updateIssue(member, 'iss-eng-31', {
      title: issue.title,
      priority: issue.priority,
      labelIds: ['lbl-feature', 'lbl-eng-backend'],
    });
    expect(result.changed).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('a project change clears the old milestone; null leaves the project', async () => {
    const moved = await h.engine.updateIssue(member, 'iss-eng-16', {
      projectId: 'proj-beacon',
    });
    expect(moved.changed).toEqual(['projectId', 'projectMilestoneId']);
    expect(moved.issue).toMatchObject({
      projectId: 'proj-beacon',
      milestoneId: null,
    });
    const placed = await h.engine.updateIssue(member, 'iss-eng-16', {
      projectMilestoneId: 'ms-beacon-2',
    });
    expect(placed.issue.milestoneId).toBe('ms-beacon-2');
    const audit = await h.engine.listAudit(WORKSPACE_ID, 3);
    expect(audit.map((e) => [e.action, e.before, e.after])).toEqual(
      expect.arrayContaining([
        ['issue.milestone', null, 'ms-beacon-2'],
        ['issue.project', 'proj-atlas', 'proj-beacon'],
      ])
    );
  });

  test('a closed issue moved out of every project leaves the mirror', async () => {
    await h.engine.updateIssue(member, 'iss-eng-13', {
      stateId: 'st-eng-done',
      projectId: null,
    });
    const loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.snapshot.issues.has('iss-eng-13')).toBe(false);
    // Linear still has it, now without a project.
    expect(fixtureIssue(h.fixture, 'iss-eng-13').projectId).toBeNull();
  });

  test('invalid edits are refused before Linear is called', async () => {
    writes.length = 0;
    const cases: [unknown, string][] = [
      [{}, 'Nothing to change.'],
      [{ owner: 'x' }, 'Unknown issue field: owner.'],
      [{ title: '   ' }, 'The title cannot be empty.'],
      [{ title: 'a\nb' }, 'The title must be a single line.'],
      [{ title: 'x'.repeat(256) }, 'The title must be at most 255 characters.'],
      [
        { description: 'x'.repeat(100_001) },
        'The description must be at most 100,000 characters.',
      ],
      [
        { stateId: 'st-ops-todo' },
        'That status is not in the Engineering workflow.',
      ],
      [{ assigneeId: 'user-hugo' }, 'Hugo Laurent is deactivated in Linear.'],
      [
        { assigneeId: 'user-app' },
        'Milestone Planner is an app, not a person.',
      ],
      [{ assigneeId: 'user-nobody' }, 'The assignee must be a Linear user.'],
      [
        { priority: 5 },
        'Priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).',
      ],
      [
        { projectId: 'proj-nope' },
        'That project is not in the planner (closed, or not visible to the app).',
      ],
      [
        { projectMilestoneId: 'ms-beacon-1' },
        'Search v2 beta is not a milestone of Atlas billing migration.',
      ],
      [
        { projectId: null, projectMilestoneId: 'ms-atlas-2' },
        'An issue without a project cannot have a milestone.',
      ],
      [
        { dueDate: '2026-02-30' },
        'The due date must be a calendar date (YYYY-MM-DD) or empty.',
      ],
      [{ estimate: -1 }, 'The estimate must be a whole number, or empty.'],
      // Engineering estimates on the plain Fibonacci scale.
      [{ estimate: 4 }, "4 is not on this team's estimate scale."],
      [{ estimate: 13 }, "13 is not on this team's estimate scale."],
      [
        { labelIds: ['lbl-ops-vendor'] },
        "A label is not available on this issue's team.",
      ],
      [
        { labelIds: ['lbl-legacy'] },
        "A label is not available on this issue's team.",
      ],
      [
        { labelIds: ['lbl-eng-frontend', 'lbl-eng-backend'] },
        'Only one Area label can be applied (Frontend or Backend).',
      ],
      [{ labelIds: 'lbl-bug' }, 'Labels must be a list of label ids.'],
    ];
    for (const [patch, message] of cases) {
      const error = await rejectsWith(
        h.engine.updateIssue(
          member,
          'iss-eng-12',
          patch as Parameters<typeof h.engine.updateIssue>[2]
        ),
        EngineInputError,
        'invalid'
      );
      expect(error.message).toBe(message);
    }
    await rejectsWith(
      h.engine.updateIssue(member, 'iss-nope', { title: 'x' }),
      EngineInputError,
      'not_found'
    );
    expect(writes).toEqual([]);
  });

  test('Operations allows zero and the extended T-shirt sizes', async () => {
    const zero = await h.engine.updateIssue(member, 'iss-ops-5', {
      estimate: 0,
    });
    expect(zero.changed).toEqual(['estimate']);
    await h.engine.updateIssue(member, 'iss-ops-5', { estimate: 21 });
    const page = await h.engine.getIssueDetail(member, 'iss-ops-5');
    expect(page.extra?.estimate).toBe(21);
    expect(page.estimateOptions.map((o) => o.label)).toEqual([
      '0',
      'XS',
      'S',
      'M',
      'L',
      'XL',
      'XXL',
      'XXXL',
    ]);
  });

  // The audit log is shown to every signed-in person (Settings → Audit),
  // while descriptions are read with each person's own token so Linear's
  // permissions decide who sees them: the log keeps a text's length only,
  // never any of its words (a short text's "excerpt" would be all of it).
  test('descriptions are audited as their length only', async () => {
    const description = `${'Long text. '.repeat(30)}End.`;
    await h.engine.updateIssue(member, 'iss-eng-36', { description });
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry?.action).toBe('issue.description');
    expect(entry?.after).toEqual({ length: Array.from(description).length });
    expect(entry?.after).toEqual(textSummary(description));
    await h.engine.updateIssue(member, 'iss-eng-36', { description: 'Short.' });
    const [short] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(short?.before).toEqual({ length: Array.from(description).length });
    expect(short?.after).toEqual({ length: 6 });
    expect(JSON.stringify(short)).not.toContain('Short');
    expect(JSON.stringify(short)).not.toContain('Long text');
  });
});

describe('issue edits: archived labels', () => {
  // linear.app/docs/labels: "Archiving a label keeps it on any issues
  // where it's been applied, but stops people from using that label moving
  // forward." An edit sends the whole label set back (labelIds), so the
  // set read live must include it and the edit must be allowed to keep it.
  test('a label edit keeps an archived label the issue carries', async () => {
    const h = await createDemoHarness();
    try {
      const member = await actorFor(h, 'user-chloe');
      const fields = h.fixture.issueFields['iss-eng-12'];
      if (fields === undefined) throw new Error('iss-eng-12 has demo fields');
      fields.labelIds = [...fields.labelIds, 'lbl-legacy'];

      const page = await h.engine.getIssueDetail(member, 'iss-eng-12');
      const carried = page.extra?.labels.map((label) => label.id) ?? [];
      expect(carried).toContain('lbl-legacy');

      const added = await h.engine.updateIssue(member, 'iss-eng-12', {
        labelIds: [...carried, 'lbl-feature'],
      });
      expect(added.changed).toEqual(['labelIds']);
      expect(h.fixture.issueFields['iss-eng-12']?.labelIds).toEqual(
        expect.arrayContaining(['lbl-legacy', 'lbl-feature'])
      );

      // It can be removed, but not applied again once it is gone.
      const without = carried.filter((id) => id !== 'lbl-legacy');
      const removed = await h.engine.updateIssue(member, 'iss-eng-12', {
        labelIds: without,
      });
      expect(removed.changed).toEqual(['labelIds']);
      expect(h.fixture.issueFields['iss-eng-12']?.labelIds).not.toContain(
        'lbl-legacy'
      );
      const error = await rejectsWith(
        h.engine.updateIssue(member, 'iss-eng-12', { labelIds: carried }),
        EngineInputError,
        'invalid'
      );
      expect(error.message).toBe(
        "A label is not available on this issue's team."
      );
    } finally {
      await h.close();
    }
  });
});

describe('issue edits: mirror timing', () => {
  test('a write that does not move the state keeps the refined lastStateChangeAt', async () => {
    const h = await createDemoHarness({
      wrap: (gateway): LinearGateway => ({
        ...gateway,
        // Linear's answer only carries the timestamp approximation.
        updateIssueFields: async (id, patch) => ({
          ...(await gateway.updateIssueFields(id, patch)),
          lastStateChangeAt: '2020-01-01T00:00:00.000Z',
        }),
      }),
    });
    try {
      const member = await actorFor(h, 'user-dev');
      const before = (await h.engine.load(WORKSPACE_ID)).snapshot.issues.get(
        'iss-eng-23'
      )?.lastStateChangeAt;
      const result = await h.engine.updateIssue(member, 'iss-eng-23', {
        priority: 3,
      });
      expect(result.issue.lastStateChangeAt).toBe(before ?? '');
      const moved = await h.engine.updateIssue(member, 'iss-eng-23', {
        stateId: 'st-eng-review',
      });
      // A state change takes what Linear says.
      expect(moved.issue.lastStateChangeAt).toBe('2020-01-01T00:00:00.000Z');
    } finally {
      await h.close();
    }
  });
});

describe('issue edits: Linear refusals', () => {
  let failWith: LinearApiError | Error = new Error('unset');
  let h: DemoHarness;
  let member: Actor;

  beforeAll(async () => {
    h = await createDemoHarness({
      wrap: (gateway): LinearGateway => ({
        ...gateway,
        updateIssueFields: () => Promise.reject(failWith),
        createComment: () => Promise.reject(failWith),
      }),
    });
    member = await actorFor(h, 'user-dev');
  });
  afterAll(async () => {
    await h.close();
  });

  test('map to engine error codes with readable messages', async () => {
    const cases: [
      LinearApiError,
      typeof EngineAuthError | typeof EngineInputError,
      string,
    ][] = [
      [
        new LinearApiError('forbidden', 'Linear denied access to IssueUpdate'),
        EngineAuthError,
        'linear_forbidden',
      ],
      [
        new LinearApiError('unauthorized', 'token rejected'),
        EngineAuthError,
        'not_signed_in',
      ],
      [
        new LinearApiError('not_found', 'Entity not found: WorkflowState'),
        EngineInputError,
        'not_found',
      ],
      [
        new LinearApiError('invalid_input', 'Title is too long'),
        EngineInputError,
        'invalid',
      ],
      [
        new LinearApiError('rate_limited', 'Linear rate limit reached', {
          retryAt: '2026-10-21T16:00:00.000Z',
        }),
        EngineInputError,
        'rate_limited',
      ],
    ];
    for (const [error, type, code] of cases) {
      failWith = error;
      await rejectsWith(
        h.engine.updateIssue(member, 'iss-eng-23', { title: 'Retitled' }),
        type,
        code
      );
    }
    failWith = new LinearApiError('invalid_input', 'Title is too long');
    expect(
      (await rejection(
        h.engine.updateIssue(member, 'iss-eng-23', { title: 'Retitled' })
      )) as Error
    ).toMatchObject({
      message: 'Linear refused to update the issue: Title is too long',
    });
    failWith = new LinearApiError('rate_limited', 'x', {
      retryAt: '2026-10-21T16:00:00.000Z',
    });
    expect(
      await rejection(h.engine.addComment(member, 'iss-eng-23', 'Hello'))
    ).toMatchObject({
      code: 'rate_limited',
      retryAt: '2026-10-21T16:00:00.000Z',
    });
    // Transport failures stay LinearApiError (the web layer answers 502).
    failWith = new LinearApiError(
      'server',
      'Linear IssueUpdate failed with HTTP 503'
    );
    expect(
      await rejection(
        h.engine.updateIssue(member, 'iss-eng-23', { title: 'Retitled' })
      )
    ).toBe(failWith);
    // Nothing reached the mirror or the audit log.
    expect(
      (await h.engine.load(WORKSPACE_ID)).snapshot.issues.get('iss-eng-23')
        ?.title
    ).toBe('Typo tolerance');
    expect(await h.engine.listAudit(WORKSPACE_ID, 10)).toEqual([]);
  });
});

describe('issue edits: comments and relations', () => {
  let h: DemoHarness;
  let member: Actor;
  const writes: string[] = [];

  beforeAll(async () => {
    h = await createDemoHarness({ wrap: recordWrites(writes) });
    member = await actorFor(h, 'user-grace');
  });
  afterAll(async () => {
    await h.close();
  });

  test('a comment is written as the person and audited without its full text', async () => {
    const body = `  ${'I can take this after the token work. '.repeat(5)} `;
    const comment = await h.engine.addComment(member, 'iss-eng-71', body);
    expect(writes).toEqual(['user-grace:createComment:iss-eng-71']);
    expect(comment).toMatchObject({
      body: body.trim(),
      author: { id: 'user-grace', name: 'Grace Lin' },
      parentId: null,
    });
    expect(h.fixture.comments.at(-1)).toMatchObject({
      issueId: 'iss-eng-71',
      authorId: 'user-grace',
      body: body.trim(),
    });
    const page = await h.engine.getIssueDetail(member, 'iss-eng-71');
    expect(page.extra?.comments.at(-1)?.id).toBe(comment.id);
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      action: 'issue.comment',
      subjectId: 'iss-eng-71',
      before: null,
      after: { commentId: comment.id, length: body.trim().length },
    });
    expect(JSON.stringify(entry?.after)).not.toContain(body.trim());

    // A short comment is not kept in full either (an 80-character
    // "excerpt" would be the whole of it): only its id and length.
    const short = await h.engine.addComment(member, 'iss-eng-71', 'Done.');
    const [shortEntry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(shortEntry?.after).toEqual({ commentId: short.id, length: 5 });
    expect(JSON.stringify(shortEntry)).not.toContain('Done');

    for (const bad of ['', '   ', 'x'.repeat(10_001)]) {
      await rejectsWith(
        h.engine.addComment(member, 'iss-eng-71', bad),
        EngineInputError,
        'invalid'
      );
    }
  });

  test('add a blocker: mirror and both issues update at once', async () => {
    writes.length = 0;
    const relation = await h.engine.addBlocker(
      member,
      'iss-eng-62',
      'iss-eng-60'
    );
    expect(writes).toEqual([
      'user-grace:createBlockingRelation:iss-eng-60>iss-eng-62',
    ]);
    expect(relation).toMatchObject({
      blockerId: 'iss-eng-60',
      blockedId: 'iss-eng-62',
    });
    const blocked = await h.engine.getIssueDetail(member, 'iss-eng-62');
    expect(
      blocked.detail.blockedBy.map((r) => [r.relationId, r.identifier])
    ).toEqual([[relation.id, 'ENG-60']]);
    const blocker = await h.engine.getIssueDetail(member, 'iss-eng-60');
    expect(blocker.detail.blocks.map((r) => r.identifier)).toEqual(['ENG-62']);

    await rejectsWith(
      h.engine.addBlocker(member, 'iss-eng-62', 'iss-eng-60'),
      EngineInputError,
      'conflict'
    );
    await rejectsWith(
      h.engine.addBlocker(member, 'iss-eng-62', 'iss-eng-62'),
      EngineInputError,
      'invalid'
    );
    await rejectsWith(
      h.engine.addBlocker(member, 'iss-eng-62', 'iss-nope'),
      EngineInputError,
      'not_found'
    );
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      action: 'issue.blocker_added',
      subjectId: 'iss-eng-62',
      after: { relationId: relation.id, blockerIdentifier: 'ENG-60' },
    });
  });

  test('remove a relation, including one Linear already dropped', async () => {
    await h.engine.removeRelation(member, 'rel-chain-1');
    let page = await h.engine.getIssueDetail(member, 'iss-eng-23');
    expect(page.detail.blockedBy).toEqual([]);
    // Linear lost rel-atlas already: the mirror still drops it.
    h.fixture.data.relations = h.fixture.data.relations.filter(
      (r) => r.id !== 'rel-atlas'
    );
    await h.engine.removeRelation(member, 'rel-atlas');
    page = await h.engine.getIssueDetail(member, 'iss-eng-16');
    expect(page.detail.blockedBy).toEqual([]);
    await rejectsWith(
      h.engine.removeRelation(member, 'rel-nope'),
      EngineInputError,
      'not_found'
    );
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      action: 'issue.relation_removed',
      subjectId: 'iss-eng-16',
      before: { relationId: 'rel-atlas', blockerIdentifier: 'ENG-10' },
      after: null,
    });
  });
});

describe('issue edits: relation refresh fallback', () => {
  test('when the app cannot re-read relations the direct change is applied', async () => {
    const h = await createDemoHarness({
      wrap: (gateway, actor): LinearGateway =>
        actor === 'app'
          ? {
              ...gateway,
              fetchIssueRelations: () =>
                Promise.reject(new LinearApiError('network', 'down')),
            }
          : gateway,
    });
    try {
      const member = await actorFor(h, 'user-dev');
      const relation = await h.engine.addBlocker(
        member,
        'iss-eng-61',
        'iss-eng-60'
      );
      const loaded = await h.engine.load(WORKSPACE_ID);
      expect(loaded.snapshot.data.relations.map((r) => r.id)).toContain(
        relation.id
      );
      await h.engine.removeRelation(member, relation.id);
      expect(
        (await h.engine.load(WORKSPACE_ID)).snapshot.data.relations.map(
          (r) => r.id
        )
      ).not.toContain(relation.id);
    } finally {
      await h.close();
    }
  });
});
