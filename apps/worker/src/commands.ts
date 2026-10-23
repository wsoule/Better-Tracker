// The worker's commands (architecture §9) over the engine. Every command
// that touches workspaces runs them one after another; a failure in one is
// logged and recorded, and the others still run. The result carries one
// outcome per workspace, from which the exit code and the one-line human
// summary are derived.

import { isValidTimeZone } from '@better-tracker/core';
import type {
  CleanupResult,
  DailyResult,
  Engine,
  SyncResult,
  WarningRunResult,
} from '@better-tracker/engine';
import type { Logger } from '@better-tracker/logger';

import type { CliCommand, CommandName } from './cli';
import type { WorkerConfig } from './config';
import { decideDailyRun } from './schedule';

/** An allocation run as the engine returns it. */
export type AllocationRunResult = Awaited<ReturnType<Engine['runAllocation']>>;

/**
 * The slice of the engine the worker uses. `workspaceTimezone` resolves a
 * workspace's saved timezone (falling back to DEFAULT_TIMEZONE when the
 * saved one is invalid, as the engine itself does), so the schedule
 * decision and the engine's "today" agree.
 */
export interface WorkerEngine {
  readonly mode: 'linear' | 'fixture';
  listWorkspaceIds(): Promise<string[]>;
  /** Installed workspaces whose app grant is dead (need a reinstall). */
  listRevokedWorkspaceIds(): Promise<string[]>;
  workspaceTimezone(workspaceId: string): Promise<string>;
  fullSync(workspaceId: string): Promise<SyncResult>;
  runDaily(input: {
    workspaceId: string;
    force?: boolean;
    /** The workspace-local day the scheduler decided is due. */
    day?: string;
  }): Promise<DailyResult>;
  runAllocation: Engine['runAllocation'];
  runWarnings(input: { workspaceId: string }): Promise<WarningRunResult>;
  cleanup(): Promise<CleanupResult>;
  close(): Promise<void>;
}

/** Adapts a full engine to the worker's slice. */
export function workerEngineFrom(engine: Engine): WorkerEngine {
  return {
    mode: engine.mode,
    listWorkspaceIds: () => engine.listWorkspaceIds(),
    listRevokedWorkspaceIds: () => engine.listRevokedWorkspaceIds(),
    // getSettings, not load(): load syncs a workspace that was never
    // mirrored, and the tick decides on its own whether to sync.
    workspaceTimezone: async (workspaceId) => {
      const settings = await engine.getSettings(workspaceId);
      return isValidTimeZone(settings.timezone)
        ? settings.timezone
        : engine.config.defaultTimezone;
    },
    fullSync: (workspaceId) => engine.fullSync(workspaceId),
    runDaily: (input) => engine.runDaily(input),
    runAllocation: (input) => engine.runAllocation(input),
    runWarnings: (input) => engine.runWarnings(input),
    cleanup: () => engine.cleanup(),
    close: () => engine.close(),
  };
}

/** What one command did for one workspace. */
export interface WorkspaceOutcome {
  workspaceId: string;
  ok: boolean;
  /** A short human phrase for the summary line ('' when it threw). */
  detail: string;
  /** Why it failed (ok false), one line; null when ok. */
  error: string | null;
}

/** What one command did overall. */
export interface CommandResult {
  command: CommandName;
  outcomes: WorkspaceOutcome[];
  /** Failures not tied to one workspace (listing them, cleanup). */
  problems: string[];
  /** Extra summary text not tied to one workspace (cleanup counts). */
  notes: string[];
}

export interface CommandContext {
  engine: WorkerEngine;
  logger: Logger;
  config: WorkerConfig;
  /** The clock the schedule decision uses (the engine gets the same one). */
  now: () => Date;
}

/** Exit codes: 0 ok, 1 something failed, 2 usage error (cli.ts). */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/**
 * What a command does in api_key mode (LINEAR_AUTH=api_key, owner request
 * 2026-10-23); the caller (run.ts) asks only in that mode, before the
 * engine is built. Personal API keys live only in the planner's memory,
 * so nothing here could read or write Linear. `tick` and `serve` exit 0
 * with a note (a leftover Railway cron stays quiet); `sync`, `daily`,
 * `allocate` and `warn` exit 1 with a sentence. Null for `migrate`, which
 * boots as always (it only opens the store and migrates).
 */
