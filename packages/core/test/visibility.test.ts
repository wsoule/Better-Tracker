import { describe, expect, test } from 'bun:test';

import {
  assessWorkspace,
  buildDigests,
  buildIssueList,
  buildIssueListOptions,
  buildTimelineView,
  normalizeIssueListQuery,
  buildWeekView,
  planAllocation,
  planWarnings,
  scopeSeesProject,
  viewerScope,
  visibleDigest,
  visibleSnapshot,
} from '../src/index';
import type { WorkspaceData } from '../src/index';
import {
  day,
  evaluate,
  initiative,
  issue,
  milestone,
  project,
  team,
  TEAM,
  teamStates,
  user,
  workspace,
} from './helpers';

const SEC = 'team-sec';
const SEC_INFRA = 'team-sec-infra';

// Engineering (public), Security (private: Sam and Lead are members) with
// a restricted sub-team, and Contractor Cleo, a guest of Engineering only.
// Orion is an Engineering project in an initiative; Vault is Security's.
function scenario(): WorkspaceData {
  return workspace({
    users: [
      user('lead'),
      user('wyat'),
      user('sam'),
      user('cleo', { guest: true }),
    ],
    teams: [
      team(TEAM, 'ENG', 'Engineering', { memberIds: ['lead', 'cleo'] }),
      team(SEC, 'SEC', 'Security', {
        visibility: 'private',
        memberIds: ['sam', 'lead'],
      }),
      team(SEC_INFRA, 'SEI', 'Security infra', {
        visibility: 'restricted',
        parentId: SEC,
      }),
    ],
    states: [...teamStates(), ...teamStates(SEC), ...teamStates(SEC_INFRA)],
    initiatives: [initiative('init-1')],
    projects: [
      project('orion', { name: 'Orion', initiativeIds: ['init-1'] }),
      project('vault', { name: 'Vault', teamIds: [SEC] }),
    ],
    milestones: [
      milestone('m-orion', 'orion', { targetDate: day(3) }),
      milestone('m-vault', 'vault', { targetDate: day(3) }),
    ],
    issues: [
      issue('eng-1', {
        identifier: 'ENG-1',
        projectId: 'orion',
        milestoneId: 'm-orion',
        assigneeId: 'cleo',
      }),
      issue('sec-1', {
        identifier: 'SEC-1',
        title: 'Rotate the root keys',
        teamId: SEC,
        stateId: `${SEC}:st-todo`,
        projectId: 'vault',
        milestoneId: 'm-vault',
        assigneeId: 'cleo',
      }),
      issue('loose-sec', {
        identifier: 'SEC-2',
        teamId: SEC,
        stateId: `${SEC}:st-todo`,
        assigneeId: 'wyat',
      }),
    ],
    relations: [{ id: 'r1', blockerId: 'sec-1', blockedId: 'eng-1' }],
  });
}

describe('viewerScope', () => {
  test('a member sees public teams, and private ones only as a member', () => {
    const { snapshot } = evaluate(scenario());
    expect([...viewerScope(snapshot, 'wyat').teamIds]).toEqual([TEAM]);
    // Sam is in Security, so its restricted sub-team is visible too.
    expect([...viewerScope(snapshot, 'sam').teamIds].sort()).toEqual(
      [SEC, SEC_INFRA, TEAM].sort()
    );
    expect(viewerScope(snapshot, 'sam').everything).toBe(true);
    expect(viewerScope(snapshot, 'wyat').everything).toBe(false);
  });

  test('a guest sees only the teams they belong to; an unknown user nothing', () => {
    const { snapshot } = evaluate(scenario());
    const cleo = viewerScope(snapshot, 'cleo');
    expect(cleo.guest).toBe(true);
    expect([...cleo.teamIds]).toEqual([TEAM]);
    expect([...viewerScope(snapshot, 'nobody').teamIds]).toEqual([]);
  });

  test('a team whose visibility the mirror does not know fails closed', () => {
    const data = scenario();
    data.teams = [
      { id: TEAM, key: 'ENG', name: 'Engineering' },
      ...data.teams.slice(1),
    ];
    const { snapshot } = evaluate(data);
    expect(viewerScope(snapshot, 'wyat').teamIds.has(TEAM)).toBe(false);
  });
});

