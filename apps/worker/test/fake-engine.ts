// A scriptable stand-in for the engine slice the worker uses. Every call is
// recorded as a string (`fullSync:ws-a`, `runDaily:ws-a@2026-10-21`,
// `runDaily:ws-a:force`), daily claims are tracked per (workspace, day) like
// the real store (the given day, else today in the workspace timezone), and
// any method can be replaced per test.

import { todayIn } from '@better-tracker/core';
import type { AllocationMode } from '@better-tracker/core';
import type {
  CleanupResult,
  DailyResult,
  SyncResult,
  WarningRunResult,
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

export function fakeEngine(
  options: {
    workspaces?: string[];
    /** Installed workspaces whose grant is dead (not recorded in calls). */
    revoked?: string[];
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
    listWorkspaceIds: () => {
      calls.push('listWorkspaceIds');
      return Promise.resolve(options.workspaces ?? ['ws-a', 'ws-b']);
    },
    listRevokedWorkspaceIds: () => Promise.resolve(options.revoked ?? []),
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
    close: () => {
      calls.push('close');
      engine.closed = true;
      return Promise.resolve();
    },
  };
  Object.assign(engine, options.overrides ?? {});
  return engine;
}
