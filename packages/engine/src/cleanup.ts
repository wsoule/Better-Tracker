// cleanup() (§7.1, §9 `tick`): the housekeeping the worker runs at the
// start of every tick, before it lists and runs the workspaces.
//
// - Expired sessions are deleted. In real mode their Linear grants are
//   revoked, best effort: Linear may auto-revoke a user's oldest tokens
//   once they hold more than about 10 for one app, so grants of sessions
//   nobody can use any more must not pile up. A failed revocation is logged
//   and counted, never fatal (the session is gone either way).
// - Webhook delivery records older than WEBHOOK_RETENTION_DAYS are pruned.
//   Dedupe only needs Linear's retry window (about six hours); the longer
//   window keeps each delivery's processing error around to investigate.
// - Admission refusals (design doc §12, 2026-10-25; architecture §7
//   "Admission"): an installed workspace LINEAR_WORKSPACES no longer
//   admits is a soft gate. It is not served, but nothing is revoked,
//   ended or deleted here: a warn line per tick names it and the fix
//   (handleRefusedInstallations), and re-admitting it restores everything
//   as it was. Its sessions read as signed out until it is admitted again
//   or they expire (the expired-session step then revokes their grants).
//   When a URL key entry of the list is still unpinned, an active one gets
//   one read of its current URL key with the app token first (a rename no
//   sync has seen, since a refused workspace is never synced), which may
//   admit it again. A blocked workspace is a hard gate: one still
//   installed is revoked as 'removed', as the operator's `block` does.
// - Several workspaces (owner decision 2026-10-25): sessions of workspaces
//   uninstalled or removed that predate the revoke are ended (grants
//   revoked best effort); such workspaces are purged PURGE_AFTER_DAYS
//   after the revoke; notifications and job claims are pruned past their
//   retention. A 'grant_dead' workspace (Linear refused the app's token,
//   nobody asked for anything) keeps its sessions and is never purged
//   here. The audit log and the run log are never pruned (kept for good,
//   2026-10-22); the purge is what deletes them.
// - Every step is bounded per call in count. With a deadline (the worker
//   passes one: CleanupOptions) it is bounded in time too: work that calls
//   Linear (revocations, purges, identity reads) starts only when it ends
//   before the deadline even if every revocation takes its full timeout
//   (REVOKE_WORST_MS), so a slow Linear cannot use up the tick that every
//   workspace's sync and daily job wait for. Taking sessions from the
//   store deletes them, so a batch is sized to what the time left can
//   revoke: nothing taken is left unrevoked. A step cut short (by time or
//   by its count) is named in CleanupResult.deferred, and the next call
//   carries on.

import {
  OAUTH_TIMEOUT_MS,
  type OAuthClientConfig,
} from '@better-tracker/linear';
import type { RevokedReason } from '@better-tracker/store';

import {
  admission,
  refusedWorkspaces,
  unpinnedUrlKeyEntries,
} from './admission';
import { revokeGrant } from './auth';
import type { EngineRuntime } from './runtime';
import { refreshInstallationIdentity } from './sync';
import type { CleanupOptions, CleanupResult, CleanupStep } from './types';
import {
  endWorkspaceSessions,
  purgeRevokedWorkspace,
  revokeWorkspace,
  SESSION_REVOKE_CONCURRENCY,
} from './workspaces';

/** How long webhook delivery records are kept, in days. */
export const WEBHOOK_RETENTION_DAYS = 30;
/**
 * Days after an uninstall or an operator's remove before the workspace's
 * data is deleted (an engine constant, so the privacy page and the worker
 * always agree). A reinstall within them keeps everything.
 */
export const PURGE_AFTER_DAYS = 30;
/** How long notifications (digests, the outbox) are kept, in days. */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** How long daily job claims are kept, in days. */
export const JOB_CLAIM_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
/** Expired sessions taken from the store (and revoked) per call. */
const SESSION_BATCH = 50;
/**
 * At most this many expired sessions are revoked per cleanup, so a backlog
 * cannot stretch one tick past its timeout. The rest wait for the next
 * tick; being expired, they cannot be used meanwhile.
 */
