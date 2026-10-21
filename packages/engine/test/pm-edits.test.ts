import { addDays } from '@better-tracker/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type Actor, EngineAuthError, EngineInputError } from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  type GatewayWrapper,
  WORKSPACE_ID,
} from './helpers';

// One harness for the file: each test edits different entities.
let h: DemoHarness;
let pm: Actor;
let member: Actor;

beforeAll(async () => {
  h = await createDemoHarness();
  pm = await actorFor(h, 'user-ana');
  member = await actorFor(h, 'user-chloe');
});
afterAll(async () => {
  await h.close();
});

function readOnly(actor: Actor): Actor {
  return { ...actor, canWriteLinear: false };
}

async function rejectsWith(
  promise: Promise<unknown>,
  type: typeof EngineAuthError | typeof EngineInputError,
  code: string
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  expect((caught as { code: string }).code).toBe(code);
}

describe('permissions', () => {
  test('non-PMs cannot edit anything', async () => {
    const date = addDays(h.clock.today(), 10);
    await rejectsWith(
      h.engine.setMilestoneTargetDate(member, 'ms-juniper-2', date),
      EngineAuthError,
      'not_pm'
    );
    await rejectsWith(
      h.engine.setProjectLead(member, 'proj-delta', 'user-chloe'),
      EngineAuthError,
      'not_pm'
    );
    await rejectsWith(
      h.engine.setMilestoneWeight(member, 'ms-juniper-2', 3),
      EngineAuthError,
      'not_pm'
    );
    await rejectsWith(
      h.engine.setMilestoneDoneMeans(member, 'ms-juniper-2', 'x'),
      EngineAuthError,
      'not_pm'
    );
    await rejectsWith(
      h.engine.updateSettings(member, { warningsMode: 'live' }),
      EngineAuthError,
      'not_pm'
    );
  });

  test('Linear edits need the write scope; tool-owned edits do not', async () => {
    const date = addDays(h.clock.today(), 10);
    await rejectsWith(
      h.engine.setMilestoneTargetDate(readOnly(pm), 'ms-juniper-2', date),
      EngineAuthError,
      'needs_write_scope'
    );
    await rejectsWith(
      h.engine.setProjectLead(readOnly(pm), 'proj-delta', 'user-chloe'),
      EngineAuthError,
      'needs_write_scope'
    );
    await h.engine.setMilestoneWeight(readOnly(pm), 'ms-beacon-2', 2);
    const meta = (await h.store.listMilestoneMeta(WORKSPACE_ID)).find(
      (m) => m.milestoneId === 'ms-beacon-2'
    );
    expect(meta?.weight).toBe(2);
    // The weight change did not touch the existing done-means.
    expect(meta?.doneMeans).toBe('Search v2 serves all production traffic.');
    expect(
      h.fixture.data.milestones.find((m) => m.id === 'ms-juniper-2')?.targetDate
    ).toBe(addDays(h.clock.today(), 35));
  });
});

describe('milestone target date', () => {
  test('writes to Linear as the PM, patches the mirror and audits', async () => {
    const before = addDays(h.clock.today(), 35);
    const after = addDays(h.clock.today(), 42);
    await h.engine.setMilestoneTargetDate(pm, 'ms-juniper-2', after);

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
    await h.engine.setMilestoneTargetDate(pm, 'ms-compass-3', null);
    expect(
      (await h.engine.load(WORKSPACE_ID)).snapshot.milestones.get(
        'ms-compass-3'
      )?.targetDate
    ).toBeNull();
  });

  test('rejects invalid dates and unknown milestones', async () => {
    for (const bad of ['2026-02-30', '21/10/2026', '', 'tomorrow']) {
      await rejectsWith(
        h.engine.setMilestoneTargetDate(pm, 'ms-juniper-2', bad),
        EngineInputError,
        'invalid'
      );
    }
    await rejectsWith(
      h.engine.setMilestoneTargetDate(pm, 'ms-nope', '2026-12-01'),
      EngineInputError,
      'not_found'
    );
  });
});

describe('project lead', () => {
  test('must be an active person in the workspace', async () => {
    for (const bad of ['user-hugo', 'user-app', 'user-nobody']) {
      await rejectsWith(
        h.engine.setProjectLead(pm, 'proj-delta', bad),
        EngineInputError,
        'invalid'
      );
    }
    await rejectsWith(
      h.engine.setProjectLead(pm, 'proj-nope', 'user-chloe'),
      EngineInputError,
      'not_found'
    );
    expect(
      h.fixture.data.projects.find((p) => p.id === 'proj-delta')?.leadId
    ).toBeNull();
  });

  test('a valid lead is written to Linear and unblocks allocation', async () => {
    await h.engine.setProjectLead(pm, 'proj-delta', 'user-femi');
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

    await h.engine.setProjectLead(pm, 'proj-delta', null);
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
        h.engine.setMilestoneWeight(pm, 'ms-juniper-2', bad),
        EngineInputError,
        'invalid'
      );
    }
    await h.engine.setMilestoneWeight(pm, 'ms-juniper-2', -1000);
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
    await h.engine.setMilestoneWeight(pm, 'ms-juniper-2', null);
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
      h.engine.setMilestoneWeight(pm, 'ms-nope', 1),
      EngineInputError,
      'not_found'
    );
  });
});

describe('done means', () => {
  test('trimmed, one line, at most 280 characters; empty clears it', async () => {
    await h.engine.setMilestoneDoneMeans(
      pm,
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
      h.engine.setMilestoneDoneMeans(pm, 'ms-harbor-1', 'line one\nline two'),
      EngineInputError,
      'invalid'
    );
    await rejectsWith(
      h.engine.setMilestoneDoneMeans(pm, 'ms-harbor-1', 'x'.repeat(281)),
      EngineInputError,
      'invalid'
    );
    await h.engine.setMilestoneDoneMeans(pm, 'ms-harbor-1', 'é'.repeat(280));

    await h.engine.setMilestoneDoneMeans(pm, 'ms-harbor-1', '   ');
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
    const saved = await h.engine.updateSettings(pm, {
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

    // The PM list drives isPm on the next request.
    await h.engine.updateSettings(pm, {
      pmUserIds: ['user-ana', 'user-chloe'],
    });
    const chloe = await actorFor(h, 'user-chloe');
    expect(chloe.isPm).toBe(true);
    const ben = await actorFor(h, 'user-ben');
    expect(ben.isPm).toBe(false);
  });

  test('rejects lockouts and nonsense', async () => {
    const bad: unknown[] = [
      { pmUserIds: [] },
      { pmUserIds: ['user-hugo'] },
      { pmUserIds: ['user-app'] },
      { pmUserIds: ['user-nobody'] },
      { watcherUserIds: ['user-app'] },
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
        h.engine.updateSettings(pm, patch as never),
        EngineInputError,
        'invalid'
      );
    }
    expect((await h.engine.load(WORKSPACE_ID)).settings).toEqual(before);
  });
});

// Review regressions: who writes, whether the app is still installed, and
// edits of one milestone saved together.
describe('edits run as the PM, only while installed', () => {
  test("Linear edits go through the PM's own gateway, never the app", async () => {
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
