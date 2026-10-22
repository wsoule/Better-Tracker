import { addDays, type MilestoneMeta } from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  type Actor,
  createEngine,
  type Engine,
  EngineAuthError,
  EngineInputError,
  LinearApiError,
} from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  fixtureProvider,
  type GatewayWrapper,
  recordingChannel,
  recordingLogger,
  storeWith,
  TEST_CONFIG,
  WORKSPACE_ID,
} from './helpers';

// One harness for the file: each test edits different entities.
let h: DemoHarness;
let ana: Actor;
let member: Actor;

beforeAll(async () => {
  h = await createDemoHarness();
  ana = await actorFor(h, 'user-ana');
  member = await actorFor(h, 'user-chloe');
});
afterAll(async () => {
  await h.close();
});

function readOnly(actor: Actor): Actor {
  return { ...actor, canWriteLinear: false };
}

async function caughtError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

async function rejectsWith(
  promise: Promise<unknown>,
  type: typeof EngineAuthError | typeof EngineInputError,
  code: string
): Promise<void> {
  const caught = await caughtError(promise);
  expect(caught).toBeInstanceOf(type);
  expect((caught as { code: string }).code).toBe(code);
}

describe('permissions', () => {
  // Owner decision 2026-10-22: there is no PM role. Chloe was never on the
  // old PM list, yet every formerly PM-only edit goes through for her, each
  // audited under her name; nobody is ever refused with not_pm.
  test('a member makes every milestone, lead and settings edit', async () => {
    const own = await createDemoHarness();
    try {
      const chloe = await actorFor(own, 'user-chloe');
      expect(chloe).not.toHaveProperty('isPm');
      const date = addDays(own.clock.today(), 12);
      await own.engine.setMilestoneTargetDate(chloe, 'ms-juniper-2', date);
      await own.engine.setProjectLead(chloe, 'proj-delta', 'user-femi');
      await own.engine.setMilestoneWeight(chloe, 'ms-juniper-2', 3);
      await own.engine.setMilestoneDoneMeans(
        chloe,
        'ms-harbor-1',
        'Beta customers call every v3 endpoint.'
      );
      const saved = await own.engine.updateSettings(chloe, {
        allocationMode: 'live',
        warningsMode: 'live',
        watcherUserIds: ['user-chloe'],
        timezone: 'Europe/Oslo',
        tuning: { warnLeadDays: 5 } as never,
      });
      expect(saved).toMatchObject({
        allocationMode: 'live',
        warningsMode: 'live',
        watcherUserIds: ['user-chloe'],
        timezone: 'Europe/Oslo',
      });
      expect(saved.tuning.warnLeadDays).toBe(5);

      const loaded = await own.engine.load(WORKSPACE_ID);
      expect(loaded.snapshot.milestones.get('ms-juniper-2')?.targetDate).toBe(
        date
      );
      expect(loaded.snapshot.projects.get('proj-delta')?.leadId).toBe(
        'user-femi'
      );
      expect(loaded.settings.allocationMode).toBe('live');
      const audit = await own.engine.listAudit(WORKSPACE_ID, 10);
      expect(audit.map((entry) => entry.action).sort()).toEqual([
        'milestone.done_means',
        'milestone.target_date',
        'milestone.weight',
        'project.lead',
        'settings.update',
      ]);
      expect(new Set(audit.map((entry) => entry.actorUserId))).toEqual(
        new Set(['user-chloe'])
      );
    } finally {
      await own.close();
    }
  });

  test('Linear edits need the write scope; tool-owned edits do not', async () => {
    const date = addDays(h.clock.today(), 10);
    await rejectsWith(
      h.engine.setMilestoneTargetDate(readOnly(member), 'ms-juniper-2', date),
      EngineAuthError,
      'needs_write_scope'
    );
    await rejectsWith(
      h.engine.setProjectLead(readOnly(member), 'proj-delta', 'user-chloe'),
      EngineAuthError,
      'needs_write_scope'
    );
    // Planner-only edits need nothing beyond a session.
    await h.engine.setMilestoneWeight(readOnly(member), 'ms-beacon-2', 2);
    const meta = (await h.store.listMilestoneMeta(WORKSPACE_ID)).find(
      (m) => m.milestoneId === 'ms-beacon-2'
    );
    expect(meta?.weight).toBe(2);
    // The weight change did not touch the existing done-means.
    expect(meta?.doneMeans).toBe('Search v2 serves all production traffic.');
    expect(
      h.fixture.data.milestones.find((m) => m.id === 'ms-juniper-2')?.targetDate
    ).toBe(addDays(h.clock.today(), 35));
    const settings = await h.engine.updateSettings(readOnly(member), {
      timezone: 'UTC',
    });
    expect(settings.timezone).toBe('UTC');
  });
});

