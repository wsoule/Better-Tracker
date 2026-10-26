// The worker's driver: parse arguments, validate the environment, build the
// engine (createEngineFromEnv runs migrations first), run the command,
// print one human summary line, close the engine and return the exit code.
//
// `tick` and the manual one-shot commands (`sync`, `daily`, `allocate`,
// `warn`) run under one hard deadline, TICK_TIMEOUT_MINUTES, counted from
// the start and covering boot, the command and closing the store: when it
// passes, the worker logs an error naming the stage it was in and exits 1
// without waiting. So a hung run never blocks later cron runs (Railway
// skips a cron run while the previous one is still running), and no
// worker run outlives the window the engine's daily lease and stale-run
// threshold assume (config.ts, MAX_TICK_TIMEOUT_MINUTES). `serve` gives
// its boot, each tick and its shutdown a deadline of that length each.
// `migrate` has none: it claims no daily job and starts no allocation run,
// and it is how an operator applies a migration too long for one budget
// (every other command applies pending migrations inside its own). The
// commands see that deadline as CommandContext.deadlineAt and start a
// workspace only with enough time left before it (scaling.ts).
//
// The operator's workspace commands (`workspaces`, `remove`, `purge`,
// `block`, `unblock`; operator.ts) run like the one-shot commands, under
// the same deadline, and write their JSON logs to stderr so stdout holds
// only the table, the JSON or the summary line.

import {
  createEngineFromEnv,
  type CreateEngineFromEnvOptions,
  type EngineEnv,
  isFixtureEnv,
  linearAuthFromEnv,
} from '@better-tracker/engine';
import {
  createLogger,
  type Logger,
  type LogLevel,
} from '@better-tracker/logger';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type CliCommand, isOperatorCommand, parseArgs, USAGE } from './cli';
import {
  apiKeyModeOutcome,
  type CommandContext,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeFor,
  oneLine,
  runCommand,
  summaryLine,
  type WorkerEngine,
  workerEngineFrom,
} from './commands';
import { loadWorkerConfig, type WorkerConfig, type WorkerEnv } from './config';
import { runOperatorCommand } from './operator';
import { dailyRunTooLate } from './schedule';

const MINUTE_MS = 60_000;

/** Where the worker's human-readable lines go (not the JSON logs). */
export interface CliOutput {
  /** One-line summaries and --help, on stdout. */
  out(line: string): void;
  /** Usage and startup errors, on stderr. */
  err(line: string): void;
}

/** Builds the engine; tests pass a fake. */
export type WorkerEngineFactory = (
  env: EngineEnv,
  options: CreateEngineFromEnvOptions
) => Promise<WorkerEngine>;

export interface CliDeps {
  env: WorkerEnv;
  output?: CliOutput;
  /** The worker's own JSON logger (default: `worker` at LOG_LEVEL). */
  logger?: Logger;
  /** The engine's JSON logger (default: `engine` at LOG_LEVEL). */
  engineLogger?: Logger;
  createEngine?: WorkerEngineFactory;
  /** Clock for the schedule decision and the engine. */
  now?: () => Date;
  /**
   * Ends the process when a command passes its deadline (default
   * process.exit). Tests record the code instead.
   */
  exit?: (code: number) => void;
  /**
   * serve: aborted when the loop should stop (default: aborted by SIGTERM
   * or SIGINT).
   */
  stopSignal?: AbortSignal;
  /** serve: waits `ms`, or less when `stop` is aborted. */
  sleep?: (ms: number, stop: AbortSignal) => Promise<void>;
  /**
   * Overrides the hard timer's TICK_TIMEOUT_MINUTES in milliseconds
   * (tests). The start rules (CommandContext.deadlineAt) still count
   * TICK_TIMEOUT_MINUTES on the `now` clock, so a short test timer does
   * not leave every workspace unstarted.
   */
  tickTimeoutMs?: number;
}

/** The human output the CLI prints by default (stdout / stderr). */
export const consoleOutput: CliOutput = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

// Every log line on stderr: the operator commands keep stdout for their
// table, JSON or summary line.
function stderrSink(_level: LogLevel, line: string): void {
  console.error(line);
}