export function apiKeyModeOutcome(
  command: CommandName
): { code: number; line: string } | null {
  if (command === 'migrate') return null;
  if (command === 'tick' || command === 'serve') {
    return {
      code: EXIT_OK,
      line: "api-key mode: no scheduled sync, allocation or digests (keys live only in the planner's memory)",
    };
  }
  return {
    code: EXIT_FAILED,
    line: `${command}: off when LINEAR_AUTH=api_key: keys live only in the planner's memory; start a run or a resync from the planner`,
  };
}

/**
 * The process exit code for a command: 1 when any workspace failed or a
 * workspace-independent step (listing workspaces, cleanup) failed, so cron
 * failures are loud; otherwise 0. No workspaces at all is not a failure.
 */
export function exitCodeFor(
  result: Pick<CommandResult, 'outcomes' | 'problems'>
): 0 | 1 {
  if (result.problems.length > 0) return EXIT_FAILED;
  return result.outcomes.some((outcome) => !outcome.ok) ? EXIT_FAILED : EXIT_OK;
}

const MAX_ERROR_CHARS = 300;

/** An error's message as one short line (summaries, outcomes). */
export function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…`
    : text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The one-line human summary printed when a command finishes, e.g.
 * `tick ok — ws-1: synced (mirror v4, 120 issues, 812 ms); cleanup: …`.
 */
export function summaryLine(result: CommandResult): string {
  const failed = result.outcomes.filter((outcome) => !outcome.ok).length;
  const status =
    exitCodeFor(result) === EXIT_OK
      ? 'ok'
      : failed > 0
        ? `FAILED (${failed} of ${plural(result.outcomes.length, 'workspace')})`
        : 'FAILED';
  const parts: string[] = [];
  if (result.command !== 'migrate' && result.outcomes.length === 0) {
    parts.push('no installed workspaces');
  }
  for (const outcome of result.outcomes) {
    if (outcome.ok) {
      parts.push(`${outcome.workspaceId}: ${outcome.detail}`);
      continue;
    }
    const detail = outcome.detail === '' ? '' : ` ${outcome.detail}`;
    const error = outcome.error === null ? '' : ` (${outcome.error})`;
    parts.push(`${outcome.workspaceId}: FAILED${detail}${error}`);
  }
  parts.push(...result.notes);
  parts.push(...result.problems.map((problem) => `FAILED ${problem}`));
  return `${result.command} ${status}${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}`;
}

function describeSync(sync: SyncResult): string {
  return `synced (mirror v${sync.version}, ${plural(sync.counts['issues'] ?? 0, 'issue')}, ${sync.durationMs} ms)`;
}

// Allocation runs that ended `failed` (no assignment applied) or `partial`
// (some Linear writes failed) count as failures: they need someone to look.
function describeAllocation(run: AllocationRunResult): {
  ok: boolean;
  detail: string;
  error: string | null;
} {
  const summary = run.summary;
  const counts =
    summary === null
      ? ''
      : run.mode === 'live'
        ? `: ${summary.assigned} assigned, ${summary.failed} failed, ${plural(summary.blockedProjects, 'blocked project')}`
        : `: ${summary.wouldAssign} would be assigned, ${plural(summary.blockedProjects, 'blocked project')}`;
  const ok = run.status !== 'failed' && run.status !== 'partial';
  return {
    ok,
    detail: `allocation ${run.mode === 'live' ? 'live' : 'dry run'} ${run.status}${counts}`,
    error: ok ? null : (run.error ?? 'see the run log'),
  };
}

// Digests that were not delivered are reported but do not fail the
// command: the count includes people with no Slack account, who would make
// every daily run "fail" forever. The engine logs each one at warn, and a
// Slack configuration error at error.
function describeWarnings(warnings: WarningRunResult): string {
  const parts = [
    plural(warnings.notices, 'notice'),
    plural(warnings.digests.length, 'digest'),
  ];
  if (warnings.mode === 'live') {
    parts.push(`${warnings.delivered} delivered`);
    if (warnings.failed > 0) parts.push(`${warnings.failed} not delivered`);
  }
  if (warnings.alreadySent > 0) {
    parts.push(`${warnings.alreadySent} already had today's digest`);
  }
  return `warnings ${warnings.mode}: ${parts.join(', ')}`;
}