const MAX_SESSIONS_PER_CLEANUP = 500;
/** Sessions of uninstalled or removed workspaces ended per cleanup. */
const MAX_WORKSPACE_SESSIONS_PER_CLEANUP = 500;
/** Workspaces purged per cleanup (each purge is one transaction). */
const MAX_PURGES_PER_CLEANUP = 3;
/** Notifications and job claims each deleted per cleanup, at most. */
const RETENTION_PRUNE_LIMIT = 2000;
/** The revoke reasons whose workspaces are ended and purged here. */
const ENDED_REASONS: readonly RevokedReason[] = ['uninstalled', 'removed'];
/**
 * The longest one grant revocation may take: one call to Linear's revoke
 * endpoint (revokeToken: OAUTH_TIMEOUT_MS, no retry) plus a second for the
 * rest. Batches are sized with it (Budget.sessionsThatFit).
 */
export const REVOKE_WORST_MS: number = OAUTH_TIMEOUT_MS + 1000;
/** What a purge's own transaction is allowed before its revocations. */
const PURGE_TRANSACTION_MS = 10_000;
/**
 * The least time left to start one identity read: an app token refresh at
 * most (one token endpoint call), then the read, which is cut off at the
 * deadline (a read leaves nothing behind).
 */
const IDENTITY_READ_MIN_MS = REVOKE_WORST_MS;

/**
 * One cleanup pass's time limit (CleanupOptions.deadline) on the engine's
 * clock. Without a deadline everything fits.
 */
interface Budget {
  /** Milliseconds left before the deadline (Infinity without one). */
  leftMs(): number;
  /** The whole pass's length (Infinity without a deadline). */
  readonly totalMs: number;
  /**
   * How many sessions can be taken now so that revoking them all,
   * `parallel` at a time at REVOKE_WORST_MS each, ends before the deadline.
   */
  sessionsThatFit(parallel: number): number;
}

function budgetFor(rt: EngineRuntime, options: CleanupOptions): Budget {
  const deadline = options.deadline;
  const deadlineMs = deadline === undefined ? null : deadline.getTime();
  const startedMs = rt.clock().getTime();
  const leftMs = (): number =>
    deadlineMs === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, deadlineMs - rt.clock().getTime());
  return {
    leftMs,
    totalMs:
      deadlineMs === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, deadlineMs - startedMs),
    sessionsThatFit: (parallel) => {
      const left = leftMs();
      if (left === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
      if (left <= 0) return 0;
      return Math.floor(left / REVOKE_WORST_MS) * parallel;
    },
  };
}

// Adds a step to the result's deferred list once.
function defer(result: CleanupResult, step: CleanupStep): void {
  const deferred = (result.deferred ??= []);
  if (!deferred.includes(step)) deferred.push(step);
}

// Takes expired sessions in batches and revokes each one's Linear grant,
// adding to `result`. Each batch is at most what the time left can revoke
// one after another (Budget.sessionsThatFit), since taking it deletes it.
// Stops at a short batch (nothing left), the cap or the deadline (the last
// two defer the step).
async function revokeExpiredSessions(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  now: Date,
  budget: Budget,
  result: CleanupResult
): Promise<void> {
  const nowIso = now.toISOString();
  for (;;) {
    if (result.expiredSessions >= MAX_SESSIONS_PER_CLEANUP) {
      defer(result, 'expired_sessions');
      return;
    }
    const limit = Math.min(
      SESSION_BATCH,
      MAX_SESSIONS_PER_CLEANUP - result.expiredSessions,
      budget.sessionsThatFit(1)
    );
    if (limit <= 0) {
      defer(result, 'expired_sessions');
      return;
    }
    const batch = await rt.store.takeExpiredSessions(nowIso, limit);
    result.expiredSessions += batch.length;
    for (const session of batch) {
      const revoked = await revokeGrant(rt, oauth, session.tokens);
      if (revoked.ok) {
        result.revokedTokens += 1;
        continue;
      }
      result.revokeFailures += 1;
      rt.logger.warn("could not revoke an expired session's Linear token", {
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: session.id,
        error: revoked.error,
      });
    }
    if (batch.length < limit) return;
  }
}

/** What handleRefusedInstallations found and did. */
export interface RefusedInstallations {
  /** Blocked workspaces whose installation it revoked as 'removed'. */
  removed: string[];
  /** Installed workspaces LINEAR_WORKSPACES does not admit, left as they are. */
  notServed: string[];
  /**
   * Installed workspaces LINEAR_WORKSPACES admits again once their URL key
   * was read from Linear (refreshIdentity).
   */
  reAdmitted: string[];
  /** An identity read was left for the next call (no time left). */
  refreshDeferred: boolean;
}

/** What one identity read of a refused installation came to. */
type IdentityRefresh = 'admitted' | 'refused' | 'no_time';

