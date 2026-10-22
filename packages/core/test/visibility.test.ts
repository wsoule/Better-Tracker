import { describe, expect, test } from 'bun:test';

import {
  assessWorkspace,
  buildDependencyGraph,
  buildDigests,
  buildTimelineView,
  buildWeekView,
  homeInitiativeIds,
  planAllocation,
  planWarnings,
  readinessLabel,
  resolveGraphScope,
  scopeSeesProject,
  viewerScope,
  visibleDigest,
  visibleSnapshot,
} from '../src/index';
import type {
  DependencyGraph,
  GraphScope,
  Snapshot,
  WorkspaceData,
} from '../src/index';
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

describe('graphs follow visibility', () => {
  // The viewer's snapshot, as the engine builds every read from it.
  function seenBy(userId: string): Snapshot {
    const { snapshot } = evaluate(scenario());
    return visibleSnapshot(snapshot, viewerScope(snapshot, userId));
  }

  // The graph of `scope` as `userId` may see it (assessed over what they see).
  function graphFor(userId: string, scope: GraphScope): DependencyGraph {
    const seen = seenBy(userId);
    const { ctx } = evaluate(scenario());
    return buildDependencyGraph(seen, ctx, assessWorkspace(seen, ctx), scope);
  }

  test('a guest: every project is in no initiative', () => {
    expect([...homeInitiativeIds(seenBy('cleo')).entries()]).toEqual([
      ['orion', null],
    ]);
    // Orion is in init-1 for a member.
    expect(homeInitiativeIds(seenBy('wyat')).get('orion')).toBe('init-1');
  });

  test('a guest asking for initiatives gets the workspace, whatever the id', () => {
    const seen = seenBy('cleo');
    for (const initiativeId of ['init-1', 'init-unknown', 'none']) {
      expect(
        resolveGraphScope(seen, { level: 'project', initiativeId })
      ).toEqual({
        ok: true,
        scope: { level: 'project' },
        fallback: {
          reason: 'no_initiatives',
          requested: { level: 'project', initiativeId },
        },
      });
    }
    expect(graphFor('cleo', { level: 'initiative' })).toMatchObject({
      scope: { level: 'project' },
      fallback: { reason: 'no_initiatives' },
    });
  });

  test('a hidden team’s project is never a node, an external or a count', () => {
    // Sam sees Vault blocking Orion; Wyat sees neither the edge nor Vault.
    const all = graphFor('sam', { level: 'project' });
    expect(all.edges.map((e) => [e.from, e.to])).toEqual([['vault', 'orion']]);
    for (const scope of [
      { level: 'project' },
      { level: 'project', initiativeId: 'init-1' },
      { level: 'initiative' },
      { level: 'issue', initiativeId: 'init-1' },
    ] as GraphScope[]) {
      const seen = graphFor('wyat', scope);
      expect(JSON.stringify(seen)).not.toContain('vault');
      expect(JSON.stringify(seen)).not.toContain('sec-1');
      expect(seen.edges).toEqual([]);
      expect(seen.unplacedRelations).toBe(0);
    }
    expect(
      graphFor('wyat', { level: 'initiative' }).nodes.map((n) => [
        n.id,
        n.sublabel,
      ])
    ).toEqual([['init-1', '1 project']]);
    // Its id is unknown to them, exactly like an id that does not exist.
    expect(
      resolveGraphScope(seenBy('wyat'), {
        level: 'milestone',
        projectId: 'vault',
      })
    ).toEqual({
      ok: false,
      problem: 'not_found',
      message: 'That project is not in the mirror.',
    });
  });

  test('readiness counts only blockers the viewer can see', () => {
    // SEC-1 (Vault, Security) blocks ENG-1 (Orion). Wyat cannot see SEC-1,
    // so for him ENG-1 and Orion are free to start; Sam sees the wait.
    const nodeIn = (graph: DependencyGraph, id: string) =>
      graph.nodes.find((n) => n.id === id);
    const orionIssues: GraphScope = { level: 'issue', projectId: 'orion' };
    expect(nodeIn(graphFor('wyat', orionIssues), 'eng-1')).toMatchObject({
      readiness: 'ready',
      blockedBy: 0,
    });
    expect(nodeIn(graphFor('sam', orionIssues), 'eng-1')).toMatchObject({
      readiness: 'blocked',
      blockedBy: 1,
    });
    const wyatOrion = nodeIn(graphFor('wyat', { level: 'project' }), 'orion');
    expect(wyatOrion).toMatchObject({
      readiness: 'ready',
      blockedBy: 0,
      openIssues: 1,
      readyIssues: 1,
    });
    expect(wyatOrion === undefined ? null : readinessLabel(wyatOrion)).toBe(
      'Clear'
    );
    const samProjects = graphFor('sam', { level: 'project' });
    expect(nodeIn(samProjects, 'orion')).toMatchObject({
      readiness: 'blocked',
      blockedBy: 1,
    });
    expect(nodeIn(samProjects, 'vault')?.unblocks).toBe(1);
    for (const scope of [
      orionIssues,
      { level: 'issue', issueId: 'eng-1' },
      { level: 'milestone' },
      { level: 'project' },
    ] as GraphScope[]) {
      const text = JSON.stringify(graphFor('wyat', scope));
      expect(text).not.toContain('vault');
      expect(text).not.toContain('sec-1');
    }
  });
});