function describeDaily(daily: DailyResult): {
  ok: boolean;
  detail: string;
  error: string | null;
} {
  if (!daily.ran) {
    return {
      ok: true,
      detail: `daily already ran for ${daily.day} (use --force to run it again)`,
      error: null,
    };
  }
  const parts = [`daily ran for ${daily.day}`];
  let ok = true;
  let error: string | null = null;
  if (daily.allocation !== null) {
    const allocation = describeAllocation(daily.allocation);
    parts.push(allocation.detail);
    ok = allocation.ok;
    error = allocation.error;
  }
  if (daily.warnings !== null) parts.push(describeWarnings(daily.warnings));
  return { ok, detail: parts.join(', '), error };
}

type Step = (workspaceId: string) => Promise<{
  ok: boolean;
  detail: string;
  error?: string | null;
}>;

// Runs `step` for each workspace in turn. A thrown error becomes a failed
// outcome (logged at error) and the loop continues with the next one.
async function forEachWorkspace(
  ctx: CommandContext,
  command: CommandName,
  workspaceIds: readonly string[],
  step: Step
): Promise<WorkspaceOutcome[]> {
  const outcomes: WorkspaceOutcome[] = [];
  for (const workspaceId of workspaceIds) {
    const log = ctx.logger.child({ command, workspaceId });
    try {
      const done = await step(workspaceId);
      const outcome: WorkspaceOutcome = {
        workspaceId,
        ok: done.ok,
        detail: done.detail,
        error: done.ok ? null : (done.error ?? null),
      };
      if (outcome.ok) log.info('workspace done', { detail: outcome.detail });
      else log.error('workspace failed', { detail: outcome.error });
      outcomes.push(outcome);
    } catch (error) {
      log.error('workspace failed', { error });
      outcomes.push({
        workspaceId,
        ok: false,
        detail: '',
        error: oneLine(error),
      });
    }
  }
  return outcomes;
}

/**
 * One tick for one workspace: the daily run when it is due in the
 * workspace's timezone (the engine's claim makes it once per local day);
 * otherwise, or when today's run already happened, a plain full resync —
 * the periodic one that heals milestone and relation drift (Linear sends no
 * webhooks for those).
 */
async function tickWorkspace(
  ctx: CommandContext,
  workspaceId: string
): Promise<{ ok: boolean; detail: string; error: string | null }> {
  const timezone = await ctx.engine.workspaceTimezone(workspaceId);
  const decision = decideDailyRun(ctx.now(), timezone, ctx.config.dailyAt);
  ctx.logger.info('daily schedule checked', {
    workspaceId,
    timezone,
    dailyAt: ctx.config.dailyAt,
    ...decision,
  });
  if (decision.due) {
    // The day decided above, not whatever day it is once runDaily starts:
    // a tick deciding at 23:59:59 local must not claim tomorrow early.
    const daily = await ctx.engine.runDaily({
      workspaceId,
      day: decision.localDate,
    });
    if (daily.ran) return describeDaily(daily);
    const sync = await ctx.engine.fullSync(workspaceId);
    return {
      ok: true,
      detail: `${describeSync(sync)}, daily already ran for ${daily.day}`,
      error: null,
    };
  }
  const sync = await ctx.engine.fullSync(workspaceId);
  return {
    ok: true,
    detail: `${describeSync(sync)}, daily due at ${ctx.config.dailyAt} ${timezone}`,
    error: null,
  };
}

