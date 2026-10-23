// api_key mode end to end in the engine (architecture §7 "API-key mode",
// spec cases 1–16): connect, binding, the key each call uses, read-only
// keys, runs, the issue page, expiry, the reader gateway, logs failing
// closed, relayed errors, key-shaped text, status, and a leak scan after
// every test. Keys are obviously fake (TESTKEY); nothing calls Linear.

import {
  FIXTURE_WORKSPACE,
  type FetchLike,
  LinearApiError,
} from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';
import { describe, expect, test } from 'bun:test';

import { NOT_FOR_YOUR_KEY_MESSAGE } from '../src/allocation-run';
import { KEY_UNANSWERED_MESSAGE } from '../src/issue-detail';
import {
  createApiKeyLinearProvider,
  GATEWAY_WRITE_METHODS,
  isKeyPermissionRefusal,
} from '../src/key-provider';
import { createKeyVault } from '../src/key-vault';
import { createLinearProvider } from '../src/providers';
import { EngineAuthError, EngineInputError } from '../src/types';
import {
  type ApiKeyHarness,
  callsOf,
  connect,
  createApiKeyHarness,
  fakeKeyGatewayFactory,
  KEY_USERS,
  KEYS,
  leakScan,
  scopeRefusal,
  SECURITY_PROJECT_ID,
  securityIssueIds,
  writesSince,
} from './api-key-harness';
import { actorFor, createDemoHarness, rejection } from './helpers';

const WS = FIXTURE_WORKSPACE.id;
const BEACON_ISSUE = 'iss-eng-23';

async function withHarness(
  options: Parameters<typeof createApiKeyHarness>[0],
  fn: (h: ApiKeyHarness) => Promise<void>
): Promise<void> {
  const h = await createApiKeyHarness(options);
  try {
    await fn(h);
    await leakScan(h);
  } finally {
    await h.close();
  }
}

function code(error: unknown): string | null {
  return error instanceof EngineAuthError || error instanceof EngineInputError
    ? error.code
    : null;
}

