import {
  addDays,
  type Digest,
  type DigestItem,
  type Notice,
} from '@better-tracker/core';
import {
  createOutboxChannel,
  type DeliveryResult,
} from '@better-tracker/notify';
import type { NotificationRecord } from '@better-tracker/store';
import { afterEach, describe, expect, test } from 'bun:test';

import { SLACK_NOT_CONFIGURED } from '../src/index';
import { toldEarlierToday } from '../src/warning-run';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  recordingChannel,
  WORKSPACE_ID,
  rejection,
} from './helpers';

let harness: DemoHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Day one's notices in the fixture, per kind:subject. */
const DAY_ONE_NOTICES = [
  'allocation_blocked:proj-delta',
  'allocation_blocked:proj-ember',
  'allocation_blocked:proj-harbor',
  'at_risk:ms-beacon-1',
  'at_risk:ms-compass-1',
  'at_risk:ms-garnet-1',
  'invalid_due_soon:ms-harbor-1',
  'overdue:ms-atlas-2',
];
const DAY_ONE_RECIPIENTS = [
  'user-ana',
  'user-ben',
  'user-chloe',
  'user-dev',
  'user-elena',
];

function noticeKeys(digests: Digest[]): string[] {
  const keys = new Set<string>();
  for (const digest of digests) {
    for (const item of digest.items) {
      keys.add(`${item.notice.kind}:${item.notice.subjectId}`);
    }
  }
  return [...keys].sort();
}

async function goLive(h: DemoHarness): Promise<void> {
  await h.engine.updateSettings(await actorFor(h, 'user-ana'), {
    warningsMode: 'live',
  });
}

describe('preview mode', () => {
  test('records preview digests and sends nothing', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const result = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(result.mode).toBe('preview');
    expect(result.day).toBe(h.clock.today());
    expect(result.notices).toBe(8);
    expect(noticeKeys(result.digests)).toEqual(DAY_ONE_NOTICES);
    expect(result.digests.map((d) => d.recipientId).sort()).toEqual(
      DAY_ONE_RECIPIENTS
    );
    expect(result).toMatchObject({ delivered: 0, failed: 0, alreadySent: 0 });
    expect(h.channel.sent).toEqual([]);

    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    expect(records).toHaveLength(5);
    expect(records.every((r) => r.status === 'preview')).toBe(true);
    expect(records.every((r) => r.channel === 'outbox')).toBe(true);
    expect(records.every((r) => r.day === h.clock.today())).toBe(true);
    const ana = records.find((r) => r.recipientId === 'user-ana');
    // Links that leave the app name their workspace (§7).
    expect(ana?.digest.items[0]?.url).toBe(
      `https://planner.example/timeline?milestone=ms-atlas-2&ws=${WORKSPACE_ID}`
    );

    // Memory was saved: the same day has nothing new to say.
    const again = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(again.notices).toBe(0);
    expect(again.digests).toEqual([]);
  });

  test('previewOnly builds digests without writing anything', async () => {
    harness = await createDemoHarness();
    const h = harness;
    await goLive(h);
    const preview = await h.engine.runWarnings({
      workspaceId: WORKSPACE_ID,
      previewOnly: true,
    });
    expect(preview.digests).toHaveLength(5);
    expect(h.channel.sent).toEqual([]);
    expect(await h.engine.listNotifications(WORKSPACE_ID, 50)).toEqual([]);
    expect(await h.store.listWarningMemory(WORKSPACE_ID)).toEqual([]);

    // A real run afterwards still announces everything.
    const real = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(real.notices).toBe(8);
    expect(h.channel.sent).toHaveLength(5);
  });
});

describe('explicit day', () => {
  test('evaluates and records the given day; rejects a malformed one', async () => {
    harness = await createDemoHarness();
    const h = harness;
    const tomorrow = addDays(h.clock.today(), 1);
    const result = await h.engine.runWarnings({
      workspaceId: WORKSPACE_ID,
      day: tomorrow,
    });
    expect(result.day).toBe(tomorrow);
    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    expect(records.every((r) => r.day === tomorrow)).toBe(true);
    expect(
      await rejection(
        h.engine.runWarnings({ workspaceId: WORKSPACE_ID, day: '2026-13-01' })
      )
    ).toMatchObject({ name: 'EngineInputError', code: 'invalid' });
  });
});

