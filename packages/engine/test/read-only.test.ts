// Guests are read-only (owner decision 2026-10-22, "Guests limited to read
// only") end to end over the demo workspace: Gus Hart, the fixture's Linear
// guest (Operations only), signs in and reads what Linear lets him see, but
// every engine method that changes something for a person refuses him first
// with read_only — nothing reaches Linear, the mirror, the settings, the run
// log or the audit log — while the same call still works for a member.

import { addDays } from '@better-tracker/core';
import {
  createFixtureStore,
  FIXTURE_APP_USER_ID,
  FIXTURE_GUEST_USER_ID,
  FIXTURE_INSTALLER_USER_ID,
  FIXTURE_WORKSPACE,
  type LinearGateway,
} from '@better-tracker/linear';
import type { Store } from '@better-tracker/store';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  type Actor,
  createEngine,
  type Engine,
  EngineAuthError,
  READ_ONLY_MESSAGE,
  requireWritable,
} from '../src/index';
import {
  actorFor,
  createClock,
  createDemoHarness,
  type DemoHarness,
  fixtureProvider,
  type GatewayWrapper,
  openTestStore,
  recordingChannel,
  recordingLogger,
  rejection,
  TEST_CONFIG,
  WORKSPACE_ID,
} from './helpers';

// Records every Linear write a gateway makes, by actor, so a refused call
// can be shown to have written nothing.
function recordWrites(log: string[]): GatewayWrapper {
  return (gateway, actor): LinearGateway => {
    const who = actor === 'app' ? 'app' : actor.userId;
    return {
      ...gateway,
      updateIssueFields: (id, patch) => {
        log.push(`${who}:updateIssueFields:${id}`);
        return gateway.updateIssueFields(id, patch);
      },
      updateIssue: (id, patch) => {
        log.push(`${who}:updateIssue:${id}`);
        return gateway.updateIssue(id, patch);
      },
      createComment: (id, body) => {
        log.push(`${who}:createComment:${id}`);
        return gateway.createComment(id, body);
      },
      createBlockingRelation: (blocker, blocked) => {
        log.push(`${who}:createBlockingRelation:${blocker}>${blocked}`);
        return gateway.createBlockingRelation(blocker, blocked);
      },
      deleteRelation: (id) => {
        log.push(`${who}:deleteRelation:${id}`);
        return gateway.deleteRelation(id);
      },
      updateMilestoneTargetDate: (id, date) => {
        log.push(`${who}:updateMilestoneTargetDate:${id}`);
        return gateway.updateMilestoneTargetDate(id, date);
      },
      updateProjectLead: (id, leadId) => {
        log.push(`${who}:updateProjectLead:${id}`);
        return gateway.updateProjectLead(id, leadId);
      },
    };
  };
}

async function refusedReadOnly(promise: Promise<unknown>): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(EngineAuthError);
  expect(error).toMatchObject({
    code: 'read_only',
    message: READ_ONLY_MESSAGE,
  });
}

let h: DemoHarness;
let writes: string[];
let gus: Actor;
let member: Actor;

beforeAll(async () => {
  writes = [];
  h = await createDemoHarness({ wrap: recordWrites(writes) });
  gus = await actorFor(h, FIXTURE_GUEST_USER_ID);
  member = await actorFor(h, 'user-elena');
});
afterAll(async () => {
  await h.close();
});