describe('api_key mode: connect and binding', () => {
  test('1. the first member binds the workspace, synced before the result', async () => {
    await withHarness({}, async (h) => {
      const result = h.keep(
        await h.engine.connectApiKey({ apiKey: KEYS.member })
      );
      expect(result.syncAfter).toBe(false);
      expect(result.needsInstall).toBe(false);
      expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.session.tokens.accessToken).toBe('');
      expect(result.session.userId).toBe('user-chloe');
      const binding = await h.store.getInstallation(WS);
      expect(binding?.appUserId).toBe('');
      expect(binding?.installedByUserId).toBe('user-chloe');
      expect(binding?.tokens).toEqual({
        accessToken: '',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      });
      expect(callsOf(h, 'member', 'fetchWorkspace').length).toBe(1);
      const actor = h.keep(await h.engine.authenticate(result.sessionToken));
      expect(actor?.readOnly).toBe(false);
      expect(actor?.canWriteLinear).toBe(true);
      expect(actor?.session.tokens.accessToken).toBe('');
      expect(await h.engine.listWorkspaceIds()).toEqual([WS]);
      expect(await h.engine.listRevokedWorkspaceIds()).toEqual([]);
    });
  });

  test('2. each person writes with their own key; the binder reads first', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const ben = h.keep(await h.engine.connectApiKey({ apiKey: KEYS.second }));
      expect(ben.syncAfter).toBe(false);
      h.clock.set(new Date(h.clock.now().getTime() + 61_000).toISOString());
      const again = h.keep(
        await h.engine.connectApiKey({ apiKey: KEYS.second })
      );
      expect(again.syncAfter).toBe(true);
      const benActor = h.keep(await h.engine.authenticate(ben.sessionToken));
      if (benActor === null) throw new Error('ben');

      const before = h.calls.length;
      h.keep(
        await h.engine.updateIssue(benActor, BEACON_ISSUE, {
          title: 'Ben renamed it',
        })
      );
      h.keep(
        await h.engine.addComment(chloe.actor, BEACON_ISSUE, 'Chloe says hi')
      );
      const writes = writesSince(h, before);
      expect(writes.map((w) => [w.key, w.method])).toEqual([
        ['second', 'updateIssueFields'],
        ['member', 'createComment'],
      ]);

      let mark = h.calls.length;
      h.keep(await h.engine.fullSync(WS));
      expect(
        h.calls
          .slice(mark)
          .filter((c) => c.method === 'fetchWorkspace')
          .map((c) => c.key)
      ).toEqual(['member']);
      await h.engine.signOut(chloe.token, { everyDevice: true });
      mark = h.calls.length;
      h.keep(await h.engine.fullSync(WS));
      expect(
        h.calls
          .slice(mark)
          .filter((c) => c.method === 'fetchWorkspace')
          .map((c) => c.key)
      ).toEqual(['second']);
    });
  });

  test('3a. another org is refused without naming the bound one', async () => {
    await withHarness({}, async (h) => {
      await connect(h, 'member');
      const error = await rejection(
        h.engine.connectApiKey({ apiKey: KEYS.otherorg })
      );
      expect(code(error)).toBe('wrong_workspace');
      expect((error as Error).message).not.toContain(FIXTURE_WORKSPACE.name);
    });
  });

  test('3b. a guest cannot bind; with the pin a guest may connect and another org may not', async () => {
    await withHarness({}, async (h) => {
      const error = await rejection(
        h.engine.connectApiKey({ apiKey: KEYS.guest })
      );
      expect(code(error)).toBe('guest_cannot_bind');
      expect(await h.store.listInstallations()).toEqual([]);
    });
    await withHarness({ pin: 'NorthWind' }, async (h) => {
      const result = h.keep(
        await h.engine.connectApiKey({ apiKey: KEYS.guest })
      );
      expect(result.session.userId).toBe('user-gus');
      const binding = await h.store.getInstallation(WS);
      expect(binding?.appUserId).toBe('');
      // A guest is never the binder: the first member to connect is.
      expect(binding?.installedByUserId).toBe('');
      const error = await rejection(
        h.engine.connectApiKey({ apiKey: KEYS.otherorg })
      );
      expect(code(error)).toBe('wrong_workspace');

      const chloe = await connect(h, 'member');
      expect((await h.store.getInstallation(WS))?.installedByUserId).toBe(
        'user-chloe'
      );
      expect((await h.engine.getSettings(WS)).watcherUserIds).toEqual([
        'user-chloe',
      ]);
      const status = h.keep(await h.engine.getKeyConnection(chloe.actor));
      expect(status?.reader?.userId).toBe('user-chloe');
      await connect(h, 'second');
      expect((await h.store.getInstallation(WS))?.installedByUserId).toBe(
        'user-chloe'
      );
    });
  });

  test('3b2. pinned, guest first: the binder reads again once she reconnects, so her private team comes back', async () => {
    await withHarness({ pin: 'northwind' }, async (h) => {
      await connect(h, 'guest');
      const chloe = await connect(h, 'member');
      await connect(h, 'second');
      const secIssue = [...securityIssueIds(h.fixture)][0] ?? '';
      await h.engine.signOut(chloe.token, { everyDevice: true });
      h.keep(await h.engine.fullSync(WS));
      expect((await h.engine.load(WS)).snapshot.issues.has(secIssue)).toBe(
        false
      );
      const back = await connect(h, 'member');
      const mark = h.calls.length;
      h.keep(await h.engine.fullSync(WS));
      expect(
        h.calls
          .slice(mark)
          .filter((c) => c.method === 'fetchWorkspace')
          .map((c) => c.key)
      ).toEqual(['member']);
      expect((await h.engine.load(WS)).snapshot.issues.has(secIssue)).toBe(
        true
      );
      const status = h.keep(await h.engine.getKeyConnection(back.actor));
      expect(status?.reader?.userId).toBe('user-chloe');
    });
  });

  test('3f. a connect that fails after the key is held forgets it again', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      await h.engine.signOut(chloe.token, { everyDevice: true });
      // A database blip right after the binding was saved: reading the
      // mirror (getSyncState) is the first store call after vault.add.
      const store = h.store as unknown as Record<string, unknown>;
      const real = store.getSyncState as (...a: unknown[]) => unknown;
      let failNext = true;
      store.getSyncState = (...args: unknown[]): unknown => {
        if (failNext) {
          failNext = false;
          return Promise.reject(
            new Error('connection terminated unexpectedly')
          );
        }
        return real.apply(h.store, args);
      };
      const error = await rejection(
        h.engine.connectApiKey({ apiKey: KEYS.second })
      );
      expect((error as Error).message).toBe(
        'connection terminated unexpectedly'
      );
      expect(h.logs.join('\n')).toContain(
        'a connect failed after the key was held; forgot it'
      );
      // Nothing holds Ben's key now: no later sync reads with it.
      const mark = h.calls.length;
      expect(code(await rejection(h.engine.fullSync(WS)))).toBe('no_reader');
      h.clock.set(
        new Date(h.clock.now().getTime() + 60 * 60_000).toISOString()
      );
      expect(code(await rejection(h.engine.fullSync(WS)))).toBe('no_reader');
      expect(h.calls.slice(mark)).toEqual([]);
    });
  });

  test('3c. a leftover demo row never becomes the binding', async () => {
    await withHarness({}, async (h) => {
      await h.keyedStore().saveInstallation({
        workspaceId: 'org-demo-leftover',
        workspaceName: 'Demo leftover',
        urlKey: 'demo',
        appUserId: 'user-app',
        installedByUserId: 'user-ana',
        revokedAt: null,
        tokens: {
          accessToken: 'fixture',
          refreshToken: null,
          expiresAt: null,
          scopes: ['read'],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await connect(h, 'member');
      expect(await h.engine.listWorkspaceIds()).toEqual([WS]);
      // The leftover row stays as it was (nothing is purged).
      expect(
        (await h.keyedStore().getInstallation('org-demo-leftover'))?.tokens
          .accessToken
      ).toBe('fixture');
    });
  });

  test('3d. adopting an OAuth row keeps settings and createdAt; OAuth then sees lost access', async () => {
    await withHarness({}, async (h) => {
      const keyed = h.keyedStore();
      await keyed.saveInstallation({
        workspaceId: WS,
        workspaceName: 'Old name',
        urlKey: 'old',
        appUserId: 'user-app',
        installedByUserId: 'user-ana',
        revokedAt: null,
        tokens: {
          accessToken: 'oauth-app-access',
          refreshToken: 'oauth-app-refresh',
          expiresAt: null,
          scopes: ['read', 'write'],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const settings = await h.engine.getSettings(WS);
      await keyed.saveSettings({ ...settings, timezone: 'Europe/Berlin' });
      await connect(h, 'member');
      const adopted = await h.store.getInstallation(WS);
      expect(adopted?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(adopted?.installedByUserId).toBe('user-ana');
      expect(adopted?.workspaceName).toBe(FIXTURE_WORKSPACE.name);
      expect((await h.engine.getSettings(WS)).timezone).toBe('Europe/Berlin');

      const fetched: string[] = [];
      const fetch: FetchLike = (url) => {
        fetched.push(url);
        return Promise.reject(new Error('no Linear here'));
      };
      const oauth = createLinearProvider({
        store: keyed,
        oauth: {
          clientId: 'id',
          clientSecret: 'secret',
          redirectUri: 'https://x/cb',
        },
        logger: createLogger({ name: 't', sink: () => undefined }),
        fetch,
      });
      const error = await rejection(oauth.forApp(WS));
      expect(code(error)).toBe('not_installed');
      expect(fetched).toEqual([]);
    });
  });

  test('3e. app users, deactivated people, rejected keys and bad shapes', async () => {
    await withHarness({}, async (h) => {
      for (const label of ['appuser', 'hugo'] as const) {
        expect(
          code(await rejection(h.engine.connectApiKey({ apiKey: KEYS[label] })))
        ).toBe('not_signed_in');
      }
      expect(
        code(await rejection(h.engine.connectApiKey({ apiKey: KEYS.revoked })))
      ).toBe('key_rejected');
      const before = h.calls.length;
      for (const bad of [
        '',
        'not-a-key',
        'lin_api_short',
        `Bearer ${KEYS.member}`,
      ]) {
        const error = await rejection(h.engine.connectApiKey({ apiKey: bad }));
        expect(code(error)).toBe('invalid');
        expect((error as Error).message).toBe(
          'That does not look like a Linear personal API key (they start with lin_api_).'
        );
      }
      expect(h.calls.length).toBe(before);
    });
  });
});

describe('api_key mode: keys that stop working', () => {
  test('4. a key revoked mid-session is forgotten', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      h.behaviour.revoked.add('member');
      const error = await rejection(
        h.engine.updateIssue(chloe.actor, BEACON_ISSUE, { title: 'Too late' })
      );
      expect(code(error)).toBe('not_signed_in');
      expect((error as Error).message).toBe(
        'Linear no longer accepts your API key (revoked?). Paste a new one.'
      );
      expect(await h.engine.authenticate(chloe.token)).toBeNull();
    });
  });

  test('5. a read-only key turns the person read-only after its first refused write', async () => {
    await withHarness({}, async (h) => {
      const dev = await connect(h, 'readonly');
      const first = await rejection(
        h.engine.updateIssue(dev.actor, BEACON_ISSUE, { title: 'Nope' })
      );
      expect(code(first)).toBe('read_only');
      expect((first as Error).message).toContain('only allows reading');
      const actor = h.keep(await h.engine.authenticate(dev.token));
      if (actor === null) throw new Error('dev');
      expect(actor.readOnly).toBe(true);
      expect(actor.canWriteLinear).toBe(false);
      expect(actor.readOnlyReason).toBe('read_only_key');

      const mark = h.calls.length;
      const attempts: Promise<unknown>[] = [
        h.engine.updateIssue(actor, BEACON_ISSUE, { title: 'Nope' }),
        h.engine.addComment(actor, BEACON_ISSUE, 'nope'),
        h.engine.addBlocker(actor, BEACON_ISSUE, 'iss-eng-70'),
        h.engine.removeRelation(actor, 'rel-cycle-1'),
        h.engine.updateIssues(actor, [BEACON_ISSUE], { priority: 1 }),
        h.engine.setMilestoneTargetDate(actor, 'ms-juniper-2', null),
        h.engine.setProjectLead(actor, 'proj-delta', 'user-femi'),
        h.engine.updateSettings(actor, { timezone: 'UTC' }),
        h.engine.runAllocation({
          workspaceId: WS,
          mode: 'live',
          trigger: 'manual',
          actor,
        }),
      ];
      for (const attempt of attempts) {
        expect(code(await rejection(attempt))).toBe('read_only');
      }
      expect(writesSince(h, mark)).toEqual([]);
    });
  });

  test('5b. a per-issue refusal stays per-issue', async () => {
    await withHarness({}, async (h) => {
      await connect(h, 'member');
      const ben = await connect(h, 'second');
      h.behaviour.refuseIssue.set('second', BEACON_ISSUE);
      const error = await rejection(
        h.engine.updateIssue(ben.actor, BEACON_ISSUE, { title: 'Refused here' })
      );
      expect(code(error)).toBe('linear_forbidden');
      const actor = h.keep(await h.engine.authenticate(ben.token));
      expect(actor?.readOnly).toBe(false);
      expect(isKeyPermissionRefusal(scopeRefusal())).toBe(true);
      expect(
        isKeyPermissionRefusal(new LinearApiError('forbidden', 'nope'))
      ).toBe(false);
    });
  });

  test('6. a bulk edit stops with read_only part-way, and throws when nothing changed', async () => {
    await withHarness({}, async (h) => {
      await connect(h, 'member');
      const ben = await connect(h, 'second');
      h.behaviour.scopeRefusalAfter.set('second', 1);
      const ids = [
        'iss-eng-23',
        'iss-ops-20',
        'iss-eng-70',
        'iss-eng-71',
        'iss-ops-21',
        'iss-ops-22',
      ];
      const visible = ids.filter((id) =>
        h.fixture.data.issues.some((i) => i.id === id)
      );
      const result = h.keep(
        await h.engine.updateIssues(ben.actor, visible, { priority: 1 })
      );
      expect(result.stopped?.code).toBe('read_only');
      expect(result.counts.changed).toBe(1);
      expect(
        result.outcomes
          .filter((o) => o.status === 'skipped')
          .every((o) => o.status === 'skipped' && o.reason === 'not_attempted')
      ).toBe(true);
      expect(result.counts.skipped).toBeGreaterThan(0);

      const dev = await connect(h, 'readonly');
      const error = await rejection(
        h.engine.updateIssues(dev.actor, visible, { priority: 4 })
      );
      expect(code(error)).toBe('read_only');
    });
  });
});

describe('api_key mode: runs', () => {
  test('7a. a live run by Chloe writes with her key', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const mark = h.calls.length;
      const run = h.keep(
        await h.engine.runAllocation({
          workspaceId: WS,
          mode: 'live',
          trigger: 'manual',
          actor: chloe.actor,
        })
      );
      expect(run.startedByUserId).toBe('user-chloe');
      const writes = writesSince(h, mark);
      expect(writes.length).toBeGreaterThan(0);
      expect(new Set(writes.map((w) => w.key))).toEqual(new Set(['member']));
      expect(new Set(writes.map((w) => w.method))).toEqual(
        new Set(['updateIssue', 'createComment'])
      );
    });
  });

  test("7b. Ben's run plans over his view: no Security issue, no call for one", async () => {
    await withHarness({}, async (h) => {
      await connect(h, 'member');
      const ben = await connect(h, 'second');
      const security = securityIssueIds(h.fixture);
      expect(security.size).toBeGreaterThan(0);
      const dry = h.keep(
        await h.engine.runAllocation({
          workspaceId: WS,
          mode: 'dry_run',
          trigger: 'manual',
          actor: ben.actor,
        })
      );
      const detail = h.keep(await h.engine.getRun(WS, dry.id));
      expect(
        detail?.entries.some((e) => e.projectId === SECURITY_PROJECT_ID)
      ).toBe(false);
      expect(
        detail?.entries.some(
          (e) => e.issueId !== null && security.has(e.issueId)
        )
      ).toBe(false);

      // Chloe's dry run does plan Security work, so the difference is the view.
      const chloe = h.keep(
        await h.engine.authenticate((await connect(h, 'member')).token)
      );
      if (chloe === null) throw new Error('chloe');
      const chloeDry = h.keep(
        await h.engine.runAllocation({
          workspaceId: WS,
          mode: 'dry_run',
          trigger: 'manual',
          actor: chloe,
        })
      );
      const chloeEntries =
        (await h.engine.getRun(WS, chloeDry.id))?.entries ?? [];
      expect(
        chloeEntries.some((e) => e.projectId === SECURITY_PROJECT_ID)
      ).toBe(true);

      const mark = h.calls.length;
      h.keep(
        await h.engine.runAllocation({
          workspaceId: WS,
          mode: 'live',
          trigger: 'manual',
          actor: ben.actor,
        })
      );
      for (const call of h.calls.slice(mark)) {
        expect(security.has(String(call.arg))).toBe(false);
        if (
          call.method !== 'fetchWorkspace' &&
          call.method !== 'fetchLastStateChanges'
        ) {
          expect(call.key).toBe('second');
        }
      }
    });
  });

  test('7c. a re-check that finds nothing fails with the key sentence', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const dry = await h.engine.runAllocation({
        workspaceId: WS,
        mode: 'dry_run',
        trigger: 'manual',
        actor: chloe.actor,
      });
      const planned = (await h.engine.getRun(WS, dry.id))?.entries.find(
        (e) => e.outcome === 'planned'
      );
      if (planned?.issueId === null || planned === undefined)
        throw new Error('nothing planned');
      h.behaviour.hiddenIssue = planned.issueId;
      const run = h.keep(
        await h.engine.runAllocation({
          workspaceId: WS,
          mode: 'live',
          trigger: 'manual',
          actor: chloe.actor,
        })
      );
      const entries = (await h.engine.getRun(WS, run.id))?.entries ?? [];
      const failed = entries.find((e) => e.issueId === planned.issueId);
      expect(failed?.outcome).toBe('failed');
      expect(failed?.error).toBe(NOT_FOR_YOUR_KEY_MESSAGE);
    });
  });

  test('7d. nothing unattended: no actor-less run, no daily, no live warnings; the preview works', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      expect(
        code(
          await rejection(
            h.engine.runAllocation({
              workspaceId: WS,
              mode: 'dry_run',
              trigger: 'schedule',
              actor: null,
            })
          )
        )
      ).toBe('not_signed_in');
      expect(
        code(await rejection(h.engine.runDaily({ workspaceId: WS })))
      ).toBe('invalid');
      expect(
        code(await rejection(h.engine.runWarnings({ workspaceId: WS })))
      ).toBe('invalid');
      const preview = h.keep(
        await h.engine.runWarnings({
          workspaceId: WS,
          previewOnly: true,
          viewer: chloe.actor,
        })
      );
      expect(preview.workspaceId).toBe(WS);
    });
  });
});

