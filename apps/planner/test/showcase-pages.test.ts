import type { GraphScope } from '@better-tracker/core';
import {
  type Actor,
  createEngineFromEnv,
  type Engine,
} from '@better-tracker/engine';
import { SHOWCASE_CRITICAL_PATH } from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { buildGraphPage, parseGraphParams } from '../lib/adapters/graph';
import { buildProjectsPage } from '../lib/adapters/projects';
import { statusRows } from '../lib/adapters/settings';
import { buildTimelinePage } from '../lib/adapters/timeline';
import {
  buildWeekPage,
  localHour,
  noMilestoneIssueProjects,
} from '../lib/adapters/week';

// The showcase demo workspace (LINEAR_FIXTURE=showcase, for the live
// demo) through the same engine calls and adapters the pages use: /graph
// at every level and inside every container kind, /timeline, /projects and
// /week, for a member and for the read-only guest. Each page's model must
// build without error, draw (never "Too many to draw") with a layout and
// Mermaid text, and stay fast: the server time per page is measured.

const WORKSPACE = 'org-northwind';
/** Generous per-page budget for the model on a shared CI machine. */
const PAGE_BUDGET_MS = 5_000;

let engine: Engine;
let member: Actor;
let guest: Actor;
const timings: string[] = [];

beforeAll(async () => {
  engine = await createEngineFromEnv(
    { LINEAR_FIXTURE: 'showcase', APP_URL: 'http://localhost:3000' },
    { logger: createLogger({ name: 'test', level: 'error' }) }
  );
  const chloe = await engine.devSignIn('user-chloe');
  const gus = await engine.devSignIn('user-gus');
  member = (await engine.authenticate(chloe.sessionToken)) as Actor;
  guest = (await engine.authenticate(gus.sessionToken)) as Actor;
});

afterAll(async () => {
  // One line of server times, for the record (bun prints it with the run).
  console.log(`showcase page models (ms): ${timings.join(', ')}`);
  await engine.close();
});

// Times one page's server work: its engine reads and its model.
async function timed<T>(label: string, body: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await body();
  const ms = performance.now() - started;
  timings.push(`${label} ${Math.round(ms)}`);
  expect(ms).toBeLessThan(PAGE_BUDGET_MS);
  return result;
}

// What /graph does for a scope (app/(app)/graph/page.tsx), with the
// ?issue= slide-over open when `issueKey` is given.
async function graphPage(
  scope: GraphScope,
  actor: Actor = member,
  issueKey: string | null = null
) {
  const [graph, loaded] = await Promise.all([
    engine.getGraph(WORKSPACE, scope, actor),
    engine.load(WORKSPACE, actor),
  ]);
  return buildGraphPage({
    graph,
    snapshot: loaded.snapshot,
    assessments: loaded.assessments,
    allocationPlan: loaded.allocationPlan,
    today: loaded.today,
    issueKey,
    readOnlyReason: actor.readOnlyReason,
  });
}