// Housekeeping after a tick: expired sessions (their Linear grants revoked)
// and webhook delivery records older than 30 days (the engine's
// WEBHOOK_RETENTION_DAYS, pruned inside cleanup()).
async function runCleanup(
  ctx: CommandContext,
  result: CommandResult
): Promise<void> {
  try {
    const cleaned = await ctx.engine.cleanup();
    const revoked =
      cleaned.revokeFailures > 0
        ? ` (${plural(cleaned.revokeFailures, 'revocation')} failed)`
        : '';
    result.notes.push(
      `cleanup: ${plural(cleaned.expiredSessions, 'expired session')}${revoked}, ${plural(cleaned.oldDeliveries, 'old webhook delivery record')}`
    );
  } catch (error) {
    ctx.logger.error('cleanup failed', { error });
    result.problems.push(`cleanup: ${oneLine(error)}`);
  }
}

/**
 * Runs one parsed command (except serve, which loops over tick in
 * run.ts). Never throws: failures end up in the result's outcomes or
 * problems.
 */
export async function runCommand(
  ctx: CommandContext,
  command: Exclude<CliCommand, { name: 'serve' }>
): Promise<CommandResult> {
  const result: CommandResult = {
    command: command.name,
    outcomes: [],
    problems: [],
    notes: [],
  };
  if (command.name === 'migrate') {
    // createEngineFromEnv already applied migrations (advisory-locked).
    result.notes.push('database schema is up to date');
    return result;
  }

  let workspaceIds: string[];
  let revokedIds: string[] = [];
  try {
    if (command.workspaceId === null) {
      [workspaceIds, revokedIds] = await Promise.all([
        ctx.engine.listWorkspaceIds(),
        ctx.engine.listRevokedWorkspaceIds(),
      ]);
    } else {
      workspaceIds = [command.workspaceId];
    }
  } catch (error) {
    ctx.logger.error('could not list installed workspaces', { error });
    result.problems.push(`listing workspaces: ${oneLine(error)}`);
    return result;
  }
  if (workspaceIds.length === 0 && revokedIds.length === 0) {
    ctx.logger.warn('no installed workspaces; nothing to do', {
      command: command.name,
    });
  }

  const { engine } = ctx;
  switch (command.name) {
    case 'sync':
      result.outcomes = await forEachWorkspace(
        ctx,
        command.name,
        workspaceIds,
        async (id) => ({
          ok: true,
          detail: describeSync(await engine.fullSync(id)),
        })
      );
      break;
    case 'daily':
      result.outcomes = await forEachWorkspace(
        ctx,
        command.name,
        workspaceIds,
        async (id) =>
          describeDaily(
            await engine.runDaily({ workspaceId: id, force: command.force })
          )
      );
      break;
    case 'allocate':
      result.outcomes = await forEachWorkspace(
        ctx,
        command.name,
        workspaceIds,
        async (id) =>
          describeAllocation(
            await engine.runAllocation({
              workspaceId: id,
              mode: command.mode,
              trigger: 'manual',
              actor: null,
            })
          )
      );
      break;
    case 'warn':
      result.outcomes = await forEachWorkspace(
        ctx,
        command.name,
        workspaceIds,
        async (id) => ({
          ok: true,
          detail: describeWarnings(
            await engine.runWarnings({ workspaceId: id })
          ),
        })
      );
      break;
    case 'tick':
      result.outcomes = await forEachWorkspace(
        ctx,
        command.name,
        workspaceIds,
        (id) => tickWorkspace(ctx, id)
      );
      await runCleanup(ctx, result);
      break;
  }
  result.outcomes.push(...revokedOutcomes(ctx, command.name, revokedIds));
  return result;
}

/** Why a revoked workspace fails every command (architecture §9). */
export const REVOKED_INSTALLATION_ERROR =
  'the app lost its Linear access (uninstalled, or its authorization stopped working); an admin must install it again from /setup';

// One failed outcome per workspace whose installation lost its Linear
// grant: listWorkspaceIds leaves them out, and without this the worker
// would exit 0 while allocation and every warning have stopped there.
function revokedOutcomes(
  ctx: CommandContext,
  command: CommandName,
  revokedIds: readonly string[]
): WorkspaceOutcome[] {
  return revokedIds.map((workspaceId) => {
    ctx.logger.error('workspace skipped: its installation is revoked', {
      command,
      workspaceId,
      remedy: 'an admin must install the app again from /setup',
    });
    return {
      workspaceId,
      ok: false,
      detail: '',
      error: REVOKED_INSTALLATION_ERROR,
    };
  });
}
