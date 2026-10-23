// The fixture's issue page support (owner decision 2026-10-21): demo
// content for every new read, and every new write applied in memory with
// the refusals Linear would give, so demo mode exercises the whole feature.

import { isAllowedEstimate } from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  createFixtureGateway,
  createFixtureStore,
  createFixtureWorkspace,
} from '../src/fixture';
import { createFixtureIssueDetails } from '../src/fixture-details';
import { caught } from './helpers';

const TODAY = '2026-10-21';
const fixedNow = new Date(`${TODAY}T15:00:00.000Z`);

function setup() {
  const store = createFixtureStore(TODAY);
  store.now = () => fixedNow;
  return {
    store,
    app: createFixtureGateway(store, { kind: 'app' }),
    ana: createFixtureGateway(store, { kind: 'user', userId: 'user-ana' }),
    dev: createFixtureGateway(store, 'user-dev'),
  };
}

describe('fixture issue page content', () => {
  const details = createFixtureIssueDetails(TODAY);
  const workspace = createFixtureWorkspace(TODAY);
  const issueIds = new Set(workspace.issues.map((i) => i.id));
  const teamOf = new Map(workspace.issues.map((i) => [i.id, i.teamId]));
  const labelById = new Map(details.labels.map((l) => [l.id, l]));

  test('is deterministic for a given day', () => {
    expect(createFixtureIssueDetails(TODAY)).toEqual(details);
  });

  test('most issues have a description; every entry is a mirrored issue', () => {
    const entries = Object.entries(details.issueFields);
    expect(entries.every(([id]) => issueIds.has(id))).toBe(true);
    const described = entries.filter(([, f]) => f.description !== null);
    expect(described.length / workspace.issues.length).toBeGreaterThan(0.8);
  });

  test('every estimate is on its team scale and labels are applicable', () => {
    for (const [issueId, fields] of Object.entries(details.issueFields)) {
      const teamId = teamOf.get(issueId) ?? '';
      const scale = details.estimateScales[teamId];
      if (scale === undefined) throw new Error(`no scale for ${teamId}`);
      if (fields.estimate !== null) {
        expect(isAllowedEstimate(scale, fields.estimate)).toBe(true);
      }
      const groups = new Set<string>();
      for (const labelId of fields.labelIds) {
        const entry = labelById.get(labelId);
        expect(entry).toBeDefined();
        expect(entry?.archived).toBe(false);
        expect(entry?.isGroup).toBe(false);
        expect([null, teamId]).toContain(entry?.teamId ?? null);
        if (entry?.parentId !== null && entry?.parentId !== undefined) {
          expect(groups.has(entry.parentId)).toBe(false);
          groups.add(entry.parentId);
        }
      }
    }
  });

  test('the two teams use different scales', () => {
    expect(details.estimateScales).toEqual({
      'team-eng': { type: 'fibonacci', allowZero: false, extended: false },
      'team-ops': { type: 'tShirt', allowZero: true, extended: true },
    });
  });

  test('seeded comments belong to mirrored issues and people', () => {
    const people = new Set(
      workspace.users.filter((u) => !u.app).map((u) => u.id)
    );
    expect(details.seededComments.length).toBeGreaterThanOrEqual(10);
    for (const comment of details.seededComments) {
      expect(issueIds.has(comment.issueId)).toBe(true);
      expect(people.has(comment.authorId)).toBe(true);
      expect(Date.parse(comment.createdAt)).toBeLessThan(fixedNow.getTime());
    }
    const reply = details.seededComments.find((c) => c.parentId !== undefined);
    expect(reply?.issueId).toBe('iss-eng-12');
  });
});