describe('api_key mode: the issue page and expiry', () => {
  test("8. the issue page reads with the viewer's key only", async () => {
    await withHarness({}, async (h) => {
      await connect(h, 'member');
      const ben = await connect(h, 'second');
      const mark = h.calls.length;
      const page = h.keep(
        await h.engine.getIssueDetail(ben.actor, BEACON_ISSUE)
      );
      expect(page.extra).not.toBeNull();
      const live = h.calls
        .slice(mark)
        .filter((c) => c.method === 'fetchIssueDetail');
      expect(live.map((c) => c.key)).toEqual(['second']);

      h.behaviour.transient.add('second');
      const next = h.calls.length;
      const down = h.keep(
        await h.engine.getIssueDetail(ben.actor, BEACON_ISSUE)
      );
      expect(down.extra).toBeNull();
      expect(down.extraError).toBe(KEY_UNANSWERED_MESSAGE);
      expect(h.calls.slice(next).every((c) => c.key === 'second')).toBe(true);
    });
  });

  test('9. idle and absolute expiry, restart, and signing out', async () => {
    await withHarness({}, async (h) => {
      const start = h.clock.now().getTime();
      const idle = await connect(h, 'member');
      h.clock.set(new Date(start + 2 * 3_600_000).toISOString());
      expect(await h.engine.authenticate(idle.token)).toBeNull();

      const steady = await connect(h, 'member');
      const connectedAt = h.clock.now().getTime();
      for (let hour = 1; hour < 12; hour++) {
        h.clock.set(new Date(connectedAt + hour * 3_600_000).toISOString());
        expect(
          h.keep(await h.engine.authenticate(steady.token))
        ).not.toBeNull();
      }
      h.clock.set(new Date(connectedAt + 12 * 3_600_000).toISOString());
      expect(await h.engine.authenticate(steady.token)).toBeNull();

      const kept = await connect(h, 'member');
      const restarted = h.restart();
      expect(await restarted.engine.authenticate(kept.token)).toBeNull();
      expect((await restarted.store.getInstallation(WS))?.appUserId).toBe('');

      const one = await connect(h, 'member');
      const two = await connect(h, 'member');
      await h.engine.signOut(one.token, { everyDevice: true });
      expect(await h.engine.authenticate(one.token)).toBeNull();
      expect(await h.engine.authenticate(two.token)).toBeNull();

      const three = await connect(h, 'member');
      const four = await connect(h, 'member');
      await h.engine.signOut(three.token, {});
      expect(await h.engine.authenticate(three.token)).toBeNull();
      expect(h.keep(await h.engine.authenticate(four.token))).not.toBeNull();
    });
  });
});

