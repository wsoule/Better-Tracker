// Pins down every scenario the fixture workspace exists to exercise, so a
// later edit cannot silently remove one. The checks use small local
// helpers (not core's rules) so this package stays independent of core's
// implementation; they mirror architecture §2.

import type {
  Issue,
  Milestone,
  Project,
  WorkspaceData,
} from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  createFixtureGateway,
  createFixtureStore,
  createFixtureWorkspace,
  FIXTURE_APP_USER_ID,
  FIXTURE_MILESTONE_META,
  FIXTURE_PM_USER_IDS,
  FIXTURE_WORKSPACE,
} from '../src/fixture';
import { LinearApiError } from '../src/gateway';
import { caught } from './helpers';

const TODAY = '2026-10-21';
const NOW_MS = Date.parse(`${TODAY}T12:00:00.000Z`);
const DAY_MS = 86_400_000;
const WARN_LEAD_DAYS = 7;
const STALL_DAYS = 7;
const PACE_WINDOW_DAYS = 7;
const DONE_MEANS = /^\s*done means\b[\s:—–-]*(.+)$/i;

const data: WorkspaceData = createFixtureWorkspace(TODAY);
const stateById = new Map(data.states.map((s) => [s.id, s]));
const userById = new Map(data.users.map((u) => [u.id, u]));
const metaById = new Map(FIXTURE_MILESTONE_META.map((m) => [m.milestoneId, m]));

function stateType(issue: Issue): string {
  const state = stateById.get(issue.stateId);
  if (state === undefined) throw new Error(`no state ${issue.stateId}`);
  return state.type;
}

function isOpen(issue: Issue): boolean {
  return ['triage', 'backlog', 'unstarted', 'started'].includes(
    stateType(issue)
  );
}

function issuesIn(milestoneId: string): Issue[] {
  return data.issues.filter((i) => i.milestoneId === milestoneId);
}

function daysLeft(date: string): number {
  return Math.round((Date.parse(date) - Date.parse(TODAY)) / DAY_MS);
}

function project(key: string): Project {
  const found = data.projects.find((p) => p.id === `proj-${key}`);
  if (found === undefined) throw new Error(`no project ${key}`);
  return found;
}

// Linear order: dated by target date ascending, undated last, then sortOrder.
function milestonesOf(projectId: string): Milestone[] {
  return data.milestones
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => {
      if (a.targetDate !== b.targetDate) {
        if (a.targetDate === null) return 1;
        if (b.targetDate === null) return -1;
        return a.targetDate < b.targetDate ? -1 : 1;
      }
      return a.sortOrder - b.sortOrder;
    });
}

function isComplete(m: Milestone): boolean {
  const issues = issuesIn(m.id);
  return issues.length > 0 && issues.every((i) => !isOpen(i));
}

function nextMilestone(key: string): Milestone {
  const next = milestonesOf(project(key).id).find((m) => !isComplete(m));
  if (next === undefined) throw new Error(`no next milestone for ${key}`);
  return next;
}

function doneMeans(m: Milestone): string | null {
  const fromMeta = metaById.get(m.id)?.doneMeans?.trim();
  if (fromMeta !== undefined && fromMeta !== '') return fromMeta;
  const firstMatch = (m.description ?? '')
    .split('\n')
    .map((line) => DONE_MEANS.exec(line)?.[1] ?? null)
    .find((text) => text !== null);
  return firstMatch ?? null;
}

function progress(m: Milestone) {
  const issues = issuesIn(m.id);
  const completed = issues.filter((i) => stateType(i) === 'completed').length;
  const canceled = issues.filter((i) => stateType(i) === 'canceled').length;
  const open = issues.filter(isOpen);
  return {
    total: issues.length,
    completed,
    canceled,
    scope: issues.length - canceled,
    open: open.length,
    openUnassigned: open.filter((i) => i.assigneeId === null).length,
  };
}

function lastChangeMs(m: Milestone): number {
  return Math.max(
    ...issuesIn(m.id).map((i) => Date.parse(i.lastStateChangeAt))
  );
}

function isStalled(m: Milestone): boolean {
  return NOW_MS - lastChangeMs(m) > STALL_DAYS * DAY_MS;
}