function logLevelFrom(env: WorkerEnv): LogLevel | undefined {
  const value = env['LOG_LEVEL']?.trim();
  return value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
    ? value
    : undefined;
}

/**
 * Starts a deadline: unless cancelled within `ms`, `onExpire` runs once.
 * The timer keeps the process alive on purpose (an unref'd timer would let
 * a hung, handle-less promise exit 0 silently), so callers must cancel it.
 */
export function startDeadline(
  ms: number,
  onExpire: () => void
): { cancel(): void } {
  const timer = setTimeout(onExpire, ms);
  return { cancel: () => clearTimeout(timer) };
}

/** Waits `ms`, resolving early when `stop` is aborted. */
export function sleepUnlessStopped(
  ms: number,
  stop: AbortSignal
): Promise<void> {
  if (stop.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      stop.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener('abort', done, { once: true });
  });
}

/**
 * An abort signal fed by SIGTERM and SIGINT: the first asks serve to
 * finish its current tick and exit; a second one exits 1 immediately.
 * `dispose` removes the handlers.
 */
export function processStopSignal(
  logger: Logger,
  exit: (code: number) => void
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const handler = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      logger.warn('second stop signal; exiting now', { signal });
      exit(EXIT_FAILED);
      return;
    }
    logger.info('stop requested; finishing the current tick', { signal });
    controller.abort();
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGTERM', handler);
      process.off('SIGINT', handler);
    },
  };
}

/**
 * Demo mode (LINEAR_FIXTURE=1 or showcase) never uses DATABASE_URL (§7.1)
 * and, without PGLITE_DIR, keeps everything in memory: every run starts
 * from a fresh database, so the "once per day" claim cannot carry over to
 * the next process. Says so instead of letting it surprise an operator.
 */
export function warnAboutDemoStorage(env: WorkerEnv, logger: Logger): void {
  if (!isFixtureEnv(env)) return;
  const set = (name: string): boolean => (env[name]?.trim() ?? '') !== '';
  if (set('DATABASE_URL')) {
    logger.warn('demo mode ignores DATABASE_URL; demo data never goes to it');
  }
  if (!set('PGLITE_DIR')) {
    logger.warn(
      'demo mode keeps its data in memory: each run starts fresh, so nothing (including the daily claim) carries over to the next run; set PGLITE_DIR to keep it'
    );
  }
}

const defaultEngineFactory: WorkerEngineFactory = async (env, options) =>
  workerEngineFrom(await createEngineFromEnv(env, options));

/** What the hard deadline needs to report and end the process. */
interface DeadlineTarget {
  output: CliOutput;
  logger: Logger;
  exit: (code: number) => void;
  timeoutMs: number;
}

interface Session extends DeadlineTarget {
  ctx: CommandContext;
  config: WorkerConfig;
}

// When a run that starts now hits its TICK_TIMEOUT_MINUTES deadline, on
// the commands' clock (CommandContext.deadlineAt).
function deadlineFrom(now: () => Date, config: WorkerConfig): Date {
  return new Date(now().getTime() + config.tickTimeoutMinutes * MINUTE_MS);
}

// What the deadline says was still running: the stage, and the workspaces
// whose step had not finished (CommandContext.inFlight), so the operator
// can tell which workspace keeps a run from finishing in time.
function stageWithWorkspaces(
  stage: string | null,
  inFlight: ReadonlySet<string>
): string | null {
  if (inFlight.size === 0) return stage;
  const ids = [...inFlight].join(', ');
  return `${stage ?? 'running'} (workspaces still running: ${ids})`;
}

// Arms the hard deadline for `what` (a one-shot command, or serve's boot,
// tick or shutdown): when it passes, log, tell the operator and end the
// process with exit code 1. `stage` names what was still running then
// (one deadline can cover several stages), e.g. "booting" for a one-shot
// command's whole-run deadline, and the workspaces still in flight.
function armDeadline(
  target: DeadlineTarget,
  what: string,
  stage: () => string | null = () => null
): { cancel(): void } {
  const minutes = target.timeoutMs / MINUTE_MS;
  return startDeadline(target.timeoutMs, () => {
    const during = stage();
    target.logger.error('worker timed out; exiting', {
      what,
      stage: during,
      timeoutMinutes: minutes,
    });
    target.output.err(
      `worker: ${what} did not finish within TICK_TIMEOUT_MINUTES (${minutes} min${during === null ? '' : `; stuck while ${during}`}); exiting with code 1`
    );
    target.exit(EXIT_FAILED);
  });
}

