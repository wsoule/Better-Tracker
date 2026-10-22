// Per-viewer visibility (architecture §2.13) end to end over the demo
// workspace: a private team is shown only to its members and a guest only
// their own teams, in every read made for a person (load, week, timeline,
// graph, milestone drawer, issue page, edits, run log, audit, digest
// preview), while the worker's own jobs keep the whole mirror and each
// digest names only what its recipient may see.

import { afterEach, describe, expect, test } from 'bun:test';

import { type Actor, EngineInputError } from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  rejection,
  WORKSPACE_ID,
} from './helpers';

let harness: DemoHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const OPS_ONLY_PROJECTS = ['proj-delta', 'proj-fjord'];

// The demo workspace with Operations made private (its members: Ana, Ben,
// Elena, Femi), synced. Chloe is in Engineering only.
async function privateOps(): Promise<{
  h: DemoHarness;
  chloe: Actor;
  ben: Actor;
}> {
  harness = await createDemoHarness();
  const h = harness;
  const ops = h.fixture.data.teams.find((t) => t.id === 'team-ops');
  if (ops === undefined) throw new Error('fixture changed');
  ops.visibility = 'private';
  await h.engine.fullSync(WORKSPACE_ID);
  return {
    h,
    chloe: await actorFor(h, 'user-chloe'),
    ben: await actorFor(h, 'user-ben'),
  };
}

function opsKeys(identifiers: readonly string[]): string[] {
  return identifiers.filter((key) => key.startsWith('OPS-'));
}

describe('a private team', () => {
  test('load(): an outsider sees no trace of it; members and jobs see all', async () => {
    const { h, chloe, ben } = await privateOps();
    const seen = (await h.engine.load(WORKSPACE_ID, chloe)).snapshot;
    for (const id of OPS_ONLY_PROJECTS)
      expect(seen.projects.has(id)).toBe(false);
    expect(seen.milestones.has('ms-delta-1')).toBe(false);
    expect(opsKeys([...seen.issues.values()].map((i) => i.identifier))).toEqual(
      []
    );
    expect(seen.data.teams.map((t) => t.id)).toEqual(['team-eng']);
    // Compass also belongs to Engineering, so it stays, without OPS-1.
    expect(seen.projects.has('proj-compass')).toBe(true);

    const all = (await h.engine.load(WORKSPACE_ID)).snapshot;
    expect(all.projects.has('proj-delta')).toBe(true);
    expect(all.issues.has('iss-ops-1')).toBe(true);
    const asBen = (await h.engine.load(WORKSPACE_ID, ben)).snapshot;
    expect(asBen).toBe(all);
  });

  test('week, timeline, graph and drawer are built from what the viewer sees', async () => {
    const { h, chloe } = await privateOps();
    // Ana's week, viewed by Chloe: none of Ana's Operations issues.
    const week = await h.engine.getWeekView(WORKSPACE_ID, 'user-femi', chloe);
    expect(
      opsKeys(week.sections.flatMap((s) => s.rows.map((r) => r.identifier)))
    ).toEqual([]);
    const ownWeek = await h.engine.getWeekView(WORKSPACE_ID, 'user-femi');
    expect(
      opsKeys(ownWeek.sections.flatMap((s) => s.rows.map((r) => r.identifier)))
        .length
    ).toBeGreaterThan(0);

    const timeline = await h.engine.getTimelineView(WORKSPACE_ID, chloe);
    const lanes = timeline.groups.flatMap((g) =>
      g.lanes.map((l) => l.projectId)
    );
    for (const id of OPS_ONLY_PROJECTS) expect(lanes).not.toContain(id);
    expect(lanes).toContain('proj-compass');

    const graph = await h.engine.getGraph(
      WORKSPACE_ID,
      { level: 'milestone' },
      chloe
    );
    expect(JSON.stringify(graph)).not.toContain('ms-delta-1');

    expect(
      await rejection(
        h.engine.getMilestoneDetail(WORKSPACE_ID, 'ms-delta-1', chloe)
      )
    ).toMatchObject({ code: 'not_found' });
    expect(
      (await h.engine.getMilestoneDetail(WORKSPACE_ID, 'ms-delta-1')).milestone
        .id
    ).toBe('ms-delta-1');
  });

  test('the issue page and edits treat its issues as not found', async () => {
    const { h, chloe, ben } = await privateOps();
    const hidden = await rejection(h.engine.getIssueDetail(chloe, 'iss-ops-1'));
    expect(hidden).toBeInstanceOf(EngineInputError);
    expect(hidden).toMatchObject({ code: 'not_found' });
    expect(
      (await h.engine.getIssueDetail(ben, 'iss-ops-1')).detail.issue.identifier
    ).toBe('OPS-1');
    // A visible issue's relations to hidden ones are not shown either.
    const compass = await h.engine.getIssueDetail(chloe, 'iss-eng-31');
    expect(
      [...compass.detail.blockedBy, ...compass.detail.blocks].some((row) =>
        row.identifier.startsWith('OPS-')
      )
    ).toBe(false);

    const before = h.fixture.data.issues.find(
      (i) => i.id === 'iss-ops-1'
    )?.title;
    expect(
      await rejection(
        h.engine.updateIssue(chloe, 'iss-ops-1', { title: 'Peeked' })
      )
    ).toMatchObject({ code: 'not_found' });
    expect(
      await rejection(h.engine.addBlocker(chloe, 'iss-eng-31', 'iss-ops-1'))
    ).toMatchObject({ code: 'not_found' });
    expect(h.fixture.data.issues.find((i) => i.id === 'iss-ops-1')?.title).toBe(
      before
    );
  });

  test('run entries and the audit log leave out what the viewer cannot see', async () => {
    const { h, chloe, ben } = await privateOps();
    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'manual',
      actor: null,
    });
    const all = await h.engine.getRun(WORKSPACE_ID, run.id);
    const asChloe = await h.engine.getRun(WORKSPACE_ID, run.id, chloe);
    expect(all?.entries.some((e) => e.issueId === 'iss-ops-1')).toBe(true);
    expect(asChloe?.entries.some((e) => e.issueId === 'iss-ops-1')).toBe(false);
    expect(
      asChloe?.entries.some((e) => OPS_ONLY_PROJECTS.includes(e.projectId))
    ).toBe(false);
    expect(asChloe?.entries.length).toBeGreaterThan(0);

    await h.engine.updateIssue(ben, 'iss-ops-1', { title: 'Provision v2' });
    await h.engine.setMilestoneWeight(chloe, 'ms-harbor-1', 3);
    const audit = (viewer?: Actor) =>
      h.engine
        .listAudit(WORKSPACE_ID, 50, viewer)
        .then((entries) => entries.map((e) => `${e.action}:${e.subjectId}`));
    expect(await audit(ben)).toContain('issue.title:iss-ops-1');
    expect(await audit(chloe)).not.toContain('issue.title:iss-ops-1');
    expect(await audit(chloe)).toContain('milestone.weight:ms-harbor-1');
  });

  test('digests name only what their recipient (or the previewer) can see', async () => {
    const { h, chloe } = await privateOps();
    const ana = await actorFor(h, 'user-ana');
    await h.engine.updateSettings(ana, {
      watcherUserIds: ['user-chloe', 'user-ben'],
    });
    const preview = await h.engine.runWarnings({
      workspaceId: WORKSPACE_ID,
      previewOnly: true,
      viewer: chloe,
    });
    const previewText = JSON.stringify(preview.digests);
    expect(previewText).not.toContain('OPS-');
    expect(previewText).not.toContain('proj-fjord');
    // Ben's digest is in it, narrowed to what Chloe may see.
    expect(preview.digests.map((d) => d.recipientId)).toContain('user-ben');

    const sent = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    const chloes = sent.digests.find((d) => d.recipientId === 'user-chloe');
    const bens = sent.digests.find((d) => d.recipientId === 'user-ben');
    expect(chloes).toBeDefined();
    expect(JSON.stringify(chloes)).not.toContain('OPS-');
    expect(
      chloes?.items.some((i) => OPS_ONLY_PROJECTS.includes(i.notice.projectId))
    ).toBe(false);
    // Ben is in Operations: his digest has its milestones.
    expect(
      bens?.items.some((i) => OPS_ONLY_PROJECTS.includes(i.notice.projectId))
    ).toBe(true);
  });
});

