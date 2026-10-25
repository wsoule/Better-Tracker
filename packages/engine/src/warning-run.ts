// runWarnings (§7, design §7.5, §6.8): plan today's notices against the
// remembered warning state, build one digest per recipient, record each in
// the notification log (one per person per day), deliver when the
// workspace is live and a channel can reach people, then save the warning
// memory.
//
// Guarantees:
// - One digest per person per day, at most once: the notification row is
//   claimed ('pending') before the send and updated with its outcome.
// - Memory is saved only after every notification is recorded, so a crash
//   mid-run re-announces instead of silently forgetting.
// - A notice that did not reach someone today keeps its previous memory
//   row, so it is announced again tomorrow instead of being lost: a
//   recipient already had a digest today that did not carry it (or whose
//   send never confirmed, 'pending'), a delivery failed (Slack down, bad
//   token), warnings are live with no channel configured, or the notice
//   had no recipient at all (no active lead, no watchers). A person Slack
//   cannot reach at all (undeliverable) does not hold the notice back:
//   that would repeat it to everyone else daily.
// - A second run the same day (a daily takeover after a killed run) counts
//   what today's delivered digests already told each person, so only the
//   notices someone may have missed come back tomorrow.

import {
  buildDigests,
  type Digest,
  type IsoDate,
  isValidIsoDate,
  type Notice,
  planWarnings,
  visibleDigest,
  type WarningMemory,
  type WarningsMode,
} from '@better-tracker/core';
import type { DeliveryResult } from '@better-tracker/notify';
import type {
  NotificationRecord,
  NotificationStatus,
} from '@better-tracker/store';

import { SLACK_SHARED_OFF, sharedSlackReason } from './fail-safes';
import { loadWorkspace } from './load';
import { type EngineRuntime, errorMessage } from './runtime';
import { type Actor, EngineInputError, type WarningRunResult } from './types';
import { viewerSnapshot } from './visibility';

/** Detail recorded when warnings are live but no channel is configured. */
export const SLACK_NOT_CONFIGURED: string =
  'Slack is not configured (SLACK_BOT_TOKEN is unset); the digest is kept in the outbox.';

function memoryKey(kind: WarningMemory['subjectKind'], id: string): string {
  return `${kind}\u0000${id}`;
}

/**
 * How many of today's notification rows a re-run reads back (one per
 * person). Rows past it read as "told nothing", which only repeats a
 * notice, never loses one.
 */
const TODAY_ROWS_LIMIT = 10_000;

// A notice's identity across runs: its subject and its dedupe key.
function noticeKey(
  notice: Pick<Notice, 'subjectKind' | 'subjectId' | 'key'>
): string {
  return `${notice.subjectKind}\u0000${notice.subjectId}\u0000${notice.key}`;
}

/**
 * For a recipient who already has today's notification row (an earlier
 * run the same day), which of today's notices that row already told them.
 * A digest that went out ('sent', or 'preview' while warnings are in
 * preview) told them the notices it carried with the same key. A person
 * Slack cannot reach at all holds nothing back, as on a first send.
 * Anything else told them nothing: 'pending' (the send's outcome is
 * unknown, so it is never repeated, but it does not count as told),
 * 'failed', live without a channel, or a preview from before going live.
 */
export function toldEarlierToday(
  row: NotificationRecord | undefined,
  mode: WarningsMode
): (notice: Notice) => boolean {
  if (row === undefined) return () => false;
  if (row.status === 'undeliverable' && row.channel === 'slack') {
    return () => true;
  }
  const delivered =
    row.status === 'sent' || (row.status === 'preview' && mode === 'preview');
  if (!delivered) return () => false;
  // Read defensively: a malformed stored digest tells nothing.
  const stored: unknown = row.digest;
  const items: unknown =
    typeof stored === 'object' && stored !== null
      ? (stored as { items?: unknown }).items
      : undefined;
  const told = new Set<string>();
  for (const item of Array.isArray(items) ? (items as unknown[]) : []) {
    const notice: unknown =
      typeof item === 'object' && item !== null
        ? (item as { notice?: unknown }).notice
        : undefined;
    if (typeof notice === 'object' && notice !== null) {
      told.add(noticeKey(notice as Notice));
    }
  }
  return (candidate) => told.has(noticeKey(candidate));
}

/** How a digest ends up: anything but the 'pending' claim. */
interface DeliveryOutcome {
  status: Exclude<NotificationStatus, 'pending'>;
  channel: 'slack' | 'outbox';
  error: string | null;
}