describe('a Linear guest', () => {
  test('signs in read-only: never holds canWriteLinear', () => {
    expect(gus.readOnly).toBe(true);
    // Demo sessions carry write scopes; a guest still may not write.
    expect(gus.session.tokens.scopes).toContain('write');
    expect(gus.canWriteLinear).toBe(false);
    expect(member).toMatchObject({ readOnly: false, canWriteLinear: true });
    expect(() => requireWritable(gus)).toThrow(READ_ONLY_MESSAGE);
    expect(() => requireWritable(member)).not.toThrow();
  });

  test('reads what Linear lets him see, with no edit controls', async () => {
    const seen = (await h.engine.load(WORKSPACE_ID, gus)).snapshot;
    expect(seen.data.teams.map((t) => t.id)).toEqual(['team-ops']);
    expect(seen.issues.has('iss-ops-1')).toBe(true);
    expect(seen.issues.has('iss-eng-12')).toBe(false);
    const timeline = await h.engine.getTimelineView(WORKSPACE_ID, gus);
    expect(timeline.groups.length).toBeGreaterThan(0);
    const week = await h.engine.getWeekView(WORKSPACE_ID, 'user-femi', gus);
    expect(week.userId).toBe('user-femi');
    const detail = await h.engine.getIssueDetail(gus, 'iss-ops-1');
    expect(detail).toMatchObject({ canEdit: false, readOnly: true });
    expect(detail.extra).not.toBeNull();
    // Even a crafted actor that claims write scope is read-only.
    const crafted = { ...gus, canWriteLinear: true };
    expect((await h.engine.getIssueDetail(crafted, 'iss-ops-1')).canEdit).toBe(
      false
    );
    const asMember = await h.engine.getIssueDetail(member, 'iss-ops-1');
    expect(asMember).toMatchObject({ canEdit: true, readOnly: false });
  });

  test('every mutating method refuses him first, and writes nothing', async () => {
    const auditBefore = await h.store.listAudit(WORKSPACE_ID, 100);
    const settingsBefore = await h.engine.getSettings(WORKSPACE_ID);
    const runsBefore = await h.engine.listRuns(WORKSPACE_ID, 100);
    const mirrorBefore = (await h.engine.load(WORKSPACE_ID)).mirrorVersion;
    const date = addDays(h.clock.today(), 9);
    // A crafted actor claiming write scope is refused the same way: the
    // guard reads readOnly, not the scopes.
    for (const actor of [gus, { ...gus, canWriteLinear: true }]) {
      await refusedReadOnly(
        h.engine.setMilestoneTargetDate(actor, 'ms-delta-1', date)
      );
      await refusedReadOnly(
        h.engine.setProjectLead(actor, 'proj-delta', 'user-femi')
      );
      await refusedReadOnly(
        h.engine.setMilestoneWeight(actor, 'ms-delta-1', 4)
      );
      await refusedReadOnly(
        h.engine.setMilestoneDoneMeans(actor, 'ms-delta-1', 'Exports ship.')
      );
      await refusedReadOnly(
        h.engine.updateSettings(actor, { allocationMode: 'live' })
      );
      await refusedReadOnly(
        h.engine.updateIssue(actor, 'iss-ops-1', { priority: 1 })
      );
      await refusedReadOnly(h.engine.addComment(actor, 'iss-ops-1', 'Hello'));
      await refusedReadOnly(
        h.engine.addBlocker(actor, 'iss-ops-5', 'iss-ops-6')
      );
      await refusedReadOnly(h.engine.removeRelation(actor, 'rel-atlas'));
      for (const mode of ['dry_run', 'live'] as const) {
        await refusedReadOnly(
          h.engine.runAllocation({
            workspaceId: WORKSPACE_ID,
            mode,
            trigger: 'manual',
            actor,
          })
        );
      }
      // The digest preview is computed from everyone's digests.
      await refusedReadOnly(
        h.engine.runWarnings({
          workspaceId: WORKSPACE_ID,
          previewOnly: true,
          viewer: actor,
        })
      );
      // Refused before the OAuth exchange (demo mode has none at all).
      await refusedReadOnly(
        h.engine.finishInstall({ code: 'code', codeVerifier: 'v', actor })
      );
    }

    expect(writes).toEqual([]);
    expect(await h.store.listAudit(WORKSPACE_ID, 100)).toEqual(auditBefore);
    expect(await h.engine.getSettings(WORKSPACE_ID)).toEqual(settingsBefore);
    expect(await h.engine.listRuns(WORKSPACE_ID, 100)).toEqual(runsBefore);
    expect((await h.engine.load(WORKSPACE_ID)).mirrorVersion).toBe(
      mirrorBefore
    );
  });
});

describe('a member', () => {
  // The same calls go through for a workspace member (owner decision
  // 2026-10-22: no PM role), each audited under her name.
  test('makes every change the guest was refused', async () => {
    const date = addDays(h.clock.today(), 9);
    await h.engine.setMilestoneTargetDate(member, 'ms-delta-1', date);
    await h.engine.setProjectLead(member, 'proj-delta', 'user-femi');
    await h.engine.setMilestoneWeight(member, 'ms-delta-1', 4);
    await h.engine.setMilestoneDoneMeans(member, 'ms-delta-1', 'Exports ship.');
    const settings = await h.engine.updateSettings(member, {
      allocationMode: 'live',
    });
    expect(settings.allocationMode).toBe('live');
    const updated = await h.engine.updateIssue(member, 'iss-ops-1', {
      priority: 1,
    });
    expect(updated.changed).toEqual(['priority']);
    const comment = await h.engine.addComment(member, 'iss-ops-1', 'Hello');
    expect(comment.id).not.toBe('');
    const relation = await h.engine.addBlocker(
      member,
      'iss-ops-5',
      'iss-ops-6'
    );
    await h.engine.removeRelation(member, relation.id);
    await h.engine.removeRelation(member, 'rel-atlas');
    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'manual',
      actor: member,
    });
    expect(run.startedByUserId).toBe('user-elena');
    const preview = await h.engine.runWarnings({
      workspaceId: WORKSPACE_ID,
      previewOnly: true,
      viewer: member,
    });
    expect(preview.digests.length).toBeGreaterThan(0);

    expect(writes).toEqual([
      'user-elena:updateMilestoneTargetDate:ms-delta-1',
      'user-elena:updateProjectLead:proj-delta',
      'user-elena:updateIssueFields:iss-ops-1',
      'user-elena:createComment:iss-ops-1',
      'user-elena:createBlockingRelation:iss-ops-6>iss-ops-5',
      `user-elena:deleteRelation:${relation.id}`,
      'user-elena:deleteRelation:rel-atlas',
    ]);
    const audit = await h.store.listAudit(WORKSPACE_ID, 100);
    expect(new Set(audit.map((entry) => entry.actorUserId))).toEqual(
      new Set(['user-elena'])
    );
  });

  test("the worker's own jobs are no person's change", async () => {
    // runAllocation with actor null and runWarnings without a viewer are
    // the worker's: no guard applies.
    const run = await h.engine.runAllocation({
      workspaceId: WORKSPACE_ID,
      mode: 'dry_run',
      trigger: 'schedule',
      actor: null,
    });
    expect(run.trigger).toBe('schedule');
    const preview = await h.engine.runWarnings({
      workspaceId: WORKSPACE_ID,
      previewOnly: true,
    });
    expect(preview.workspaceId).toBe(WORKSPACE_ID);
  });
});