describe('a guest', () => {
  test('sees only the teams they belong to, and no initiatives', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const grace = h.fixture.data.users.find((u) => u.id === 'user-grace');
    if (grace === undefined) throw new Error('fixture changed');
    grace.guest = true;
    await h.engine.fullSync(WORKSPACE_ID);
    const guest = await actorFor(h, 'user-grace');
    const member = await actorFor(h, 'user-chloe');

    // Operations is public: members see it, the Engineering guest does not.
    const seen = (await h.engine.load(WORKSPACE_ID, guest)).snapshot;
    expect(seen.data.teams.map((t) => t.id)).toEqual(['team-eng']);
    expect(opsKeys([...seen.issues.values()].map((i) => i.identifier))).toEqual(
      []
    );
    expect(seen.projects.has('proj-delta')).toBe(false);
    expect(seen.initiatives.size).toBe(0);
    expect(
      [...seen.projects.values()].every((p) => p.initiativeIds.length === 0)
    ).toBe(true);
    // Even an Operations issue assigned to her is not hers to see.
    const week = await h.engine.getWeekView(WORKSPACE_ID, 'user-grace', guest);
    expect(
      week.sections.flatMap((s) => s.rows.map((r) => r.identifier))
    ).not.toContain('OPS-20');
    const timeline = await h.engine.getTimelineView(WORKSPACE_ID, guest);
    expect(timeline.groups.map((g) => g.initiativeId)).toEqual([null]);

    const asMember = (await h.engine.load(WORKSPACE_ID, member)).snapshot;
    expect(asMember.projects.has('proj-delta')).toBe(true);
    expect(asMember.initiatives.size).toBeGreaterThan(0);
  });

  test('a viewer from another workspace is refused', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const member = await actorFor(h, 'user-chloe');
    const foreign: Actor = {
      ...member,
      session: { ...member.session, workspaceId: 'org-elsewhere' },
    };
    expect(await rejection(h.engine.load(WORKSPACE_ID, foreign))).toMatchObject(
      { code: 'wrong_workspace' }
    );
  });
});