describe('api_key mode: signing out from a stale browser', () => {
  test("9b. a browser whose own connection ended still forgets the person's others; an unknown one says so", async () => {
    await withHarness({}, async (h) => {
      const at = (ms: number): void => {
        h.clock.set(new Date(ms).toISOString());
      };
      // Idle: the laptop goes quiet, the phone stays in use.
      const start = h.clock.now().getTime();
      const laptop = await connect(h, 'member');
      at(start + 90 * 60_000);
      const phone = await connect(h, 'member');
      at(start + 150 * 60_000);
      expect(h.keep(await h.engine.authenticate(phone.token))).not.toBeNull();
      expect(await h.engine.authenticate(laptop.token)).toBeNull();
      expect(
        h.keep(await h.engine.signOut(laptop.token, { everyDevice: true }))
      ).toEqual({ known: true, keysForgotten: 1 });
      expect(await h.engine.authenticate(phone.token)).toBeNull();

      // Evicted by the sixth connect.
      const first = await connect(h, 'member');
      const rest: string[] = [];
      for (let i = 1; i <= 5; i++) {
        at(h.clock.now().getTime() + 1_000);
        rest.push((await connect(h, 'member')).token);
      }
      expect(await h.engine.authenticate(first.token)).toBeNull();
      expect(
        h.keep(await h.engine.signOut(first.token, { everyDevice: true }))
      ).toEqual({ known: true, keysForgotten: 5 });
      for (const token of rest) {
        expect(await h.engine.authenticate(token)).toBeNull();
      }

      // The absolute limit, with the laptop in steady use.
      const steady = await connect(h, 'member');
      const connectedAt = h.clock.now().getTime();
      let later: string | null = null;
      for (let hour = 1; hour < 12; hour++) {
        at(connectedAt + hour * 3_600_000);
        expect(
          h.keep(await h.engine.authenticate(steady.token))
        ).not.toBeNull();
        if (hour === 6) later = (await connect(h, 'member')).token;
        if (later !== null) h.keep(await h.engine.authenticate(later));
      }
      at(connectedAt + 12 * 3_600_000 + 60_000);
      expect(await h.engine.authenticate(steady.token)).toBeNull();
      expect(
        h.keep(await h.engine.signOut(steady.token, { everyDevice: true }))
      ).toEqual({ known: true, keysForgotten: 1 });
      expect(await h.engine.authenticate(later ?? '')).toBeNull();

      // A token the planner never knew, or no longer knows of.
      expect(
        h.keep(await h.engine.signOut('not-a-token', { everyDevice: true }))
      ).toEqual({ known: false, keysForgotten: 0 });
      const kept = await connect(h, 'member');
      const restarted = h.restart();
      expect(
        h.keep(
          await restarted.engine.signOut(kept.token, { everyDevice: true })
        )
      ).toEqual({ known: false, keysForgotten: 0 });
    });
  });
});