// Waits for `work` at most `ms` (no limit when infinite); TIMED_OUT past it.
// The work itself goes on unwatched, so only a read may be cut off here.
const TIMED_OUT: unique symbol = Symbol('timed out');
async function within<T>(
  work: Promise<T>,
  ms: number
): Promise<T | typeof TIMED_OUT> {
  if (ms === Number.POSITIVE_INFINITY) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One read of a refused installation's organization with the app token
 * (forApp, then whoAmI), for an active installation LINEAR_WORKSPACES
 * refuses while one of its URL key entries is still unpinned: a rename no
 * sync has seen leaves the installation's URL key stale, and a refused
 * workspace is never synced, so nothing else refreshes it until someone
 * signs in. Keeps the name and URL key current
 * (refreshInstallationIdentity), then re-checks admission fresh, which
 * pins the entry when it matches the key now. The read is cut off at the
 * deadline. Nothing is revoked, ended or deleted; a failure is logged
 * (the workspace stays refused, and the next call reads again).
 */
async function refreshIdentity(
  rt: EngineRuntime,
  workspaceId: string,
  budget: Budget
): Promise<IdentityRefresh> {
  if (budget.leftMs() < IDENTITY_READ_MIN_MS) return 'no_time';
  const readAt = rt.nowIso();
  try {
    const gateway = await rt.linear.forApp(workspaceId);
    const identity = await within(gateway.whoAmI(), budget.leftMs());
    if (identity === TIMED_OUT) {
      rt.logger.warn(
        "could not read a refused workspace's URL key from Linear in time",
        { workspaceId }
      );
      return 'no_time';
    }
    if (identity.workspace.id !== workspaceId) {
      rt.logger.warn(
        "Linear answered for another workspace when asked for a refused workspace's URL key",
        { workspaceId }
      );
      return 'refused';
    }
    await refreshInstallationIdentity(
      rt,
      workspaceId,
      identity.workspace,
      readAt
    );
    const verdict = await admission(
      rt,
      { id: workspaceId, urlKey: identity.workspace.urlKey, installed: true },
      { fresh: true }
    );
    return verdict === 'ok' ? 'admitted' : 'refused';
  } catch (error) {
    rt.logger.warn("could not read a refused workspace's URL key from Linear", {
      workspaceId,
      error,
    });
    return 'refused';
  }
}

/**
 * The installed workspaces admission refuses now (fresh read). A blocked
 * one with an active installation is revoked as 'removed' (revokeWorkspace:
 * credentials wiped, its cached mirror forgotten; warn), so a block stays
 * a hard gate even for a workspace that matched a URL-key block only after
 * the operator's `block`. An active one LINEAR_WORKSPACES refuses while a
 * URL key entry is still unpinned gets one identity read first
 * (refreshIdentity, at most once per call), so a rename no sync has seen
 * cannot keep it refused. One LINEAR_WORKSPACES does not admit then
 * (active, or revoked as grant_dead) is only warned about, every call,
 * with its id and the fix: nothing is revoked, ended or deleted, so
 * putting it back on the list restores it as it was, and only the
 * operator's `remove`, `block` or `purge` take it away. OAuth mode only
 * (refusedWorkspaces is empty otherwise).
 */
export async function handleRefusedInstallations(
  rt: EngineRuntime,
  options: CleanupOptions = {}
): Promise<RefusedInstallations> {
  const outcome: RefusedInstallations = {
    removed: [],
    notServed: [],
    reAdmitted: [],
    refreshDeferred: false,
  };
  const budget = budgetFor(rt, options);
  const refused = await refusedWorkspaces(rt);
  const unpinned = refused.some(
    (entry) =>
      entry.verdict === 'not_allowed' &&
      entry.status.installation?.revokedAt === null
  )
    ? await unpinnedUrlKeyEntries(rt)
    : [];
  for (const { workspaceId, verdict, status } of refused) {
    const installation = status.installation;
    if (installation === null) continue;
    if (verdict === 'blocked') {
      if (installation.revokedAt !== null) continue;
      if (!(await revokeWorkspace(rt, workspaceId, 'removed'))) continue;
      rt.logger.warn('removed a blocked workspace; its app token is wiped', {
        workspaceId,
        admission: verdict,
      });
      outcome.removed.push(workspaceId);
      continue;
    }
    const reason = installation.revokedReason ?? 'grant_dead';
    if (installation.revokedAt !== null && reason !== 'grant_dead') continue;
    if (installation.revokedAt === null && unpinned.length > 0) {
      const refreshed = await refreshIdentity(rt, workspaceId, budget);
      if (refreshed === 'admitted') {
        rt.logger.info(
          'LINEAR_WORKSPACES admits an installed workspace again: its URL key, read from Linear now, matches an entry',
          { workspaceId }
        );
        outcome.reAdmitted.push(workspaceId);
        continue;
      }
      if (refreshed === 'no_time') outcome.refreshDeferred = true;
    }
    rt.logger.warn(
      `${workspaceId} is installed but LINEAR_WORKSPACES does not admit it: it is not served, and nothing is removed automatically; add it to LINEAR_WORKSPACES to serve it again, or run 'remove --workspace ${workspaceId}' to uninstall it`,
      {
        workspaceId,
        admission: verdict,
        installation: installation.revokedAt === null ? 'active' : reason,
        variable: 'LINEAR_WORKSPACES',
      }
    );
    outcome.notServed.push(workspaceId);
  }
  return outcome;
}

// Ends the sessions of workspaces uninstalled or removed that were created
// before the revoke, revoking each grant (endWorkspaceSessions: bounded
// concurrency, failures logged without tokens), up to
// MAX_WORKSPACE_SESSIONS_PER_CLEANUP, each batch at most what the time
// left can revoke. A session created after the revoke is kept: an admin
// who signed in to reinstall. Personal API keys keep no sessions here, so
// the step does nothing then.
async function endRevokedWorkspaceSessions(
  rt: EngineRuntime,
  budget: Budget,
  result: CleanupResult
): Promise<void> {
  if (rt.config.auth === 'api_key') return;
  const statuses = await rt.store.listWorkspaceStatus();
  for (const status of statuses) {
    const ended = result.endedWorkspaceSessions ?? 0;
    const installation = status.installation;
    if (
      installation === null ||
      installation.revokedAt === null ||
      installation.revokedReason === null ||
      !ENDED_REASONS.includes(installation.revokedReason) ||
      status.sessionCount === 0
    ) {
      continue;
    }
    if (
      ended >= MAX_WORKSPACE_SESSIONS_PER_CLEANUP ||
      budget.sessionsThatFit(SESSION_REVOKE_CONCURRENCY) <= 0
    ) {
      defer(result, 'workspace_sessions');
      return;
    }
    const ending = await endWorkspaceSessions(rt, status.workspaceId, {
      createdBefore: installation.revokedAt,
      max: MAX_WORKSPACE_SESSIONS_PER_CLEANUP - ended,
      batchLimit: () => budget.sessionsThatFit(SESSION_REVOKE_CONCURRENCY),
      why:
        installation.revokedReason === 'uninstalled'
          ? 'a session of an uninstalled workspace'
          : 'a session of a removed workspace',
    });
    if (ending.cutShort) defer(result, 'workspace_sessions');
    result.endedWorkspaceSessions = ended + ending.ended;
    result.revokedTokens += ending.revokedTokens;
    result.revokeFailures += ending.revokeFailures;
    if (ending.ended > 0) {
      rt.logger.info('ended the sessions of a revoked workspace', {
        workspaceId: status.workspaceId,
        reason: installation.revokedReason,
        sessions: ending.ended,
      });
    }
  }
}

// Purges workspaces uninstalled or removed more than PURGE_AFTER_DAYS ago,
// oldest revoke first, at most MAX_PURGES_PER_CLEANUP per call (the rest
// wait for the next tick). The store re-checks the revoke under a row lock
// and deletes the remaining sessions in the same transaction, so a
// reinstall racing the purge wins and keeps every session (the installer's
// too); purgeRevokedWorkspace revokes the deleted sessions' grants after
// the commit and logs the id only. A purge starts only when its
// transaction and the revocation of every session it would delete end
// before the deadline (their number is known from the listing): the rest
// wait. One that could not fit even a whole pass is logged with the
// operator's purge, which has the whole tick. 'grant_dead' is never purged
// here (only by the operator's purge).
async function purgeRevokedWorkspaces(
  rt: EngineRuntime,
  now: Date,
  budget: Budget,
  result: CleanupResult
): Promise<void> {
  if (rt.config.auth === 'api_key') return;
  const revokedBefore = new Date(
    now.getTime() - PURGE_AFTER_DAYS * DAY_MS
  ).toISOString();
  const cutoffMs = Date.parse(revokedBefore);
  const due = (await rt.store.listWorkspaceStatus())
    .flatMap((status) => {
      const installation = status.installation;
      if (
        installation === null ||
        installation.revokedAt === null ||
        installation.revokedReason === null ||
        !ENDED_REASONS.includes(installation.revokedReason) ||
        Date.parse(installation.revokedAt) >= cutoffMs
      ) {
        return [];
      }
      return [
        {
          workspaceId: status.workspaceId,
          at: installation.revokedAt,
          sessions: status.sessionCount,
        },
      ];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (due.length > MAX_PURGES_PER_CLEANUP) defer(result, 'purges');
  for (const { workspaceId, sessions } of due.slice(
    0,
    MAX_PURGES_PER_CLEANUP
  )) {
    // The transaction, then every session it deletes revoked
    // SESSION_REVOKE_CONCURRENCY at a time at their longest.
    const needMs =
      PURGE_TRANSACTION_MS +
      Math.ceil(sessions / SESSION_REVOKE_CONCURRENCY) * REVOKE_WORST_MS;
    if (needMs > budget.leftMs()) {
      defer(result, 'purges');
      if (needMs > budget.totalMs) {
        rt.logger.warn(
          `a purge is due but revoking its sessions could take longer than cleanup's time limit; run 'purge --workspace ${workspaceId}' to purge it now`,
          { workspaceId, sessions }
        );
      }
      continue;
    }
    const { result: purge, ending } = await purgeRevokedWorkspace(
      rt,
      workspaceId,
      { revokedBefore }
    );
    result.revokedTokens += ending.revokedTokens;
    result.revokeFailures += ending.revokeFailures;
    if (purge.purged) {
      result.purgedWorkspaces = (result.purgedWorkspaces ?? 0) + 1;
    }
  }
}

// Notifications older than NOTIFICATION_RETENTION_DAYS and job claims older
// than JOB_CLAIM_RETENTION_DAYS, at most RETENTION_PRUNE_LIMIT of each per
// call (oldest first; a backlog clears over a few ticks).
async function pruneRetention(
  rt: EngineRuntime,
  now: Date,
  result: CleanupResult
): Promise<void> {
  const daysAgo = (days: number): string =>
    new Date(now.getTime() - days * DAY_MS).toISOString();
  result.oldNotifications = await rt.store.pruneNotifications(
    daysAgo(NOTIFICATION_RETENTION_DAYS),
    RETENTION_PRUNE_LIMIT
  );
  result.oldJobClaims = await rt.store.pruneJobClaims(
    daysAgo(JOB_CLAIM_RETENTION_DAYS),
    RETENTION_PRUNE_LIMIT
  );
}

/**
 * Deletes expired sessions (revoking their grants) and old deliveries,
 * prunes notifications and job claims, ends the sessions of uninstalled
 * or removed workspaces and purges such workspaces once their grace is
 * over; removes blocked installations, reads the URL key of installed ones
 * LINEAR_WORKSPACES refuses for want of a current key, and warns about the
 * ones it still does not admit (the module comment above). With
 * `options.deadline`, work that calls Linear stops before it.
 */
export async function cleanup(
  rt: EngineRuntime,
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  const now = rt.clock();
  const budget = budgetFor(rt, options);
  const result: CleanupResult = {
    expiredSessions: 0,
    revokedTokens: 0,
    revokeFailures: 0,
    oldDeliveries: 0,
    endedWorkspaceSessions: 0,
    purgedWorkspaces: 0,
    oldNotifications: 0,
    oldJobClaims: 0,
    notServedWorkspaces: 0,
    reAdmittedWorkspaces: 0,
    deferred: [],
  };
  const refused = await handleRefusedInstallations(rt, options);
  result.notServedWorkspaces = refused.notServed.length;
  result.reAdmittedWorkspaces = refused.reAdmitted.length;
  if (refused.refreshDeferred) defer(result, 'identity_reads');
  const oauth = rt.config.oauth;
  if (
    rt.linear.mode === 'fixture' ||
    rt.config.auth === 'api_key' ||
    oauth === null
  ) {
    // Demo sessions carry no real Linear grant to revoke, and personal API
    // keys keep no sessions here (and have nothing to revoke, F5).
    result.expiredSessions = await rt.store.deleteExpiredSessions(
      now.toISOString()
    );
  } else {
    await revokeExpiredSessions(rt, oauth, now, budget, result);
  }
  result.oldDeliveries = await rt.store.pruneWebhookDeliveries(
    new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS).toISOString()
  );
  await pruneRetention(rt, now, result);
  await endRevokedWorkspaceSessions(rt, budget, result);
  await purgeRevokedWorkspaces(rt, now, budget, result);
  rt.logger.info('cleanup finished', { ...result });
  return result;
}