describe('fixture fetchIssueDetail and listIssueLabels', () => {
  test('reads the demo fields, labels with groups and the discussion', async () => {
    const { app } = setup();
    const detail = await app.fetchIssueDetail('iss-eng-12');
    expect(detail).toMatchObject({
      issueId: 'iss-eng-12',
      estimate: 3,
      dueDate: '2026-10-19',
      commentsTruncated: false,
      estimateScale: { type: 'fibonacci', allowZero: false, extended: false },
    });
    expect(detail?.description).toContain('nightly reconciler');
    expect(detail?.labels).toEqual([
      {
        id: 'lbl-eng-backend',
        name: 'Backend',
        color: '#5e6ad2',
        teamId: 'team-eng',
        group: { id: 'lbl-eng-area', name: 'Area', singleSelect: true },
      },
      {
        id: 'lbl-bug',
        name: 'Bug',
        color: '#eb5757',
        teamId: null,
        group: null,
      },
    ]);
    expect(detail?.comments.map((c) => [c.author?.name, c.parentId])).toEqual([
      ['Chloe Diaz', null],
      ['Ben Carter', 'seed-comment-1'],
      ['Ana Moreno', null],
    ]);
    expect(await app.fetchIssueDetail('nope')).toBeNull();
    // An issue without demo fields reads as empty, not missing.
    expect(await app.fetchIssueDetail('iss-eng-14')).toMatchObject({
      description: 'Duplicate of the audit logging that ENG-11 already covers.',
      labels: [],
      estimate: null,
    });
  });

  test("lists the team's and workspace labels, without groups or archived ones", async () => {
    const { app } = setup();
    const eng = await app.listIssueLabels('team-eng');
    const names = eng.map((l) => l.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('Backend');
    expect(names).toContain('Bug');
    expect(names).not.toContain('Area');
    expect(names).not.toContain('Legacy');
    expect(names).not.toContain('Vendor');
    const ops = await app.listIssueLabels('team-ops');
    expect(ops.map((l) => l.name)).toContain('Vendor');
    expect(ops.map((l) => l.name)).not.toContain('Backend');
  });
});

describe('fixture updateIssueFields', () => {
  test('applies every field and later reads see it', async () => {
    const { app, ana } = setup();
    const updated = await ana.updateIssueFields('iss-eng-12', {
      title: '  Reconcile drift nightly ',
      description: 'New text',
      stateId: 'st-eng-progress',
      assigneeId: 'user-ana',
      priority: 2,
      dueDate: '2026-10-30',
      estimate: 5,
      labelIds: ['lbl-bug', 'lbl-eng-frontend'],
    });
    expect(updated).toMatchObject({
      title: 'Reconcile drift nightly',
      stateId: 'st-eng-progress',
      assigneeId: 'user-ana',
      priority: 2,
      updatedAt: fixedNow.toISOString(),
      lastStateChangeAt: fixedNow.toISOString(),
      startedAt: fixedNow.toISOString(),
      dueDate: '2026-10-30',
    });
    expect(await app.fetchIssue('iss-eng-12')).toEqual(updated);
    // The mirror reads the due date too (Issue.dueDate, since 2026-10-22).
    expect(
      (await app.fetchWorkspace()).issues.find((i) => i.id === 'iss-eng-12')
    ).toEqual(updated);
    expect(await app.fetchIssueDetail('iss-eng-12')).toMatchObject({
      description: 'New text',
      dueDate: '2026-10-30',
      estimate: 5,
      labels: [{ id: 'lbl-bug' }, { id: 'lbl-eng-frontend' }],
    });
    // Clearing.
    await ana.updateIssueFields('iss-eng-12', {
      description: '  ',
      assigneeId: null,
      dueDate: null,
      estimate: null,
      labelIds: [],
    });
    expect(await app.fetchIssueDetail('iss-eng-12')).toMatchObject({
      description: null,
      dueDate: null,
      estimate: null,
      labels: [],
    });
    expect((await app.fetchIssue('iss-eng-12'))?.assigneeId).toBeNull();
    expect((await app.fetchIssue('iss-eng-12'))?.dueDate).toBeNull();
    expect(
      (await app.fetchWorkspace()).issues.find((i) => i.id === 'iss-eng-12')
        ?.dueDate
    ).toBeNull();
  });

  test('every issue read carries its due date from the fields store', async () => {
    const { store, app, ana } = setup();
    const seeded = Object.entries(store.issueFields).find(
      ([, fields]) => fields.dueDate !== null
    );
    if (seeded === undefined) throw new Error('no seeded due date');
    const [issueId, fields] = seeded;
    expect((await app.fetchIssue(issueId))?.dueDate).toBe(fields.dueDate);
    const workspace = await app.fetchWorkspace();
    for (const issue of workspace.issues) {
      expect(issue.dueDate).toBe(store.issueFields[issue.id]?.dueDate ?? null);
    }
    // An allocation write returns it too; the store's issues never hold it.
    const allocated = await app.updateIssue(issueId, {
      assigneeId: 'user-ana',
    });
    expect(allocated.dueDate).toBe(fields.dueDate);
    expect(
      store.data.issues.find((i) => i.id === issueId)?.dueDate
    ).toBeUndefined();
    // Reads never create a fields entry for an issue without one.
    const bare = store.data.issues.find(
      (i) => store.issueFields[i.id] === undefined
    );
    if (bare !== undefined) {
      expect((await ana.fetchIssue(bare.id))?.dueDate).toBeNull();
      expect(store.issueFields[bare.id]).toBeUndefined();
    }
  });

  test('closing sets completedAt; a project change drops the old milestone', async () => {
    const { ana } = setup();
    const done = await ana.updateIssueFields('iss-eng-13', {
      stateId: 'st-eng-done',
    });
    expect(done.completedAt).toBe(fixedNow.toISOString());
    const reopened = await ana.updateIssueFields('iss-eng-13', {
      stateId: 'st-eng-todo',
    });
    expect(reopened.completedAt).toBeNull();

    const moved = await ana.updateIssueFields('iss-eng-13', {
      projectId: 'proj-beacon',
    });
    expect(moved).toMatchObject({
      projectId: 'proj-beacon',
      milestoneId: null,
    });
    const placed = await ana.updateIssueFields('iss-eng-13', {
      projectMilestoneId: 'ms-beacon-2',
    });
    expect(placed.milestoneId).toBe('ms-beacon-2');
    const loose = await ana.updateIssueFields('iss-eng-13', {
      projectId: null,
    });
    expect(loose).toMatchObject({ projectId: null, milestoneId: null });
  });

  test('refuses what Linear would refuse', async () => {
    const { ana } = setup();
    const refusals: Parameters<typeof ana.updateIssueFields>[1][] = [
      {},
      { title: '   ' },
      { stateId: 'st-ops-todo' },
      { assigneeId: 'user-nobody' },
      { priority: 7 as 0 },
      { projectId: 'proj-nope' },
      { projectMilestoneId: 'ms-beacon-1' },
      { projectId: 'proj-beacon', projectMilestoneId: 'ms-atlas-3' },
      { dueDate: 'soon' },
      // Engineering estimates on the plain Fibonacci scale.
      { estimate: 4 },
      { estimate: 13 },
      { labelIds: ['lbl-nope'] },
      { labelIds: ['lbl-legacy'] },
      { labelIds: ['lbl-eng-area'] },
      { labelIds: ['lbl-ops-vendor'] },
      { labelIds: ['lbl-eng-frontend', 'lbl-eng-backend'] },
    ];
    for (const patch of refusals) {
      expect(
        await caught(ana.updateIssueFields('iss-eng-12', patch))
      ).toMatchObject({ kind: 'invalid_input' });
    }
    expect(
      await caught(ana.updateIssueFields('nope', { title: 'x' }))
    ).toMatchObject({ kind: 'not_found' });
    // Operations allows zero and the extended T-shirt sizes.
    expect((await ana.updateIssueFields('iss-ops-5', { estimate: 0 })).id).toBe(
      'iss-ops-5'
    );
    await ana.updateIssueFields('iss-ops-5', { estimate: 21 });
  });

  // linear.app/docs/labels: "Archiving a label keeps it on any issues
  // where it's been applied, but stops people from using that label moving
  // forward." labelIds replaces the whole set, so an edit that sends the
  // carried archived label back must keep it.
  test('keeps an archived label the issue carries; never applies it anew', async () => {
    const { store, ana } = setup();
    const fields = store.issueFields['iss-eng-12'];
    if (fields === undefined) throw new Error('iss-eng-12 has demo fields');
    fields.labelIds = [...fields.labelIds, 'lbl-legacy'];
    const carried = [...fields.labelIds];

    const before = await ana.fetchIssueDetail('iss-eng-12');
    expect(before?.labels.map((l) => l.id)).toContain('lbl-legacy');

    await ana.updateIssueFields('iss-eng-12', {
      labelIds: [...carried, 'lbl-feature'],
    });
    expect(store.issueFields['iss-eng-12']?.labelIds).toEqual([
      ...carried,
      'lbl-feature',
    ]);
    // Removing it is allowed; putting it back is not.
    const without = carried.filter((id) => id !== 'lbl-legacy');
    await ana.updateIssueFields('iss-eng-12', { labelIds: without });
    expect(store.issueFields['iss-eng-12']?.labelIds).toEqual(without);
    expect(
      await caught(
        ana.updateIssueFields('iss-eng-12', { labelIds: [...carried] })
      )
    ).toMatchObject({ kind: 'invalid_input' });
  });
});

describe('fixture relations and comments', () => {
  test('creates and deletes blocking relations', async () => {
    const { app, dev, store } = setup();
    const relation = await dev.createBlockingRelation(
      'iss-eng-60',
      'iss-eng-62'
    );
    expect(relation).toEqual({
      id: `rel-${store.data.relations.length}`,
      blockerId: 'iss-eng-60',
      blockedId: 'iss-eng-62',
    });
    expect(
      (await app.fetchIssueRelations('iss-eng-62')).map((r) => r.id)
    ).toEqual([relation.id]);
    expect(
      await caught(dev.createBlockingRelation('iss-eng-60', 'iss-eng-62'))
    ).toMatchObject({ kind: 'invalid_input' });
    expect(
      await caught(dev.createBlockingRelation('iss-eng-60', 'iss-eng-60'))
    ).toMatchObject({ kind: 'invalid_input' });
    expect(
      await caught(dev.createBlockingRelation('iss-eng-60', 'nope'))
    ).toMatchObject({ kind: 'not_found' });

    await dev.deleteRelation(relation.id);
    expect(await app.fetchIssueRelations('iss-eng-62')).toEqual([]);
    expect(await caught(dev.deleteRelation(relation.id))).toMatchObject({
      kind: 'not_found',
    });
  });

  // A stale tab still shows a relation that was deleted elsewhere. If the
  // next relation reused its id, that tab's remove would delete the new,
  // unrelated relation; ids come from a counter that only grows instead.
  test('relation ids are never reused after a delete', async () => {
    const { dev, store } = setup();
    const first = await dev.createBlockingRelation('iss-eng-60', 'iss-eng-62');
    const second = await dev.createBlockingRelation('iss-eng-60', 'iss-eng-61');
    expect([first.id, second.id]).toEqual([
      `rel-${store.data.relations.length - 1}`,
      `rel-${store.data.relations.length}`,
    ]);
    await dev.deleteRelation(first.id);
    await dev.deleteRelation(second.id);

    const third = await dev.createBlockingRelation('iss-eng-61', 'iss-eng-62');
    expect([first.id, second.id]).not.toContain(third.id);
    expect(third.id).toBe(`rel-${store.lastRelationNumber}`);
    expect(store.lastRelationNumber).toBe(
      Number(second.id.slice('rel-'.length)) + 1
    );
    // The stale tab's remove of the first relation hits nothing.
    expect(await caught(dev.deleteRelation(first.id))).toMatchObject({
      kind: 'not_found',
    });
    expect(store.data.relations.map((r) => r.id)).toContain(third.id);

    // A store's counter is its own: a fresh store starts after its seeded
    // relations again.
    const fresh = setup();
    expect(fresh.store.lastRelationNumber).toBe(
      fresh.store.data.relations.length
    );
  });

  test("a person's comment joins the discussion, newest last", async () => {
    const { app, ana } = setup();
    const { id } = await ana.createComment('iss-eng-12', 'On it today.');
    const detail = await app.fetchIssueDetail('iss-eng-12');
    expect(detail?.comments.at(-1)).toEqual({
      id,
      body: 'On it today.',
      createdAt: fixedNow.toISOString(),
      url: `https://linear.app/northwind/comment/${id}`,
      parentId: null,
      author: { id: 'user-ana', name: 'Ana Moreno' },
      externalAuthor: null,
    });
  });
});