describe('milestone target date', () => {
  test('writes to Linear as the person, patches the mirror and audits', async () => {
    const before = addDays(h.clock.today(), 35);
    const after = addDays(h.clock.today(), 42);
    await h.engine.setMilestoneTargetDate(ana, 'ms-juniper-2', after);

    expect(
      h.fixture.data.milestones.find((m) => m.id === 'ms-juniper-2')?.targetDate
    ).toBe(after);
    const loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.snapshot.milestones.get('ms-juniper-2')?.targetDate).toBe(
      after
    );
    const timeline = await h.engine.getTimelineView(WORKSPACE_ID);
    const bar = timeline.groups
      .flatMap((g) => g.lanes)
      .flatMap((lane) => lane.bars)
      .find((b) => b.milestoneId === 'ms-juniper-2');
    expect(bar?.end).toBe(after);

    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actorUserId: 'user-ana',
      action: 'milestone.target_date',
      subjectId: 'ms-juniper-2',
      before,
      after,
    });

    // Clearing the date works too.
    await h.engine.setMilestoneTargetDate(ana, 'ms-compass-3', null);
    expect(
      (await h.engine.load(WORKSPACE_ID)).snapshot.milestones.get(
        'ms-compass-3'
      )?.targetDate
    ).toBeNull();
  });

  test('rejects invalid dates and unknown milestones', async () => {
    for (const bad of ['2026-02-30', '21/10/2026', '', 'tomorrow']) {
      await rejectsWith(
        h.engine.setMilestoneTargetDate(ana, 'ms-juniper-2', bad),
        EngineInputError,
        'invalid'
      );
    }
    await rejectsWith(
      h.engine.setMilestoneTargetDate(ana, 'ms-nope', '2026-12-01'),
      EngineInputError,
      'not_found'
    );
  });
});

describe('project lead', () => {
  test('must be an active person in the workspace', async () => {
    for (const bad of ['user-hugo', 'user-app', 'user-nobody']) {
      await rejectsWith(
        h.engine.setProjectLead(ana, 'proj-delta', bad),
        EngineInputError,
        'invalid'
      );
    }
    await rejectsWith(
      h.engine.setProjectLead(ana, 'proj-nope', 'user-chloe'),
      EngineInputError,
      'not_found'
    );
    expect(
      h.fixture.data.projects.find((p) => p.id === 'proj-delta')?.leadId
    ).toBeNull();
  });

  test('a valid lead is written to Linear and unblocks allocation', async () => {
    await h.engine.setProjectLead(ana, 'proj-delta', 'user-femi');
    expect(
      h.fixture.data.projects.find((p) => p.id === 'proj-delta')?.leadId
    ).toBe('user-femi');
    const loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.snapshot.projects.get('proj-delta')?.leadId).toBe(
      'user-femi'
    );
    const delta = loaded.allocationPlan.projects.find(
      (p) => p.projectId === 'proj-delta'
    );
    expect(delta?.outcome).toBe('allocate');
    expect(delta?.actions.map((a) => a.issueId)).toEqual(['iss-ops-5']);
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      action: 'project.lead',
      subjectId: 'proj-delta',
      before: null,
      after: 'user-femi',
    });

    await h.engine.setProjectLead(ana, 'proj-delta', null);
    expect(
      h.fixture.data.projects.find((p) => p.id === 'proj-delta')?.leadId
    ).toBeNull();
  });
});

