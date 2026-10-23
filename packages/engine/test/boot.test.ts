import type { DependencyGraph, GraphScope } from '@better-tracker/core';
import { LinearApiError as SourceLinearApiError } from '@better-tracker/linear';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Actor,
  createEngineFromEnv,
  type Engine,
  EngineAuthError,
  EngineInputError,
  isLinearApiError,
  LinearApiError,
  loadEngineConfigFromEnv,
} from '../src/index';
import {
  recordingLogger,
  TEST_KEY,
  rejectionMessage,
  rejection,
} from './helpers';

const REAL_ENV = {
  APP_URL: 'https://planner.example.com/',
  TOKEN_ENCRYPTION_KEY: TEST_KEY,
  LINEAR_CLIENT_ID: 'client-id',
  LINEAR_CLIENT_SECRET: 'client-secret',
};

describe('loadEngineConfigFromEnv', () => {
  test('demo mode needs no other variables', () => {
    const config = loadEngineConfigFromEnv({ LINEAR_FIXTURE: '1' });
    expect(config).toEqual({
      auth: 'demo',
      apiKey: null,
      appName: 'Milestone Planner',
      appUrl: 'http://localhost:3000',
      defaultTimezone: 'UTC',
      bootstrapWatcherEmails: [],
      oauth: null,
      sessionDays: 30,
    });
  });

  test('real mode builds OAuth config and normalises values', () => {
    const config = loadEngineConfigFromEnv({
      ...REAL_ENV,
      APP_NAME: 'Planner',
      DEFAULT_TIMEZONE: 'America/Chicago',
      WATCHER_EMAILS:
        ' Wyat@Example.com, shanzer@example.com ,,wyat@example.com',
      SESSION_DAYS: '14',
    });
    expect(config.appUrl).toBe('https://planner.example.com');
    expect(config.oauth).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://planner.example.com/api/auth/linear/callback',
    });
    expect(config.bootstrapWatcherEmails).toEqual([
      'wyat@example.com',
      'shanzer@example.com',
    ]);
    expect(config.defaultTimezone).toBe('America/Chicago');
    expect(config.sessionDays).toBe(14);
    expect(config.appName).toBe('Planner');
  });

  test('reports every problem in one error', () => {
    let message = '';
    try {
      loadEngineConfigFromEnv({
        DEFAULT_TIMEZONE: 'Mars/Olympus',
        SESSION_DAYS: 'forever',
        WATCHER_EMAILS: 'not-an-email',
        LOG_LEVEL: 'loud',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const part of [
      'APP_URL is required',
      'TOKEN_ENCRYPTION_KEY is required',
      'LINEAR_CLIENT_ID is required',
      'LINEAR_CLIENT_SECRET is required',
      'DEFAULT_TIMEZONE is not a known IANA timezone: Mars/Olympus',
      'SESSION_DAYS must be a whole number',
      'WATCHER_EMAILS has an entry that is not an email: not-an-email',
      'LOG_LEVEL must be one of',
    ]) {
      expect(message).toContain(part);
    }
  });

  // The PM list is retired (owner decision 2026-10-22): PM_EMAILS is
  // neither read nor validated, so an old deploy still boots.
  test('ignores the retired PM_EMAILS, even malformed', () => {
    const config = loadEngineConfigFromEnv({
      ...REAL_ENV,
      PM_EMAILS: 'wyat@example.com, not-an-email',
    });
    expect(config).not.toHaveProperty('bootstrapPmEmails');
    expect(config.bootstrapWatcherEmails).toEqual([]);
  });

  test('rejects malformed values that are present', () => {
    expect(() =>
      loadEngineConfigFromEnv({ ...REAL_ENV, APP_URL: 'ftp://x.example' })
    ).toThrow('APP_URL must start with http:// or https://');
    expect(() =>
      loadEngineConfigFromEnv({ ...REAL_ENV, TOKEN_ENCRYPTION_KEY: 'short' })
    ).toThrow('TOKEN_ENCRYPTION_KEY is invalid');
    expect(() =>
      loadEngineConfigFromEnv({ ...REAL_ENV, DATABASE_URL: 'mysql://db' })
    ).toThrow('DATABASE_URL must be a postgres:// connection string');
    expect(() => loadEngineConfigFromEnv({ LINEAR_FIXTURE: 'yes' })).toThrow(
      'LINEAR_FIXTURE must be 1'
    );
  });
});

