// Workspace lifecycle (architecture §7 "Several workspaces", §9): revoking
// an installation, ending a workspace's sessions, purging what a revoked
// workspace left behind, and the operator commands over them (`remove`,
// `purge`, `block`, `unblock`). One deployment serves several Linear
// workspaces (owner decision 2026-10-25), so these act on one whole
// workspace at a time and never return a Linear credential.
//
// - revokeWorkspace makes no Linear call and ends no session: it runs
//   inside a webhook's after() and must stay fast. cleanup() ends the
//   sessions of uninstalled and removed workspaces later (cleanup.ts);
//   reads of a revoked workspace are already refused (requireInstallation),
//   so the delay leaks nothing.
// - The operator commands run from the worker's CLI only; no planner route
//   calls them (there is no operator role in the planner).

import type { IsoDateTime } from '@better-tracker/core';
import type { OAuthClientConfig } from '@better-tracker/linear';
import type {
  BlockKind,
  PurgeResult,
  RevokedReason,
  TakenSession,
  WorkspaceStatus,
} from '@better-tracker/store';

import { revokeGrant } from './auth';
import type { EngineRuntime } from './runtime';
import {
  EngineInputError,
  type WorkspaceBlock,
  type WorkspacePurge,
  type WorkspaceRemoval,
} from './types';

/**
 * The operator's purge refuses a workspace revoked more recently than this:
 * a tick (at most 14 minutes) or a sync join (2 minutes) of the revoked
 * workspace may still be writing.
 */
export const OPERATOR_PURGE_MIN_MINUTES = 15;
/** Grant revocations in flight at once while a workspace's sessions end. */
export const SESSION_REVOKE_CONCURRENCY = 4;
/** Sessions taken from the store per batch. */
const SESSION_BATCH = 50;
/**
 * An operator command or a purge ends at most this many sessions of one
 * workspace (far more than one workspace's people hold), so a stream of
 * sign-ins can never keep it looping.
 */
const MAX_SESSIONS_PER_WORKSPACE = 10_000;
/** What a workspace is named by: an org id or a URL key. */
const WORKSPACE_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** A Linear organization id (a UUID), so an unknown one is blocked by id. */
const ORG_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest block reason kept. */
const BLOCK_REASON_MAX_LENGTH = 500;

/** What operator commands say with personal API keys. */
export const OPERATOR_OFF_MESSAGE =
  'Workspace commands are off when the planner uses personal API keys: there is one workspace and nothing to remove or purge.';

const MINUTE_MS = 60_000;

/** Sessions ended for one workspace, and how revoking their grants went. */
export interface SessionEnding {
  ended: number;
  revokedTokens: number;
  revokeFailures: number;
}

/**
 * Revokes a workspace's installation as `reason` (store.revokeInstallation:
 * wipes its credentials; with `ifUpdatedBefore`, a revoke older than the
 * row's last update is ignored) and forgets this process's cached mirror
 * of it. Idempotent; true when the row changed. No Linear call.
 */
export async function revokeWorkspace(
  rt: EngineRuntime,
  workspaceId: string,
  reason: RevokedReason,
  options: { ifUpdatedBefore?: IsoDateTime } = {}
): Promise<boolean> {
  const changed = await rt.store.revokeInstallation(
    workspaceId,
    reason,
    rt.nowIso(),
    options
  );
  rt.mirror.forget(workspaceId);
  return changed;
}

// Revokes the Linear grants of sessions just taken from the store, at most
// SESSION_REVOKE_CONCURRENCY at a time, adding to `ending`. Best effort: a
// failure is logged (never the tokens) and counted. A session whose tokens
// no longer decrypt cannot be revoked and counts as a failure (the store
// logged it). Demo mode has no grants to revoke.
async function revokeTakenGrants(
  rt: EngineRuntime,
  sessions: readonly TakenSession[],
  ending: SessionEnding,
  why: string
): Promise<void> {
  const oauth: OAuthClientConfig | null = rt.config.oauth;
  if (oauth === null || rt.linear.mode === 'fixture') return;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const session = sessions[next];
      next += 1;
      if (session === undefined) return;
      if (session.tokens === null) {
        ending.revokeFailures += 1;
        continue;
      }
      const revoked = await revokeGrant(rt, oauth, session.tokens);
      if (revoked.ok) {
        ending.revokedTokens += 1;
        continue;
      }
      ending.revokeFailures += 1;
      rt.logger.warn(`could not revoke the Linear token of ${why}`, {
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: session.id,
        error: revoked.error,
      });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SESSION_REVOKE_CONCURRENCY, sessions.length) },
      worker
    )
  );
}

