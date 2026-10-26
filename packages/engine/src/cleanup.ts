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
//   admits is a soft gate. It is not served, but the planner revokes, ends
//   and deletes nothing of it by its own choice: a warn line per tick names
//   it and the fix (handleRefusedInstallations), and re-admitting it
//   restores everything as it was. Its sessions read as signed out until
//   it is admitted again or they expire (the expired-session step then
//   revokes their grants). When a URL key entry of the list is still
//   unpinned, active ones get a read of their current URL key with the app
//   token (a rename no sync has seen, since a refused workspace is never
//   synced), which may admit them again: last in the pass, a few per tick,
//   the ones checked longest ago first. A dead app grant Linear refuses in
//   that read is recorded as grant_dead, as for any installed workspace. A
//   blocked workspace is a hard gate: one still installed is revoked as
//   'removed' first, as the operator's `block` does.
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
//   workspace's sync and daily job wait for. The identity reads come last
//   and each waits IDENTITY_READ_MAX_MS at most, so they cannot take the
//   time of the revocations and purges either. Taking sessions from the
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
  type RefusedWorkspace,
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
/** How long one identity read waits for Linear's answer, at most. */
const IDENTITY_READ_MAX_MS = 10_000;
/**
 * Identity reads per cleanup, at most: the rest wait for the next ticks,
 * the ones checked longest ago first.
 */
const MAX_IDENTITY_READS_PER_CLEANUP = 5;

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

/** What the refused-installation steps found and did. */
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
  /**
   * Identity reads were left for the next call: no time left, or more
   * candidates than MAX_IDENTITY_READS_PER_CLEANUP.
   */
  readsDeferred: boolean;
}

/** What one identity read of a refused installation came to. */
type IdentityRefresh = 'admitted' | 'refused' | 'failed' | 'no_time';

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

// Records that an identity read was tried at `at` and whether it worked
// (store.recordUrlKeyCheck), so the next pass reads the others first;
// returns the failed tries in a row, or null when it could not be recorded
// (logged).
async function recordCheck(
  rt: EngineRuntime,
  workspaceId: string,
  check: { at: string; ok: boolean }
): Promise<number | null> {
  try {
    return await rt.store.recordUrlKeyCheck(workspaceId, check);
  } catch (error) {
    rt.logger.warn('could not record a URL key read from Linear', {
      workspaceId,
      error,
    });
    return null;
  }
}

/** Why an identity read did not give a usable answer, for its log line. */
interface ReadFailure {
  message: string;
  error?: unknown;
}

/**
 * One read of a refused installation's organization with the app token
 * (forApp, then whoAmI), for an active installation LINEAR_WORKSPACES
 * refuses while one of its URL key entries is still unpinned: a rename no
 * sync has seen leaves the installation's URL key stale, and a refused
 * workspace is never synced, so nothing else refreshes it until someone
 * signs in. Keeps the name and URL key current
 * (refreshInstallationIdentity), then re-checks admission fresh, which
 * pins the entry when it matches the key now.
 *
 * It starts only with IDENTITY_READ_MIN_MS left (forApp may refresh the
 * app token, which writes the rotated tokens and is never cut off), and
 * Linear's answer is waited for at most IDENTITY_READ_MAX_MS and never
 * past the deadline. Every read asked of Linear is recorded
 * (recordCheck), so the next pass reads the others first. A failure is
 * logged at warn the first time in a row and at info after that (the
 * store counts them: the worker exits after every tick); the workspace
 * stays refused and is read again in its turn. Nothing is revoked or
 * ended by the planner's choice; a dead app grant Linear refuses in
 * forApp's refresh is recorded as grant_dead, as for any installed
 * workspace.
 */
async function refreshIdentity(
  rt: EngineRuntime,
  workspaceId: string,
  budget: Budget
): Promise<IdentityRefresh> {
  if (budget.leftMs() < IDENTITY_READ_MIN_MS) return 'no_time';
  const readAt = rt.nowIso();
  let outcome: IdentityRefresh;
  let failure: ReadFailure | null = null;
  try {
    const gateway = await rt.linear.forApp(workspaceId);
    const left = budget.leftMs();
    if (left <= 0) return 'no_time';
    const wait = Math.min(IDENTITY_READ_MAX_MS, left);
    const identity = await within(gateway.whoAmI(), wait);
    if (identity === TIMED_OUT) {
      failure = {
        message:
          "could not read a refused workspace's URL key from Linear in time",
      };
      // Cut off by the deadline rather than the wait: the rest waits too.
      outcome = wait < IDENTITY_READ_MAX_MS ? 'no_time' : 'failed';
    } else if (identity.workspace.id !== workspaceId) {
      failure = {
        message:
          "Linear answered for another workspace when asked for a refused workspace's URL key",
      };
      outcome = 'failed';
    } else {
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
      outcome = verdict === 'ok' ? 'admitted' : 'refused';
    }
  } catch (error) {
    failure = {
      message: "could not read a refused workspace's URL key from Linear",
      error,
    };
    outcome = 'failed';
  }
  const failures = await recordCheck(rt, workspaceId, {
    at: readAt,
    ok: failure === null,
  });
  if (failure !== null) {
    const fields: Record<string, unknown> = { workspaceId };
    if (failure.error !== undefined) fields.error = failure.error;
    if (failures !== null && failures > 1) {
      rt.logger.info(failure.message, { ...fields, failuresInARow: failures });
    } else {
      rt.logger.warn(failure.message, fields);
    }
  }
  return outcome;
}