describe('weight', () => {
  test('integer within ±1000 or null', async () => {
    for (const bad of [
      1001,
      -1001,
      1.5,
      Number.NaN,
      '3' as unknown as number,
    ]) {
      await rejectsWith(
        h.engine.setMilestoneWeight(ana, 'ms-juniper-2', bad),
        EngineInputError,
        'invalid'
      );
    }
    await h.engine.setMilestoneWeight(ana, 'ms-juniper-2', -1000);
    expect(
      (await h.engine.load(WORKSPACE_ID)).snapshot.milestones.has(
        'ms-juniper-2'
      )
    ).toBe(true);
    let meta = (await h.store.listMilestoneMeta(WORKSPACE_ID)).find(
      (m) => m.milestoneId === 'ms-juniper-2'
    );
    expect(meta?.weight).toBe(-1000);
    expect(meta?.updatedBy).toBe('user-ana');
    await h.engine.setMilestoneWeight(ana, 'ms-juniper-2', null);
    meta = (await h.store.listMilestoneMeta(WORKSPACE_ID)).find(
      (m) => m.milestoneId === 'ms-juniper-2'
    );
    expect(meta?.weight).toBeNull();
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      action: 'milestone.weight',
      before: -1000,
      after: null,
    });
    await rejectsWith(
      h.engine.setMilestoneWeight(ana, 'ms-nope', 1),
      EngineInputError,
      'not_found'
    );
  });
});

describe('done means', () => {
  test('trimmed, one line, at most 280 characters; empty clears it', async () => {
    await h.engine.setMilestoneDoneMeans(
      ana,
      'ms-harbor-1',
      '   Beta customers call every v3 endpoint.   '
    );
    let loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.assessments.get('ms-harbor-1')?.doneMeans).toEqual({
      text: 'Beta customers call every v3 endpoint.',
      source: 'planner',
    });
    // Filling it in fixes the rubric and unblocks Harbor.
    expect(loaded.assessments.get('ms-harbor-1')?.rubric.valid).toBe(true);
    expect(
      loaded.allocationPlan.projects.find((p) => p.projectId === 'proj-harbor')
        ?.outcome
    ).toBe('allocate');
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry).toMatchObject({
      action: 'milestone.done_means',
      subjectId: 'ms-harbor-1',
      before: null,
      after: 'Beta customers call every v3 endpoint.',
    });

    await rejectsWith(
      h.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'line one\nline two'),
      EngineInputError,
      'invalid'
    );
    await rejectsWith(
      h.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'x'.repeat(281)),
      EngineInputError,
      'invalid'
    );
    // A NUL used to reach Postgres and fail as a 500; DEL and other C0
    // characters are refused the same way (a tab is fine).
    for (const text of ['a\u0000b', 'a\u007fb', 'a\u0007b']) {
      await rejectsWith(
        h.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', text),
        EngineInputError,
        'invalid'
      );
    }
    await h.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'a\tb');
    await h.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'é'.repeat(280));

    await h.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', '   ');
    loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.assessments.get('ms-harbor-1')?.doneMeans.text).toBeNull();
    expect(
      (await h.store.listMilestoneMeta(WORKSPACE_ID)).find(
        (m) => m.milestoneId === 'ms-harbor-1'
      )?.doneMeans
    ).toBeNull();
  });
});

