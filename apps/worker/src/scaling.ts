// How a run over every workspace is scheduled (architecture §9 "Scaling";
// owner decision 2026-10-25: one deployment serves several Linear
// workspaces). Pure functions of the engine's workspace overview
// (listWorkspaceStatus) and a clock, so each rule is unit-tested:
//
// - which workspaces a run works on: active, admitted installations; the
//   others are skipped (uninstalled, removed, blocked, not admitted) or,
//   for a dead app grant, reported as failed;
// - in what order: least recently attempted full sync first (the later of
//   the attempt's start and its finish, so a workspace whose sync was
//   killed with its tick goes after the ones that tick never reached),
//   never attempted first, so a run cut short never starves the same ones;
// - whether there is time left to start one before the run's deadline;
// - when a tick's plain resync is not needed (a recent successful one);
// - when a workspace's failure is chronic (warned about, not failed).

import type { WorkspaceOverview } from '@better-tracker/engine';

const MINUTE_MS = 60_000;

/** Least time left to start a workspace at all. */
export const MIN_START_MS: number = 3 * MINUTE_MS;
/** Least time left to start a daily job (sync, allocation, warnings). */
export const MIN_DAILY_START_MS: number = 5 * MINUTE_MS;
/**
 * What a start never asks for beyond the whole budget: a need larger than
 * the budget minus this could never be met, so it is capped there and the
 * workspace still starts at the beginning of a run (see startNeedMs).
 */
export const START_MARGIN_MS: number = MINUTE_MS;
/** A tick's plain resync is skipped after a successful one this recent. */
export const RECENT_SYNC_MS: number = 10 * MINUTE_MS;
/** A failure is chronic after this long without a successful full sync. */
export const CHRONIC_AFTER_MS: number = 24 * 60 * MINUTE_MS;

/** Why a run over every workspace leaves one out without failing. */
export type SkipReason = 'blocked' | 'not admitted' | 'uninstalled' | 'removed';

/** What a run over every workspace does with one of them. */
export type WorkspacePlan =
  | { kind: 'run'; workspaceId: string; status: WorkspaceOverview }
  | { kind: 'skip'; workspaceId: string; reason: SkipReason }
  /** Revoked as `grant_dead` (Linear refused the app's token): a failure. */
  | { kind: 'grant_dead'; workspaceId: string };

/**
 * The plan for one workspace, or null for one nobody installed (people
 * signed in, no installation: nothing for the worker to do). A block or a
 * refusal by LINEAR_WORKSPACES wins over a revoke, so a workspace taken
 * out of the list never fails a run, whatever happened to its grant.
 */
export function planFor(status: WorkspaceOverview): WorkspacePlan | null {
  const { workspaceId, installation } = status;
  if (installation === null) return null;
  if (status.admission === 'blocked') {
    return { kind: 'skip', workspaceId, reason: 'blocked' };
  }
  if (status.admission === 'not_allowed') {
    return { kind: 'skip', workspaceId, reason: 'not admitted' };
  }
  if (installation.revokedAt !== null) {
    const reason = installation.revokedReason ?? 'grant_dead';
    return reason === 'grant_dead'
      ? { kind: 'grant_dead', workspaceId }
      : { kind: 'skip', workspaceId, reason };
  }
  return { kind: 'run', workspaceId, status };
}