/**
 * Ends a workspace's sessions (only those created before `createdBefore`
 * when given), in batches, revoking each grant best effort. Stops at a
 * short batch (nothing left) or after `max` sessions. `why` names the
 * sessions in the warning a failed revocation logs.
 */
export async function endWorkspaceSessions(
  rt: EngineRuntime,
  workspaceId: string,
  options: { createdBefore?: IsoDateTime; max: number; why: string }
): Promise<SessionEnding> {
  const ending: SessionEnding = {
    ended: 0,
    revokedTokens: 0,
    revokeFailures: 0,
  };
  while (ending.ended < options.max) {
    const limit = Math.min(SESSION_BATCH, options.max - ending.ended);
    const batch = await rt.store.takeSessionsForWorkspace(workspaceId, {
      createdBefore: options.createdBefore,
      limit,
    });
    ending.ended += batch.length;
    await revokeTakenGrants(rt, batch, ending, options.why);
    if (batch.length < limit) break;
  }
  return ending;
}

/**
 * Purges a revoked workspace (store.purgeWorkspace, which re-checks the
 * revoke under a row lock and deletes its sessions in the same
 * transaction), then revokes the Linear grants of the sessions it deleted
 * (best effort, as endWorkspaceSessions does: Linear may auto-revoke a
 * person's oldest tokens once too many pile up). A purge the store refuses
 * (a reinstall that won the lock) ends no session at all. Forgets this
 * process's cached mirror when it purged. Logs the id only: a workspace's
 * name must not outlive its data in the host's logs.
 */
export async function purgeRevokedWorkspace(
  rt: EngineRuntime,
  workspaceId: string,
  options: { revokedBefore: IsoDateTime; allowGrantDead?: boolean }
): Promise<{ result: PurgeResult; ending: SessionEnding }> {
  const ending: SessionEnding = {
    ended: 0,
    revokedTokens: 0,
    revokeFailures: 0,
  };
  const result = await rt.store.purgeWorkspace(workspaceId, options);
  if (result.purged) {
    rt.mirror.forget(workspaceId);
    rt.logger.info('workspace purged', { workspaceId });
    ending.ended = result.sessions.length;
    await revokeTakenGrants(
      rt,
      result.sessions,
      ending,
      'a session of a purged workspace'
    );
  } else {
    rt.logger.info('workspace purge skipped', {
      workspaceId,
      reason: result.reason,
    });
  }
  return { result, ending };
}

// The operator commands refuse personal API keys (one bound workspace and
// no grants to revoke).
function requireOperatorMode(rt: EngineRuntime): void {
  if (rt.config.auth === 'api_key') {
    throw new EngineInputError('invalid', OPERATOR_OFF_MESSAGE);
  }
}

// An operator's workspace name, checked for shape and lower-cased.
function workspaceName(idOrUrlKey: string): string {
  if (typeof idOrUrlKey !== 'string' || !WORKSPACE_NAME.test(idOrUrlKey)) {
    throw new EngineInputError(
      'invalid',
      'Name a workspace by its organization id or URL key (letters, digits and dashes, at most 64).'
    );
  }
  return idOrUrlKey.toLowerCase();
}

/**
 * The workspace an operator names, from listWorkspaceStatus: its org id
 * first, else its URL key (the installation's, else the newest
 * session's), both matched without case. Null when nothing here matches;
 * EngineInputError('conflict') when two workspaces share the URL key (a
 * rename): the id then has to be used.
 */
export async function findWorkspace(
  rt: EngineRuntime,
  idOrUrlKey: string
): Promise<WorkspaceStatus | null> {
  const name = workspaceName(idOrUrlKey);
  const statuses = await rt.store.listWorkspaceStatus(rt.nowIso());
  const byId = statuses.find(
    (status) => status.workspaceId.toLowerCase() === name
  );
  if (byId !== undefined) return byId;
  const byKey = statuses.filter(
    (status) => status.urlKey?.toLowerCase() === name
  );
  if (byKey.length > 1) {
    throw new EngineInputError(
      'conflict',
      'More than one workspace here has that URL key; name the one you mean by its organization id (the workspaces command lists them).'
    );
  }
  return byKey[0] ?? null;
}

