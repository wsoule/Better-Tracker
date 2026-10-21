import { LinearApiError, type LinearGateway } from '@better-tracker/linear';
import { afterEach, describe, expect, test } from 'bun:test';

import type { Engine } from '../src/index';
import {
  createDemoHarness,
  type DemoHarness,
  fixtureIssue,
  type GatewayWrapper,
  WORKSPACE_ID,
  rejection,
} from './helpers';

let harness: DemoHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

let deliveries = 0;
function event(
  type: string,
  action: string,
  entityId: string | null,
  deliveryId: string | null = `delivery-${++deliveries}`
): Parameters<Engine['handleWebhook']>[0] {
  return {
    deliveryId,
    workspaceId: WORKSPACE_ID,
    type,
    action,
    entityId,
    updatedFrom: null,
  };
}

async function snapshot(h: DemoHarness) {
  return (await h.engine.load(WORKSPACE_ID)).snapshot;
}

async function linearHarness(wrap?: GatewayWrapper): Promise<DemoHarness> {
  harness = await createDemoHarness({ mode: 'linear', wrap });
  return harness;
}

describe('issue events', () => {
  test('an update refetches the issue and patches the mirror; a redelivery is a duplicate', async () => {
    const h = await linearHarness();
    const issue = fixtureIssue(h.fixture, 'iss-eng-12');
    issue.assigneeId = 'user-dev';
    issue.title = 'Reconcile drift (renamed)';
    const versionBefore = (await h.engine.load(WORKSPACE_ID)).mirrorVersion;

    const first = event('Issue', 'update', 'iss-eng-12', 'delivery-fixed');
    expect(await h.engine.handleWebhook(first)).toBe('processed');
    const after = await h.engine.load(WORKSPACE_ID);
    expect(after.mirrorVersion).toBeGreaterThan(versionBefore);
    expect(after.snapshot.issues.get('iss-eng-12')).toMatchObject({
      assigneeId: 'user-dev',
      title: 'Reconcile drift (renamed)',
    });
    expect(after.syncState?.lastWebhookAt).toBe(h.clock.now().toISOString());

    // Linear retries the same delivery: nothing is processed again.
    issue.title = 'Changed again';
    expect(await h.engine.handleWebhook(first)).toBe('duplicate');
    expect((await snapshot(h)).issues.get('iss-eng-12')?.title).toBe(
      'Reconcile drift (renamed)'
    );
  });

  test('replaces every relation touching the issue', async () => {
    const h = await linearHarness();
    h.fixture.data.relations = h.fixture.data.relations.filter(
      (r) => r.id !== 'rel-chain-1'
    );
    h.fixture.data.relations.push({
      id: 'rel-new',
      blockerId: 'iss-eng-13',
      blockedId: 'iss-eng-12',
    });
    expect(
      await h.engine.handleWebhook(event('Issue', 'update', 'iss-eng-12'))
    ).toBe('processed');
    const relations = (await snapshot(h)).data.relations
      .map((r) => r.id)
      .sort();
    expect(relations).toContain('rel-new');
    expect(relations).not.toContain('rel-chain-1');
    expect(relations).toContain('rel-chain-2'); // does not touch ENG-12
    expect(relations).toHaveLength(6);
  });

  test('remove deletes the issue and its relations', async () => {
    const h = await linearHarness();
    expect(
      await h.engine.handleWebhook(event('Issue', 'remove', 'iss-eng-23'))
    ).toBe('processed');
    const s = await snapshot(h);
    expect(s.issues.has('iss-eng-23')).toBe(false);
    expect(s.data.relations.map((r) => r.id)).not.toContain('rel-chain-1');
    expect(s.data.relations.map((r) => r.id)).not.toContain('rel-chain-2');
  });

  test('an update whose refetch is null (archived) deletes the issue', async () => {
    const h = await linearHarness();
    h.fixture.data.issues = h.fixture.data.issues.filter(
      (i) => i.id !== 'iss-eng-31'
    );
    expect(
      await h.engine.handleWebhook(event('Issue', 'update', 'iss-eng-31'))
    ).toBe('processed');
    expect((await snapshot(h)).issues.has('iss-eng-31')).toBe(false);
  });

  test('an issue in a milestone the mirror lacks pulls in its project', async () => {
    const h = await linearHarness();
    h.fixture.data.milestones.push({
      id: 'ms-atlas-4',
      projectId: 'proj-atlas',
      name: 'Decommission',
      description: null,
      targetDate: null,
      sortOrder: 4,
    });
    fixtureIssue(h.fixture, 'iss-eng-17').milestoneId = 'ms-atlas-4';
    expect(
      await h.engine.handleWebhook(event('Issue', 'create', 'iss-eng-17'))
    ).toBe('processed');
    const s = await snapshot(h);
    expect(s.milestones.get('ms-atlas-4')?.name).toBe('Decommission');
    expect(s.issues.get('iss-eng-17')?.milestoneId).toBe('ms-atlas-4');
  });

  test('a closed issue without a project leaves the mirror', async () => {
    const h = await linearHarness();
    fixtureIssue(h.fixture, 'iss-eng-80').stateId = 'st-eng-done';
    await h.engine.handleWebhook(event('Issue', 'update', 'iss-eng-80'));
    expect((await snapshot(h)).issues.has('iss-eng-80')).toBe(false);
  });
});