describe('updateSettings', () => {
  test('validates, saves and audits', async () => {
    const saved = await h.engine.updateSettings(ana, {
      warningsMode: 'live',
      timezone: 'America/Chicago',
      watcherUserIds: ['user-ana', 'user-grace', 'user-ana'],
      tuning: { warnLeadDays: 10 } as never,
    });
    expect(saved.warningsMode).toBe('live');
    expect(saved.timezone).toBe('America/Chicago');
    expect(saved.watcherUserIds).toEqual(['user-ana', 'user-grace']);
    expect(saved.tuning.warnLeadDays).toBe(10);
    expect(saved.tuning.stallDays).toBe(7);
    const loaded = await h.engine.load(WORKSPACE_ID);
    expect(loaded.settings).toEqual(saved);
    const [entry] = await h.engine.listAudit(WORKSPACE_ID, 1);
    expect(entry?.action).toBe('settings.update');
    expect(entry?.before).toMatchObject({ warningsMode: 'preview' });
    expect(entry?.after).toMatchObject({ warningsMode: 'live' });

    // The settings never carry a PM list again.
    expect(saved).not.toHaveProperty('pmUserIds');
    expect(entry?.after).not.toHaveProperty('pmUserIds');
  });

  // No "last PM" rule: the watcher list may be emptied (then only each
  // project's lead is warned) and filled again.
  test('watchers can be emptied and refilled', async () => {
    const own = await createDemoHarness();
    try {
      const chloe = await actorFor(own, 'user-chloe');
      const empty = await own.engine.updateSettings(chloe, {
        watcherUserIds: [],
      });
      expect(empty.watcherUserIds).toEqual([]);
      expect(
        (await own.engine.load(WORKSPACE_ID)).settings.watcherUserIds
      ).toEqual([]);
      const refilled = await own.engine.updateSettings(chloe, {
        watcherUserIds: ['user-dev'],
      });
      expect(refilled.watcherUserIds).toEqual(['user-dev']);
    } finally {
      await own.close();
    }
  });

  // Everyone can edit settings now, so two people saving different
  // sections at the same moment is ordinary. Each save used to read the
  // settings before the other wrote them and then put back the stale copy:
  // one person's change vanished and the audit read as a revert.
  test('two people saving different sections at once both stick', async () => {
    const own = await createDemoHarness();
    try {
      const chloe = await actorFor(own, 'user-chloe');
      const ben = await actorFor(own, 'user-ben');
      await Promise.all([
        own.engine.updateSettings(chloe, { watcherUserIds: ['user-chloe'] }),
        own.engine.updateSettings(ben, { allocationMode: 'live' }),
        own.engine.updateSettings(chloe, {
          tuning: { stallDays: 9 } as never,
        }),
      ]);
      const { settings } = await own.engine.load(WORKSPACE_ID);
      expect(settings.watcherUserIds).toEqual(['user-chloe']);
      expect(settings.allocationMode).toBe('live');
      expect(settings.tuning.stallDays).toBe(9);

      // Each audit entry's "before" is what the previous save left, so the
      // log reads as three changes in a row, never as a revert.
      const audit = (await own.engine.listAudit(WORKSPACE_ID, 10)).filter(
        (entry) => entry.action === 'settings.update'
      );
      expect(audit).toHaveLength(3);
      const [last] = audit;
      expect(last?.after).toMatchObject({
        watcherUserIds: ['user-chloe'],
        allocationMode: 'live',
        tuning: { stallDays: 9 },
      });
      expect(new Set(audit.map((entry) => entry.actorUserId))).toEqual(
        new Set(['user-chloe', 'user-ben'])
      );
    } finally {
      await own.close();
    }
  });

  test('rejects the retired PM list and nonsense', async () => {
    const retired = await caughtError(
      h.engine.updateSettings(member, {
        pmUserIds: ['user-ana'],
      } as never)
    );
    expect(retired).toBeInstanceOf(EngineInputError);
    expect((retired as EngineInputError).message).toContain(
      'pmUserIds is no longer a setting'
    );
    const bad: unknown[] = [
      { pmUserIds: [] },
      { watcherUserIds: ['user-app'] },
      { watcherUserIds: ['user-nobody'] },
      { watcherUserIds: 'user-ana' },
      { timezone: 'Mars/Olympus' },
      { allocationMode: 'yolo' },
      { warningsMode: 'loud' },
      { workspaceId: 'org-other' },
      { favoriteColor: 'orange' },
      { tuning: { warnLeadDays: 0 } },
      { tuning: { stallDays: 91 } },
      { tuning: { paceWindowDays: 2.5 } },
      { tuning: { activeProjectStatuses: [] } },
      { tuning: { activeProjectStatuses: ['exploding'] } },
      { tuning: { surprise: 1 } },
      'not an object',
    ];
    const before = (await h.engine.load(WORKSPACE_ID)).settings;
    for (const patch of bad) {
      await rejectsWith(
        h.engine.updateSettings(ana, patch as never),
        EngineInputError,
        'invalid'
      );
    }
    expect((await h.engine.load(WORKSPACE_ID)).settings).toEqual(before);
  });
});

