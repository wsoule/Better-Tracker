// LINEAR_FIXTURE=showcase (architecture §7.1, "Demo mode"): the variable's
// values, and an engine booted over the showcase demo workspace, seeded
// with its "done means…" rows and serving every view and graph level, for
// a member and for the read-only guest. The base demo (LINEAR_FIXTURE=1)
// is covered by boot.test.ts and must not change.

import {
  createShowcaseWorkspace,
  SHOWCASE_CRITICAL_PATH,
} from '@better-tracker/linear';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  type Actor,
  createEngineFromEnv,
  type Engine,
  fixtureDatasetFromEnv,
  isFixtureEnv,
  loadEngineConfigFromEnv,
} from '../src/index';
import { recordingLogger } from './helpers';

const WORKSPACE = 'org-northwind';

describe('LINEAR_FIXTURE values', () => {
  test('1/true pick the base demo, showcase the showcase, 0/false/unset neither', () => {
    const cases: [string | undefined, 'base' | 'showcase' | null][] = [
      ['1', 'base'],
      ['true', 'base'],
      ['TRUE', 'base'],
      ['showcase', 'showcase'],
      [' Showcase ', 'showcase'],
      ['0', null],
      ['false', null],
      ['', null],
      [undefined, null],
      ['yes', null],
    ];
    for (const [value, dataset] of cases) {
      const env = { LINEAR_FIXTURE: value };
      expect(fixtureDatasetFromEnv(env)).toBe(dataset);
      expect(isFixtureEnv(env)).toBe(dataset !== null);
    }
  });

  test('showcase is demo mode: no other variable is needed', () => {
    expect(loadEngineConfigFromEnv({ LINEAR_FIXTURE: 'showcase' })).toEqual(
      loadEngineConfigFromEnv({ LINEAR_FIXTURE: '1' })
    );
  });

  test('anything else is one clear error naming the accepted values', () => {
    expect(() => loadEngineConfigFromEnv({ LINEAR_FIXTURE: 'demo' })).toThrow(
      'LINEAR_FIXTURE must be 1 (demo mode), showcase (demo mode with the larger showcase workspace) or 0'
    );
  });
});

describe('createEngineFromEnv with LINEAR_FIXTURE=showcase', () => {
  let engine: Engine;
  let member: Actor;
  let guest: Actor;
  const { logger, lines } = recordingLogger();
  const bootMs: number[] = [];

  beforeAll(async () => {
    const started = performance.now();
    engine = await createEngineFromEnv(
      { LINEAR_FIXTURE: 'showcase' },
      { logger }
    );
    bootMs.push(performance.now() - started);
    const chloe = await engine.devSignIn('user-chloe');
    const gus = await engine.devSignIn('user-gus');
    member = (await engine.authenticate(chloe.sessionToken)) as Actor;
    guest = (await engine.authenticate(gus.sessionToken)) as Actor;
  });
  afterAll(async () => {
    await engine.close();
  });

  test('boots the showcase, seeded like the base demo', async () => {
    expect(engine.mode).toBe('fixture');
    expect(await engine.listWorkspaceIds()).toEqual([WORKSPACE]);
    const loaded = await engine.load(WORKSPACE);
    const expected = createShowcaseWorkspace(loaded.today);
    expect(loaded.snapshot.projects.size).toBe(expected.projects.length);
    expect(loaded.snapshot.milestones.size).toBe(expected.milestones.length);
    expect(loaded.snapshot.issues.size).toBe(expected.issues.length);
    expect(loaded.snapshot.data.relations).toHaveLength(
      expected.relations.length
    );
    expect(loaded.settings.watcherUserIds).toEqual(['user-ana', 'user-ben']);
    expect((await engine.getInstallation(WORKSPACE))?.installedByUserId).toBe(
      'user-ana'
    );
    expect(loaded.settings.allocationMode).toBe('dry_run');
    // The showcase's own "done means…" and weights were seeded.
    expect(loaded.assessments.get('ms-lagoon-3')?.rubric.valid).toBe(true);
    expect(loaded.assessments.get('ms-willow-1')?.rubric.gaps).toEqual([
      'no_done_means',
    ]);
    expect(loaded.assessments.get('ms-harbor-1')?.rubric.gaps).toEqual([
      'no_done_means',
    ]);
    expect(
      lines.some((line) => line.includes('"demoWorkspace":"showcase"'))
    ).toBe(true);
    // A full demo boot (store, migrations, seeding, the first sync).
    expect(bootMs[0]).toBeLessThan(20_000);
  });

  test('the demo picker lists the grown team, the guest included', async () => {
    const users = await engine.listDemoUsers();
    expect(users.length).toBe(20);
    expect(users.map((u) => u.id)).toContain('user-gus');
    expect(users.map((u) => u.id)).toContain('user-iris');
    expect(users.map((u) => u.id)).not.toContain('user-hugo');
    expect(member.readOnly).toBe(false);
    expect(guest.readOnly).toBe(true);
  });

  test('every view and graph level builds for a member', async () => {
    const week = await engine.getWeekView(WORKSPACE, 'user-chloe', member);
    expect(week.totals.open).toBeGreaterThanOrEqual(10);
    const timeline = await engine.getTimelineView(WORKSPACE, member);
    expect(timeline.groups.map((g) => g.initiativeId)).toEqual([
      'init-platform',
      'init-enterprise',
      'init-insights',
      'init-growth',
      null,
    ]);
    for (const level of [
      'initiative',
      'project',
      'milestone',
      'issue',
    ] as const) {
      const graph = await engine.getGraph(WORKSPACE, { level }, member);
      expect(graph.edges.length).toBeGreaterThan(5);
    }
    const chain = await engine.getGraph(
      WORKSPACE,
      { level: 'issue', issueId: SHOWCASE_CRITICAL_PATH[5] ?? '' },
      member
    );
    expect(chain.chain?.focusId).toBe('iss-eng-240');
    expect(chain.nodes.length).toBeGreaterThan(SHOWCASE_CRITICAL_PATH.length);
  });

  test('the guest sees Operations only, read-only, with no initiatives', async () => {
    const loaded = await engine.load(WORKSPACE, guest);
    expect(loaded.snapshot.initiatives.size).toBe(0);
    for (const issue of loaded.snapshot.issues.values()) {
      expect(issue.teamId).toBe('team-ops');
    }
    const graph = await engine.getGraph(
      WORKSPACE,
      { level: 'initiative' },
      guest
    );
    expect(graph.fallback?.reason).toBe('no_initiatives');
    const issues = await engine.getGraph(WORKSPACE, { level: 'issue' }, guest);
    expect(issues.cycles).toEqual([['iss-ops-55', 'iss-ops-73']]);
  });
});