function isBehindPace(m: Milestone): boolean {
  const p = progress(m);
  const left = Math.min(
    Math.max(daysLeft(m.targetDate ?? TODAY), 0),
    PACE_WINDOW_DAYS
  );
  return p.open / p.scope > left / PACE_WINDOW_DAYS;
}

describe('fixture workspace: people, teams, states, initiatives', () => {
  test('~8 people incl. two active PMs, one deactivated user and the app user', () => {
    const humans = data.users.filter((u) => !u.app);
    expect(humans.length).toBeGreaterThanOrEqual(8);
    expect(data.users.filter((u) => u.app).map((u) => u.id)).toEqual([
      FIXTURE_APP_USER_ID,
    ]);
    expect(userById.get(FIXTURE_APP_USER_ID)?.email).toBeNull();
    expect(humans.filter((u) => !u.active)).toHaveLength(1);
    expect(FIXTURE_PM_USER_IDS).toHaveLength(2);
    for (const id of FIXTURE_PM_USER_IDS) {
      expect(userById.get(id)?.active).toBe(true);
      expect(userById.get(id)?.email).toContain('@northwind.example');
    }
  });

  test('two teams (ENG, OPS), each with the full workflow and a Duplicate state', () => {
    expect(data.teams.map((t) => t.key).sort()).toEqual(['ENG', 'OPS']);
    for (const team of data.teams) {
      const states = data.states.filter((s) => s.teamId === team.id);
      expect(states.map((s) => `${s.name}:${s.type}`)).toEqual([
        'Triage:triage',
        'Backlog:backlog',
        'Todo:unstarted',
        'In Progress:started',
        'In Review:started',
        'Done:completed',
        'Canceled:canceled',
        'Duplicate:canceled',
      ]);
    }
  });

  test('two initiatives with priorities', () => {
    expect(data.initiatives).toHaveLength(2);
    for (const initiative of data.initiatives)
      expect(initiative.priority).toBeGreaterThan(0);
    expect(new Set(data.initiatives.map((i) => i.priority)).size).toBe(2);
  });

  test('a duplicate-state issue exists (counts as canceled)', () => {
    const duplicates = data.issues.filter(
      (i) => stateById.get(i.stateId)?.name === 'Duplicate'
    );
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
  });
});