// An installed demo workspace whose first sync has not landed: the app's
// installation is saved but nothing is mirrored yet (the minutes right
// after an install, or a first sync that keeps failing). `failSync` makes
// the app's full read of the workspace fail.
async function unsyncedWorkspace(
  options: { failSync?: boolean } = {}
): Promise<{ engine: Engine; store: Store }> {
  const clock = createClock();
  const store = await openTestStore(clock);
  const fixture = createFixtureStore(clock.today());
  fixture.now = clock.now;
  const engine = createEngine({
    store,
    linear: fixtureProvider(fixture, {
      wrap: (gateway, actor) =>
        actor === 'app' && options.failSync === true
          ? {
              ...gateway,
              fetchWorkspace: () => Promise.reject(new Error('Linear is down')),
            }
          : gateway,
    }),
    channel: recordingChannel(),
    logger: recordingLogger().logger,
    config: TEST_CONFIG,
    now: clock.now,
  });
  const at = clock.now().toISOString();
  await store.saveInstallation({
    workspaceId: FIXTURE_WORKSPACE.id,
    workspaceName: FIXTURE_WORKSPACE.name,
    urlKey: FIXTURE_WORKSPACE.urlKey,
    appUserId: FIXTURE_APP_USER_ID,
    installedByUserId: FIXTURE_INSTALLER_USER_ID,
    revokedAt: null,
    tokens: {
      accessToken: 'fixture',
      refreshToken: null,
      expiresAt: null,
      scopes: ['read', 'write'],
    },
    createdAt: at,
    updatedAt: at,
  });
  return { engine, store };
}

async function signedIn(engine: Engine, userId: string): Promise<Actor> {
  const { sessionToken } = await engine.devSignIn(userId);
  const actor = await engine.authenticate(sessionToken);
  if (actor === null) throw new Error(`could not sign in ${userId}`);
  return actor;
}

describe('before the first sync lands', () => {
  // A person the mirror does not know is treated like a guest; with no
  // mirror at all nobody is known, so an installed workspace places people
  // with its first sync before deciding (a guest who signs in right after
  // the install must not get a run in while the mirror is empty).
  test('a guest is still read-only: authenticate places him with the first sync', async () => {
    const { engine, store } = await unsyncedWorkspace();
    try {
      const gus = await signedIn(engine, FIXTURE_GUEST_USER_ID);
      expect(gus).toMatchObject({ readOnly: true, canWriteLinear: false });
      await refusedReadOnly(
        engine.runAllocation({
          workspaceId: WORKSPACE_ID,
          mode: 'dry_run',
          trigger: 'manual',
          actor: gus,
        })
      );
      expect(await engine.listRuns(WORKSPACE_ID, 10)).toEqual([]);
      // A member is placed by the same sync and may change things.
      const elena = await signedIn(engine, 'user-elena');
      expect(elena).toMatchObject({ readOnly: false, canWriteLinear: true });
    } finally {
      await store.close();
    }
  });

  test('when the first sync fails nobody can be placed, so nobody changes anything', async () => {
    const { engine, store } = await unsyncedWorkspace({ failSync: true });
    try {
      for (const userId of [FIXTURE_GUEST_USER_ID, 'user-elena']) {
        const actor = await signedIn(engine, userId);
        expect(actor).toMatchObject({ readOnly: true, canWriteLinear: false });
        await refusedReadOnly(
          engine.runAllocation({
            workspaceId: WORKSPACE_ID,
            mode: 'dry_run',
            trigger: 'manual',
            actor,
          })
        );
      }
      expect(await engine.listRuns(WORKSPACE_ID, 10)).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
