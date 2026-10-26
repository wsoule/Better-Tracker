// The worker's commands (architecture §9) over the engine. A command over
// every workspace plans them from the engine's overview (scaling.ts): the
// active, admitted ones run, WORKER_CONCURRENCY at a time, least recently
// attempted first, each only when there is time left to finish it; the rest
// are skipped (uninstalled, removed, blocked, not admitted) or failed (a
// dead app grant). A failure in one is logged and recorded, and the others
// still run. The result carries one outcome per workspace, from which the
// exit code and the one-line human summary are derived. The operator's
// workspace commands are in operator.ts.

import { isValidTimeZone } from '@better-tracker/core';
import type {
  CleanupOptions,
  CleanupResult,
  CleanupStep,
  DailyResult,
  Engine,
  SyncResult,
  WarningRunResult,
  WorkspaceOverview,
} from '@better-tracker/engine';
import type { Logger } from '@better-tracker/logger';

import {
  type CliCommand,
  type CommandName,
  isOperatorCommandName,
  LIVE_ALLOCATE_NEEDS_WORKSPACE,
  type OperatorCommand,
} from './cli';
import type { WorkerConfig } from './config';
import {
  cleanupDeadline,
  dailyStartNeedMs,
  formatDuration,
  isChronic,
  planWorkspaces,
  recentSyncAgeMs,
  startNeedMs,
  startWantedMs,
  type WorkspacePlan,
} from './scaling';
import { decideDailyRun } from './schedule';

/** An allocation run as the engine returns it. */
export type AllocationRunResult = Awaited<ReturnType<Engine['runAllocation']>>;

/**
 * The slice of the engine the worker uses. `workspaceTimezone` resolves a
 * workspace's saved timezone (falling back to DEFAULT_TIMEZONE when the
 * saved one is invalid, as the engine itself does), so the schedule
 * decision and the engine's "today" agree. The workspace lifecycle methods
 * are the operator commands' (operator.ts); nothing else calls them.
 */
export interface WorkerEngine {
  readonly mode: 'linear' | 'fixture';
  /**
   * Every workspace the store knows, least recently attempted first, with
   * its installation, sync state, sessions and admission's verdict.
   */
  listWorkspaceStatus(): Promise<WorkspaceOverview[]>;
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
  cleanup(options?: CleanupOptions): Promise<CleanupResult>;
  removeWorkspace: Engine['removeWorkspace'];
  purgeWorkspaceNow: Engine['purgeWorkspaceNow'];
  blockWorkspace: Engine['blockWorkspace'];
  unblockWorkspace: Engine['unblockWorkspace'];
  listBlockedWorkspaces: Engine['listBlockedWorkspaces'];
  close(): Promise<void>;
}

/** Adapts a full engine to the worker's slice. */
export function workerEngineFrom(engine: Engine): WorkerEngine {
  return {
    mode: engine.mode,
    listWorkspaceStatus: () => engine.listWorkspaceStatus(),
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
    cleanup: (options) => engine.cleanup(options),
    removeWorkspace: (name) => engine.removeWorkspace(name),
    purgeWorkspaceNow: (name, options) =>
      engine.purgeWorkspaceNow(name, options),
    blockWorkspace: (name, reason) => engine.blockWorkspace(name, reason),
    unblockWorkspace: (name) => engine.unblockWorkspace(name),
    listBlockedWorkspaces: () => engine.listBlockedWorkspaces(),
    close: () => engine.close(),
  };
}

/**
 * How one workspace ended up: `done`; `failed` (fails the command);
 * `chronic` (a tick's failure in a workspace that has had no successful
 * full sync for 24 hours: warned about, does not fail it); `skipped`
 * (uninstalled, removed, blocked or not admitted); `deferred` (not
 * started: too little time left; the next tick picks it up first).
 */
export type OutcomeKind =
  | 'done'
  | 'failed'
  | 'chronic'
  | 'skipped'
  | 'deferred';

