// A scriptable stand-in for the engine slice the worker uses. Every call is
// recorded as a string (`fullSync:ws-a`, `runDaily:ws-a@2026-10-21`,
// `runDaily:ws-a:force`, `removeWorkspace:acme`), daily claims are tracked
// per (workspace, day) like the real store (the given day, else today in
// the workspace timezone), and any method can be replaced per test. The
// workspace overview comes from `workspaces` (active, admitted, never
// synced), `revoked` (grant_dead) and `statuses` (anything else, built with
// overview()).

import { todayIn } from '@better-tracker/core';
import type { AllocationMode } from '@better-tracker/core';
import type {
  CleanupResult,
  DailyResult,
  SyncResult,
  WarningRunResult,
  WorkspaceOverview,
} from '@better-tracker/engine';

import type { AllocationRunResult, WorkerEngine } from '../src/commands';

export interface FakeEngine extends WorkerEngine {
  calls: string[];
  closed: boolean;
}

export function syncResult(workspaceId: string): SyncResult {
  return {
    workspaceId,
    ok: true,
    version: 7,
    counts: { issues: 42 },
    durationMs: 12,
    error: null,
  };
}

export function allocationRun(
  workspaceId: string,
  overrides: Partial<AllocationRunResult> = {}
): AllocationRunResult {
  const mode: AllocationMode = overrides.mode ?? 'dry_run';
  return {
    id: `run-${workspaceId}`,
    workspaceId,
    mode,
    trigger: 'schedule',
    startedByUserId: null,
    status: 'succeeded',
    startedAt: '2026-10-21T08:00:00.000Z',
    finishedAt: '2026-10-21T08:00:01.000Z',
    summary: {
      assigned: mode === 'live' ? 2 : 0,
      wouldAssign: mode === 'live' ? 0 : 2,
      failed: 0,
      blockedProjects: 1,
      skippedIssues: 3,
    },
    error: null,
    ...overrides,
  };
}

export function warningResult(
  workspaceId: string,
  overrides: Partial<WarningRunResult> = {}
): WarningRunResult {
  return {
    workspaceId,
    day: '2026-10-21',
    mode: 'preview',
    notices: 3,
    digests: [],
    delivered: 0,
    failed: 0,
    alreadySent: 0,
    ...overrides,
  };
}

export const NO_CLEANUP: CleanupResult = {
  expiredSessions: 0,
  revokedTokens: 0,
  revokeFailures: 0,
  oldDeliveries: 0,
};

type InstallationSummary = NonNullable<WorkspaceOverview['installation']>;
type SyncSummary = NonNullable<WorkspaceOverview['sync']>;

/**
 * When the fake workspaces were installed: hours before most test clocks,
 * so a never-synced workspace that fails is not chronic yet.
 */
export const INSTALLED_AT = '2026-10-21T00:00:00.000Z';

/**
 * A workspace as listWorkspaceStatus reports it: installed (active),
 * admitted, never synced, no sessions, unless overridden. `installation`
 * and `sync` merge into the defaults; pass null for none.
 */
export function overview(
  workspaceId: string,
  overrides: {
    installation?: Partial<InstallationSummary> | null;
    sync?: Partial<SyncSummary> | null;
    admission?: WorkspaceOverview['admission'];
    sessionCount?: number;
    workspaceName?: string | null;
    urlKey?: string | null;
  } = {}
): WorkspaceOverview {
  const urlKey =
    overrides.urlKey === undefined
      ? workspaceId.replace(/^org-/, '')
      : overrides.urlKey;
  const name =
    overrides.workspaceName === undefined
      ? `Workspace ${workspaceId}`
      : overrides.workspaceName;
  const installation: InstallationSummary | null =
    overrides.installation === null
      ? null
      : {
          workspaceName: name ?? workspaceId,
          urlKey: urlKey ?? workspaceId,
          appUserId: `app-${workspaceId}`,
          installedByUserId: 'u-admin',
          createdAt: INSTALLED_AT,
          updatedAt: INSTALLED_AT,
          revokedAt: null,
          revokedReason: null,
          ...overrides.installation,
        };
  const sync: SyncSummary | null =
    overrides.sync === undefined || overrides.sync === null
      ? null
      : {
          workspaceId,
          version: 3,
          lastFullSyncAt: null,
          lastFullSyncStatus: null,
          lastFullSyncError: null,
          lastWebhookAt: null,
          consecutiveFailures: 0,
          lastFullSyncMs: null,
          lastSuccessAt: null,
          mirrorIssueCount: null,
          lastFullSyncStartedAt: null,
          ...overrides.sync,
        };
  return {
    workspaceId,
    workspaceName: name,
    urlKey,
    installation,
    sync,
    sessionCount: overrides.sessionCount ?? 0,
    admission: overrides.admission ?? 'ok',
  };
}