// Review regressions: who writes, whether the app is still installed, and
// edits of one milestone saved together.
describe('edits run as the person, only while installed', () => {
  test("Linear edits go through the person's own gateway, never the app", async () => {
    const writes: string[] = [];
    const wrap: GatewayWrapper = (gateway, actor) => {
      const who = actor === 'app' ? 'app' : actor.userId;
      return {
        ...gateway,
        updateMilestoneTargetDate: (id, date) => {
          writes.push(`${who}:date:${id}`);
          return gateway.updateMilestoneTargetDate(id, date);
        },
        updateProjectLead: (id, leadId) => {
          writes.push(`${who}:lead:${id}`);
          return gateway.updateProjectLead(id, leadId);
        },
      };
    };
    const own = await createDemoHarness({ wrap });
    try {
      const ana = await actorFor(own, 'user-ana');
      await own.engine.setMilestoneTargetDate(
        ana,
        'ms-juniper-2',
        addDays(own.clock.today(), 40)
      );
      await own.engine.setProjectLead(ana, 'proj-delta', 'user-femi');
      expect(writes).toEqual([
        'user-ana:date:ms-juniper-2',
        'user-ana:lead:proj-delta',
      ]);
      const audit = await own.engine.listAudit(WORKSPACE_ID, 2);
      expect(audit.map((entry) => entry.actorUserId)).toEqual([
        'user-ana',
        'user-ana',
      ]);
    } finally {
      await own.close();
    }
  });

  test('an uninstalled workspace accepts no edits', async () => {
    const writes: string[] = [];
    const wrap: GatewayWrapper = (gateway) => ({
      ...gateway,
      updateMilestoneTargetDate: (id, date) => {
        writes.push(id);
        return gateway.updateMilestoneTargetDate(id, date);
      },
      updateProjectLead: (id, leadId) => {
        writes.push(id);
        return gateway.updateProjectLead(id, leadId);
      },
    });
    const own = await createDemoHarness({ wrap });
    try {
      const ana = await actorFor(own, 'user-ana');
      await own.store.markInstallationRevoked(
        WORKSPACE_ID,
        own.clock.now().toISOString()
      );
      const date = addDays(own.clock.today(), 40);
      const edits: Promise<unknown>[] = [
        own.engine.setMilestoneTargetDate(ana, 'ms-juniper-2', date),
        own.engine.setProjectLead(ana, 'proj-delta', 'user-femi'),
        own.engine.setMilestoneWeight(ana, 'ms-juniper-2', 5),
        own.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'Shipped.'),
        own.engine.updateSettings(ana, { warningsMode: 'live' }),
      ];
      for (const edit of edits) {
        await rejectsWith(edit, EngineAuthError, 'not_installed');
      }
      expect(writes).toEqual([]);
      expect(await own.engine.listAudit(WORKSPACE_ID, 10)).toEqual([]);
      expect((await own.store.getSettings(WORKSPACE_ID))?.warningsMode).toBe(
        'preview'
      );
    } finally {
      await own.close();
    }
  });

  test('two web instances editing different fields of one milestone both stick', async () => {
    const own = await createDemoHarness();
    try {
      const ana = await actorFor(own, 'user-ana');
      // Each instance reads the meta row, then waits until the other has
      // read it too, so both writes start from the same old row: a
      // whole-row upsert would drop one of the two fields.
      let readers = 0;
      let bothRead = (): void => undefined;
      const barrier = new Promise<void>((resolve) => {
        bothRead = resolve;
      });
      const instance = (): Engine =>
        createEngine({
          store: storeWith(own.store, {
            listMilestoneMeta: async (
              workspaceId
            ): Promise<MilestoneMeta[]> => {
              const rows = await own.store.listMilestoneMeta(workspaceId);
              readers += 1;
              if (readers === 2) bothRead();
              await Promise.race([
                barrier,
                new Promise((resolve) => setTimeout(resolve, 2000)),
              ]);
              return rows;
            },
          }),
          linear: fixtureProvider(own.fixture),
          channel: recordingChannel(),
          logger: recordingLogger().logger,
          config: TEST_CONFIG,
          now: own.clock.now,
        });
      const [first, second] = [instance(), instance()];
      await Promise.all([
        first.setMilestoneWeight(ana, 'ms-harbor-1', 9),
        second.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'v3 is live.'),
      ]);
      expect(readers).toBe(2);
      const meta = (await own.store.listMilestoneMeta(WORKSPACE_ID)).find(
        (m) => m.milestoneId === 'ms-harbor-1'
      );
      expect(meta).toMatchObject({
        weight: 9,
        doneMeans: 'v3 is live.',
        updatedBy: 'user-ana',
      });
    } finally {
      await own.close();
    }
  });

  test('a weight and a "done means…" saved together both stick', async () => {
    const own = await createDemoHarness();
    try {
      const ana = await actorFor(own, 'user-ana');
      await Promise.all([
        own.engine.setMilestoneWeight(ana, 'ms-harbor-1', 7),
        own.engine.setMilestoneDoneMeans(ana, 'ms-harbor-1', 'v3 is live.'),
      ]);
      const meta = (await own.store.listMilestoneMeta(WORKSPACE_ID)).find(
        (m) => m.milestoneId === 'ms-harbor-1'
      );
      expect(meta).toMatchObject({ weight: 7, doneMeans: 'v3 is live.' });
      expect(
        (await own.engine.listAudit(WORKSPACE_ID, 5))
          .map((entry) => entry.action)
          .sort()
      ).toEqual(['milestone.done_means', 'milestone.weight']);
    } finally {
      await own.close();
    }
  });
});