// Epoch ms of an ISO time; -Infinity for none or an unreadable one.
function epochMs(at: string | null | undefined): number {
  const ms = at === null || at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

// Epoch ms of the last full sync attempt: the later of when it started
// and when it finished. An attempt killed with its process recorded only
// its start, which must count, or the workspace would look least recently
// attempted and go first on every tick, ahead of the ones its kill kept
// from running. -Infinity when never attempted, so those sort first.
// Only the ordering reads the start: backoff, the chronic rule and the
// skip-recent rule read finished attempts (lastSuccessAt).
function lastAttemptMs(status: WorkspaceOverview): number {
  return Math.max(
    epochMs(status.sync?.lastFullSyncAt),
    epochMs(status.sync?.lastFullSyncStartedAt)
  );
}

/**
 * Plans every workspace the overview lists: the ones to run first, least
 * recently attempted first (never attempted first; ties keep the engine's
 * order), then the skipped and failed ones in the engine's order.
 */
export function planWorkspaces(
  statuses: readonly WorkspaceOverview[]
): WorkspacePlan[] {
  const plans = statuses
    .map(planFor)
    .filter((plan): plan is WorkspacePlan => plan !== null);
  const runs = plans
    .filter(
      (plan): plan is Extract<WorkspacePlan, { kind: 'run' }> =>
        plan.kind === 'run'
    )
    .map((plan, index) => ({ plan, index, at: lastAttemptMs(plan.status) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1))
    .map(({ plan }) => plan);
  return [...runs, ...plans.filter((plan) => plan.kind !== 'run')];
}

// The most a start may ask for within a run of `budgetMs`.
function startCapMs(budgetMs: number): number {
  return Math.max(0, budgetMs - START_MARGIN_MS);
}

/**
 * What a workspace wants left before it starts: max(3 min, 2 × its last
 * full sync's duration), so a slow one is not cut off by the deadline
 * half way (which strands its daily claim and allocation run).
 */
export function startWantedMs(lastFullSyncMs: number | null): number {
  return Math.max(MIN_START_MS, 2 * Math.max(0, lastFullSyncMs ?? 0));
}

/**
 * The time left a workspace needs before a run of `budgetMs` starts it:
 * startWantedMs, capped at the budget minus START_MARGIN_MS. Without the
 * cap a workspace whose doubled duration exceeds the budget (or any
 * workspace under a TICK_TIMEOUT_MINUTES below 4) would never start
 * again, and since only a successful sync records a new duration, one
 * slow sync would stop it for good. Capped, it starts at the beginning of
 * a run.
 */
export function startNeedMs(
  lastFullSyncMs: number | null,
  budgetMs: number
): number {
  return Math.min(startWantedMs(lastFullSyncMs), startCapMs(budgetMs));
}

/** The time left a daily job needs to start (5 min, capped like a start). */
export function dailyStartNeedMs(budgetMs: number): number {
  return Math.min(MIN_DAILY_START_MS, startCapMs(budgetMs));
}

/**
 * Milliseconds since the workspace's last successful full sync finished
 * when that is less than RECENT_SYNC_MS ago, else null. A finish time in
 * the future (clock skew) is not recent.
 */
export function recentSyncAgeMs(
  status: WorkspaceOverview | null,
  now: Date
): number | null {
  const at = status?.sync?.lastSuccessAt ?? null;
  if (at === null) return null;
  const age = now.getTime() - Date.parse(at);
  return age >= 0 && age < RECENT_SYNC_MS ? age : null;
}

/**
 * Whether a failure in this run is chronic: the run's own sync did not
 * succeed, and the workspace's last successful full sync finished more
 * than CHRONIC_AFTER_MS before `now` (or it never had one and was
 * installed more than that long ago). `status` is the overview read when
 * the run started. A chronic failure is warned about and does not fail
 * the tick: the cron turns red when a workspace starts failing, not again
 * every 15 minutes while someone looks into it.
 */
export function isChronic(status: WorkspaceOverview, now: Date): boolean {
  const cutoff = now.getTime() - CHRONIC_AFTER_MS;
  const lastSuccess = status.sync?.lastSuccessAt ?? null;
  if (lastSuccess !== null) return Date.parse(lastSuccess) < cutoff;
  const installedAt = status.installation?.createdAt ?? null;
  return installedAt !== null && Date.parse(installedAt) < cutoff;
}

/** A duration for people: `45 s`, `3 min`, `2.5 min`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'no limit';
  if (ms < MINUTE_MS) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const minutes = Math.round((ms / MINUTE_MS) * 10) / 10;
  return `${minutes} min`;
}
