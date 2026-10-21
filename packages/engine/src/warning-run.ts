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
//   recipient already had today's digest, a delivery failed (Slack down,
//   bad token), warnings are live with no channel configured, or the
//   notice had no recipient at all (no active lead, no watchers). A person
//   Slack cannot reach at all (undeliverable) does not hold the notice
//   back: that would repeat it to everyone else daily.

import {
  buildDigests,
  type Digest,
  type IsoDate,
  isValidIsoDate,
  planWarnings,
  type WarningMemory,
} from '@better-tracker/core';
import type { DeliveryResult } from '@better-tracker/notify';
import type { NotificationStatus } from '@better-tracker/store';

import { loadWorkspace } from './load';
import { type EngineRuntime, errorMessage } from './runtime';
import { EngineInputError, type WarningRunResult } from './types';

/** Detail recorded when warnings are live but no channel is configured. */
export const SLACK_NOT_CONFIGURED: string =
  'Slack is not configured (SLACK_BOT_TOKEN is unset); the digest is kept in the outbox.';

function memoryKey(kind: WarningMemory['subjectKind'], id: string): string {
  return `${kind}\u0000${id}`;
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
  input: { workspaceId: string; day?: IsoDate; previewOnly?: boolean }
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
  if (input.previewOnly === true) return result;

  const channel = rt.deps.channel;
  const delivering = settings.warningsMode === 'live' && channel.delivers;

  // What a digest is recorded as when nothing is delivered: preview mode
  // keeps it in the outbox on purpose; live mode without a channel that
  // reaches people is undeliverable, loudly.
  const recordOnly = (): DeliveryOutcome =>
    settings.warningsMode === 'live'
      ? {
          status: 'undeliverable',
          channel: 'outbox',
          error: SLACK_NOT_CONFIGURED,
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
      missedRecipients.add(digest.recipientId);
      recipientLog.info('recipient already had today\u2019s digest; not sent');
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
  for (const notice of plan.notices) {
    if (
      notice.recipientIds.length === 0 ||
      notice.recipientIds.some((id) => missedRecipients.has(id))
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