describe('fixture workspace: project scenarios', () => {
  test('(a) atlas: overdue next milestone with unassigned open issues; later "Done means:" description', () => {
    const atlas = project('atlas');
    expect(atlas.statusType).toBe('started');
    expect(userById.get(atlas.leadId ?? '')?.active).toBe(true);
    const next = nextMilestone('atlas');
    expect(daysLeft(next.targetDate ?? TODAY)).toBeLessThan(0);
    const unassignedOpen = issuesIn(next.id).filter(
      (i) => isOpen(i) && i.assigneeId === null
    );
    expect(unassignedOpen.length).toBeGreaterThanOrEqual(2);
    expect(unassignedOpen.some((i) => stateType(i) === 'backlog')).toBe(true);
    expect(unassignedOpen.some((i) => stateType(i) === 'unstarted')).toBe(true);
    expect(doneMeans(next)).not.toBeNull();
    const later = milestonesOf(atlas.id).filter(
      (m) => (m.targetDate ?? '') > (next.targetDate ?? '')
    );
    expect(
      later.some(
        (m) =>
          /^Done means: /.test(m.description ?? '') &&
          metaById.get(m.id) === undefined
      )
    ).toBe(true);
  });

  test('(b) beacon: due in 2 days, 3/7 done, behind pace and nothing else', () => {
    const next = nextMilestone('beacon');
    expect(project('beacon').statusType).toBe('started');
    expect(daysLeft(next.targetDate ?? '')).toBe(2);
    expect(progress(next)).toEqual({
      total: 7,
      completed: 3,
      canceled: 0,
      scope: 7,
      open: 4,
      openUnassigned: 0,
    });
    expect(isBehindPace(next)).toBe(true);
    expect(isStalled(next)).toBe(false);
  });

  test('(c) compass: planned; due in 5 days with unassigned Backlog issues, a triage issue, and an undated milestone', () => {
    const compass = project('compass');
    expect(compass.statusType).toBe('planned');
    const next = nextMilestone('compass');
    expect(daysLeft(next.targetDate ?? '')).toBe(5);
    const open = issuesIn(next.id).filter(isOpen);
    const backlogUnassigned = open.filter(
      (i) => i.assigneeId === null && stateType(i) === 'backlog'
    );
    expect(backlogUnassigned.length).toBeGreaterThanOrEqual(2);
    // Allocation targets in both teams, so both teams' Todo states are used.
    expect(new Set(backlogUnassigned.map((i) => i.teamId)).size).toBe(2);
    expect(
      open.some((i) => i.assigneeId === null && stateType(i) === 'triage')
    ).toBe(true);
    expect(
      open.some((i) => i.assigneeId === null && stateType(i) === 'unstarted')
    ).toBe(true);
    const undated = milestonesOf(compass.id).filter(
      (m) => m.targetDate === null
    );
    expect(undated).toHaveLength(1);
    expect(
      issuesIn(undated[0]?.id ?? '').filter(isOpen).length
    ).toBeGreaterThan(0);
  });

  test('(d) delta: started, no lead', () => {
    expect(project('delta').statusType).toBe('started');
    expect(project('delta').leadId).toBeNull();
    expect(issuesIn(nextMilestone('delta').id).length).toBeGreaterThan(0);
  });

  test('(e) ember: started, lead deactivated', () => {
    const ember = project('ember');
    expect(ember.statusType).toBe('started');
    expect(userById.get(ember.leadId ?? '')?.active).toBe(false);
  });

  test('(f) fjord: paused', () => {
    expect(project('fjord').statusType).toBe('paused');
  });

  test('(g) garnet: no initiative; fully assigned, stalled 10+ days; later empty milestone; unplanned issues', () => {
    const garnet = project('garnet');
    expect(garnet.statusType).toBe('started');
    expect(garnet.initiativeIds).toEqual([]);
    const next = nextMilestone('garnet');
    expect(daysLeft(next.targetDate ?? '')).toBe(6);
    expect(progress(next).openUnassigned).toBe(0);
    expect(progress(next).open).toBeGreaterThan(0);
    expect(NOW_MS - lastChangeMs(next)).toBeGreaterThanOrEqual(10 * DAY_MS);
    expect(isBehindPace(next)).toBe(false);
    const later = milestonesOf(garnet.id).filter((m) => m.id !== next.id);
    expect(
      later.some((m) => issuesIn(m.id).length === 0 && m.targetDate !== null)
    ).toBe(true);
    const unplanned = data.issues.filter(
      (i) => i.projectId === garnet.id && i.milestoneId === null && isOpen(i)
    );
    expect(unplanned.length).toBeGreaterThanOrEqual(2);
  });

  test('(h) harbor: due in 4 days with no done-means anywhere', () => {
    const harbor = project('harbor');
    expect(harbor.statusType).toBe('started');
    expect(userById.get(harbor.leadId ?? '')?.active).toBe(true);
    const next = nextMilestone('harbor');
    expect(daysLeft(next.targetDate ?? '')).toBe(4);
    expect(daysLeft(next.targetDate ?? '')).toBeLessThanOrEqual(WARN_LEAD_DAYS);
    expect(metaById.has(next.id)).toBe(false);
    expect(doneMeans(next)).toBeNull();
    expect(
      issuesIn(next.id).some((i) => isOpen(i) && i.assigneeId === null)
    ).toBe(true);
  });

  test('(i) a complete milestone in the past', () => {
    const complete = data.milestones.filter(
      (m) =>
        m.targetDate !== null && daysLeft(m.targetDate) < 0 && isComplete(m)
    );
    expect(complete.length).toBeGreaterThanOrEqual(1);
  });

  test('(j) on-track milestones further out than the warning window', () => {
    const farOut = data.milestones.filter(
      (m) =>
        m.targetDate !== null &&
        daysLeft(m.targetDate) > WARN_LEAD_DAYS &&
        issuesIn(m.id).some(isOpen)
    );
    expect(farOut.length).toBeGreaterThanOrEqual(3);
  });

  test('the only invalid-soon next milestone is harbor; other active next milestones have done-means', () => {
    const withoutDoneMeans: string[] = [];
    for (const p of data.projects) {
      if (!['planned', 'started'].includes(p.statusType)) continue;
      const next = nextMilestone(p.id.replace('proj-', ''));
      if (doneMeans(next) === null) withoutDoneMeans.push(p.id);
    }
    expect(withoutDoneMeans).toEqual(['proj-harbor']);
  });

  test('META gives exactly one weight override and only references real milestones', () => {
    expect(
      FIXTURE_MILESTONE_META.filter((m) => m.weight !== null)
    ).toHaveLength(1);
    const ids = new Set(data.milestones.map((m) => m.id));
    for (const meta of FIXTURE_MILESTONE_META)
      expect(ids.has(meta.milestoneId)).toBe(true);
  });
});