/** What one command did for one workspace. */
export interface WorkspaceOutcome {
  workspaceId: string;
  kind: OutcomeKind;
  /** false when it failed (`failed` or `chronic`). */
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
  /**
   * When the run's hard deadline (TICK_TIMEOUT_MINUTES from its start)
   * passes, on the `now` clock; null for none (migrate). A workspace or a
   * daily job starts only with enough time left before it.
   */
  deadlineAt: Date | null;
  /**
   * The workspaces whose step is running right now (runOne adds and drops
   * them), so the hard deadline's message can name what was still running
   * when it fired. Optional: a context without it tracks nothing.
   */
  inFlight?: Set<string>;
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
 * `allocate`, `warn` and the operator's workspace commands exit 1 with a
 * sentence. Null for `migrate`, which boots as always (it only opens the
 * store and migrates).
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
  if (isOperatorCommandName(command)) {
    return {
      code: EXIT_FAILED,
      line: `${command}: off when LINEAR_AUTH=api_key: the planner serves one workspace with personal keys, so there is nothing to list, remove, purge or block`,
    };
  }
  return {
    code: EXIT_FAILED,
    line: `${command}: off when LINEAR_AUTH=api_key: keys live only in the planner's memory; start a run or a resync from the planner`,
  };
}

/**
 * The process exit code for a command: 1 when any workspace failed (not
 * chronic, skipped or deferred ones) or a workspace-independent step
 * (listing workspaces, cleanup) failed, so cron failures are loud;
 * otherwise 0. No workspaces at all is not a failure.
 */