describe('milestone date and project lead: Linear refusals', () => {
  // Linear's refusals of these two writes map like issue edits' (§7.2), so
  // the web layer answers 403 / 401 / 429 instead of 502.
  test('map to engine error codes, and nothing is written', async () => {
    let failWith: Error = new Error('unset');
    const own = await createDemoHarness({
      wrap: (gateway): LinearGateway => ({
        ...gateway,
        updateMilestoneTargetDate: () => Promise.reject(failWith),
        updateProjectLead: () => Promise.reject(failWith),
      }),
    });
    try {
      const ana = await actorFor(own, 'user-ana');
      const cases: [
        LinearApiError,
        typeof EngineAuthError | typeof EngineInputError,
        string,
      ][] = [
        [
          new LinearApiError(
            'forbidden',
            'Linear denied access to ProjectUpdate'
          ),
          EngineAuthError,
          'linear_forbidden',
        ],
        [
          new LinearApiError('unauthorized', 'token rejected'),
          EngineAuthError,
          'not_signed_in',
        ],
        [
          new LinearApiError('rate_limited', 'limited', {
            retryAt: '2026-10-21T16:00:00.000Z',
          }),
          EngineInputError,
          'rate_limited',
        ],
      ];
      for (const [error, type, code] of cases) {
        failWith = error;
        await rejectsWith(
          own.engine.setMilestoneTargetDate(ana, 'ms-harbor-1', '2026-12-01'),
          type,
          code
        );
        await rejectsWith(
          own.engine.setProjectLead(ana, 'proj-harbor', 'user-chloe'),
          type,
          code
        );
      }
      failWith = new LinearApiError('forbidden', 'denied');
      expect(
        await caughtError(
          own.engine.setProjectLead(ana, 'proj-harbor', 'user-chloe')
        )
      ).toMatchObject({
        message: 'Linear does not let you change the project lead (denied).',
      });
      // Transport failures stay LinearApiError (502).
      failWith = new LinearApiError('server', 'HTTP 503');
      expect(
        await caughtError(
          own.engine.setMilestoneTargetDate(ana, 'ms-harbor-1', '2026-12-01')
        )
      ).toBe(failWith);
      expect(await own.engine.listAudit(WORKSPACE_ID, 5)).toEqual([]);
    } finally {
      await own.close();
    }
  });
});