/** The engine's runWarnings. */
export async function runWarnings(
  rt: EngineRuntime,
  input: {
    workspaceId: string;
    day?: IsoDate;
    previewOnly?: boolean;
    viewer?: Actor;
  }
): Promise<WarningRunResult> {
  const { workspaceId } = input;
  if (input.day !== undefined && !isValidIsoDate(input.day)) {
    throw new EngineInputError(
      'invalid',
      'day must be a calendar date (YYYY-MM-DD).'
    );
  }
  const loaded = await loadWorkspace(rt, workspaceId, { today: input.day });
  const { snapshot, ctx, settings, assessments, allocationPlan } = loaded;
  const day = loaded.today;
  const log = rt.logger.child({ workspaceId, op: 'warnings', day });

  const memory = await rt.store.listWarningMemory(workspaceId);
  const plan = planWarnings({
    snapshot,
    ctx,
    assessments,
    allocationPlan,
    memory,
    watcherUserIds: settings.watcherUserIds,
  });
  const digests = buildDigests({
    snapshot,
    ctx,
    assessments,
    notices: plan.notices,
    appUrl: rt.config.appUrl,
  });
  const result: WarningRunResult = {
    workspaceId,
    day,
    mode: settings.warningsMode,
    notices: plan.notices.length,
    digests,
    delivered: 0,
    failed: 0,
    alreadySent: 0,
  };
  if (input.previewOnly === true) {
    // The Settings preview shows everyone's digests to the person asking,
    // so each one is narrowed to what that person may see (§2.13).
    if (input.viewer === undefined) return result;
    const { scope } = viewerSnapshot(snapshot, workspaceId, input.viewer);
    return {
      ...result,
      digests: digests
        .map((digest) => visibleDigest(snapshot, scope, digest))
        .filter((digest) => digest.items.length > 0),
    };
  }

  const channel = rt.deps.channel;
  // The Slack fail-safe (owner decision 2026-10-25): one bot never carries
  // digests while this planner may serve more than one workspace (checked
  // here too, since a second install may come after boot).
  const slackOff =
    settings.warningsMode === 'live' && channel.delivers
      ? await sharedSlackReason(rt.config, rt.store)
      : null;
  if (slackOff !== null) {
    log.warn('Slack is off: digests stay in the outbox', { reason: slackOff });
  }
  const delivering =
    settings.warningsMode === 'live' && channel.delivers && slackOff === null;

  // What a digest is recorded as when nothing is delivered: preview mode
  // keeps it in the outbox on purpose; live mode without a channel that
  // reaches people (or with Slack off by the fail-safe) is undeliverable,
  // loudly.
  const recordOnly = (): DeliveryOutcome =>
    settings.warningsMode === 'live'
      ? {
          status: 'undeliverable',
          channel: 'outbox',
          error: slackOff === null ? SLACK_NOT_CONFIGURED : SLACK_SHARED_OFF,
        }
      : { status: 'preview', channel: 'outbox', error: null };

  // Sends one digest; a thrown send counts as a failed delivery.
  const send = async (digest: Digest): Promise<DeliveryOutcome> => {
    let sent: DeliveryResult;
    try {
      sent = await channel.send(digest, {
        appName: rt.config.appName,
        appUrl: rt.config.appUrl,
      });
    } catch (error) {
      return {
        status: 'failed',
        channel: channel.name,
        error: errorMessage(error),
      };
    }
    return {
      status: sent.status,
      channel: sent.channel,
      error: sent.status === 'sent' ? null : sent.detail,
    };
  };

  const missedRecipients = new Set<string>();
  // Recipients who already had a row today, with what it told them.
  const toldBefore = new Map<string, (notice: Notice) => boolean>();
  let todayRows: Map<string, NotificationRecord> | null = null;
  for (const digest of digests) {
    const recipientLog = log.child({ recipientId: digest.recipientId });
    // Claim-first: the row is today's one digest for this person. When
    // delivering it is written as 'pending' and updated after the send, so
    // a crash mid-send never leads to a second digest the same day.
    const recorded = delivering ? null : recordOnly();
    const claimed = await rt.store.insertNotification({
      workspaceId,
      day,
      recipientId: digest.recipientId,
      channel: recorded?.channel ?? channel.name,
      status: recorded?.status ?? 'pending',
      digest,
      error: recorded?.error ?? null,
      now: rt.nowIso(),
    });
    if (!claimed) {
      result.alreadySent += 1;
      // Read once, on the first recipient who already has a row.
      todayRows ??= new Map(
        (
          await rt.store.listNotifications(workspaceId, {
            day,
            limit: TODAY_ROWS_LIMIT,
          })
        ).map((row) => [row.recipientId, row])
      );
      const earlier = todayRows.get(digest.recipientId);
      toldBefore.set(
        digest.recipientId,
        toldEarlierToday(earlier, settings.warningsMode)
      );
      recipientLog.info('recipient already had today\u2019s digest; not sent', {
        status: earlier?.status ?? null,
      });
      continue;
    }
    let outcome: DeliveryOutcome;
    if (recorded === null) {
      outcome = await send(digest);
      await rt.store.updateNotificationStatus({
        workspaceId,
        day,
        recipientId: digest.recipientId,
        channel: outcome.channel,
        status: outcome.status,
        error: outcome.error,
      });
    } else {
      outcome = recorded;
    }
    if (outcome.status === 'sent') {
      result.delivered += 1;
    } else if (
      outcome.status === 'failed' ||
      outcome.status === 'undeliverable'
    ) {
      // Live mode only: preview digests are recorded on purpose.
      result.failed += 1;
      recipientLog.warn('digest not delivered', {
        status: outcome.status,
        detail: outcome.error,
      });
      // Retry tomorrow unless this one person is unreachable for good.
      if (outcome.status === 'failed' || recorded !== null) {
        missedRecipients.add(digest.recipientId);
      }
    }
  }

  // Keep the previous memory for notices someone did not receive today,
  // and for notices nobody could receive (no active lead and no watchers):
  // they are told once someone can hear them, not remembered as sent.
  const held = new Set<string>();
  const missed = (id: string, notice: Notice): boolean => {
    if (missedRecipients.has(id)) return true;
    const told = toldBefore.get(id);
    return told !== undefined && !told(notice);
  };
  for (const notice of plan.notices) {
    if (
      notice.recipientIds.length === 0 ||
      notice.recipientIds.some((id) => missed(id, notice))
    ) {
      held.add(memoryKey(notice.subjectKind, notice.subjectId));
    }
  }
  const rows = plan.memory.filter(
    (row) => !held.has(memoryKey(row.subjectKind, row.subjectId))
  );
  await rt.store.saveWarningMemory(workspaceId, rows);
  log.info('warnings run finished', {
    mode: settings.warningsMode,
    notices: result.notices,
    digests: digests.length,
    delivered: result.delivered,
    failed: result.failed,
    alreadySent: result.alreadySent,
    heldNotices: held.size,
  });
  return result;
}