/** A workspace revoked as `reason` (default grant_dead) at `at`. */
export function revokedOverview(
  workspaceId: string,
  reason: 'uninstalled' | 'removed' | 'grant_dead' = 'grant_dead',
  at = '2026-10-20T00:00:00.000Z'
): WorkspaceOverview {
  return overview(workspaceId, {
    installation: { revokedAt: at, revokedReason: reason },
  });
}

export function fakeEngine(
  options: {
    /** Active, admitted, never-synced workspaces, in this order. */
    workspaces?: string[];
    /** Installed workspaces whose grant is dead (listed after). */
    revoked?: string[];
    /** The whole overview instead of `workspaces` and `revoked`. */
    statuses?: WorkspaceOverview[];
    timezones?: Record<string, string>;
    now?: () => Date;
    overrides?: Partial<WorkerEngine>;
  } = {}
): FakeEngine {
  const now = options.now ?? ((): Date => new Date('2026-10-21T12:00:00Z'));
  const claims = new Set<string>();
  const calls: string[] = [];
  const engine: FakeEngine = {
    mode: 'fixture',
    calls,
    closed: false,
    listWorkspaceStatus: () => {
      calls.push('listWorkspaceStatus');
      return Promise.resolve(
        options.statuses ?? [
          ...(options.workspaces ?? ['ws-a', 'ws-b']).map((id) => overview(id)),
          ...(options.revoked ?? []).map((id) => revokedOverview(id)),
        ]
      );
    },
    workspaceTimezone: (id) => {
      calls.push(`workspaceTimezone:${id}`);
      return Promise.resolve(options.timezones?.[id] ?? 'UTC');
    },
    fullSync: (id) => {
      calls.push(`fullSync:${id}`);
      return Promise.resolve(syncResult(id));
    },
    runDaily: ({ workspaceId, force, day: given }) => {
      calls.push(
        `runDaily:${workspaceId}${given === undefined ? '' : `@${given}`}${force === true ? ':force' : ''}`
      );
      const timezone = options.timezones?.[workspaceId] ?? 'UTC';
      const day = given ?? todayIn(timezone, now());
      const key = `${workspaceId}:${day}`;
      const fresh = !claims.has(key);
      claims.add(key);
      const result: DailyResult = {
        workspaceId,
        day,
        ran: fresh || force === true,
        sync: null,
        allocation: null,
        warnings: null,
      };
      if (!result.ran) return Promise.resolve(result);
      return Promise.resolve({
        ...result,
        sync: syncResult(workspaceId),
        allocation: allocationRun(workspaceId),
        warnings: warningResult(workspaceId, { day }),
      });
    },
    runAllocation: (input) => {
      calls.push(
        `runAllocation:${input.workspaceId}:${input.mode}:${input.trigger}:${input.actor === null ? 'no-actor' : 'actor'}`
      );
      return Promise.resolve(
        allocationRun(input.workspaceId, {
          mode: input.mode,
          trigger: input.trigger,
        })
      );
    },
    runWarnings: ({ workspaceId }) => {
      calls.push(`runWarnings:${workspaceId}`);
      return Promise.resolve(warningResult(workspaceId));
    },
    cleanup: () => {
      calls.push('cleanup');
      return Promise.resolve(NO_CLEANUP);
    },
    removeWorkspace: (name) => {
      calls.push(`removeWorkspace:${name}`);
      return Promise.resolve({
        workspaceId: `org-${name}`,
        revoked: true,
        appTokenRevoked: true,
        endedSessions: 2,
        revokedTokens: 2,
        revokeFailures: 0,
      });
    },
    purgeWorkspaceNow: (name) => {
      calls.push(`purgeWorkspaceNow:${name}`);
      return Promise.resolve({
        purged: false,
        workspaceId: `org-${name}`,
        reason: 'not_revoked',
      });
    },
    blockWorkspace: (name, reason) => {
      calls.push(`blockWorkspace:${name}:${reason ?? 'no reason'}`);
      return Promise.resolve({
        key: name,
        kind: 'url_key',
        workspaceId: null,
        removal: null,
      });
    },
    unblockWorkspace: (name) => {
      calls.push(`unblockWorkspace:${name}`);
      return Promise.resolve(true);
    },
    listBlockedWorkspaces: () => {
      calls.push('listBlockedWorkspaces');
      return Promise.resolve([]);
    },
    close: () => {
      calls.push('close');
      engine.closed = true;
      return Promise.resolve();
    },
  };
  Object.assign(engine, options.overrides ?? {});
  return engine;
}