// serve: tick, wait out the rest of the interval, repeat until a stop is
// requested. A stop during a tick lets that tick finish first. Per-tick
// failures are logged and summarized; the loop keeps going.
async function serveLoop(
  session: Session,
  workspaceId: string | null,
  stop: AbortSignal,
  sleep: (ms: number, stop: AbortSignal) => Promise<void>
): Promise<number> {
  const intervalMs = session.config.syncIntervalMinutes * MINUTE_MS;
  session.logger.info('serve started', {
    intervalMinutes: session.config.syncIntervalMinutes,
    dailyAt: session.config.dailyAt,
  });
  let ticks = 0;
  let failedTicks = 0;
  while (!stop.aborted) {
    const startedMs = Date.now();
    const inFlight = session.ctx.inFlight ?? new Set<string>();
    const deadline = armDeadline(session, 'tick', () =>
      stageWithWorkspaces('running tick', inFlight)
    );
    try {
      const ctx: CommandContext = {
        ...session.ctx,
        deadlineAt: deadlineFrom(session.ctx.now, session.config),
      };
      const result = await runCommand(ctx, { name: 'tick', workspaceId });
      ticks += 1;
      if (exitCodeFor(result) !== EXIT_OK) failedTicks += 1;
      session.output.out(summaryLine(result));
    } finally {
      deadline.cancel();
    }
    if (stop.aborted) break;
    await sleep(Math.max(0, intervalMs - (Date.now() - startedMs)), stop);
  }
  session.logger.info('serve stopped', { ticks, failedTicks });
  return EXIT_OK;
}