describe('fixture workspace: relations', () => {
  const issueById = new Map(data.issues.map((i) => [i.id, i]));
  const milestoneById = new Map(data.milestones.map((m) => [m.id, m]));

  test('a cross-project blocks chain ends in an unassigned issue in an overdue milestone', () => {
    const found = data.relations.some((first) =>
      data.relations.some((second) => {
        if (second.blockerId !== first.blockedId) return false;
        const root = issueById.get(first.blockerId);
        const middle = issueById.get(first.blockedId);
        const last = issueById.get(second.blockedId);
        if (root === undefined || middle === undefined || last === undefined)
          return false;
        const rootMilestone = milestoneById.get(root.milestoneId ?? '');
        const projects = new Set([
          root.projectId,
          middle.projectId,
          last.projectId,
        ]);
        return (
          projects.size >= 2 &&
          isOpen(root) &&
          root.assigneeId === null &&
          rootMilestone?.targetDate !== null &&
          rootMilestone !== undefined &&
          daysLeft(rootMilestone.targetDate ?? TODAY) < 0
        );
      })
    );
    expect(found).toBe(true);
  });

  test('a two-issue cycle', () => {
    const cycle = data.relations.some((a) =>
      data.relations.some(
        (b) => a.blockerId === b.blockedId && a.blockedId === b.blockerId
      )
    );
    expect(cycle).toBe(true);
  });

  test('a resolved (closed) blocker of an open issue', () => {
    const resolved = data.relations.some((r) => {
      const blocker = issueById.get(r.blockerId);
      const blocked = issueById.get(r.blockedId);
      return (
        blocker !== undefined &&
        blocked !== undefined &&
        !isOpen(blocker) &&
        isOpen(blocked)
      );
    });
    expect(resolved).toBe(true);
  });
});

describe('fixture workspace: My week content', () => {
  test('both PMs have open issues across several milestones plus one with no milestone', () => {
    for (const pm of FIXTURE_PM_USER_IDS) {
      const open = data.issues.filter((i) => i.assigneeId === pm && isOpen(i));
      const milestones = new Set(
        open.map((i) => i.milestoneId).filter((id) => id !== null)
      );
      expect(open.length).toBeGreaterThanOrEqual(5);
      expect(milestones.size).toBeGreaterThanOrEqual(3);
      expect(open.some((i) => i.milestoneId === null)).toBe(true);
    }
  });

  test('open issues without a project exist, including a triage one', () => {
    const loose = data.issues.filter((i) => i.projectId === null);
    expect(loose.length).toBeGreaterThanOrEqual(2);
    for (const issue of loose) expect(isOpen(issue)).toBe(true);
    expect(loose.some((i) => stateType(i) === 'triage')).toBe(true);
  });
});