describe('createEngineFromEnv in demo mode', () => {
  let engine: Engine;
  const { logger, lines } = recordingLogger();

  beforeAll(async () => {
    engine = await createEngineFromEnv({ LINEAR_FIXTURE: '1' }, { logger });
  });
  afterAll(async () => {
    await engine.close();
  });

  test('boots a seeded, synced demo workspace', async () => {
    expect(engine.mode).toBe('fixture');
    expect(engine.config.oauth).toBeNull();
    expect(await engine.listWorkspaceIds()).toEqual(['org-northwind']);

    const loaded = await engine.load('org-northwind');
    expect(loaded.snapshot.projects.size).toBe(9);
    expect(loaded.snapshot.milestones.size).toBe(17);
    expect(loaded.mirrorVersion).toBeGreaterThan(0);
    expect(loaded.syncState?.lastFullSyncStatus).toBe('ok');
    expect(loaded.settings).not.toHaveProperty('pmUserIds');
    expect(loaded.settings.watcherUserIds).toEqual(['user-ana', 'user-ben']);
    expect(
      (await engine.getInstallation('org-northwind'))?.installedByUserId
    ).toBe('user-ana');
    expect(loaded.settings.allocationMode).toBe('dry_run');
    expect(loaded.settings.warningsMode).toBe('preview');
    expect(loaded.assessments.size).toBe(17);
    expect(loaded.allocationPlan.totals.actions).toBe(5);

    // Seeded "done means…" makes ms-compass-1 valid; ms-harbor-1 stays invalid.
    expect(loaded.assessments.get('ms-compass-1')?.rubric.valid).toBe(true);
    expect(loaded.assessments.get('ms-harbor-1')?.rubric.gaps).toEqual([
      'no_done_means',
    ]);

    // A cached load reuses the indexed snapshot object.
    const again = await engine.load('org-northwind');
    expect(again.snapshot).toBe(loaded.snapshot);
  });

  test('every view builds over the demo workspace', async () => {
    const loaded = await engine.load('org-northwind');
    const users = await engine.listDemoUsers();
    expect(users.map((u) => u.id)).toEqual([
      'user-ana',
      'user-ben',
      'user-chloe',
      'user-dev',
      'user-elena',
      'user-femi',
      'user-grace',
      // The demo's Linear guest (read-only, owner decision 2026-10-22).
      'user-gus',
    ]);
    for (const user of users) {
      const week = await engine.getWeekView('org-northwind', user.id);
      expect(week.userId).toBe(user.id);
      expect(week.userName).toBe(user.name);
      expect(week.today).toBe(loaded.today);
    }
    const anaWeek = await engine.getWeekView('org-northwind', 'user-ana');
    expect(anaWeek.sections.at(-1)?.milestoneId).toBeNull();
    expect(anaWeek.totals.open).toBeGreaterThan(0);

    const timeline = await engine.getTimelineView('org-northwind');
    expect(timeline.groups.length).toBeGreaterThan(0);
    expect(
      timeline.banners.projectsWithoutLead.map((p) => p.projectId)
    ).toEqual(['proj-delta']);
    expect(
      timeline.banners.blockedProjects.map((p) => p.projectId).sort()
    ).toEqual(['proj-delta', 'proj-ember', 'proj-harbor']);

    const graph = await engine.getGraph('org-northwind', {
      level: 'milestone',
    });
    expect(graph.nodes.length).toBeGreaterThan(0);
    // Golden captured before the graph levels change (spec §13 commit 1):
    // the workspace milestone edges, in node order, all on a risk chain.
    expect(
      graph.edges.map((e) => [e.from, e.to, e.onRiskChain, e.weight])
    ).toEqual([
      ['ms-atlas-2', 'ms-beacon-1', true, 1],
      ['ms-atlas-2', 'ms-atlas-3', true, 1],
      ['ms-beacon-1', 'ms-juniper-1', true, 1],
    ]);
    const juniper = await engine.getGraph('org-northwind', {
      level: 'issue',
      milestoneId: 'ms-juniper-1',
    });
    expect(juniper.cycles.length).toBe(1);
    const atlas = await engine.getGraph('org-northwind', {
      level: 'issue',
      projectId: 'proj-atlas',
    });
    expect(atlas.nodes.some((n) => n.id === 'iss-eng-12')).toBe(true);

    for (const milestoneId of loaded.snapshot.milestones.keys()) {
      const detail = await engine.getMilestoneDetail(
        'org-northwind',
        milestoneId
      );
      expect(detail.milestone.id).toBe(milestoneId);
    }

    expect(await engine.listRuns('org-northwind', 10)).toEqual([]);
    expect(await engine.listNotifications('org-northwind', 10)).toEqual([]);
    expect(await engine.listAudit('org-northwind', 10)).toEqual([]);
    const installation = await engine.getInstallation('org-northwind');
    expect(installation?.appUserId).toBe('user-app');
    expect(installation?.tokens.accessToken).toBe('');
  });

  test('reads reject unknown ids and scopes', async () => {
    expect(
      await rejection(engine.getMilestoneDetail('org-northwind', 'ms-nope'))
    ).toMatchObject({ name: 'EngineInputError', code: 'not_found' });
    expect(
      await rejection(
        engine.getGraph('org-northwind', {
          level: 'issue',
          projectId: 'proj-nope',
        })
      )
    ).toBeInstanceOf(EngineInputError);
    expect(
      await rejection(engine.getWeekView('org-northwind', 'user-nobody'))
    ).toMatchObject({ code: 'not_found' });
    expect(await rejection(engine.load('org-elsewhere'))).toMatchObject({
      name: 'EngineAuthError',
      code: 'not_installed',
    });
  });

  test('graphs at every level over the demo workspace', async () => {
    const edges = (graph: DependencyGraph) =>
      graph.edges.map((e) => [e.from, e.to, e.onRiskChain, e.inCycle]);

    // Platform reliability → Customer growth (ENG-12 → ENG-23) and back
    // (ENG-23 → OPS-20, Juniper counting under Platform, its first).
    const initiatives = await engine.getGraph('org-northwind', {
      level: 'initiative',
    });
    expect(initiatives.nodes.map((n) => [n.id, n.label])).toEqual([
      ['init-platform', 'Platform reliability'],
      ['init-growth', 'Customer growth'],
      ['none', 'No initiative'],
    ]);
    expect(edges(initiatives)).toEqual([
      ['init-platform', 'init-growth', true, true],
      ['init-growth', 'init-platform', true, true],
    ]);
    expect(initiatives.cycles).toEqual([['init-platform', 'init-growth']]);
    // ENG-70 ⇄ ENG-71 deadlock inside Juniper.
    expect(
      initiatives.nodes.filter((n) => n.holdsCycle).map((n) => n.id)
    ).toEqual(['init-platform']);
    expect(initiatives.fallback).toBeNull();

    const projects = await engine.getGraph('org-northwind', {
      level: 'project',
    });
    expect(
      projects.edges.map((e) => [
        e.from,
        e.to,
        e.onRiskChain,
        e.crossInitiative,
      ])
    ).toEqual([
      ['proj-atlas', 'proj-beacon', true, true],
      ['proj-beacon', 'proj-juniper', true, true],
    ]);
    expect(projects.nodes.find((n) => n.id === 'proj-delta')?.sublabel).toBe(
      'No lead'
    );

    const growth = await engine.getGraph('org-northwind', {
      level: 'project',
      initiativeId: 'init-growth',
    });
    expect(growth.nodes.map((n) => [n.id, n.external])).toEqual([
      ['proj-beacon', false],
      ['proj-compass', false],
      ['proj-ember', false],
      ['proj-atlas', true],
      ['proj-juniper', true],
    ]);

    const atlas = await engine.getGraph('org-northwind', {
      level: 'milestone',
      projectId: 'proj-atlas',
    });
    // Every milestone of the project is drawn (owner decision 2026-10-23),
    // the complete Schema cutover (ms-atlas-1) included, then the one
    // outside milestone on an edge.
    expect(atlas.nodes.map((n) => [n.id, n.external])).toEqual([
      ['ms-atlas-2', false],
      ['ms-atlas-1', false],
      ['ms-atlas-3', false],
      ['ms-beacon-1', true],
    ]);
    expect(atlas.edges.map((e) => [e.from, e.to])).toEqual([
      ['ms-atlas-2', 'ms-atlas-3'],
      ['ms-atlas-2', 'ms-beacon-1'],
    ]);

    // A chain by identifier, in any case: the scope comes back with the id.
    const chain = await engine.getGraph('org-northwind', {
      level: 'issue',
      issueId: 'eng-23',
    });
    expect(chain.scope).toEqual({ level: 'issue', issueId: 'iss-eng-23' });
    expect(chain.nodes.map((n) => [n.id, n.distance])).toEqual([
      ['iss-eng-23', 0],
      ['iss-eng-12', -1],
      ['iss-ops-20', 1],
    ]);
    expect(chain.chain).toEqual({
      focusId: 'iss-eng-23',
      upstream: 1,
      downstream: 1,
      hidden: 0,
    });
    const resolved = await engine.getGraph('org-northwind', {
      level: 'issue',
      issueId: 'iss-eng-26',
    });
    expect(resolved.edges.map((e) => [e.from, e.to, e.resolved])).toEqual([
      ['iss-eng-2', 'iss-eng-26', true],
    ]);
  });

  test('graph scopes are validated against the mirror', async () => {
    for (const [scope, code] of [
      [{ level: 'initiative', initiativeId: 'init-growth' }, 'invalid'],
      [{ level: 'project', projectId: 'proj-atlas' }, 'invalid'],
      [{ level: 'milestone', milestoneId: 'ms-atlas-2' }, 'invalid'],
      [{ level: 'milestone', issueId: 'ENG-23' }, 'invalid'],
      [{ level: 'team' }, 'invalid'],
      [{ level: 'project', initiativeId: 'init-nope' }, 'not_found'],
      [{ level: 'issue', issueId: 'ENG-9999' }, 'not_found'],
    ] as [GraphScope, string][]) {
      expect(
        await rejection(engine.getGraph('org-northwind', scope))
      ).toMatchObject({ name: 'EngineInputError', code });
    }
    // "No initiative" is always a container.
    const none = await engine.getGraph('org-northwind', {
      level: 'project',
      initiativeId: 'none',
    });
    expect(none.nodes.map((n) => n.id)).toEqual(['proj-garnet']);
  });

  test('demo sign-in works for people only, and webhooks are ignored', async () => {
    const signIn = await engine.devSignIn('user-chloe');
    expect(signIn.needsInstall).toBe(false);
    expect(signIn.session.tokens.accessToken).toBe('');
    const actor = await engine.authenticate(signIn.sessionToken);
    // Demo people carry no PM flag: everyone may edit everything.
    expect(actor).not.toHaveProperty('isPm');
    expect(actor?.canWriteLinear).toBe(true);
    expect(actor?.readOnly).toBe(false);
    expect(actor?.session.userId).toBe('user-chloe');

    // The demo's Linear guest signs in too, read-only: demo sessions carry
    // write scopes, but a guest never holds canWriteLinear.
    const guest = await engine.authenticate(
      (await engine.devSignIn('user-gus')).sessionToken
    );
    expect(guest).toMatchObject({ readOnly: true, canWriteLinear: false });

    expect(await rejection(engine.devSignIn('user-app'))).toBeInstanceOf(
      EngineInputError
    );
    expect(await rejection(engine.devSignIn('user-hugo'))).toBeInstanceOf(
      EngineInputError
    );
    expect(await rejection(engine.devSignIn('user-nobody'))).toMatchObject({
      code: 'not_found',
    });

    await engine.signOut(signIn.sessionToken);
    expect(await engine.authenticate(signIn.sessionToken)).toBeNull();
    expect(await engine.authenticate(undefined)).toBeNull();

    expect(
      await engine.handleWebhook({
        deliveryId: 'd-1',
        workspaceId: 'org-northwind',
        type: 'Issue',
        action: 'update',
        entityId: 'iss-eng-12',
        updatedFrom: null,
      })
    ).toBe('ignored');
    expect(() => engine.startOAuth('signin')).toThrow(EngineInputError);
  });

  test('cleanup drops expired sessions and old webhook deliveries', async () => {
    const before = lines.length;
    await engine.cleanup();
    const line = lines
      .slice(before)
      .find((l) => l.includes('"msg":"cleanup finished"'));
    expect(line).toContain('"expiredSessions":0');
    expect(line).toContain('"oldDeliveries":0');
  });

  test('logs carry context and no tokens', () => {
    expect(lines.some((line) => line.includes('"msg":"engine ready"'))).toBe(
      true
    );
    expect(
      lines.some(
        (line) =>
          line.includes('"msg":"full sync finished"') &&
          line.includes('"workspaceId":"org-northwind"')
      )
    ).toBe(true);
    expect(lines.join('\n')).not.toContain(TEST_KEY);
  });
});