describe('visibleSnapshot', () => {
  test('a private team: its projects, milestones, issues and relations are left out', () => {
    const { snapshot } = evaluate(scenario());
    const seen = visibleSnapshot(snapshot, viewerScope(snapshot, 'wyat'));
    expect([...seen.projects.keys()]).toEqual(['orion']);
    expect([...seen.milestones.keys()]).toEqual(['m-orion']);
    expect([...seen.issues.keys()]).toEqual(['eng-1']);
    expect(seen.data.relations).toEqual([]);
    expect(seen.blockersOf.get('eng-1')).toBeUndefined();
    expect([...seen.teams.keys()]).toEqual([TEAM]);
    expect(seen.data.states.every((s) => s.teamId === TEAM)).toBe(true);
    // Wyat's own Security issue is not his to see either.
    expect(seen.issuesByAssignee.get('wyat')).toBeUndefined();
    // Members still see initiatives; people stay listed.
    expect(seen.initiatives.has('init-1')).toBe(true);
    expect(seen.users.has('sam')).toBe(true);
  });

  test('a guest: only their teams, and no initiatives', () => {
    const { snapshot } = evaluate(scenario());
    const seen = visibleSnapshot(snapshot, viewerScope(snapshot, 'cleo'));
    expect([...seen.issues.keys()]).toEqual(['eng-1']);
    expect(seen.initiatives.size).toBe(0);
    expect(seen.projects.get('orion')?.initiativeIds).toEqual([]);
  });

  test('someone who sees everything gets the very same snapshot', () => {
    const { snapshot } = evaluate(scenario());
    expect(visibleSnapshot(snapshot, viewerScope(snapshot, 'sam'))).toBe(
      snapshot
    );
  });

  test("views built on it never show what the viewer can't see", () => {
    const evaluated = evaluate(scenario());
    const seen = visibleSnapshot(
      evaluated.snapshot,
      viewerScope(evaluated.snapshot, 'cleo')
    );
    const ctx = evaluated.ctx;
    const week = buildWeekView({
      snapshot: seen,
      ctx,
      assessments: evaluate(scenario()).assessments,
      userId: 'cleo',
      recentAllocations: [],
    });
    const listed = week.sections.flatMap((s) => s.rows.map((r) => r.issueId));
    expect(listed).toEqual(['eng-1']);
    const timeline = buildTimelineView({
      snapshot: seen,
      ctx,
      assessments: evaluated.assessments,
      allocationPlan: planAllocation(seen, ctx, evaluated.assessments),
    });
    const lanes = timeline.groups.flatMap((g) =>
      g.lanes.map((l) => l.projectId)
    );
    expect(lanes).toEqual(['orion']);
  });
});

describe('the issue list follows visibility', () => {
  // The list and its options as `userId` gets them: built from the
  // narrowed snapshot, assessed over it, as the engine's load() does.
  function listFor(userId: string, rawQuery: unknown = {}) {
    const evaluated = evaluate(scenario());
    const seen = visibleSnapshot(
      evaluated.snapshot,
      viewerScope(evaluated.snapshot, userId)
    );
    const assessments = assessWorkspace(seen, evaluated.ctx);
    return {
      view: buildIssueList({
        snapshot: seen,
        ctx: evaluated.ctx,
        assessments,
        allocationPlan: planAllocation(seen, evaluated.ctx, assessments),
        query: normalizeIssueListQuery(rawQuery),
        viewerId: userId,
      }),
      options: buildIssueListOptions(seen, evaluated.ctx, assessments),
    };
  }

  test('someone who sees every team gets every issue', () => {
    const { view, options } = listFor('sam');
    expect(view.total).toBe(3);
    expect(view.counts.blocked).toBe(1);
    expect(options.projects.map((p) => p.id)).toEqual(['orion', 'vault']);
  });

  test('a member outside a private team: nothing of it in rows, counts, flags, refs or options', () => {
    const { view, options } = listFor('wyat', {
      filters: { assigneeIds: ['me'] },
    });
    // Wyat's own Security issue is hidden from him, so "mine" is empty.
    expect(view.total).toBe(0);
    expect(view.counts).toEqual({
      all: 1,
      mine: 0,
      unplanned: 0,
      unassigned: 0,
      blocked: 0,
      // Orion's milestone is due in 3 days with all its work open.
      at_risk: 1,
    });
    const all = listFor('wyat').view;
    const row = all.sections[0]?.groups[0]?.rows[0];
    expect(row?.identifier).toBe('ENG-1');
    // The blocker sits in the private team: not counted.
    expect(row?.blockedBy).toBe(0);
    expect(Object.keys(all.refs.projects)).toEqual(['orion']);
    expect(Object.keys(all.refs.teams)).toEqual([TEAM]);
    expect(options.projects.map((p) => p.id)).toEqual(['orion']);
    expect(options.teams.map((t) => t.id)).toEqual([TEAM]);
    expect(options.initiatives.map((i) => i.id)).toEqual(['init-1']);
    const text = JSON.stringify([all, options]);
    expect(text).not.toContain('vault');
    expect(text).not.toContain('Rotate the root keys');
    expect(text).not.toContain('SEC-');
  });

  test("naming another team's milestone gives no header, name, count or progress", () => {
    const { view } = listFor('wyat', {
      filters: { milestoneIds: ['m-vault'] },
    });
    expect(view.sections).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.unknownIds).toEqual([{ facet: 'milestone', id: 'm-vault' }]);
    expect(view.refs.milestones).toEqual({});
    // An unknown id gets exactly the same answer.
    const unknown = listFor('wyat', { filters: { milestoneIds: ['m-none'] } });
    expect(unknown.view.unknownIds).toEqual([
      { facet: 'milestone', id: 'm-none' },
    ]);
    expect({ ...unknown.view, unknownIds: [] }).toEqual({
      ...view,
      unknownIds: [],
      query: unknown.view.query,
    });
  });

  test('a guest: their teams only, no initiatives, the fallback', () => {
    const { view, options } = listFor('cleo', {
      filters: { initiativeIds: ['init-1'] },
      group: 'initiative',
    });
    expect(view.fallback).toEqual({ reason: 'no_initiatives' });
    expect(view.query.group).toBe('project');
    expect(view.total).toBe(1);
    expect(view.refs.initiatives).toEqual({});
    expect(view.refs.projects['orion']?.homeInitiativeId).toBeNull();
    expect(options.initiatives).toEqual([]);
    expect(options.projects.map((p) => p.id)).toEqual(['orion']);
    expect(JSON.stringify([view, options])).not.toContain('vault');
  });

  test("a project shared with a hidden team lists only the viewer's teams", () => {
    const data = scenario();
    data.projects = data.projects.map((p) =>
      p.id === 'orion' ? { ...p, teamIds: [TEAM, SEC] } : p
    );
    const evaluated = evaluate(data);
    const seen = visibleSnapshot(
      evaluated.snapshot,
      viewerScope(evaluated.snapshot, 'wyat')
    );
    // The narrowed snapshot keeps the full list; the options do not.
    expect(seen.projects.get('orion')?.teamIds).toEqual([TEAM, SEC]);
    const options = buildIssueListOptions(
      seen,
      evaluated.ctx,
      assessWorkspace(seen, evaluated.ctx)
    );
    expect(options.projects[0]?.teamIds).toEqual([TEAM]);
  });
});

