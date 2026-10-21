// runDaily (§7): the scheduled job. Claims (workspace, 'daily', today) so
// it runs once per workspace-local day, then sync → allocation in the
// configured mode → warnings, and marks the claim finished.
//
// The claim is a lease. If anything throws, it is released so the next
// scheduler tick can retry. If the process dies instead (killed, or the
// worker's hard timeout), the claim stays unfinished; once it is older
// than the lease (config.dailyLeaseMinutes, longer than any tick can
// live) the next tick takes the day over and runs the whole job again,
// which is safe at any point the first run stopped: allocation never
// reassigns an assigned issue, and nobody gets a second digest that day.

import { isValidTimeZone, todayIn } from '@better-tracker/core';

import { runAllocation } from './allocation-run';
import { DEFAULT_DAILY_LEASE_MINUTES } from './config';
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

  // A forced run still claims an unclaimed (or abandoned) day so the
  // schedule does not run it a second time; it only skips the "already
  // claimed" check. The claim time identifies this claim when it is
  // finished or released, so a run whose claim was taken over never
  // touches the new holder's.
  const claimedAt = rt.nowIso();
  const leaseMinutes =
    rt.config.dailyLeaseMinutes ?? DEFAULT_DAILY_LEASE_MINUTES;
  const claimed = await rt.store.claimJob(
    workspaceId,
    'daily',
    day,
    claimedAt,
    { leaseMinutes }
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

  let result: DailyResult;
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
    result = { workspaceId, day, ran: true, sync, allocation, warnings };
  } catch (error) {
    log.error('daily run failed', { error });
    if (claimed) {
      try {
        await rt.store.releaseJob(workspaceId, 'daily', day, claimedAt);
      } catch (releaseError) {
        log.error('could not release the daily claim', { error: releaseError });
      }
    }
    throw error;
  }

  if (claimed) {
    // A failure here does not undo the run: the claim stays unfinished
    // and, after the lease, a later tick repeats the (idempotent) job.
    try {
      const finished = await rt.store.finishJob(workspaceId, 'daily', day, {
        claimedAt,
        at: rt.nowIso(),
      });
      if (!finished) {
        log.warn(
          'the daily claim was taken over before this run finished; the other run repeats the job',
          { leaseMinutes }
        );
      }
    } catch (error) {
      log.error('could not mark the daily claim finished', { error });
    }
  }
  return result;
}