/**
 * Runs the worker CLI for `argv` (`process.argv.slice(2)`) and resolves
 * with the exit code: 0 ok, 1 a workspace or the worker failed (including
 * invalid configuration), 2 usage error. Closes the engine before
 * resolving. When a command passes its hard deadline it calls
 * `deps.exit(1)` instead and never resolves.
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    output.out(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === 'error') {
    output.err(`worker: ${parsed.message}`);
    output.err('Run with --help for usage.');
    return EXIT_USAGE;
  }
  const command: CliCommand = parsed.command;
  const level = logLevelFrom(deps.env);
  const sink = isOperatorCommand(command) ? stderrSink : undefined;
  const logger = (
    deps.logger ?? createLogger({ name: 'worker', level, sink })
  ).child({ command: command.name });

  // Personal API keys (LINEAR_AUTH=api_key) live only in the planner's
  // memory: decided before booting, so the store is not even opened
  // (migrate excepted).
  const apiKeyOutcome =
    linearAuthFromEnv(deps.env) === 'api_key'
      ? apiKeyModeOutcome(command.name)
      : null;
  if (apiKeyOutcome !== null) {
    if (apiKeyOutcome.code === EXIT_OK) {
      output.out(apiKeyOutcome.line);
    } else {
      logger.error(apiKeyOutcome.line);
      output.err(apiKeyOutcome.line);
    }
    return apiKeyOutcome.code;
  }

  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(deps.env);
  } catch (error) {
    logger.error('invalid worker configuration', { error: oneLine(error) });
    output.err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }
  const scheduled = command.name === 'tick' || command.name === 'serve';
  const interval = command.name === 'serve' ? config.syncIntervalMinutes : 15;
  if (scheduled && dailyRunTooLate(config.dailyTime, interval)) {
    logger.warn(
      'DAILY_RUN_AT is so close to midnight that no tick may land between it and midnight; the daily run could be skipped',
      { dailyAt: config.dailyAt, intervalMinutes: interval }
    );
  }

  warnAboutDemoStorage(deps.env, logger);

  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const now = deps.now ?? ((): Date => new Date());
  const ownStop =
    command.name === 'serve' && deps.stopSignal === undefined
      ? processStopSignal(logger, exit)
      : null;
  const timeoutMs = deps.tickTimeoutMs ?? config.tickTimeoutMinutes * MINUTE_MS;
  // One-shot commands: the deadline the commands see, from this moment.
  const deadlineAt =
    command.name === 'serve' || command.name === 'migrate'
      ? null
      : deadlineFrom(now, config);
  const target: DeadlineTarget = { output, logger, exit, timeoutMs };
  // One-shot commands but migrate: one deadline from here until the engine
  // is closed. Booting can hang too (an unreachable database, a held
  // migration lock), and with a deadline per stage a run could last
  // several timeouts and overlap the next cron slot or a daily takeover.
  // serve: boot gets its own; each tick and the shutdown get theirs below.
  let stage = 'booting';
  // The workspaces a command's steps are running now (runOne).
  const inFlight = new Set<string>();
  const runDeadline =
    command.name === 'serve' || command.name === 'migrate'
      ? null
      : armDeadline(target, command.name, () =>
          stageWithWorkspaces(stage, inFlight)
        );
  const bootDeadline =
    command.name === 'serve' ? armDeadline(target, 'boot') : null;

  let engine: WorkerEngine;
  try {
    const createEngine = deps.createEngine ?? defaultEngineFactory;
    const engineLogger =
      deps.engineLogger ?? createLogger({ name: 'engine', level, sink });
    engine = await createEngine(deps.env, {
      logger: engineLogger.child({ command: command.name }),
      now,
      // migrate never handles a key: no api_key deploy checks for it.
      ...(command.name === 'migrate' ? { migrateOnly: true } : {}),
    });
  } catch (error) {
    runDeadline?.cancel();
    bootDeadline?.cancel();
    ownStop?.dispose();
    logger.error('worker could not start', { error });
    output.err(`worker: could not start: ${oneLine(error)}`);
    return EXIT_FAILED;
  }
  bootDeadline?.cancel();
  stage = `running ${command.name}`;

  const session: Session = {
    ...target,
    config,
    ctx: { engine, logger, config, now, deadlineAt, inFlight },
  };
  let code: number;
  try {
    if (command.name === 'serve') {
      const stop = deps.stopSignal ?? ownStop?.signal;
      if (stop === undefined) throw new Error('serve needs a stop signal');
      code = await serveLoop(
        session,
        command.workspaceId,
        stop,
        deps.sleep ?? sleepUnlessStopped
      );
    } else if (isOperatorCommand(command)) {
      const result = await runOperatorCommand(session.ctx, command);
      code = result.code;
      for (const line of result.lines) output.out(line);
    } else {
      const result = await runCommand(session.ctx, command);
      code = exitCodeFor(result);
      output.out(summaryLine(result));
      logger.info('command finished', {
        exitCode: code,
        outcomes: result.outcomes,
        problems: result.problems,
      });
    }
  } catch (error) {
    logger.error('command failed', { error });
    output.err(`worker: ${command.name} failed: ${oneLine(error)}`);
    code = EXIT_FAILED;
  }

  stage = 'closing the store';
  const closeDeadline =
    command.name === 'serve' ? armDeadline(target, 'shutdown') : null;
  try {
    await engine.close();
  } catch (error) {
    logger.error('could not close the engine', { error });
    code = EXIT_FAILED;
  } finally {
    runDeadline?.cancel();
    closeDeadline?.cancel();
    // Only now: a second SIGTERM/SIGINT while the store closes must still
    // exit 1 at once (without a listener, node as PID 1 ignores SIGTERM).
    ownStop?.dispose();
  }
  return code;
}

/**
 * True when the module at `moduleUrl` is the script node was started with
 * (`argv1` = process.argv[1]), so importing the package does not run the
 * CLI. `argv1` is what was typed, so it is resolved the way node resolves
 * its main script (an extension-less path, a directory's package.json
 * `main` or index.js): otherwise `node apps/worker tick` would load the CLI
 * and silently do nothing. Symlinks are resolved on both sides.
 */
export function isEntryPoint(
  moduleUrl: string,
  argv1: string | undefined
): boolean {
  if (argv1 === undefined) return false;
  try {
    const script = createRequire(moduleUrl).resolve(resolve(argv1));
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(script);
  } catch {
    return false;
  }
}