// findWorkspace, or EngineInputError('not_found').
async function requireWorkspace(
  rt: EngineRuntime,
  idOrUrlKey: string
): Promise<WorkspaceStatus> {
  const found = await findWorkspace(rt, idOrUrlKey);
  if (found === null) {
    throw new EngineInputError(
      'not_found',
      'No workspace here has that organization id or URL key (the workspaces command lists them).'
    );
  }
  return found;
}

// Revokes the active installation's app token with Linear, best effort,
// under the installation's row lock: a refresh waiting on that lock then
// finds the grant dead, and none can rotate the tokens while they are
// being revoked. Null when there is nothing to revoke (no active row, a
// blank api_key-era token, demo mode). Never throws.
async function revokeAppToken(
  rt: EngineRuntime,
  workspaceId: string
): Promise<boolean | null> {
  const oauth = rt.config.oauth;
  if (oauth === null || rt.linear.mode === 'fixture') return null;
  try {
    return await rt.store.withInstallationLock(workspaceId, async (locked) => {
      if (locked.revokedAt !== null || locked.tokens.accessToken === '') {
        return { result: null };
      }
      const revoked = await revokeGrant(rt, oauth, locked.tokens);
      if (!revoked.ok) {
        rt.logger.warn("could not revoke the app's Linear token", {
          workspaceId,
          error: revoked.error,
        });
      }
      return { result: revoked.ok };
    });
  } catch (error) {
    rt.logger.warn("could not revoke the app's Linear token", {
      workspaceId,
      error,
    });
    return false;
  }
}

// remove for a workspace already found: the app token (when installed and
// active), the revoke as 'removed', then every session created up to now.
async function removeFound(
  rt: EngineRuntime,
  status: WorkspaceStatus
): Promise<WorkspaceRemoval> {
  const { workspaceId } = status;
  const now = rt.nowIso();
  let appTokenRevoked: boolean | null = null;
  let revoked = false;
  if (status.installation !== null) {
    appTokenRevoked = await revokeAppToken(rt, workspaceId);
    revoked = await revokeWorkspace(rt, workspaceId, 'removed');
  }
  const ending = await endWorkspaceSessions(rt, workspaceId, {
    createdBefore: new Date(Date.parse(now) + 1).toISOString(),
    max: MAX_SESSIONS_PER_WORKSPACE,
    why: 'a session of a removed workspace',
  });
  rt.logger.info('workspace removed by the operator', {
    workspaceId,
    revoked,
    appTokenRevoked,
    endedSessions: ending.ended,
  });
  return {
    workspaceId,
    revoked,
    appTokenRevoked,
    endedSessions: ending.ended,
    revokedTokens: ending.revokedTokens,
    revokeFailures: ending.revokeFailures,
  };
}

/** The operator's `remove` (Engine.removeWorkspace). */
export async function removeWorkspace(
  rt: EngineRuntime,
  idOrUrlKey: string
): Promise<WorkspaceRemoval> {
  requireOperatorMode(rt);
  return removeFound(rt, await requireWorkspace(rt, idOrUrlKey));
}

/** The operator's `purge` (Engine.purgeWorkspaceNow). */
export async function purgeWorkspaceNow(
  rt: EngineRuntime,
  idOrUrlKey: string,
  options: { now?: IsoDateTime } = {}
): Promise<WorkspacePurge> {
  requireOperatorMode(rt);
  const { workspaceId, installation } = await requireWorkspace(rt, idOrUrlKey);
  if (installation === null) {
    return { purged: false, workspaceId, reason: 'not_installed' };
  }
  if (installation.revokedAt === null) {
    return { purged: false, workspaceId, reason: 'not_revoked' };
  }
  const nowMs = Date.parse(options.now ?? rt.nowIso());
  if (Number.isNaN(nowMs)) {
    throw new EngineInputError('invalid', 'now must be an ISO instant.');
  }
  const revokedBefore = new Date(
    nowMs - OPERATOR_PURGE_MIN_MINUTES * MINUTE_MS
  ).toISOString();
  if (Date.parse(installation.revokedAt) >= Date.parse(revokedBefore)) {
    return { purged: false, workspaceId, reason: 'too_recent' };
  }
  const { result, ending } = await purgeRevokedWorkspace(rt, workspaceId, {
    revokedBefore,
    allowGrantDead: true,
  });
  if (!result.purged) {
    // A reinstall (or another purge) got there between the check and
    // the purge's own locked re-check.
    return {
      purged: false,
      workspaceId,
      reason: result.reason === 'grant_dead' ? 'not_revoked' : result.reason,
    };
  }
  return {
    purged: true,
    workspaceId,
    endedSessions: ending.ended,
    counts: result.counts,
  };
}