/**
 * Step 0, before anything that calls Linear: of the workspaces admission
 * refuses now (`refused`, a fresh read), a blocked one with an active
 * installation is revoked as 'removed' (revokeWorkspace: credentials
 * wiped, its cached mirror forgotten; warn; no Linear call), so a block
 * stays a hard gate even for a workspace that matched a URL-key block only
 * after the operator's `block`, and its sessions end in this same pass.
 */
async function removeBlockedInstallations(
  rt: EngineRuntime,
  refused: readonly RefusedWorkspace[],
  outcome: RefusedInstallations
): Promise<void> {
  for (const { workspaceId, verdict, status } of refused) {
    if (verdict !== 'blocked') continue;
    if (status.installation === null || status.installation.revokedAt !== null)
      continue;
    if (!(await revokeWorkspace(rt, workspaceId, 'removed'))) continue;
    rt.logger.warn('removed a blocked workspace; its app token is wiped', {
      workspaceId,
      admission: verdict,
    });
    outcome.removed.push(workspaceId);
  }
}

// Active installations LINEAR_WORKSPACES refuses, the one checked longest
// ago (never checked first) first, ties by id.
function readOrder(refused: readonly RefusedWorkspace[]): RefusedWorkspace[] {
  const checkedMs = (entry: RefusedWorkspace): number => {
    const at = entry.status.installation?.urlKeyCheckedAt ?? null;
    return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
  };
  return refused
    .filter(
      (entry) =>
        entry.verdict === 'not_allowed' &&
        entry.status.installation !== null &&
        entry.status.installation.revokedAt === null
    )
    .sort((a, b) => {
      const byCheck = checkedMs(a) - checkedMs(b);
      // Both never checked: -Infinity minus -Infinity is NaN.
      if (!Number.isNaN(byCheck) && byCheck !== 0) return byCheck;
      return a.workspaceId.localeCompare(b.workspaceId);
    });
}

/**
 * The last step, once the revocations and purges are done (so a slow
 * Linear answer can only use what they left of the pass): the soft gate.
 * While a LINEAR_WORKSPACES URL key entry is still unpinned, the active
 * installations it refuses get an identity read (refreshIdentity), at
 * most MAX_IDENTITY_READS_PER_CLEANUP per call, the ones checked longest
 * ago first, so a rename no sync has seen cannot keep one refused; once no
 * entry is left unpinned, no more reads are made. Every installation
 * LINEAR_WORKSPACES still does not admit (active, or revoked as
 * grant_dead) is warned about, every call, with its id and the fix: the
 * planner revokes, ends and deletes nothing of it, so putting it back on
 * the list restores it as it was, and only the operator's `remove`,
 * `block` or `purge` take it away. OAuth mode only (refusedWorkspaces is
 * empty otherwise).
 */