describe('digests follow visibility', () => {
  test('a watcher is told only about projects they can see, naming only visible issues', () => {
    const data = scenario();
    // Vault (Security) and Orion (Engineering) both at risk, three days out.
    const evaluated = evaluate(data);
    const plan = planWarnings({
      ...evaluated,
      allocationPlan: planAllocation(
        evaluated.snapshot,
        evaluated.ctx,
        evaluated.assessments
      ),
      memory: [],
      watcherUserIds: ['wyat', 'cleo', 'sam'],
    });
    const vault = plan.notices.find((n) => n.subjectId === 'm-vault');
    // Lead and Sam are in Security; Wyat (member, not in Security) and
    // Cleo (guest of Engineering) are not told about Vault.
    expect(vault?.recipientIds).toEqual(['lead', 'sam']);
    const orion = plan.notices.find((n) => n.subjectId === 'm-orion');
    expect(orion?.recipientIds).toEqual(['lead', 'wyat', 'cleo', 'sam']);

    const digests = buildDigests({
      ...evaluated,
      notices: plan.notices,
      appUrl: 'https://x.test',
    });
    const wyat = digests.find((d) => d.recipientId === 'wyat');
    expect(wyat?.items.map((i) => i.notice.subjectId)).toEqual(['m-orion']);
    expect(
      JSON.stringify(digests.find((d) => d.recipientId === 'cleo'))
    ).not.toContain('SEC-1');
  });

  test('visibleDigest drops hidden projects and hidden issue names (the preview)', () => {
    const data = scenario();
    // A mixed project: Orion also belongs to Security, and holds SEC-1.
    const orion = project('orion', { name: 'Orion', teamIds: [TEAM, SEC] });
    data.projects = [orion, ...data.projects.slice(1)];
    data.issues = data.issues.map((i) =>
      i.id === 'sec-1'
        ? { ...i, projectId: 'orion', milestoneId: 'm-orion' }
        : i
    );
    const evaluated = evaluate(data);
    const plan = planWarnings({
      ...evaluated,
      allocationPlan: planAllocation(
        evaluated.snapshot,
        evaluated.ctx,
        evaluated.assessments
      ),
      memory: [],
      watcherUserIds: ['sam'],
    });
    const [samDigest] = buildDigests({
      ...evaluated,
      notices: plan.notices,
      appUrl: 'https://x.test',
    }).filter((d) => d.recipientId === 'sam');
    if (samDigest === undefined) throw new Error('Sam got no digest');
    const orionItem = samDigest.items.find(
      (i) => i.notice.subjectId === 'm-orion'
    );
    expect(orionItem?.openIssues?.map((i) => i.identifier).sort()).toEqual([
      'ENG-1',
      'SEC-1',
    ]);
    // Previewed by Wyat: Orion stays, SEC-1 is not named; Vault is gone.
    const asWyat = visibleDigest(
      evaluated.snapshot,
      viewerScope(evaluated.snapshot, 'wyat'),
      samDigest
    );
    expect(asWyat.items.map((i) => i.notice.subjectId)).toEqual(['m-orion']);
    expect(asWyat.items[0]?.openIssues?.map((i) => i.identifier)).toEqual([
      'ENG-1',
    ]);
    expect(
      scopeSeesProject(viewerScope(evaluated.snapshot, 'wyat'), orion)
    ).toBe(true);
  });
});
