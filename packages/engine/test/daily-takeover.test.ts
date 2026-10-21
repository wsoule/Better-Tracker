import type { Digest } from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type {
  DeliveryResult,
  NotificationChannel,
} from '@better-tracker/notify';
import { afterEach, describe, expect, test } from 'bun:test';
// runDaily's claim is a lease (architecture §7, §7.1): a tick killed in the
// middle of the daily job leaves its claim unfinished, and once the claim
// is older than the lease the next tick takes the day over and runs it
// again. Each test "kills" the first run by making one call hang forever
// (the run never finishes, throws or releases anything), then checks what
// the takeover does at that point.

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

const MINUTE_MS = 60_000;

/**
 * A call that never settles, like one cut off by a killed process.
 * `reached` resolves once the first such call has started.
 */
function hangGate(): { reached: Promise<void>; hang<T>(): Promise<T> } {
  let reachedResolve: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  return {
    reached,
    hang<T>(): Promise<T> {
      reachedResolve();
      return new Promise<T>(() => undefined);
    },
  };
}

// Moves the harness clock to `minutes` after `startMs`.
function at(h: DemoHarness, startMs: number, minutes: number): void {
  h.clock.set(new Date(startMs + minutes * MINUTE_MS).toISOString());
}

function noticeIds(digest: Digest | undefined): string[] {
  return (digest?.items ?? [])
    .map((item) => `${item.notice.kind}:${item.notice.subjectId}`)
    .sort();
}