async function handleRefusedInstallations(
  rt: EngineRuntime,
  refused: readonly RefusedWorkspace[],
  budget: Budget,
  outcome: RefusedInstallations
): Promise<void> {
  const queue = readOrder(refused);
  let unpinned = queue.length === 0 ? [] : await unpinnedUrlKeyEntries(rt);
  let reads = 0;
  for (const { workspaceId } of queue) {
    if (unpinned.length === 0) break;
    if (reads >= MAX_IDENTITY_READS_PER_CLEANUP) {
      outcome.readsDeferred = true;
      break;
    }
    const refreshed = await refreshIdentity(rt, workspaceId, budget);
    if (refreshed === 'no_time') {
      outcome.readsDeferred = true;
      break;
    }
    reads += 1;
    if (refreshed !== 'admitted') continue;
    rt.logger.info(
      'LINEAR_WORKSPACES admits an installed workspace again: its URL key, read from Linear now, matches an entry',
      { workspaceId }
    );
    outcome.reAdmitted.push(workspaceId);
    unpinned = await unpinnedUrlKeyEntries(rt);
  }
  for (const { workspaceId, verdict, status } of refused) {
    const installation = status.installation;
    if (installation === null || verdict === 'blocked') continue;
    if (outcome.reAdmitted.includes(workspaceId)) continue;
    const reason = installation.revokedReason ?? 'grant_dead';
    if (installation.revokedAt !== null && reason !== 'grant_dead') continue;
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

// The time a purge needs at its longest: its transaction, then every
// session it deletes revoked SESSION_REVOKE_CONCURRENCY at a time.
function purgeNeedMs(sessions: number): number {
  return (
    PURGE_TRANSACTION_MS +
    Math.ceil(sessions / SESSION_REVOKE_CONCURRENCY) * REVOKE_WORST_MS
  );
}

// Purges workspaces uninstalled or removed more than PURGE_AFTER_DAYS ago,
// oldest revoke first, at most MAX_PURGES_PER_CLEANUP per call (the rest
// wait for the next tick). The store re-checks the revoke under a row lock
// and deletes the remaining sessions in the same transaction, so a
// reinstall racing the purge wins and keeps every session (the installer's
// too); purgeRevokedWorkspace revokes the deleted sessions' grants after
// the commit and logs the id only. A purge starts only when its
// transaction and the revocation of every session it would delete end
// before the deadline (their number is known from the listing). One that
// does not fit first ends its remaining sessions, as many as the time left
// can revoke (endWorkspaceSessions, each batch taken only while the purge
// is still due, so a reinstall stops it), and purges once the rest fits,
// in this pass or a later one: a workspace with more sessions than one
// pass can revoke is purged over a few ticks. One that could not fit even
// a whole pass is logged with the operator's purge, which has the whole
// tick. 'grant_dead' is never purged here (only by the operator's purge).
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
    let left = sessions;
    if (purgeNeedMs(left) > budget.leftMs()) {
      if (purgeNeedMs(sessions) > budget.totalMs) {
        rt.logger.warn(
          `a purge is due but revoking its ${sessions} sessions takes longer than one cleanup allows: they are ended over the next ticks, then the workspace is purged; run 'purge --workspace ${workspaceId} --yes' to purge it now`,
          { workspaceId, sessions }
        );
      }
      const ended = result.endedWorkspaceSessions ?? 0;
      if (
        left > 0 &&
        ended < MAX_WORKSPACE_SESSIONS_PER_CLEANUP &&
        budget.sessionsThatFit(SESSION_REVOKE_CONCURRENCY) > 0
      ) {
        const ending = await endWorkspaceSessions(rt, workspaceId, {
          purgeDueBefore: revokedBefore,
          max: Math.min(left, MAX_WORKSPACE_SESSIONS_PER_CLEANUP - ended),
          batchLimit: () => budget.sessionsThatFit(SESSION_REVOKE_CONCURRENCY),
          why: 'a session of a workspace whose purge is due',
        });
        result.endedWorkspaceSessions = ended + ending.ended;
        result.revokedTokens += ending.revokedTokens;
        result.revokeFailures += ending.revokeFailures;
        // Stopped by a short batch: none is left (or the purge is no
        // longer due, which the purge then finds too).
        left = ending.cutShort ? Math.max(0, left - ending.ended) : 0;
        if (ending.ended > 0) {
          rt.logger.info('ended sessions of a workspace whose purge is due', {
            workspaceId,
            sessions: ending.ended,
            left,
          });
        }
      }
      if (purgeNeedMs(left) > budget.leftMs()) {
        defer(result, 'purges');
        continue;
      }
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
 * Removes blocked installations first; deletes expired sessions (revoking
 * their grants) and old deliveries, prunes notifications and job claims,
 * ends the sessions of uninstalled or removed workspaces and purges such
 * workspaces once their grace is over; last, reads the URL key of
 * installed ones LINEAR_WORKSPACES refuses for want of a current key, and
 * warns about the ones it still does not admit (the module comment
 * above). With `options.deadline`, work that calls Linear stops before it.
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
  const refused = await refusedWorkspaces(rt);
  const outcome: RefusedInstallations = {
    removed: [],
    notServed: [],
    reAdmitted: [],
    readsDeferred: false,
  };
  await removeBlockedInstallations(rt, refused, outcome);
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
  await handleRefusedInstallations(rt, refused, budget, outcome);
  result.notServedWorkspaces = outcome.notServed.length;
  result.reAdmittedWorkspaces = outcome.reAdmitted.length;
  if (outcome.readsDeferred) defer(result, 'identity_reads');
  rt.logger.info('cleanup finished', { ...result });
  return result;
}