export function exitCodeFor(
  result: Pick<CommandResult, 'outcomes' | 'problems'>
): 0 | 1 {
  if (result.problems.length > 0) return EXIT_FAILED;
  return result.outcomes.some((outcome) => outcome.kind === 'failed')
    ? EXIT_FAILED
    : EXIT_OK;
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

/** `1 issue`, `2 issues`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The one-line human summary printed when a command finishes, e.g.
 * `tick ok — ws-1: synced (mirror v4, 120 issues, 812 ms); cleanup: …`.
 */
export function summaryLine(result: CommandResult): string {
  const failed = result.outcomes.filter((o) => o.kind === 'failed').length;
  const chronic = result.outcomes.filter((o) => o.kind === 'chronic').length;
  const status =
    exitCodeFor(result) === EXIT_OK
      ? chronic > 0
        ? `ok (${chronic} chronic)`
        : 'ok'
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
    const label = outcome.kind === 'chronic' ? 'chronic failure' : 'FAILED';
    parts.push(`${outcome.workspaceId}: ${label}${detail}${error}`);
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

function describeDaily(daily: DailyResult): StepResult {
  if (!daily.ran) {
    return {
      ok: true,
      detail: `daily already ran for ${daily.day} (use --force to run it again)`,
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
  return { ok, detail: parts.join(', '), error, synced: daily.sync !== null };
}

/** What one step did for one workspace. */
interface StepResult {
  ok: boolean;
  detail: string;
  error?: string | null;
  /** Not started for lack of time (ok, not a failure). */
  deferred?: boolean;
  /** This step's own full sync succeeded (a later failure is not chronic). */
  synced?: boolean;
}

/**
 * One workspace's work in a command. `status` is the overview read when
 * the run started, or null for a workspace named with --workspace (which
 * is not listed).
 */
type Step = (
  workspaceId: string,
  status: WorkspaceOverview | null
) => Promise<StepResult>;

/** A workspace a command runs, with its overview when it was listed. */
interface RunTarget {
  workspaceId: string;
  status: WorkspaceOverview | null;
}

/**
 * Milliseconds left before the run's deadline on the context's clock;
 * Infinity without a deadline.
 */
export function timeLeftMs(ctx: CommandContext): number {
  return ctx.deadlineAt === null
    ? Number.POSITIVE_INFINITY
    : ctx.deadlineAt.getTime() - ctx.now().getTime();
}

// The whole budget a run gets (TICK_TIMEOUT_MINUTES), for the start caps.
function budgetMs(ctx: CommandContext): number {
  return ctx.config.tickTimeoutMinutes * 60_000;
}

// The phrase for something not started for lack of time.
function deferredPhrase(
  command: CommandName,
  what: string,
  leftMs: number,
  neededMs: number
): string {
  const times = `${formatDuration(leftMs)} left, needs ${formatDuration(neededMs)}`;
  return command === 'tick'
    ? `${what} deferred to the next tick (${times})`
    : `${what} not started (${times}); run it again`;
}

// Runs one workspace's step: deferred when the time left is below what it
// needs (startNeedMs); a thrown error becomes a failed outcome (logged at
// error), or a chronic one (warn) in a tick when the workspace has had no
// successful full sync for 24 hours.
async function runOne(
  ctx: CommandContext,
  command: CommandName,
  target: RunTarget,
  step: Step
): Promise<WorkspaceOutcome> {
  const { workspaceId, status } = target;
  const log = ctx.logger.child({ command, workspaceId });
  const lastFullSyncMs = status?.sync?.lastFullSyncMs ?? null;
  const deferredMessage =
    command === 'tick'
      ? 'workspace deferred to the next tick'
      : 'workspace not started: not enough time left';
  const left = timeLeftMs(ctx);
  const needed = startNeedMs(lastFullSyncMs, budgetMs(ctx));
  if (left < needed) {
    log.info(deferredMessage, {
      timeLeftMs: left,
      neededMs: needed,
      lastFullSyncMs,
    });
    return {
      workspaceId,
      kind: 'deferred',
      ok: true,
      detail: deferredPhrase(command, 'workspace', left, needed),
      error: null,
    };
  }
  if (ctx.deadlineAt !== null && startWantedMs(lastFullSyncMs) > needed) {
    log.warn(
      'workspace syncs too slowly to start with twice its last sync time left; it starts only at the beginning of a run',
      { lastFullSyncMs, tickTimeoutMinutes: ctx.config.tickTimeoutMinutes }
    );
  }

  let done: StepResult;
  let thrown: unknown = null;
  ctx.inFlight?.add(workspaceId);
  try {
    done = await step(workspaceId, status);
  } catch (error) {
    thrown = error;
    done = { ok: false, detail: '', error: oneLine(error) };
  } finally {
    ctx.inFlight?.delete(workspaceId);
  }
  const outcome = (kind: OutcomeKind): WorkspaceOutcome => ({
    workspaceId,
    kind,
    ok: kind !== 'failed' && kind !== 'chronic',
    detail: done.detail,
    error:
      kind === 'failed' || kind === 'chronic' ? (done.error ?? null) : null,
  });
  if (done.ok) {
    if (done.deferred === true) {
      log.info(deferredMessage, { detail: done.detail });
      return outcome('deferred');
    }
    log.info('workspace done', { detail: done.detail });
    return outcome('done');
  }
  // The thrown error itself (with its stack) when there is one.
  const why = thrown === null ? { detail: done.error } : { error: thrown };
  if (chronicFailure(ctx, command, status, done)) {
    log.warn(
      'workspace failed again (chronic: no successful full sync for 24 hours)',
      { ...why, lastSuccessAt: status?.sync?.lastSuccessAt ?? null }
    );
    return outcome('chronic');
  }
  log.error('workspace failed', why);
  return outcome('failed');
}

// Whether a failed step is chronic: only in a tick over listed workspaces
// (the cron; a command run by hand always reports its failures), and only
// when the step's own sync did not succeed (scaling.ts isChronic).
function chronicFailure(
  ctx: CommandContext,
  command: CommandName,
  status: WorkspaceOverview | null,
  done: StepResult
): boolean {
  return (
    command === 'tick' &&
    status !== null &&
    done.synced !== true &&
    isChronic(status, ctx.now())
  );
}

/**
 * Runs `step` for each target, at most WORKER_CONCURRENCY at once, in the
 * targets' order (each free lane takes the next one). Outcomes keep the
 * targets' order whatever order they finish in.
 */
async function runTargets(
  ctx: CommandContext,
  command: CommandName,
  targets: readonly RunTarget[],
  step: Step
): Promise<WorkspaceOutcome[]> {
  const outcomes: WorkspaceOutcome[] = Array.from({ length: targets.length });
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const target = targets[index];
      if (target === undefined) return;
      outcomes[index] = await runOne(ctx, command, target, step);
    }
  };
  const lanes = Math.max(1, Math.min(ctx.config.concurrency, targets.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return outcomes;
}

/**
 * One tick for one workspace: the daily run when it is due in the
 * workspace's timezone (the engine's claim makes it once per local day)
 * and at least 5 minutes are left; when today's run already happened, a
 * plain full resync — the periodic one that heals milestone and relation
 * drift (Linear sends no webhooks for those) — unless a successful one
 * finished less than 10 minutes ago. The daily job's own sync is never
 * skipped. A due daily job with less than 5 minutes left defers the whole
 * workspace, with no plain resync: a resync would record a fresh attempt
 * and send the workspace to the back of the next tick's queue, so the
 * same workspaces would reach their daily job too late on every tick.
 * Deferred, it keeps its old attempt time and runs first next tick.
 */
async function tickWorkspace(
  ctx: CommandContext,
  workspaceId: string,
  status: WorkspaceOverview | null
): Promise<StepResult> {
  const timezone = await ctx.engine.workspaceTimezone(workspaceId);
  const decision = decideDailyRun(ctx.now(), timezone, ctx.config.dailyAt);
  ctx.logger.info('daily schedule checked', {
    workspaceId,
    timezone,
    dailyAt: ctx.config.dailyAt,
    ...decision,
  });
  let after = `daily due at ${ctx.config.dailyAt} ${timezone}`;
  if (decision.due) {
    const left = timeLeftMs(ctx);
    const needed = dailyStartNeedMs(budgetMs(ctx));
    if (left >= needed) {
      // The day decided above, not whatever day it is once runDaily
      // starts: a tick deciding at 23:59:59 local must not claim
      // tomorrow early.
      const daily = await ctx.engine.runDaily({
        workspaceId,
        day: decision.localDate,
      });
      if (daily.ran) return describeDaily(daily);
      after = `daily already ran for ${daily.day}`;
    } else {
      ctx.logger.info('daily job deferred to the next tick', {
        workspaceId,
        timeLeftMs: left,
        neededMs: needed,
      });
      return {
        ok: true,
        deferred: true,
        detail: deferredPhrase('tick', 'daily', left, needed),
      };
    }
  }
  const recent = recentSyncAgeMs(status, ctx.now());
  if (recent !== null) {
    return {
      ok: true,
      detail: `sync skipped (the last full sync finished ${formatDuration(recent)} ago), ${after}`,
    };
  }
  const sync = await ctx.engine.fullSync(workspaceId);
  return { ok: true, detail: `${describeSync(sync)}, ${after}`, synced: true };
}

// The daily command for one workspace: deferred with less than 5 minutes
// left, so a run close to its deadline never starts allocation.
async function dailyWorkspace(
  ctx: CommandContext,
  workspaceId: string,
  force: boolean
): Promise<StepResult> {
  const left = timeLeftMs(ctx);
  const needed = dailyStartNeedMs(budgetMs(ctx));
  if (left < needed) {
    return {
      ok: true,
      deferred: true,
      detail: deferredPhrase('daily', 'daily', left, needed),
    };
  }
  return describeDaily(await ctx.engine.runDaily({ workspaceId, force }));
}

/** How a tick's summary names a cleanup step left for the next tick. */
const CLEANUP_STEP_LABEL: Record<CleanupStep, string> = {
  expired_sessions: 'expired sessions',
  workspace_sessions: 'sessions of uninstalled or removed workspaces',
  purges: 'purges',
  identity_reads: 'URL key reads',
};

// Housekeeping at the start of a tick (engine.cleanup(), arch §9
// "Cleanup"), before the workspaces are listed and run: one workspace too
// slow for TICK_TIMEOUT_MINUTES can no longer starve every other
// workspace's purges and session revocations by getting the tick killed
// first, and a workspace cleanup admits again (its URL key read from
// Linear) is served in the same tick. Each step is bounded per call, and
// in time by cleanupDeadline (at most 2 minutes, at most half the time
// left), so a slow Linear cannot starve the workspaces either; what it
// leaves is named and done next tick. Expired sessions and those of
// uninstalled or removed workspaces (their Linear grants revoked), purges
// 30 days after an uninstall or removal, and retention for webhook
// deliveries, notifications and job claims; installed workspaces
// LINEAR_WORKSPACES leaves out are counted (never removed). The counts
// added for several workspaces are listed only when not zero.
async function runCleanup(
  ctx: CommandContext,
  result: CommandResult
): Promise<void> {
  try {
    const cleaned = await ctx.engine.cleanup({
      deadline: cleanupDeadline(ctx.now(), ctx.deadlineAt),
    });
    const revoked =
      cleaned.revokeFailures > 0
        ? ` (${plural(cleaned.revokeFailures, 'revocation')} failed)`
        : '';
    const parts = [
      `${plural(cleaned.expiredSessions, 'expired session')}${revoked}`,
      plural(cleaned.oldDeliveries, 'old webhook delivery record'),
    ];
    const extra: Array<[number | undefined, string, string]> = [
      [
        cleaned.endedWorkspaceSessions,
        'session of an uninstalled or removed workspace',
        'sessions of uninstalled or removed workspaces',
      ],
      [cleaned.purgedWorkspaces, 'workspace purged', 'workspaces purged'],
      [cleaned.oldNotifications, 'old notification', 'old notifications'],
      [cleaned.oldJobClaims, 'old job claim', 'old job claims'],
      [
        cleaned.notServedWorkspaces,
        'installed workspace not served (LINEAR_WORKSPACES leaves it out)',
        'installed workspaces not served (LINEAR_WORKSPACES leaves them out)',
      ],
      [
        cleaned.reAdmittedWorkspaces,
        'installed workspace admitted again (its URL key read from Linear)',
        'installed workspaces admitted again (their URL keys read from Linear)',
      ],
    ];
    for (const [count = 0, one, many] of extra) {
      if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
    }
    const deferred = cleaned.deferred ?? [];
    if (deferred.length > 0) {
      parts.push(
        `left for the next tick: ${deferred.map((step) => CLEANUP_STEP_LABEL[step]).join(', ')}`
      );
    }
    result.notes.push(`cleanup: ${parts.join(', ')}`);
  } catch (error) {
    ctx.logger.error('cleanup failed', { error });
    result.problems.push(`cleanup: ${oneLine(error)}`);
  }
}

/** Why a workspace revoked as grant_dead fails every command (§9). */
export const REVOKED_INSTALLATION_ERROR =
  "Linear refused the app's token (its authorization stopped working); an admin must install it again from /setup";

/** The summary phrase for a workspace a run leaves out. */
const SKIPPED_DETAIL: Record<
  Extract<WorkspacePlan, { kind: 'skip' }>['reason'],
  string
> = {
  blocked: 'skipped (blocked by the operator)',
  'not admitted': 'skipped (LINEAR_WORKSPACES does not admit it)',
  uninstalled: 'skipped (uninstalled in Linear)',
  removed: 'skipped (removed by the operator)',
};

// The outcomes of the workspaces a run does not work on: skipped ones
// (info) and, for a dead app grant, a failure with an error log naming the
// reinstall, so the cron turns red instead of quietly doing nothing while
// allocation and warnings have stopped there.
function plannedOutcomes(
  ctx: CommandContext,
  command: CommandName,
  plans: readonly WorkspacePlan[]
): WorkspaceOutcome[] {
  const outcomes: WorkspaceOutcome[] = [];
  for (const plan of plans) {
    const { workspaceId } = plan;
    if (plan.kind === 'skip') {
      ctx.logger.info('workspace skipped', {
        command,
        workspaceId,
        reason: plan.reason,
      });
      outcomes.push({
        workspaceId,
        kind: 'skipped',
        ok: true,
        detail: SKIPPED_DETAIL[plan.reason],
        error: null,
      });
    } else if (plan.kind === 'grant_dead') {
      ctx.logger.error('workspace skipped: its installation is revoked', {
        command,
        workspaceId,
        reason: 'grant_dead',
        remedy: 'an admin must install the app again from /setup',
      });
      outcomes.push({
        workspaceId,
        kind: 'failed',
        ok: false,
        detail: '',
        error: REVOKED_INSTALLATION_ERROR,
      });
    }
  }
  return outcomes;
}

/** A command runCommand runs (not serve, which loops over tick in run.ts). */
export type WorkspaceCommand = Exclude<
  CliCommand,
  { name: 'serve' } | OperatorCommand
>;

/**
 * Runs one parsed command (except serve, which loops over tick in
 * run.ts, and the operator commands in operator.ts). Never throws:
 * failures end up in the result's outcomes or problems.
 */
export async function runCommand(
  ctx: CommandContext,
  command: WorkspaceCommand
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
  // The parser refuses it too (exit 2); a caller that builds the command
  // itself still never writes to Linear in every workspace at once.
  if (
    command.name === 'allocate' &&
    command.mode === 'live' &&
    command.workspaceId === null
  ) {
    result.problems.push(LIVE_ALLOCATE_NEEDS_WORKSPACE);
    return result;
  }

  // A tick's housekeeping comes first, before the listing: it may admit a
  // workspace again, which then runs in this tick.
  if (command.name === 'tick') await runCleanup(ctx, result);

  let targets: RunTarget[];
  let others: WorkspacePlan[] = [];
  try {
    if (command.workspaceId === null) {
      const plans = planWorkspaces(await ctx.engine.listWorkspaceStatus());
      targets = plans.flatMap((plan) =>
        plan.kind === 'run'
          ? [{ workspaceId: plan.workspaceId, status: plan.status }]
          : []
      );
      others = plans.filter((plan) => plan.kind !== 'run');
    } else {
      targets = [{ workspaceId: command.workspaceId, status: null }];
    }
  } catch (error) {
    ctx.logger.error('could not list installed workspaces', { error });
    result.problems.push(`listing workspaces: ${oneLine(error)}`);
    return result;
  }
  if (targets.length === 0 && others.length === 0) {
    ctx.logger.warn('no installed workspaces; nothing to do', {
      command: command.name,
    });
  }

  const { engine } = ctx;
  const run = (step: Step): Promise<WorkspaceOutcome[]> =>
    runTargets(ctx, command.name, targets, step);
  switch (command.name) {
    case 'sync':
      result.outcomes = await run(async (id) => ({
        ok: true,
        detail: describeSync(await engine.fullSync(id)),
        synced: true,
      }));
      break;
    case 'daily':
      result.outcomes = await run((id) =>
        dailyWorkspace(ctx, id, command.force)
      );
      break;
    case 'allocate':
      result.outcomes = await run(async (id) =>
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
      result.outcomes = await run(async (id) => ({
        ok: true,
        detail: describeWarnings(await engine.runWarnings({ workspaceId: id })),
      }));
      break;
    case 'tick':
      result.outcomes = await run((id, status) =>
        tickWorkspace(ctx, id, status)
      );
      break;
  }
  result.outcomes.push(...plannedOutcomes(ctx, command.name, others));
  return result;
}