describe('demo mode over a persisted PGLITE_DIR', () => {
  test('reboots with a fresh ephemeral key and drops unreadable sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-demo-'));
    const env = { LINEAR_FIXTURE: '1', PGLITE_DIR: join(dir, 'pglite') };
    const { logger } = recordingLogger();
    try {
      const first = await createEngineFromEnv(env, { logger });
      const signIn = await first.devSignIn('user-ana');
      await first.updateSettings(
        (await first.authenticate(signIn.sessionToken)) as Actor,
        { warningsMode: 'live' }
      );
      await first.close();

      const second = await createEngineFromEnv(env, { logger });
      try {
        expect(await second.authenticate(signIn.sessionToken)).toBeNull();
        const loaded = await second.load('org-northwind');
        // Settings someone changed survive; the fixture is re-seeded around today.
        expect(loaded.settings.warningsMode).toBe('live');
        expect(loaded.snapshot.issues.size).toBeGreaterThan(0);
        expect(
          (await second.getInstallation('org-northwind'))?.revokedAt
        ).toBeNull();
        const again = await second.devSignIn('user-ana');
        expect(
          (await second.authenticate(again.sessionToken))?.session.userId
        ).toBe('user-ana');
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createEngineFromEnv in real mode', () => {
  test('requires OAuth settings and migrates the store', async () => {
    expect(await rejectionMessage(createEngineFromEnv({}))).toContain(
      'APP_URL is required'
    );
    const { logger } = recordingLogger();
    const dir = await mkdtemp(join(tmpdir(), 'engine-boot-'));
    const engine = await createEngineFromEnv(
      { ...REAL_ENV, PGLITE_DIR: join(dir, 'pglite') },
      { logger }
    );
    try {
      expect(engine.mode).toBe('linear');
      expect(engine.config.oauth?.redirectUri).toBe(
        'https://planner.example.com/api/auth/linear/callback'
      );
      expect(await engine.listWorkspaceIds()).toEqual([]);
      expect(await rejection(engine.load('org-x'))).toBeInstanceOf(
        EngineAuthError
      );
      expect(await rejection(engine.devSignIn('user-ana'))).toMatchObject({
        code: 'fixture_only',
      });
      expect(await engine.listDemoUsers()).toEqual([]);
      const start = engine.startOAuth('install');
      const url = new URL(start.url);
      expect(url.searchParams.get('actor')).toBe('app');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('scope')).toBe('read,write,initiative:read');
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createEngineFromEnv with the retired PM_EMAILS', () => {
  // Owner decision 2026-10-22: no PM role. A deploy that still sets
  // PM_EMAILS boots as before and is told once that the variable is unused.
  test('boots and logs exactly one warning', async () => {
    const warning = '"msg":"PM_EMAILS is no longer used';
    const quiet = recordingLogger();
    const plain = await createEngineFromEnv(
      { LINEAR_FIXTURE: '1' },
      { logger: quiet.logger }
    );
    await plain.close();
    expect(quiet.lines.some((line) => line.includes(warning))).toBe(false);

    const { logger, lines } = recordingLogger();
    const engine = await createEngineFromEnv(
      { LINEAR_FIXTURE: '1', PM_EMAILS: 'ana@northwind.example, nope' },
      { logger }
    );
    try {
      const warnings = lines.filter((line) => line.includes(warning));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"level":"warn"');
      expect(warnings[0]).toContain('"variable":"PM_EMAILS"');
      expect(warnings[0]).toContain('WATCHER_EMAILS');
      // Nothing about the demo changed: the fixture's watchers, no PM list.
      const settings = await engine.getSettings('org-northwind');
      expect(settings).not.toHaveProperty('pmUserIds');
      expect(settings.watcherUserIds).toEqual(['user-ana', 'user-ben']);
    } finally {
      await engine.close();
    }
  });
});

describe('createEngineFromEnv in real mode: not installed', () => {
  test('the provider names the app like the rest of the engine', async () => {
    const { logger } = recordingLogger();
    const dir = await mkdtemp(join(tmpdir(), 'engine-boot-'));
    const engine = await createEngineFromEnv(
      {
        ...REAL_ENV,
        APP_NAME: 'Acme Planner',
        PGLITE_DIR: join(dir, 'pglite'),
      },
      { logger }
    );
    try {
      expect(await rejectionMessage(engine.fullSync('org-x'))).toBe(
        'Acme Planner is not installed in this Linear workspace yet.'
      );
    } finally {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isLinearApiError', () => {
  test('recognises the class and copies from another bundle', () => {
    expect(LinearApiError).toBe(SourceLinearApiError);
    expect(isLinearApiError(new LinearApiError('network', 'down'))).toBe(true);
    const foreign = Object.assign(new Error('rate limited'), {
      name: 'LinearApiError',
      kind: 'rate_limited',
    });
    expect(isLinearApiError(foreign)).toBe(true);
    expect(isLinearApiError(new Error('plain'))).toBe(false);
    expect(isLinearApiError({ name: 'LinearApiError', kind: 'x' })).toBe(false);
  });
});

describe('createEngineFromEnv in api_key mode', () => {
  test('boots over a keyed store, purges nothing, and warns about unused variables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-apikey-'));
    const pgliteDir = join(dir, 'pglite');
    try {
      // An earlier OAuth deploy left a session and an encrypted install.
      const { openStore } = await import('@better-tracker/store');
      const keyed = await openStore({ pgliteDir, encryptionKey: TEST_KEY });
      await keyed.migrate();
      await keyed.saveInstallation({
        workspaceId: 'org-acme',
        workspaceName: 'Acme',
        urlKey: 'acme',
        appUserId: 'user-app',
        installedByUserId: 'user-ana',
        revokedAt: null,
        tokens: {
          accessToken: 'oauth-access-token',
          refreshToken: 'oauth-refresh-token',
          expiresAt: null,
          scopes: ['read', 'write'],
        },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });
      const session = await keyed.createSession({
        workspaceId: 'org-acme',
        userId: 'user-ana',
        userName: 'Ana',
        tokens: {
          accessToken: 'oauth-user-token',
          refreshToken: null,
          expiresAt: null,
          scopes: ['read'],
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await keyed.close();

      const { logger, lines } = recordingLogger();
      const engine = await createEngineFromEnv(
        {
          LINEAR_AUTH: 'api_key',
          APP_URL: 'http://localhost:3360',
          PGLITE_DIR: pgliteDir,
          TOKEN_ENCRYPTION_KEY: TEST_KEY,
          LINEAR_API_URL: 'http://127.0.0.1:3361/graphql',
        },
        { logger, execArgv: [] }
      );
      try {
        expect(engine.config.auth).toBe('api_key');
        expect(engine.mode).toBe('linear');
        expect(engine.config.apiKey?.endpoint).toBe(
          'http://127.0.0.1:3361/graphql'
        );
        // The credential-free store reads the old installation blank.
        expect(
          (await engine.getInstallation('org-acme'))?.tokens.accessToken
        ).toBe('');
        expect(await engine.authenticate(session.token)).toBeNull();
      } finally {
        await engine.close();
      }
      const warning = lines.find((line) =>
        line.includes('TOKEN_ENCRYPTION_KEY is unused when LINEAR_AUTH=api_key')
      );
      expect(warning).toContain('"level":"warn"');
      const endpoint = lines.find((line) =>
        line.includes('LINEAR_API_URL is set')
      );
      expect(endpoint).toContain('"level":"error"');
      expect(endpoint).toContain('http://127.0.0.1:3361');
      expect(lines.find((line) => line.includes('engine ready'))).toContain(
        '"auth":"api_key"'
      );
      // Not deployed: PGlite is the local default, no warning.
      expect(lines.some((line) => line.includes('on a deployed planner'))).toBe(
        false
      );

      // Both rows are still there for a keyed store (nothing was purged).
      const again = await openStore({ pgliteDir, encryptionKey: TEST_KEY });
      try {
        expect(
          (await again.getInstallation('org-acme'))?.tokens.accessToken
        ).toBe('oauth-access-token');
        expect(
          (await again.getSession(session.token, '2026-10-23T00:00:00.000Z'))
            ?.tokens.accessToken
        ).toBe('oauth-user-token');
      } finally {
        await again.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses inspector flags', async () => {
    expect(
      await rejectionMessage(
        createEngineFromEnv(
          { LINEAR_AUTH: 'api_key', APP_URL: 'http://localhost:3360' },
          { execArgv: ['--inspect'] }
        )
      )
    ).toContain('--inspect is refused when LINEAR_AUTH=api_key');
  });

  test('a deployed planner on PGlite warns that every deploy erases its data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-apikey-deployed-'));
    try {
      const { logger, lines } = recordingLogger();
      const engine = await createEngineFromEnv(
        {
          LINEAR_AUTH: 'api_key',
          APP_URL: 'https://planner.example.com',
          NODE_ENV: 'production',
          LINEAR_WORKSPACE: 'acme',
          NODE_OPTIONS: '--disable-sigusr1',
          PGLITE_DIR: join(dir, 'pglite'),
        },
        { logger, execArgv: [] }
      );
      await engine.close();
      const warning = lines.find((line) =>
        line.includes('on a deployed planner')
      );
      expect(warning).toContain('"level":"warn"');
      expect(warning).toContain('set DATABASE_URL');
      expect(lines.find((line) => line.includes('engine ready'))).toContain(
        '"deployed":true'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