describe('api_key mode: the reader', () => {
  test('10. the reader gateway never writes; forSession needs the matching person', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const vault = createKeyVault({
        idleMs: 60_000,
        absoluteMs: 600_000,
        now: () => h.clock.now().getTime(),
        gateway: fakeKeyGatewayFactory(h.fixture, h.behaviour, h.calls),
      });
      const provider = createApiKeyLinearProvider({
        vault,
        logger: createLogger({ name: 't', sink: () => undefined }),
        appName: 'Milestone Planner',
        binding: () => h.store.getInstallation(WS),
      });
      const added = vault.add({
        apiKey: KEYS.member,
        workspaceId: WS,
        userId: 'user-chloe',
        userName: 'Chloe Diaz',
        guest: false,
      });
      const reader = await provider.forApp(WS);
      const mark = h.calls.length;
      for (const method of GATEWAY_WRITE_METHODS) {
        const call = (
          reader as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >
        )[method];
        expect(
          code(await rejection(call?.('iss-eng-23', 'x') ?? Promise.resolve()))
        ).toBe('read_only');
      }
      expect(h.calls.length).toBe(mark);
      expect((await reader.whoAmI()).user.id).toBe('user-chloe');

      const forged = {
        ...chloe.actor.session,
        id: added.session.id,
        userId: 'user-ben',
      };
      expect(code(await rejection(provider.forSession(forged)))).toBe(
        'not_signed_in'
      );
      const real = { ...chloe.actor.session, id: added.session.id };
      expect(await provider.forSession(real)).toBeDefined();
    });
  });

  test('11. with only a guest connected nothing reads Linear', async () => {
    await withHarness({ pin: 'northwind' }, async (h) => {
      const gus = await connect(h, 'guest');
      expect(gus.actor.readOnlyReason).toBe('not_synced');
      expect(code(await rejection(h.engine.fullSync(WS)))).toBe('no_reader');
      const actor = h.keep(await h.engine.authenticate(gus.token));
      expect(actor?.readOnly).toBe(true);
      expect(actor?.readOnlyReason).toBe('not_synced');
      expect(callsOf(h, 'guest', 'fetchWorkspace')).toEqual([]);
    });
  });

  test('11b. a reader Linear makes a guest stops reading at once; the next member reads', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const ben = await connect(h, 'second');
      const user = h.fixture.data.users.find((u) => u.id === 'user-chloe');
      if (user === undefined) throw new Error('chloe');
      user.guest = true;
      const secIssue = [...securityIssueIds(h.fixture)][0] ?? '';

      let mark = h.calls.length;
      h.keep(await h.engine.fullSync(WS));
      expect(
        h.calls
          .slice(mark)
          .filter((c) => c.method === 'fetchWorkspace')
          .map((c) => c.key)
      ).toEqual(['member', 'second']);
      // The copy is Ben's view (no Security), never the guest key's.
      expect((await h.engine.load(WS)).snapshot.issues.has(secIssue)).toBe(
        false
      );
      const status = h.keep(await h.engine.getKeyConnection(ben.actor));
      expect(status?.reader?.userId).toBe('user-ben');
      const again = h.keep(await h.engine.authenticate(chloe.token));
      expect(again?.readOnlyReason).toBe('guest');
      mark = h.calls.length;
      h.keep(await h.engine.fullSync(WS));
      expect(
        h.calls
          .slice(mark)
          .filter((c) => c.method === 'fetchWorkspace')
          .map((c) => c.key)
      ).toEqual(['second']);

      // With no member left, nothing replaces the copy.
      await h.engine.signOut(ben.token, { everyDevice: true });
      const version = (await h.store.getSyncState(WS))?.version;
      mark = h.calls.length;
      expect(code(await rejection(h.engine.fullSync(WS)))).toBe('no_reader');
      expect(h.calls.slice(mark)).toEqual([]);
      expect((await h.store.getSyncState(WS))?.version).toBe(version);
    });
  });

  test('11c. a member the mirror shows as a guest stops reading when they next load a page', async () => {
    await withHarness({}, async (h) => {
      const ben = await connect(h, 'second');
      const chloe = await connect(h, 'member');
      const user = h.fixture.data.users.find((u) => u.id === 'user-chloe');
      if (user === undefined) throw new Error('chloe');
      user.guest = true;
      h.keep(await h.engine.fullSync(WS));
      const actor = h.keep(await h.engine.authenticate(chloe.token));
      expect(actor?.readOnlyReason).toBe('guest');
      await h.engine.signOut(ben.token, { everyDevice: true });
      const mark = h.calls.length;
      expect(code(await rejection(h.engine.fullSync(WS)))).toBe('no_reader');
      expect(h.calls.slice(mark)).toEqual([]);
    });
  });

  test('12. when the reader changes, logs about a lost private team stay hidden', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const security = [...securityIssueIds(h.fixture)];
      const secIssue = security[0] ?? '';
      h.keep(
        await h.engine.updateIssue(chloe.actor, secIssue, {
          title: 'Security work renamed',
        })
      );
      const run = h.keep(
        await h.engine.runAllocation({
          workspaceId: WS,
          mode: 'dry_run',
          trigger: 'manual',
          actor: chloe.actor,
        })
      );
      const ben = await connect(h, 'second');
      await h.engine.signOut(chloe.token, { everyDevice: true });
      h.keep(await h.engine.fullSync(WS));
      const mirror = await h.engine.load(WS);
      expect(mirror.snapshot.issues.has(secIssue)).toBe(false);

      const audit = h.keep(await h.engine.listAudit(WS, 50, ben.actor));
      expect(audit.some((entry) => entry.subjectId === secIssue)).toBe(false);
      const seen = h.keep(await h.engine.getRun(WS, run.id, ben.actor));
      expect(
        seen?.entries.some((e) => e.projectId === SECURITY_PROJECT_ID)
      ).toBe(false);
      expect(
        seen?.entries.some(
          (e) => e.issueId !== null && security.includes(e.issueId)
        )
      ).toBe(false);
    });
  });

  test("13. an error from another person's sync carries no key", async () => {
    await withHarness({}, async (h) => {
      await connect(h, 'member');
      await connect(h, 'second');
      h.behaviour.echo = true;
      const first = h.engine.fullSync(WS);
      const joined = h.engine.fullSync(WS);
      const errors = await Promise.all([rejection(first), rejection(joined)]);
      for (const error of errors) {
        expect(String((error as Error).message)).not.toContain('TESTKEY');
        expect(String((error as Error).stack)).not.toContain('TESTKEY');
      }
      const state = await h.store.getSyncState(WS);
      expect(state?.lastFullSyncError ?? '').not.toContain('TESTKEY');
      expect(state?.lastFullSyncError ?? '').toContain('lin_api_[redacted]');
      h.behaviour.echo = false;
    });
  });
});

