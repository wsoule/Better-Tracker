// runDaily (§7): the scheduled job. Claims (workspace, 'daily', today) so
// it runs once per workspace-local day, then sync → allocation in the
// configured mode → warnings. If anything throws, the claim is released so
// the next scheduler tick can retry.

import { isValidTimeZone, todayIn } from '@better-tracker/core';

import { runAllocation } from './allocation-run';
import { type EngineRuntime, readSettings } from './runtime';
import { fullSync } from './sync';
import type { DailyResult } from './types';
import { runWarnings } from './warning-run';

export async function runDaily(
  rt: EngineRuntime,
  input: { workspaceId: string; force?: boolean }
): Promise<DailyResult> {
  const { workspaceId } = input;
  const force = input.force === true;
  const { settings: before } = await readSettings(rt, workspaceId);
  const timezone = isValidTimeZone(before.timezone)
    ? before.timezone
    : rt.config.defaultTimezone;
  const day = todayIn(timezone, rt.clock());
  const log = rt.logger.child({ workspaceId, op: 'daily', day, force });

  // A forced run still claims an unclaimed day so the schedule does not
  // run it a second time; it only skips the "already claimed" check.
  const claimed = await rt.store.claimJob(
    workspaceId,
    'daily',
    day,
    rt.nowIso()
  );
  if (!claimed && !force) {
    log.info('daily run already claimed for today; skipped');
    return {
      workspaceId,
      day,
      ran: false,
      sync: null,
      allocation: null,
      warnings: null,
    };
  }

  try {
    const sync = await fullSync(rt, workspaceId);
    // Settings may have just been bootstrapped by the sync.
    const { settings } = await readSettings(rt, workspaceId);
    const allocation = await runAllocation(rt, {
      workspaceId,
      mode: settings.allocationMode,
      trigger: 'schedule',
      actor: null,
      syncFirst: false,
    });
    const warnings = await runWarnings(rt, { workspaceId, day });
    log.info('daily run finished', {
      allocationStatus: allocation.status,
      notices: warnings.notices,
      delivered: warnings.delivered,
    });
    return { workspaceId, day, ran: true, sync, allocation, warnings };
  } catch (error) {
    log.error('daily run failed', { error });
    if (claimed) {
      try {
        await rt.store.releaseJob(workspaceId, 'daily', day);
      } catch (releaseError) {
        log.error('could not release the daily claim', { error: releaseError });
      }
    }
    throw error;
  }
}