describe('live mode', () => {
  test('sends one digest per recipient through the channel', async () => {
    harness = await createDemoHarness();
    const h = harness;
    await goLive(h);
    const result = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(result.mode).toBe('live');
    expect(result.delivered).toBe(5);
    expect(result.failed).toBe(0);
    expect(h.channel.sent.map((d) => d.recipientId).sort()).toEqual(
      DAY_ONE_RECIPIENTS
    );
    // Watchers see everything; a lead sees their own project's notices.
    const elena = h.channel.sent.find((d) => d.recipientId === 'user-elena');
    expect(noticeKeys(elena === undefined ? [] : [elena])).toEqual([
      'allocation_blocked:proj-harbor',
      'invalid_due_soon:ms-harbor-1',
    ]);
    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    expect(
      records
        .map((r) => [r.recipientId, r.status, r.channel])
        .sort((a, b) => a.join().localeCompare(b.join()))
    ).toEqual(DAY_ONE_RECIPIENTS.map((id) => [id, 'sent', 'slack']));
  });

  test('a second run the same day sends nothing new', async () => {
    harness = await createDemoHarness();
    const h = harness;
    await goLive(h);
    await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(h.channel.sent).toHaveLength(5);

    const again = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(again.notices).toBe(0);
    expect(h.channel.sent).toHaveLength(5);

    // Even with the memory wiped, nobody gets a second digest today.
    await h.store.saveWarningMemory(
      WORKSPACE_ID,
      (await h.store.listWarningMemory(WORKSPACE_ID)).map((row) => ({
        ...row,
        lastKey: null,
      }))
    );
    const replay = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(replay.notices).toBe(8);
    expect(replay.alreadySent).toBe(5);
    expect(replay.delivered).toBe(0);
    expect(h.channel.sent).toHaveLength(5);
    expect(await h.engine.listNotifications(WORKSPACE_ID, 50)).toHaveLength(5);
  });

  test('next day: at-risk is not repeated, overdue repeats with occurrence 2', async () => {
    harness = await createDemoHarness();
    const h = harness;
    await goLive(h);
    await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });

    h.clock.advanceDays(1);
    const dayTwo = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(dayTwo.day).toBe(h.clock.today());
    expect(noticeKeys(dayTwo.digests)).toEqual(['overdue:ms-atlas-2']);
    const occurrences = dayTwo.digests.flatMap((d) =>
      d.items.map((item) => item.notice.occurrence)
    );
    expect(new Set(occurrences)).toEqual(new Set([2]));
    expect(dayTwo.digests.map((d) => d.recipientId).sort()).toEqual([
      'user-ana',
      'user-ben',
      'user-chloe',
    ]);
    expect(dayTwo.delivered).toBe(3);
    expect(h.channel.sent).toHaveLength(8);

    h.clock.advanceDays(1);
    const dayThree = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(dayThree.digests[0]?.items[0]?.notice.occurrence).toBe(3);
  });

  test('a notice someone already missed today is held for tomorrow', async () => {
    harness = await createDemoHarness();
    const h = harness;
    await goLive(h);
    await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });

    // Later the same day Chloe (anyone may re-date) pulls Juniper's
    // milestone in: it becomes at risk, but Ana and Ben already had
    // today's digest.
    const chloe = await actorFor(h, 'user-chloe');
    await h.engine.setMilestoneTargetDate(
      chloe,
      'ms-juniper-1',
      addDays(h.clock.today(), 3)
    );
    const later = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(noticeKeys(later.digests)).toEqual(['at_risk:ms-juniper-1']);
    expect(later.delivered).toBe(1);
    expect(later.alreadySent).toBe(2);
    expect(h.channel.sent.at(-1)?.recipientId).toBe('user-grace');

    h.clock.advanceDays(1);
    const tomorrow = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    const juniperRecipients = tomorrow.digests
      .filter((d) =>
        d.items.some((item) => item.notice.subjectId === 'ms-juniper-1')
      )
      .map((d) => d.recipientId)
      .sort();
    expect(juniperRecipients).toEqual(['user-ana', 'user-ben', 'user-grace']);
  });

  test('claims the digest as pending before sending, then records the outcome', async () => {
    const seen: string[] = [];
    const sent: Digest[] = [];
    const channel = {
      name: 'slack' as const,
      delivers: true,
      sent,
      async send(digest: Digest): Promise<DeliveryResult> {
        const rows = await h.store.listNotifications(WORKSPACE_ID, {
          limit: 50,
        });
        const row = rows.find((r) => r.recipientId === digest.recipientId);
        seen.push(`${digest.recipientId}:${row?.status ?? 'missing'}`);
        sent.push(digest);
        if (digest.recipientId === 'user-dev')
          throw new Error('socket hang up');
        return { status: 'sent', channel: 'slack', detail: null };
      },
    };
    harness = await createDemoHarness({ channel });
    const h = harness;
    await goLive(h);
    const result = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(seen.sort((a, b) => a.localeCompare(b))).toEqual(
      DAY_ONE_RECIPIENTS.map((id) => `${id}:pending`)
    );
    expect(result.delivered).toBe(4);
    expect(result.failed).toBe(1);
    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    expect(records.find((r) => r.recipientId === 'user-dev')).toMatchObject({
      status: 'failed',
      error: 'socket hang up',
    });
    expect(records.filter((r) => r.status === 'sent')).toHaveLength(4);
    expect(records.some((r) => r.status === 'pending')).toBe(false);
  });

  test('live without Slack records undeliverable, loudly', async () => {
    const outbox = Object.assign(createOutboxChannel(), {
      sent: [] as Digest[],
    });
    harness = await createDemoHarness({ channel: outbox });
    const h = harness;
    await goLive(h);
    const result = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(5);
    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(record.status).toBe('undeliverable');
      expect(record.channel).toBe('outbox');
      expect(record.error).toBe(SLACK_NOT_CONFIGURED);
    }
    expect(SLACK_NOT_CONFIGURED).toContain('Slack is not configured');
  });

  test('per-person delivery results are recorded as they come back', async () => {
    const channel = recordingChannel({
      result: (digest) =>
        digest.recipientId === 'user-dev'
          ? {
              status: 'undeliverable',
              channel: 'slack',
              detail: 'users_not_found',
            }
          : digest.recipientId === 'user-elena'
            ? {
                status: 'failed',
                channel: 'slack',
                detail: 'service_unavailable',
              }
            : { status: 'sent', channel: 'slack', detail: null },
    });
    harness = await createDemoHarness({ channel });
    const h = harness;
    await goLive(h);
    const result = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(result.delivered).toBe(3);
    expect(result.failed).toBe(2);
    const records = await h.engine.listNotifications(WORKSPACE_ID, 50);
    const byRecipient = new Map(records.map((r) => [r.recipientId, r]));
    expect(byRecipient.get('user-dev')).toMatchObject({
      status: 'undeliverable',
      error: 'users_not_found',
    });
    expect(byRecipient.get('user-elena')).toMatchObject({
      status: 'failed',
      error: 'service_unavailable',
    });
    expect(byRecipient.get('user-ana')).toMatchObject({
      status: 'sent',
      error: null,
    });
  });
});