describe('showcase pages', () => {
  const scopes: [string, GraphScope][] = [
    ['workspace milestones', { level: 'milestone' }],
    ['workspace initiatives', { level: 'initiative' }],
    ['workspace projects', { level: 'project' }],
    ['workspace issues', { level: 'issue' }],
    [
      'enterprise projects',
      { level: 'project', initiativeId: 'init-enterprise' },
    ],
    [
      'enterprise milestones',
      { level: 'milestone', initiativeId: 'init-enterprise' },
    ],
    ['enterprise issues', { level: 'issue', initiativeId: 'init-enterprise' }],
    ['platform issues', { level: 'issue', initiativeId: 'init-platform' }],
    ['insights issues', { level: 'issue', initiativeId: 'init-insights' }],
    ['growth issues', { level: 'issue', initiativeId: 'init-growth' }],
    ['no-initiative issues', { level: 'issue', initiativeId: 'none' }],
    ['lagoon milestones', { level: 'milestone', projectId: 'proj-lagoon' }],
    ['lagoon issues', { level: 'issue', projectId: 'proj-lagoon' }],
    ['ms-plume-2 issues', { level: 'issue', milestoneId: 'ms-plume-2' }],
    ['chain', { level: 'issue', issueId: SHOWCASE_CRITICAL_PATH[5] ?? '' }],
  ];

  for (const [label, scope] of scopes) {
    test(`/graph: ${label} draws`, async () => {
      const model = await timed(label, () => graphPage(scope));
      expect(model.tooLarge).toBeNull();
      expect(model.nodes.length).toBeGreaterThan(1);
      expect(model.edges.length).toBeGreaterThan(0);
      expect(model.layout).not.toBeNull();
      // Mermaid per highlight: one body, each mode's styles.
      expect(model.mermaid?.body ?? '').toStartWith('flowchart LR');
      expect(Object.keys(model.mermaid?.styles ?? {}).sort()).toEqual([
        'critical',
        'risk',
        'status',
      ]);
      // Every box shows its whole sublabel: a milestone keeps its date.
      const sublabels = new Map(model.nodes.map((n) => [n.id, n.sublabel]));
      for (const box of model.layout?.nodes ?? []) {
        expect(box.sublabelLine).toBe(sublabels.get(box.id) ?? '');
      }
    });
  }

  // No highlight moves a box (the island switches modes on its own; the
  // page never reads ?highlight= into the model), and a slide-over opening
  // or closing re-renders the same drawing: each reuses the framed layout
  // of the 406-box issue level instead of laying it out again.
  test('/graph: a highlight switch or a slide-over reuses the layout', async () => {
    const pages = [];
    for (const highlight of [undefined, 'status', 'risk', 'critical']) {
      const { scope } = parseGraphParams({ level: 'issue', highlight });
      pages.push(await graphPage(scope));
    }
    pages.push(await graphPage({ level: 'issue' }, member, 'GRO-40'));
    const [first, ...rest] = pages;
    expect(first?.layout?.clustered).toBe(true);
    for (const page of rest) {
      expect(page.layout).toBe(first?.layout ?? null);
      expect(page.nodes).toEqual(first?.nodes ?? []);
      expect(page.clusters).toEqual(first?.clusters ?? []);
    }
  });

  test('/graph for the guest: his projects, with the guest notice', async () => {
    const model = await timed('guest initiatives', () =>
      graphPage({ level: 'initiative' }, guest)
    );
    expect(model.level).toBe('project');
    expect(model.notices.length).toBeGreaterThan(0);
    const issues = await timed('guest issues', () =>
      graphPage({ level: 'issue' }, guest)
    );
    expect(issues.tooLarge).toBeNull();
    expect(issues.edges.length).toBeGreaterThan(20);
  });

  test('/timeline: every initiative group, dependencies and banners', async () => {
    const page = await timed('timeline', async () => {
      const [view, graph, loaded] = await Promise.all([
        engine.getTimelineView(WORKSPACE, member),
        engine.getGraph(WORKSPACE, { level: 'milestone' }, member),
        engine.load(WORKSPACE, member),
      ]);
      return buildTimelinePage({
        view,
        graph,
        permissions: {
          canWriteLinear: member.canWriteLinear,
          readOnly: member.readOnly,
        },
        issues: loaded.snapshot.issues,
      });
    });
    expect(page.groups).toHaveLength(5);
    expect(page.groups.flatMap((g) => g.lanes).length).toBe(21);
    expect(page.dependencies.length).toBeGreaterThan(20);
  });

  test('/projects: every project in its group', async () => {
    const page = await timed('projects', async () => {
      const [timeline, loaded] = await Promise.all([
        engine.getTimelineView(WORKSPACE, member),
        engine.load(WORKSPACE, member),
      ]);
      return buildProjectsPage({
        timeline,
        statusNames: new Map(
          [...loaded.snapshot.projects.values()].map((p) => [
            p.id,
            p.statusName,
          ])
        ),
      });
    });
    expect(page.groups.flatMap((g) => g.rows).length).toBe(21);
  });

  test('Settings → Status names the showcase and its LINEAR_FIXTURE value', async () => {
    const loaded = await engine.load(WORKSPACE, member);
    const installation = await engine.getInstallation(WORKSPACE);
    const source = (demoWorkspace: 'base' | 'showcase' | null) =>
      statusRows({
        installation,
        syncState: loaded.syncState,
        users: loaded.snapshot.users,
        timeZone: 'UTC',
        demo: true,
        demoWorkspace,
      }).find((row) => row.id === 'source');
    expect(source('showcase')).toMatchObject({
      value: 'Showcase demo workspace',
      sub: 'LINEAR_FIXTURE=showcase · nothing reaches Linear',
    });
    expect(source('base')).toMatchObject({
      value: 'Demo workspace',
      sub: 'LINEAR_FIXTURE=1 · nothing reaches Linear',
    });
  });

  test("/week: Chloe's week is full", async () => {
    const page = await timed('week', async () => {
      const [week, timeline, loaded] = await Promise.all([
        engine.getWeekView(WORKSPACE, 'user-chloe', member),
        engine.getTimelineView(WORKSPACE, member),
        engine.load(WORKSPACE, member),
      ]);
      return buildWeekPage({
        week,
        timeline,
        viewerId: 'user-chloe',
        hour: localHour(engine.now(), loaded.settings.timezone),
        newBadgeDays: loaded.settings.tuning.newBadgeDays,
        issueProjects: noMilestoneIssueProjects(
          week,
          loaded.snapshot.issues,
          loaded.snapshot.projects
        ),
      });
    });
    expect(page.isSelf).toBe(true);
    expect(page.stats.length).toBeGreaterThan(0);
  });
});