describe('runDaily after a run that died', () => {
  test('a run killed mid-sync holds the day for the lease, then is taken over', async () => {
    let hangSync = false;
    const gate = hangGate();
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () => (hangSync ? gate.hang() : gateway.fetchWorkspace()),
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    const startMs = h.clock.now().getTime();
    const day = h.clock.today();

    hangSync = true;
    void h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    await gate.reached;
    hangSync = false;

    // Still within the 30-minute lease: the day counts as taken.
    at(h, startMs, 30);
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      false
    );

    at(h, startMs, 31);
    const takeover = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(takeover.ran).toBe(true);
    expect(takeover.day).toBe(day);
    expect(takeover.allocation?.status).toBe('succeeded');
    expect(takeover.warnings?.notices).toBe(8);

    // The takeover finished, so the day is never taken over again.
    at(h, startMs, 120);
    expect(h.clock.today()).toBe(day);
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      false
    );
  });

  test("a run that outlived its lease leaves the new holder's claim alone", async () => {
    let stallSync = false;
    let resume: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const gate = hangGate();
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: async () => {
        if (stallSync) {
          stallSync = false;
          void gate.hang();
          await stalled;
        }
        return gateway.fetchWorkspace();
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    const startMs = h.clock.now().getTime();

    stallSync = true;
    const slow = h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    await gate.reached;
    at(h, startMs, 31);
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      true
    );

    // The stalled run wakes up and completes; its claim is gone, so it
    // neither finishes nor frees the takeover's (finished) claim.
    resume();
    expect((await slow).ran).toBe(true);
    expect(
      h.logs.some((line) => line.includes('daily claim was taken over'))
    ).toBe(true);
    expect((await h.engine.runDaily({ workspaceId: WORKSPACE_ID })).ran).toBe(
      false
    );
  });

  test('a live allocation killed between assigning and commenting is not repeated', async () => {
    let hangSecondComment = false;
    let comments = 0;
    const assigned: string[] = [];
    const gate = hangGate();
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      updateIssue: (issueId, input) => {
        if (input.assigneeId !== undefined) assigned.push(issueId);
        return gateway.updateIssue(issueId, input);
      },
      createComment: (issueId, body) => {
        comments += 1;
        return hangSecondComment && comments === 2
          ? gate.hang()
          : gateway.createComment(issueId, body);
      },
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    const startMs = h.clock.now().getTime();
    const settings = (await h.engine.load(WORKSPACE_ID)).settings;
    await h.store.saveSettings({ ...settings, allocationMode: 'live' });

    hangSecondComment = true;
    void h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    await gate.reached;
    hangSecondComment = false;
    // The dead run assigned two issues and commented on the first only.
    expect(assigned).toHaveLength(2);
    const [first, second] = assigned;
    expect(h.fixture.comments.map((c) => c.issueId)).toEqual([first ?? '']);

    at(h, startMs, 31);
    const takeover = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(takeover.ran).toBe(true);
    expect(takeover.allocation).toMatchObject({
      mode: 'live',
      status: 'succeeded',
    });
    expect(takeover.allocation?.summary?.assigned).toBe(3);

    // Five issues, each assigned once; no issue has two comments. The
    // comment the dead run never posted stays missing.
    expect(assigned).toHaveLength(5);
    expect(new Set(assigned).size).toBe(5);
    const commented = h.fixture.comments.map((c) => c.issueId);
    expect(commented).toHaveLength(4);
    expect(new Set(commented).size).toBe(4);
    expect(commented).not.toContain(second);

    // The takeover's run log shows both as already assigned; the dead run
    // is closed as stale.
    const runId = takeover.allocation?.id ?? '';
    const log = await h.engine.getRun(WORKSPACE_ID, runId);
    const alreadyAssigned = (log?.entries ?? [])
      .filter((e) => e.action === 'skip' && e.reason === 'already_assigned')
      .map((e) => e.issueId);
    expect(alreadyAssigned).toEqual(expect.arrayContaining([first, second]));
    const runs = await h.engine.listRuns(WORKSPACE_ID, 10);
    expect(runs.find((run) => run.id !== runId)).toMatchObject({
      status: 'failed',
      error: 'stale run',
    });
  });

  test('a takeover that finds the dead allocation run not yet stale retries on a later tick', async () => {
    let slowSync = false;
    let hangAssign = false;
    const gate = hangGate();
    const wrap: GatewayWrapper = (gateway): LinearGateway => ({
      ...gateway,
      fetchWorkspace: () => {
        // The dead tick's sync took 5 minutes, so its allocation run
        // started 5 minutes after the claim.
        if (slowSync && harness !== null) {
          slowSync = false;
          at(harness, harness.clock.now().getTime(), 5);
        }
        return gateway.fetchWorkspace();
      },
      updateIssue: (issueId, input) =>
        hangAssign ? gate.hang() : gateway.updateIssue(issueId, input),
    });
    harness = await createDemoHarness({ wrap });
    const h = harness;
    const startMs = h.clock.now().getTime();
    const settings = (await h.engine.load(WORKSPACE_ID)).settings;
    await h.store.saveSettings({ ...settings, allocationMode: 'live' });

    slowSync = true;
    hangAssign = true;
    void h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    await gate.reached;
    hangAssign = false;

    // The claim is past its lease, but the allocation run is only 26
    // minutes old: the run lock still holds, the takeover fails and gives
    // the day back.
    at(h, startMs, 31);
    expect(
      await rejectionMessage(h.engine.runDaily({ workspaceId: WORKSPACE_ID }))
    ).toContain('already in progress');

    // The next tick claims the day afresh and finds the run stale.
    at(h, startMs, 46);
    const retry = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(retry.ran).toBe(true);
    expect(retry.allocation?.status).toBe('succeeded');
    expect(retry.allocation?.summary?.assigned).toBe(5);
    expect(h.fixture.comments).toHaveLength(5);
  });

  test('warnings killed mid-send: no second digest today, the lost notice comes back tomorrow', async () => {
    let sends = 0;
    let hangOnSend: number | null = 4;
    const gate = hangGate();
    const sent: Digest[] = [];
    const channel: NotificationChannel & { sent: Digest[] } = {
      name: 'slack',
      delivers: true,
      sent,
      send(digest: Digest): Promise<DeliveryResult> {
        sends += 1;
        if (sends === hangOnSend) return gate.hang();
        sent.push(digest);
        return Promise.resolve({
          status: 'sent',
          channel: 'slack',
          detail: null,
        });
      },
    };
    harness = await createDemoHarness({ channel });
    const h = harness;
    const startMs = h.clock.now().getTime();
    const day = h.clock.today();
    const settings = (await h.engine.load(WORKSPACE_ID)).settings;
    await h.store.saveSettings({ ...settings, warningsMode: 'live' });

    void h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    await gate.reached;
    hangOnSend = null;
    // Digests go out in recipient order: ana, ben and chloe got theirs;
    // dev's is claimed, and whether Slack got it is unknown.
    const before = await h.store.listNotifications(WORKSPACE_ID, {
      limit: 50,
      day,
    });
    expect(
      Object.fromEntries(before.map((r) => [r.recipientId, r.status]))
    ).toEqual({
      'user-ana': 'sent',
      'user-ben': 'sent',
      'user-chloe': 'sent',
      'user-dev': 'pending',
    });

    at(h, startMs, 31);
    const takeover = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(takeover.ran).toBe(true);
    expect(takeover.warnings).toMatchObject({ alreadySent: 4, delivered: 1 });
    // At most one digest per person per day, even for dev.
    expect(sent.map((d) => d.recipientId)).toEqual([
      'user-ana',
      'user-ben',
      'user-chloe',
      'user-elena',
    ]);

    // Dev's notice was never confirmed delivered, so it is offered again.
    h.clock.advanceDays(1);
    const tomorrow = await h.engine.runDaily({ workspaceId: WORKSPACE_ID });
    expect(tomorrow.ran).toBe(true);
    const dev = tomorrow.warnings?.digests.find(
      (d) => d.recipientId === 'user-dev'
    );
    expect(noticeIds(dev)).toEqual(['at_risk:ms-beacon-1']);
  });
});