describe('project, initiative and user events', () => {
  test('a project update upserts it with its milestones and drops vanished ones', async () => {
    const h = await linearHarness();
    h.fixture.data.milestones = h.fixture.data.milestones.filter(
      (m) => m.id !== 'ms-compass-3'
    );
    const project = h.fixture.data.projects.find(
      (p) => p.id === 'proj-compass'
    );
    if (project === undefined) throw new Error('fixture changed');
    project.name = 'Compass onboarding v2';
    const target = h.fixture.data.milestones.find(
      (m) => m.id === 'ms-compass-2'
    );
    if (target !== undefined) target.targetDate = '2027-01-15';

    expect(
      await h.engine.handleWebhook(event('Project', 'update', 'proj-compass'))
    ).toBe('processed');
    const s = await snapshot(h);
    expect(s.projects.get('proj-compass')?.name).toBe('Compass onboarding v2');
    expect(s.milestones.has('ms-compass-3')).toBe(false);
    expect(s.milestones.get('ms-compass-2')?.targetDate).toBe('2027-01-15');
    expect(s.milestones.has('ms-compass-1')).toBe(true);
  });

  test('a removed or completed project leaves with its milestones and issues', async () => {
    const h = await linearHarness();
    expect(
      await h.engine.handleWebhook(event('Project', 'remove', 'proj-garnet'))
    ).toBe('processed');
    let s = await snapshot(h);
    expect(s.projects.has('proj-garnet')).toBe(false);
    expect(s.milestones.has('ms-garnet-1')).toBe(false);
    expect(s.issues.has('iss-eng-50')).toBe(false);

    const juniper = h.fixture.data.projects.find(
      (p) => p.id === 'proj-juniper'
    );
    if (juniper === undefined) throw new Error('fixture changed');
    juniper.statusType = 'completed';
    await h.engine.handleWebhook(event('Project', 'update', 'proj-juniper'));
    s = await snapshot(h);
    expect(s.projects.has('proj-juniper')).toBe(false);
    expect(s.milestones.has('ms-juniper-1')).toBe(false);
  });

  test('initiatives and users are refetched or deleted', async () => {
    const h = await linearHarness();
    const user = h.fixture.data.users.find((u) => u.id === 'user-grace');
    if (user === undefined) throw new Error('fixture changed');
    user.active = false;
    await h.engine.handleWebhook(event('User', 'update', 'user-grace'));
    expect((await snapshot(h)).users.get('user-grace')?.active).toBe(false);

    const initiative = h.fixture.data.initiatives.find(
      (i) => i.id === 'init-growth'
    );
    if (initiative === undefined) throw new Error('fixture changed');
    initiative.name = 'Growth 2027';
    await h.engine.handleWebhook(event('Initiative', 'update', 'init-growth'));
    expect((await snapshot(h)).initiatives.get('init-growth')?.name).toBe(
      'Growth 2027'
    );

    await h.engine.handleWebhook(event('Initiative', 'remove', 'init-growth'));
    expect((await snapshot(h)).initiatives.has('init-growth')).toBe(false);
  });
});

