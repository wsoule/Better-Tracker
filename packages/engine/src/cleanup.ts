// cleanup() (§7.1, §9 `tick`): the housekeeping the worker runs after every
// tick.
//
// - Expired sessions are deleted. In real mode their Linear grants are
//   revoked, best effort: Linear may auto-revoke a user's oldest tokens
//   once they hold more than about 10 for one app, so grants of sessions
//   nobody can use any more must not pile up. A failed revocation is logged
//   and counted, never fatal (the session is gone either way).
// - Webhook delivery records older than WEBHOOK_RETENTION_DAYS are pruned.
//   Dedupe only needs Linear's retry window (about six hours); the longer
//   window keeps each delivery's processing error around to investigate.
// - Installed workspaces admission now refuses (taken out of
//   LINEAR_WORKSPACES, or blocked) are revoked as 'removed'
//   (revokeRefusedInstallations).
// - Several workspaces (owner decision 2026-10-25): sessions of workspaces
//   uninstalled or removed that predate the revoke are ended (grants
//   revoked best effort); such workspaces are purged PURGE_AFTER_DAYS
//   after the revoke; notifications and job claims are pruned past their
//   retention. A 'grant_dead' workspace (Linear refused the app's token,
//   nobody asked for anything) keeps its sessions and is never purged
//   here. The audit log and the run log are never pruned (kept for good,
//   2026-10-22); the purge is what deletes them. Every step is bounded per
//   call, so a backlog cannot stretch one tick past its timeout.

import type { OAuthClientConfig } from '@better-tracker/linear';
import type { RevokedReason } from '@better-tracker/store';

import { refusedInstalledWorkspaces } from './admission';
import { revokeGrant } from './auth';
import type { EngineRuntime } from './runtime';
import type { CleanupResult } from './types';
import {
  endWorkspaceSessions,
  purgeRevokedWorkspace,
  revokeWorkspace,
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

// Takes expired sessions in batches and revokes each one's Linear grant,
// adding to `result`. Stops at a short batch (nothing left) or the cap.
async function revokeExpiredSessions(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  now: Date,
  result: CleanupResult
): Promise<void> {
  const nowIso = now.toISOString();
  while (result.expiredSessions < MAX_SESSIONS_PER_CLEANUP) {
    const limit = Math.min(
      SESSION_BATCH,
      MAX_SESSIONS_PER_CLEANUP - result.expiredSessions
    );
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

/**
 * Revokes, as 'removed' (revokeWorkspace: credentials wiped), every
 * workspace with an active installation that admission refuses now (fresh
 * read), and forgets its cached mirror, so a workspace taken out of
 * LINEAR_WORKSPACES or blocked keeps no live app token and its purge clock
 * starts. Each one is logged at warn. No Linear call (the app token is
 * wiped, not revoked with Linear). Returns the workspaces it revoked.
 * OAuth mode only (refusedInstalledWorkspaces is empty otherwise).
 */
export async function revokeRefusedInstallations(
  rt: EngineRuntime,
  now: Date
): Promise<string[]> {
  const revoked: string[] = [];
  for (const { workspaceId, verdict } of await refusedInstalledWorkspaces(rt)) {
    if (!(await revokeWorkspace(rt, workspaceId, 'removed'))) continue;
    rt.logger.warn(
      'removed a workspace admission no longer admits; its app token is wiped',
      { workspaceId, admission: verdict }
    );
    revoked.push(workspaceId);
  }
  return revoked;
}

// Ends the sessions of workspaces uninstalled or removed that were created
// before the revoke, revoking each grant (endWorkspaceSessions: bounded
// concurrency, failures logged without tokens), up to
// MAX_WORKSPACE_SESSIONS_PER_CLEANUP. A session created after the revoke
// is kept: an admin who signed in to reinstall. Personal API keys keep no
// sessions here, so the step does nothing then.
async function endRevokedWorkspaceSessions(
  rt: EngineRuntime,
  result: CleanupResult
): Promise<void> {
  if (rt.config.auth === 'api_key') return;
  const statuses = await rt.store.listWorkspaceStatus();
  for (const status of statuses) {
    const ended = result.endedWorkspaceSessions ?? 0;
    if (ended >= MAX_WORKSPACE_SESSIONS_PER_CLEANUP) return;
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
    const ending = await endWorkspaceSessions(rt, status.workspaceId, {
      createdBefore: installation.revokedAt,
      max: MAX_WORKSPACE_SESSIONS_PER_CLEANUP - ended,
      why:
        installation.revokedReason === 'uninstalled'
          ? 'a session of an uninstalled workspace'
          : 'a session of a removed workspace',
    });
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
// wait for the next tick). purgeRevokedWorkspace ends their remaining
// sessions first and logs the id only; the store re-checks the revoke
// under a row lock, so a reinstall racing the purge wins. 'grant_dead' is
// never purged here (only by the operator's purge).
async function purgeRevokedWorkspaces(
  rt: EngineRuntime,
  now: Date,
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
      return [{ workspaceId: status.workspaceId, at: installation.revokedAt }];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, MAX_PURGES_PER_CLEANUP);
  for (const { workspaceId } of due) {
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
 * over (the module comment above).
 */
export async function cleanup(rt: EngineRuntime): Promise<CleanupResult> {
  const now = rt.clock();
  const result: CleanupResult = {
    expiredSessions: 0,
    revokedTokens: 0,
    revokeFailures: 0,
    oldDeliveries: 0,
    endedWorkspaceSessions: 0,
    purgedWorkspaces: 0,
    oldNotifications: 0,
    oldJobClaims: 0,
  };
  await revokeRefusedInstallations(rt, now);
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
    await revokeExpiredSessions(rt, oauth, now, result);
  }
  result.oldDeliveries = await rt.store.pruneWebhookDeliveries(
    new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS).toISOString()
  );
  await pruneRetention(rt, now, result);
  await endRevokedWorkspaceSessions(rt, result);
  await purgeRevokedWorkspaces(rt, now, result);
  rt.logger.info('cleanup finished', { ...result });
  return result;
}