describe('fixture workspace: integrity and determinism', () => {
  test('ids are unique across every entity', () => {
    const ids = [
      ...data.users,
      ...data.teams,
      ...data.states,
      ...data.initiatives,
      ...data.projects,
      ...data.milestones,
      ...data.issues,
      ...data.relations,
    ].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const identifiers = data.issues.map((i) => i.identifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  test('every foreign id resolves', () => {
    const teams = new Set(data.teams.map((t) => t.id));
    const initiatives = new Set(data.initiatives.map((i) => i.id));
    const projects = new Map(data.projects.map((p) => [p.id, p]));
    const milestones = new Map(data.milestones.map((m) => [m.id, m]));
    const issues = new Set(data.issues.map((i) => i.id));
    for (const state of data.states) expect(teams.has(state.teamId)).toBe(true);
    for (const p of data.projects) {
      if (p.leadId !== null) expect(userById.has(p.leadId)).toBe(true);
      for (const id of p.initiativeIds) expect(initiatives.has(id)).toBe(true);
      for (const id of p.teamIds) expect(teams.has(id)).toBe(true);
    }
    for (const m of data.milestones)
      expect(projects.has(m.projectId)).toBe(true);
    for (const issue of data.issues) {
      expect(teams.has(issue.teamId)).toBe(true);
      expect(stateById.get(issue.stateId)?.teamId).toBe(issue.teamId);
      if (issue.assigneeId !== null)
        expect(userById.has(issue.assigneeId)).toBe(true);
      if (issue.projectId !== null) {
        expect(projects.get(issue.projectId)?.teamIds).toContain(issue.teamId);
      }
      if (issue.milestoneId !== null) {
        expect(milestones.get(issue.milestoneId)?.projectId).toBe(
          issue.projectId ?? ''
        );
      }
    }
    for (const r of data.relations) {
      expect(issues.has(r.blockerId)).toBe(true);
      expect(issues.has(r.blockedId)).toBe(true);
    }
  });

  test('timestamps are consistent and never in the future', () => {
    for (const issue of data.issues) {
      const created = Date.parse(issue.createdAt);
      expect(Date.parse(issue.lastStateChangeAt)).toBeGreaterThanOrEqual(
        created
      );
      expect(Date.parse(issue.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(issue.lastStateChangeAt)
      );
      expect(Date.parse(issue.updatedAt)).toBeLessThan(
        Date.parse(`${TODAY}T00:00:00.000Z`)
      );
      const type = stateType(issue);
      expect(issue.completedAt !== null).toBe(type === 'completed');
      expect(issue.canceledAt !== null).toBe(type === 'canceled');
      if (type === 'started' || type === 'completed')
        expect(issue.startedAt).not.toBeNull();
    }
  });

  test('fictional: Northwind URLs, no names from the real team', () => {
    expect(FIXTURE_WORKSPACE).toEqual({
      id: 'org-northwind',
      name: 'Northwind Labs',
      urlKey: 'northwind',
    });
    expect(data.workspaceId).toBe(FIXTURE_WORKSPACE.id);
    for (const url of [
      ...data.projects.map((p) => p.url),
      ...data.issues.map((i) => i.url),
    ]) {
      expect(url.startsWith('https://linear.app/northwind/')).toBe(true);
    }
    expect(JSON.stringify([data, FIXTURE_MILESTONE_META])).not.toMatch(
      /orion|halo|waggoner|wyat|shanzer/i
    );
  });

  test('deterministic for a date, and dated relative to it', () => {
    expect(createFixtureWorkspace(TODAY)).toEqual(data);
    const later = createFixtureWorkspace('2026-10-31');
    const shift = (a: string | null, b: string | null): number | null =>
      a === null || b === null
        ? null
        : Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
    data.milestones.forEach((m, index) => {
      const shifted = later.milestones[index];
      expect(shifted?.id).toBe(m.id);
      if (m.targetDate !== null)
        expect(shift(m.targetDate, shifted?.targetDate ?? null)).toBe(10);
    });
    expect(
      shift(
        data.issues[0]?.createdAt ?? null,
        later.issues[0]?.createdAt ?? null
      )
    ).toBe(10);
    // Month and year boundaries are handled.
    expect(
      createFixtureWorkspace('2026-12-30').milestones.find(
        (m) => m.id === 'ms-beacon-1'
      )?.targetDate
    ).toBe('2027-01-01');
    expect(() => createFixtureWorkspace('10/21/2026')).toThrow(RangeError);
  });
});

describe('fixture gateway', () => {
  const fixedNow = new Date('2026-10-21T15:30:00.000Z');

  function setup() {
    const store = createFixtureStore(TODAY);
    store.now = () => fixedNow;
    return {
      store,
      app: createFixtureGateway(store, { kind: 'app' }),
      ana: createFixtureGateway(store, { kind: 'user', userId: 'user-ana' }),
    };
  }

  test('whoAmI returns the app user or the given human', async () => {
    const { store, app, ana } = setup();
    expect((await app.whoAmI()).user).toMatchObject({
      id: FIXTURE_APP_USER_ID,
      app: true,
    });
    expect((await ana.whoAmI()).user).toMatchObject({
      id: 'user-ana',
      app: false,
    });
    expect((await ana.whoAmI()).workspace).toEqual(FIXTURE_WORKSPACE);
    const ghost = createFixtureGateway(store, {
      kind: 'user',
      userId: 'user-ghost',
    });
    expect(await caught(ghost.whoAmI())).toMatchObject({
      kind: 'unauthorized',
    });
  });

  test('the plain actor form from architecture §4 works: user id or "app"', async () => {
    const { store } = setup();
    const app = createFixtureGateway(store, 'app');
    const ben = createFixtureGateway(store, 'user-ben');
    expect((await app.whoAmI()).user.id).toBe(FIXTURE_APP_USER_ID);
    expect((await ben.whoAmI()).user.id).toBe('user-ben');
    await app.createComment('iss-eng-12', 'by the app');
    await ben.createComment('iss-eng-12', 'by ben');
    expect(store.comments.map((c) => c.authorId)).toEqual([
      FIXTURE_APP_USER_ID,
      'user-ben',
    ]);
  });

  test('reads are deep copies', async () => {
    const { store, app } = setup();
    const workspace = await app.fetchWorkspace();
    expect(workspace).toEqual(store.data);
    const first = workspace.issues[0];
    if (first !== undefined) first.title = 'mutated';
    const issue = await app.fetchIssue('iss-eng-1');
    if (issue !== null) issue.assigneeId = 'user-ben';
    expect(store.data.issues[0]?.title).not.toBe('mutated');
    expect(
      store.data.issues.find((i) => i.id === 'iss-eng-1')?.assigneeId
    ).toBe('user-chloe');
  });

  test('updateIssue assigns and moves; the state change updates lastStateChangeAt', async () => {
    const { app } = setup();
    const before = await app.fetchIssue('iss-eng-31');
    expect(before?.assigneeId).toBeNull();
    const updated = await app.updateIssue('iss-eng-31', {
      assigneeId: 'user-ana',
      stateId: 'st-eng-todo',
    });
    expect(updated).toMatchObject({
      assigneeId: 'user-ana',
      stateId: 'st-eng-todo',
      updatedAt: fixedNow.toISOString(),
      lastStateChangeAt: fixedNow.toISOString(),
    });
    expect(await app.fetchIssue('iss-eng-31')).toEqual(updated);
    expect(
      (await app.fetchWorkspace()).issues.find((i) => i.id === 'iss-eng-31')
    ).toEqual(updated);
    expect(
      (await app.fetchLastStateChanges(['iss-eng-31', 'nope'])).get(
        'iss-eng-31'
      )
    ).toBe(fixedNow.toISOString());

    // Assigning without a state change keeps lastStateChangeAt.
    const assignedOnly = await app.updateIssue('iss-eng-32', {
      assigneeId: 'user-ana',
    });
    const original = data.issues.find((i) => i.id === 'iss-eng-32');
    expect(assignedOnly.lastStateChangeAt).toBe(
      original?.lastStateChangeAt ?? 'missing'
    );
    expect(assignedOnly.stateId).toBe(original?.stateId ?? 'missing');
    expect(assignedOnly.updatedAt).toBe(fixedNow.toISOString());
  });

  test('updateIssue validates ids', async () => {
    const { app } = setup();
    expect(
      await caught(app.updateIssue('iss-missing', { assigneeId: 'user-ana' }))
    ).toMatchObject({ kind: 'not_found' });
    expect(
      await caught(app.updateIssue('iss-eng-31', { assigneeId: 'user-ghost' }))
    ).toMatchObject({ kind: 'invalid_input' });
    // An OPS state cannot be used on an ENG issue.
    expect(
      await caught(app.updateIssue('iss-eng-31', { stateId: 'st-ops-todo' }))
    ).toMatchObject({ kind: 'invalid_input' });
    expect(await caught(app.updateIssue('iss-eng-31', {}))).toBeInstanceOf(
      LinearApiError
    );
  });

  test('createComment records the author per actor', async () => {
    const { store, app, ana } = setup();
    expect(
      await app.createComment('iss-eng-31', 'Assigned by Milestone Planner')
    ).toEqual({ id: 'comment-1' });
    expect(await ana.createComment('iss-eng-31', 'Thanks')).toEqual({
      id: 'comment-2',
    });
    expect(store.comments).toEqual([
      {
        id: 'comment-1',
        issueId: 'iss-eng-31',
        body: 'Assigned by Milestone Planner',
        authorId: FIXTURE_APP_USER_ID,
        createdAt: fixedNow.toISOString(),
      },
      {
        id: 'comment-2',
        issueId: 'iss-eng-31',
        body: 'Thanks',
        authorId: 'user-ana',
        createdAt: fixedNow.toISOString(),
      },
    ]);
    expect(await caught(app.createComment('iss-missing', 'x'))).toMatchObject({
      kind: 'not_found',
    });
  });

  test('milestone date and project lead writes are visible to later reads', async () => {
    const { app, ana } = setup();
    expect(
      (await ana.updateMilestoneTargetDate('ms-harbor-1', '2026-11-30'))
        .targetDate
    ).toBe('2026-11-30');
    expect((await app.fetchMilestone('ms-harbor-1'))?.targetDate).toBe(
      '2026-11-30'
    );
    expect(
      (await app.fetchProject('proj-harbor'))?.milestones.find(
        (m) => m.id === 'ms-harbor-1'
      )?.targetDate
    ).toBe('2026-11-30');
    await ana.updateMilestoneTargetDate('ms-harbor-1', null);
    expect((await app.fetchMilestone('ms-harbor-1'))?.targetDate).toBeNull();

    expect(
      (await ana.updateProjectLead('proj-delta', 'user-femi')).leadId
    ).toBe('user-femi');
    expect(
      (await app.fetchWorkspace()).projects.find((p) => p.id === 'proj-delta')
        ?.leadId
    ).toBe('user-femi');
    await ana.updateProjectLead('proj-delta', null);
    expect((await app.fetchProject('proj-delta'))?.project.leadId).toBeNull();

    expect(
      await caught(ana.updateMilestoneTargetDate('ms-missing', null))
    ).toMatchObject({ kind: 'not_found' });
    expect(
      await caught(ana.updateMilestoneTargetDate('ms-harbor-1', 'tomorrow'))
    ).toMatchObject({ kind: 'invalid_input' });
    expect(
      await caught(ana.updateProjectLead('proj-missing', null))
    ).toMatchObject({ kind: 'not_found' });
    expect(
      await caught(ana.updateProjectLead('proj-delta', 'user-ghost'))
    ).toMatchObject({ kind: 'invalid_input' });
  });

  test('single reads: relations, users, initiatives, and null for unknown ids', async () => {
    const { app } = setup();
    const relations = await app.fetchIssueRelations('iss-eng-23');
    expect(relations.map((r) => r.id).sort()).toEqual([
      'rel-chain-1',
      'rel-chain-2',
    ]);
    expect((await app.fetchUser('user-hugo'))?.active).toBe(false);
    expect((await app.fetchInitiative('init-growth'))?.name).toBe(
      'Customer growth'
    );
    expect(await app.fetchIssue('nope')).toBeNull();
    expect(await app.fetchProject('nope')).toBeNull();
    expect(await app.fetchMilestone('nope')).toBeNull();
    expect(await app.fetchUser('nope')).toBeNull();
    expect(await app.fetchInitiative('nope')).toBeNull();
    expect(await app.fetchIssueRelations('nope')).toEqual([]);
  });

  test('two stores are isolated', async () => {
    const first = createFixtureStore(TODAY);
    const second = createFixtureStore(TODAY);
    const a = createFixtureGateway(first, { kind: 'app' });
    const b = createFixtureGateway(second, { kind: 'app' });
    await a.updateIssue('iss-eng-12', { assigneeId: 'user-chloe' });
    await a.createComment('iss-eng-12', 'hi');
    expect((await b.fetchIssue('iss-eng-12'))?.assigneeId).toBeNull();
    expect(second.comments).toEqual([]);
    expect((await a.fetchIssue('iss-eng-12'))?.assigneeId).toBe('user-chloe');
  });
});