describe('other events', () => {
  test('unknown types and entity-less events are ignored', async () => {
    const h = await linearHarness();
    const version = (await h.engine.load(WORKSPACE_ID)).mirrorVersion;
    expect(
      await h.engine.handleWebhook(event('Comment', 'create', 'c-1'))
    ).toBe('ignored');
    expect(await h.engine.handleWebhook(event('Cycle', 'update', 'cy-1'))).toBe(
      'ignored'
    );
    expect(await h.engine.handleWebhook(event('Issue', 'update', null))).toBe(
      'ignored'
    );
    expect(
      await h.engine.handleWebhook(event('OAuthAuthorization', 'revoked', null))
    ).toBe('ignored');
    expect((await h.engine.load(WORKSPACE_ID)).mirrorVersion).toBe(version);
  });

  test('removing something the mirror never had changes nothing', async () => {
    const h = await linearHarness();
    const version = (await h.engine.load(WORKSPACE_ID)).mirrorVersion;
    expect(
      await h.engine.handleWebhook(event('Issue', 'remove', 'iss-private-1'))
    ).toBe('processed');
    expect(
      await h.engine.handleWebhook(event('User', 'remove', 'user-unknown'))
    ).toBe('processed');
    expect((await h.engine.load(WORKSPACE_ID)).mirrorVersion).toBe(version);
  });

  test('OAuthApp revoked marks the installation revoked', async () => {
    const h = await linearHarness();
    expect(
      await h.engine.handleWebhook(event('OAuthApp', 'revoked', null))
    ).toBe('processed');
    const installation = await h.engine.getInstallation(WORKSPACE_ID);
    expect(installation?.revokedAt).toBe(h.clock.now().toISOString());
    expect(await h.engine.listWorkspaceIds()).toEqual([]);
    expect(await rejection(h.engine.load(WORKSPACE_ID))).toMatchObject({
      name: 'EngineAuthError',
      code: 'not_installed',
    });
    expect(
      h.logs.some(
        (l) =>
          l.includes('"level":"error"') && l.includes('must be reinstalled')
      )
    ).toBe(true);
  });

  test('processing errors are recorded and logged, never thrown', async () => {
    let broken = false;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchIssue: (id) =>
        broken
          ? Promise.reject(new LinearApiError('server', 'Linear 502'))
          : gateway.fetchIssue(id),
    });
    const h = await linearHarness(wrap);
    broken = true;
    const version = (await h.engine.load(WORKSPACE_ID)).mirrorVersion;
    expect(
      await h.engine.handleWebhook(
        event('Issue', 'update', 'iss-eng-12', 'delivery-err')
      )
    ).toBe('processed');
    expect((await h.engine.load(WORKSPACE_ID)).mirrorVersion).toBe(version);
    const failure = h.logs.find((l) => l.includes('webhook processing failed'));
    expect(failure).toContain('Linear 502');
    expect(failure).toContain('"deliveryId":"delivery-err"');
    expect(failure).toContain(`"workspaceId":"${WORKSPACE_ID}"`);
    // The delivery stays recorded: a retry is a duplicate.
    expect(
      await h.engine.handleWebhook(
        event('Issue', 'update', 'iss-eng-12', 'delivery-err')
      )
    ).toBe('duplicate');
  });

  test('a delivery without an id is processed without dedupe', async () => {
    const h = await linearHarness();
    fixtureIssue(h.fixture, 'iss-eng-13').priority = 1;
    expect(
      await h.engine.handleWebhook(event('Issue', 'update', 'iss-eng-13', null))
    ).toBe('processed');
    expect((await snapshot(h)).issues.get('iss-eng-13')?.priority).toBe(1);
  });
  test('a blank delivery id is no id: later deliveries are not dropped', async () => {
    const h = await linearHarness();
    fixtureIssue(h.fixture, 'iss-eng-13').priority = 1;
    expect(
      await h.engine.handleWebhook(event('Issue', 'update', 'iss-eng-13', ''))
    ).toBe('processed');
    for (const priority of [2, 3] as const) {
      fixtureIssue(h.fixture, 'iss-eng-13').priority = priority;
      expect(
        await h.engine.handleWebhook(event('Issue', 'update', 'iss-eng-13', ''))
      ).toBe('processed');
      expect((await snapshot(h)).issues.get('iss-eng-13')?.priority).toBe(
        priority
      );
    }
  });
});