// Review regressions: a notice nobody actually received must come back.
describe('notices that nobody received are not forgotten', () => {
  test('going live announces what preview runs already showed', async () => {
    harness = await createDemoHarness();
    const h = harness;
    // Preview: the daily run records digests nobody receives.
    const preview = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(noticeKeys(preview.digests)).toEqual(DAY_ONE_NOTICES);

    await goLive(h);
    // Today's digests were already recorded (as previews): still at most
    // one per person per day.
    const sameDay = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(sameDay.delivered).toBe(0);
    expect(sameDay.alreadySent).toBe(5);
    expect(h.channel.sent).toEqual([]);

    // The first live day announces everything still notable, not only
    // the overdue milestone that repeats anyway.
    h.clock.advanceDays(1);
    const live = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    const keys = noticeKeys(live.digests);
    for (const key of [
      'allocation_blocked:proj-delta',
      'allocation_blocked:proj-harbor',
      'at_risk:ms-compass-1',
      'invalid_due_soon:ms-harbor-1',
      'overdue:ms-atlas-2',
    ]) {
      expect(keys).toContain(key);
    }
    expect(live.delivered).toBe(live.digests.length);
    expect(h.channel.sent.length).toBe(live.digests.length);

    // Announced once: the next day repeats only the overdue milestone.
    h.clock.advanceDays(1);
    const after = noticeKeys(
      (await h.engine.runWarnings({ workspaceId: WORKSPACE_ID })).digests
    );
    expect(after).toContain('overdue:ms-atlas-2');
    for (const key of keys.filter((k) => !k.startsWith('overdue:'))) {
      expect(after).not.toContain(key);
    }
  });

  test('a failed delivery is retried tomorrow; an unreachable person holds nothing back', async () => {
    let slackDown = true;
    const channel = recordingChannel({
      result: (digest) =>
        digest.recipientId === 'user-dev'
          ? {
              status: 'undeliverable',
              channel: 'slack',
              detail: 'users_not_found',
            }
          : digest.recipientId === 'user-elena' && slackDown
            ? {
                status: 'failed',
                channel: 'slack',
                detail: 'service_unavailable',
              }
            : { status: 'sent', channel: 'slack', detail: null },
    });
    harness = await createDemoHarness({ channel });
    const h = harness;
    await goLive(h);
    const dayOne = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(dayOne.failed).toBe(2);
    const keysOf = (recipientId: string): string[] =>
      noticeKeys(dayOne.digests.filter((d) => d.recipientId === recipientId));
    const elenaKeys = keysOf('user-elena');
    expect(elenaKeys).toEqual([
      'allocation_blocked:proj-harbor',
      'invalid_due_soon:ms-harbor-1',
    ]);
    const devOnly = keysOf('user-dev').filter(
      (key) => !elenaKeys.includes(key) && !key.startsWith('overdue:')
    );
    expect(devOnly.length).toBeGreaterThan(0);

    slackDown = false;
    h.clock.advanceDays(1);
    const dayTwo = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    const keys = noticeKeys(dayTwo.digests);
    for (const key of elenaKeys) expect(keys).toContain(key);
    for (const key of devOnly) expect(keys).not.toContain(key);
    const elena = dayTwo.digests.find((d) => d.recipientId === 'user-elena');
    expect(noticeKeys(elena === undefined ? [] : [elena])).toEqual(elenaKeys);
  });

  test('live without a channel keeps every notice until one works', async () => {
    let configured = false;
    const sent: Digest[] = [];
    const channel = {
      name: 'slack' as const,
      get delivers(): boolean {
        return configured;
      },
      sent,
      send(digest: Digest): Promise<DeliveryResult> {
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
    await goLive(h);
    const dayOne = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(dayOne.failed).toBe(5);
    expect(sent).toEqual([]);

    configured = true;
    h.clock.advanceDays(1);
    const dayTwo = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    const keys = noticeKeys(dayTwo.digests);
    for (const key of [
      'allocation_blocked:proj-harbor',
      'at_risk:ms-compass-1',
      'invalid_due_soon:ms-harbor-1',
    ]) {
      expect(keys).toContain(key);
    }
    expect(dayTwo.delivered).toBe(dayTwo.digests.length);
    expect(sent.length).toBe(dayTwo.digests.length);
  });
  test('a notice with nobody to tell waits until someone can hear it', async () => {
    harness = await createDemoHarness();
    const h = harness;
    await goLive(h);
    const chloe = await actorFor(h, 'user-chloe');
    // No watchers, and Delta has no lead: its blocked notice reaches nobody.
    await h.engine.updateSettings(chloe, { watcherUserIds: [] });
    const dayOne = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    expect(noticeKeys(dayOne.digests)).not.toContain(
      'allocation_blocked:proj-delta'
    );

    await h.engine.updateSettings(chloe, { watcherUserIds: ['user-ana'] });
    h.clock.advanceDays(1);
    const dayTwo = await h.engine.runWarnings({ workspaceId: WORKSPACE_ID });
    const ana = dayTwo.digests.find((d) => d.recipientId === 'user-ana');
    expect(noticeKeys(ana === undefined ? [] : [ana])).toContain(
      'allocation_blocked:proj-delta'
    );
  });
});

describe('toldEarlierToday', () => {
  const notice = (key: string): Notice =>
    ({ subjectKind: 'milestone', subjectId: 'ms-1', key }) as Notice;
  const row = (
    status: NotificationRecord['status'],
    channel: NotificationRecord['channel'] = 'slack'
  ): NotificationRecord => ({
    id: 'n-1',
    workspaceId: WORKSPACE_ID,
    day: '2026-10-21',
    recipientId: 'user-ana',
    channel,
    status,
    digest: {
      recipientId: 'user-ana',
      recipientName: 'Ana',
      recipientEmail: null,
      day: '2026-10-21',
      items: [{ notice: notice('at_risk:2026-10-24') } as DigestItem],
    },
    error: null,
    createdAt: '2026-10-21T08:00:00.000Z',
  });
  const carried = notice('at_risk:2026-10-24');
  const redated = notice('at_risk:2026-10-31');

  test.each([
    ['a sent digest, live', row('sent'), 'live', true, false],
    [
      'a preview digest, preview',
      row('preview', 'outbox'),
      'preview',
      true,
      false,
    ],
    [
      'a preview digest after going live',
      row('preview', 'outbox'),
      'live',
      false,
      false,
    ],
    ['a send whose outcome is unknown', row('pending'), 'live', false, false],
    ['a failed send', row('failed'), 'live', false, false],
    [
      'live without a channel',
      row('undeliverable', 'outbox'),
      'live',
      false,
      false,
    ],
    ['a person Slack cannot reach', row('undeliverable'), 'live', true, true],
    ['no row', undefined, 'live', false, false],
  ] as const)('%s', (_label, record, mode, toldCarried, toldRedated) => {
    const told = toldEarlierToday(record, mode);
    expect(told(carried)).toBe(toldCarried);
    expect(told(redated)).toBe(toldRedated);
  });

  test('a malformed stored digest tells nothing', () => {
    const broken = { ...row('sent'), digest: {} as Digest };
    expect(toldEarlierToday(broken, 'live')(carried)).toBe(false);
  });
});