describe('api_key mode: text and status', () => {
  test('14. key-shaped text is refused before Linear, unless it was already there', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const mark = h.calls.length;
      const comment = await rejection(
        h.engine.addComment(chloe.actor, BEACON_ISSUE, `here ${KEYS.member}`)
      );
      expect(code(comment)).toBe('invalid');
      expect((comment as Error).message).toBe(
        'That looks like a Linear API key; it was not sent.'
      );
      expect(writesSince(h, mark)).toEqual([]);

      const quoted = 'lin_api_MIRRORTEXT_abcdefghijklmnop';
      const fields = h.fixture.issueFields[BEACON_ISSUE];
      if (fields !== undefined) fields.description = `old ${quoted}`;
      else {
        h.fixture.issueFields[BEACON_ISSUE] = {
          description: `old ${quoted}`,
          labelIds: [],
          estimate: null,
          dueDate: null,
        };
      }
      const kept = h.keep(
        await h.engine.updateIssue(chloe.actor, BEACON_ISSUE, {
          description: `new ${quoted}`,
        })
      );
      expect(kept.changed).toEqual(['description']);
      const title = await rejection(
        h.engine.updateIssue(chloe.actor, BEACON_ISSUE, {
          title: 'see lin_api_OTHERTEXT_abcdefghijklmnop',
        })
      );
      expect(code(title)).toBe('invalid');
    });
  });

  test('15. the key status names the reader and holds no key', async () => {
    await withHarness({}, async (h) => {
      const chloe = await connect(h, 'member');
      const ben = await connect(h, 'second');
      const status = h.keep(await h.engine.getKeyConnection(chloe.actor));
      expect(status?.reader).toEqual({
        userId: 'user-chloe',
        userName: 'Chloe Diaz',
      });
      expect(status?.idleMinutes).toBe(120);
      expect(
        Date.parse(status?.expiresAt ?? '') -
          Date.parse(status?.connectedAt ?? '')
      ).toBe(12 * 3_600_000);
      await h.engine.signOut(chloe.token, { everyDevice: true });
      const after = h.keep(await h.engine.getKeyConnection(ben.actor));
      expect(after?.reader?.userId).toBe(KEY_USERS.second);
      expect(JSON.stringify([status, after])).not.toContain('TESTKEY');
    });
  });

  test('the OAuth entry points are off', async () => {
    await withHarness({}, async (h) => {
      expect(() => h.engine.startOAuth('signin')).toThrow(/OAuth is off/);
      expect(code(await rejection(h.engine.devSignIn('user-ana')))).toBe(
        'invalid'
      );
      expect(
        code(
          await rejection(
            h.engine.finishSignIn({
              code: 'c',
              codeVerifier: 'v',
              intent: 'signin',
            })
          )
        )
      ).toBe('invalid');
      expect(
        await h.engine.getKeyConnection({
          session: {
            id: 'nope',
            workspaceId: WS,
            userId: 'user-ana',
            userName: 'Ana',
            tokens: {
              accessToken: '',
              refreshToken: null,
              expiresAt: null,
              scopes: [],
            },
            createdAt: '2026-10-21T00:00:00.000Z',
            expiresAt: '2026-10-22T00:00:00.000Z',
          },
          canWriteLinear: false,
          readOnly: true,
        })
      ).toBeNull();
      expect(
        await h.engine.handleWebhook({
          deliveryId: 'd1',
          workspaceId: WS,
          type: 'Issue',
          action: 'update',
          entityId: BEACON_ISSUE,
          updatedFrom: null,
        })
      ).toBe('ignored');
    });
  });
});

describe('connectApiKey outside api_key mode', () => {
  test('is refused', async () => {
    const demo = await createDemoHarness();
    try {
      const error = await rejection(
        demo.engine.connectApiKey({ apiKey: KEYS.member })
      );
      expect(code(error)).toBe('invalid');
      expect((error as Error).message).toBe(
        'Personal API keys are off on this server.'
      );
      const ana = await actorFor(demo, 'user-ana');
      expect(await demo.engine.getKeyConnection(ana)).toBeNull();
    } finally {
      await demo.close();
    }
  });
});