// A block reason: trimmed, empty → null, at most BLOCK_REASON_MAX_LENGTH.
function blockReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  if (typeof reason !== 'string') {
    throw new EngineInputError('invalid', 'A block reason must be text.');
  }
  const trimmed = reason.trim();
  if (trimmed.length > BLOCK_REASON_MAX_LENGTH) {
    throw new EngineInputError(
      'invalid',
      `A block reason is at most ${BLOCK_REASON_MAX_LENGTH} characters.`
    );
  }
  return trimmed === '' ? null : trimmed;
}

/** The operator's `block` (Engine.blockWorkspace). */
export async function blockWorkspace(
  rt: EngineRuntime,
  idOrUrlKey: string,
  reason?: string | null
): Promise<WorkspaceBlock> {
  requireOperatorMode(rt);
  const name = workspaceName(idOrUrlKey);
  const why = blockReason(reason);
  const found = await findWorkspace(rt, name);
  const kind: BlockKind =
    found !== null || ORG_ID_SHAPE.test(name) ? 'id' : 'url_key';
  const key = found === null ? name : found.workspaceId.toLowerCase();
  // An id block remembers the URL key it was made under (the name, when
  // it is not the id; else the workspace's current key), so `unblock` by
  // that key finds it even once nothing else here knows the key.
  const urlKey =
    found === null
      ? null
      : name !== key
        ? name
        : (found.urlKey?.toLowerCase() ?? null);
  // The block first, so admission refuses new sign-ins before the
  // sessions are ended.
  await rt.store.blockWorkspace(key, kind, why, rt.nowIso(), { urlKey });
  rt.logger.info('workspace blocked by the operator', {
    key,
    kind,
    workspaceId: found?.workspaceId ?? null,
  });
  return {
    key,
    kind,
    workspaceId: found?.workspaceId ?? null,
    removal: found === null ? null : await removeFound(rt, found),
  };
}

/**
 * The operator's `unblock` (Engine.unblockWorkspace): lifts the block on
 * the name itself (a URL-key block, or an id block named by id) and the
 * block on the one org the name means: the org id findWorkspace resolves
 * it to, or an id block that recorded the name as its URL key (a URL-key
 * block pinned at a sign-in attempt, or a workspace purged since its
 * block, which nothing else here knows any more). A URL key that names
 * more than one blocked org is EngineInputError('conflict'): the id has to
 * be used. True when a block was lifted.
 */
export async function unblockWorkspace(
  rt: EngineRuntime,
  idOrUrlKey: string
): Promise<boolean> {
  requireOperatorMode(rt);
  const name = workspaceName(idOrUrlKey);
  const found = await findWorkspace(rt, name);
  const blocks = await rt.store.listBlockedWorkspaces();
  const blockedIds = new Set(
    blocks.flatMap((block) =>
      block.kind === 'id' && block.key !== name && block.urlKey === name
        ? [block.key]
        : []
    )
  );
  const foundId = found?.workspaceId.toLowerCase() ?? null;
  if (
    foundId !== null &&
    foundId !== name &&
    blocks.some((block) => block.kind === 'id' && block.key === foundId)
  ) {
    blockedIds.add(foundId);
  }
  if (blockedIds.size > 1) {
    throw new EngineInputError(
      'conflict',
      'More than one blocked workspace goes by that URL key; unblock the one you mean by its organization id (the workspaces command lists the blocks).'
    );
  }
  let removed = false;
  for (const key of [name, ...blockedIds]) {
    if (await rt.store.unblockWorkspace(key)) removed = true;
  }
  if (removed) {
    rt.logger.info('workspace unblocked by the operator', {
      workspaceId: [...blockedIds][0] ?? found?.workspaceId ?? null,
    });
  }
  return removed;
}
