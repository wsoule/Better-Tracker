// Fail-safes for the settings one deployment shares across every workspace
// it serves (owner decision 2026-10-25; architecture §7 "Fail-safes"). Both
// apply in OAuth mode only; demo and api_key modes serve one workspace.
//
// - One Slack bot (SLACK_BOT_TOKEN) is never used while the planner may
//   serve more than one workspace: under `LINEAR_WORKSPACES=*`, a list of
//   more than one, or (unset) more than one active installation, every
//   workspace's digests stay in its outbox. Read on every use, never kept
//   from boot: each live warning run, and engine.digestChannel (the
//   planner's copy), so the two always agree; boot only logs it.
// - WATCHER_EMAILS seeds watchers only in a workspace LINEAR_WORKSPACES
//   names by id or URL key, or, while it is unset, when exactly one
//   workspace is installed (one deployment's people are not made watchers
//   in a stranger's workspace).

import type { Store } from '@better-tracker/store';

import { admissionMode, namedInWorkspaceList } from './admission';
import type { EngineRuntime } from './runtime';
import type { EngineConfig } from './types';

/** Recorded on a live digest the Slack fail-safe kept in the outbox. */
export const SLACK_SHARED_OFF: string =
  'Slack is off because this planner may serve more than one Linear workspace and has one Slack bot; the digest is kept in the outbox.';

/** Workspaces with an active installation (revokedAt unset). */
export async function activeInstallationCount(store: Store): Promise<number> {
  return (await store.listWorkspaceStatus()).filter(
    (status) =>
      status.installation !== null && status.installation.revokedAt === null
  ).length;
}

/**
 * Why one Slack bot must not carry digests here, or null when it may: the
 * admission mode says more than one workspace may be served. Counts the
 * active installations only when LINEAR_WORKSPACES is unset. Null outside
 * OAuth mode.
 */
export async function sharedSlackReason(
  config: EngineConfig,
  store: Store
): Promise<string | null> {
  if (config.auth !== 'oauth') return null;
  const mode = config.workspaces ?? { mode: 'installed' };
  if (mode.mode === 'any') {
    return 'LINEAR_WORKSPACES is * (any Linear workspace may use this planner)';
  }
  if (mode.mode === 'list') {
    return mode.entries.length > 1
      ? `LINEAR_WORKSPACES names ${mode.entries.length} workspaces`
      : null;
  }
  const installed = await activeInstallationCount(store);
  return installed > 1 ? `${installed} Linear workspaces are installed` : null;
}

/**
 * The WATCHER_EMAILS addresses that may seed this workspace's watchers:
 * all of them in a workspace LINEAR_WORKSPACES names (or, while it is
 * unset, when this is the only active installation), else none (logged at
 * info). Unchanged outside OAuth mode.
 */
export async function watcherEmailsFor(
  rt: EngineRuntime,
  workspace: { id: string; urlKey: string | null }
): Promise<readonly string[]> {
  const emails = rt.config.bootstrapWatcherEmails;
  if (emails.length === 0 || rt.config.auth !== 'oauth') return emails;
  const mode = admissionMode(rt);
  const applies =
    mode.mode === 'list'
      ? await namedInWorkspaceList(rt, workspace)
      : mode.mode === 'installed' &&
        (await activeInstallationCount(rt.store)) === 1;
  if (applies) return emails;
  rt.logger.info('WATCHER_EMAILS is not applied to this workspace', {
    workspaceId: workspace.id,
    variable: 'WATCHER_EMAILS',
    reason:
      mode.mode === 'list'
        ? 'LINEAR_WORKSPACES does not name it'
        : mode.mode === 'any'
          ? 'LINEAR_WORKSPACES is *'
          : 'more than one workspace is installed',
  });
  return [];
}
