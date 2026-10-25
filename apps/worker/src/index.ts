// @better-tracker/worker: the scheduled-jobs CLI (architecture §9).
//
//   node apps/worker/dist/index.js <command> [options]   (see --help)
//
// Railway's cron service runs `tick` every 15 minutes. Run as a script, this
// module executes the CLI and exits with its code; imported, it only
// exports the pieces (parsing, the schedule decision, the commands and the
// driver) for tests and tooling.

import { isEntryPoint, runCli } from './run';

export {
  type CliCommand,
  type CommandName,
  isOperatorCommand,
  type OperatorCommand,
  type OperatorCommandName,
  parseArgs,
  type ParseResult,
  PURGE_NEEDS_YES,
  USAGE,
} from './cli';
export {
  type AllocationRunResult,
  type CommandContext,
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeFor,
  oneLine,
  type OutcomeKind,
  REVOKED_INSTALLATION_ERROR,
  runCommand,
  summaryLine,
  timeLeftMs,
  type WorkerEngine,
  workerEngineFrom,
  type WorkspaceCommand,
  type WorkspaceOutcome,
} from './commands';
export {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  DEFAULT_TICK_TIMEOUT_MINUTES,
  DEFAULT_WORKER_CONCURRENCY,
  loadWorkerConfig,
  MAX_WORKER_CONCURRENCY,
  type WorkerConfig,
  type WorkerEnv,
} from './config';
export {
  type BlockRow,
  type OperatorResult,
  redactText,
  runOperatorCommand,
  statusLabel,
  workspaceRow,
  type WorkspaceRow,
  workspacesTable,
  type WorkspaceStatusLabel,
} from './operator';
export {
  CHRONIC_AFTER_MS,
  dailyStartNeedMs,
  isChronic,
  MIN_DAILY_START_MS,
  MIN_START_MS,
  planFor,
  planWorkspaces,
  RECENT_SYNC_MS,
  recentSyncAgeMs,
  type SkipReason,
  START_MARGIN_MS,
  startNeedMs,
  startWantedMs,
  type WorkspacePlan,
} from './scaling';
export {
  type CliDeps,
  type CliOutput,
  consoleOutput,
  isEntryPoint,
  processStopSignal,
  runCli,
  sleepUnlessStopped,
  startDeadline,
  type WorkerEngineFactory,
  warnAboutDemoStorage,
} from './run';
export {
  dailyRunTooLate,
  type DailyRunDecision,
  type DailyTime,
  decideDailyRun,
  DEFAULT_DAILY_RUN_AT,
  firstInstantAtOrAfter,
  minutesOfDay,
  parseDailyRunAt,
} from './schedule';

if (isEntryPoint(import.meta.url, process.argv[1])) {
  const code = await runCli(process.argv.slice(2), { env: process.env });
  // Exit explicitly: a lingering keep-alive socket must not keep a cron
  // container running after the work is done and the store is closed.
  process.exit(code);
}
