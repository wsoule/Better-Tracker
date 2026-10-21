import { LinearApiError, type LinearGateway } from '@better-tracker/linear';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createDemoHarness,
  type DemoHarness,
  type GatewayWrapper,
  WORKSPACE_ID,
  rejectionMessage,
} from './helpers';

let harness: DemoHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('runDaily', () => {
  test('runs sync → allocation (settings mode) → warnings once per day', async () => {
    let fetches = 0;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () => {
        fetches += 1;
        return gateway.fetchWorkspace();
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    fetches = 0;

    const first = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(first.ran).toBe(true);
    expect(first.day).toBe(h.clock.today());
    expect(first.sync?.ok).toBe(true);
    expect(first.allocation?.mode).toBe('dry_run');
    expect(first.allocation?.trigger).toBe('schedule');
    expect(first.allocation?.startedByUserId).toBeNull();
    expect(first.allocation?.summary?.wouldAssign).toBe(5);
    expect(first.warnings?.notices).toBe(8);
    expect(first.warnings?.mode).toBe('preview');
    // One sync per daily run: allocation reuses the one just made.
    expect(fetches).toBe(1);
    expect(h.fixture.comments).toEqual([]);

    const second = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(second).toEqual({
      workspaceId: WORKSPACE_ID,
      day: h.clock.today(),
      ran: false,
      sync: null,
      allocation: null,
      warnings: null,
    });
    expect(await h.engine.listRuns(WORKSPACE_ID, 10)).toHaveLength(1);

    const forced = await h.engine.runDaily({
      workspaceId: WORKSPACE_ID,
      force: true,
    });
    expect(forced.ran).toBe(true);
    expect(await h.engine.listRuns(WORKSPACE_ID, 10)).toHaveLength(2);

    h.clock.advanceDays(1);
    const tomorrow = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(tomorrow.ran).toBe(true);
    expect(tomorrow.day).toBe(h.clock.today());
  });

  test('uses the live allocation mode from settings', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const settings = (await h.engine.load(WORKSPACE_ID)).settings;
    await h.store.saveSettings({ ...settings, allocationMode: 'live' });
    const result = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(result.allocation?.mode).toBe('live');
    expect(result.allocation?.summary?.assigned).toBe(5);
    expect(h.fixture.comments).toHaveLength(5);
  });

  test('a failed run releases the claim so a retry can run', async () => {
    let broken = false;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () =>
        broken
          ? Promise.reject(new LinearApiError('server', 'Linear 503'))
          : gateway.fetchWorkspace(),
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    broken = true;
    expect(
      await rejectionMessage(h.engine.runDaily({ workspaceId: WORKSPACE_ID }))
    ).toContain('Linear 503');
    broken = false;
    const retry = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(retry.ran).toBe(true);
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      false
    );
  });

  test('a forced run does not release a claim it did not make', async () => {
    let broken = false;
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () =>
        broken
          ? Promise.reject(new LinearApiError('server', 'Linear 503'))
          : gateway.fetchWorkspace(),
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      true
    );
    broken = true;
    expect(
      await rejectionMessage(
        h.engine.runDaily({ workspaceId: WORKSPACE_ID, force: true })
      )
    ).toContain('Linear 503');
    broken = false;
    // The successful run's claim still stands.
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      false
    );
  });
  test('claims and records the day in the workspace timezone', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const settings = (await h.engine.load(WORKSPACE_ID)).settings;
    // 15:00 UTC on Oct 21 is already Oct 22 in Kiritimati (UTC+14).
    await h.store.saveSettings({ ...settings, timezone: 'Pacific/Kiritimati' });
    expect((await h.engine.load(WORKSPACE_ID)).today).toBe('2026-10-22');

    const first = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(first.day).toBe('2026-10-22');
    expect(first.warnings?.day).toBe('2026-10-22');
    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.day === '2026-10-22')).toBe(true);

    // 09:59 UTC on Oct 22 is still Oct 22 there: already claimed.
    h.clock.set('2026-10-22T09:59:00.000Z');
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      false
    );
    // 10:00 UTC is midnight of Oct 23 there: a new day.
    h.clock.set('2026-10-22T10:00:00.000Z');
    const next = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(next.ran).toBe(true);
    expect(next.day).toBe('2026-10-23');
  });
});
