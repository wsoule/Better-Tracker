// Command-line parsing for the worker (architecture §9). Pure: argv in, a
// typed command or a usage error out. The caller prints USAGE for `--help`
// and exits 2 on a usage error, so a typo in a cron start command fails
// loudly instead of silently doing something else.

import type { AllocationMode } from '@better-tracker/core';

/**
 * The operator's workspace commands (OAuth mode; architecture §9
 * "Operator commands"): one deployment serves several Linear workspaces
 * (owner decision 2026-10-25), and these list, remove, purge, block and
 * unblock them. There is no operator role in the planner: they exist only
 * here, run by whoever can open a shell on the deployment.
 */
export type OperatorCommandName =
  | 'workspaces'
  | 'remove'
  | 'purge'
  | 'block'
  | 'unblock';

/** The worker's commands, in the order the usage text lists them. */
export type CommandName =
  | 'migrate'
  | 'sync'
  | 'daily'
  | 'allocate'
  | 'warn'
  | 'tick'
  | 'serve'
  | OperatorCommandName;

/**
 * A parsed command line. `workspaceId: null` means every installed
 * workspace. An operator command's `workspace` is an org id or URL key,
 * which the engine resolves.
 */
export type CliCommand =
  | { name: 'migrate' }
  | { name: 'sync'; workspaceId: string | null }
  | { name: 'daily'; workspaceId: string | null; force: boolean }
  | { name: 'allocate'; workspaceId: string | null; mode: AllocationMode }
  | { name: 'warn'; workspaceId: string | null }
  | { name: 'tick'; workspaceId: string | null }
  | { name: 'serve'; workspaceId: string | null }
  | { name: 'workspaces'; json: boolean }
  | { name: 'remove'; workspace: string }
  | { name: 'purge'; workspace: string }
  | { name: 'block'; workspace: string; reason: string | null }
  | { name: 'unblock'; workspace: string };

/** A parsed operator command. */
export type OperatorCommand = Extract<
  CliCommand,
  { name: OperatorCommandName }
>;

const OPERATOR_COMMANDS: readonly OperatorCommandName[] = [
  'workspaces',
  'remove',
  'purge',
  'block',
  'unblock',
];

/** Whether `name` is one of the operator's workspace commands. */
export function isOperatorCommandName(
  name: CommandName
): name is OperatorCommandName {
  return (OPERATOR_COMMANDS as readonly string[]).includes(name);
}

/** Whether `command` is one of the operator's workspace commands. */
export function isOperatorCommand(
  command: CliCommand
): command is OperatorCommand {
  return isOperatorCommandName(command.name);
}

/** How an operator names a workspace: an org id or a URL key (as the engine). */
const WORKSPACE_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** The longest `--reason` the engine keeps. */
const MAX_REASON_LENGTH = 500;

/**
 * Why `allocate --live` needs --workspace: one deployment serves several
 * workspaces (owner decision 2026-10-25), each with its own saved
 * allocation mode, and a live run writes to Linear (assignments, state
 * moves, comments) as the app. A run over every workspace would write
 * into workspaces whose people left allocation on dry run, which the
 * terms page says cannot happen.
 */
export const LIVE_ALLOCATE_NEEDS_WORKSPACE =
  'allocate --live writes to Linear, so it runs for one workspace at a time: add --workspace <id> (allocate --dry-run may run for every workspace).';

/** Why purge refuses to run without --yes. */
export const PURGE_NEEDS_YES =
  'purge deletes everything the planner keeps for the workspace (its mirror, settings, run log and audit log) and cannot be undone; add --yes to confirm.';

export type ParseResult =
  | { kind: 'help' }
  | { kind: 'command'; command: CliCommand }
  | { kind: 'error'; message: string };

/** Printed for `--help`, `-h` and `help`. */
export const USAGE: string = `Usage: node apps/worker/dist/index.js <command> [options]

Commands:
  migrate                          Apply database migrations, then exit.
  sync     [--workspace <id>]      Full resync from Linear.
  daily    [--workspace <id>] [--force]
                                   The scheduled job: sync, allocation (in the
                                   workspace's allocation mode), warnings.
                                   Once per local day unless --force.
  allocate --dry-run [--workspace <id>]
  allocate --live --workspace <id>
                                   Run allocation now in the given mode
                                   (live writes to Linear: one workspace).
  warn     [--workspace <id>]      Run the warnings and digests now.
  tick     [--workspace <id>]      What the cron runs every 15 minutes: the
                                   daily job when it is due in the workspace's
                                   timezone, otherwise a full resync; then
                                   housekeeping.
  serve    [--workspace <id>]      Run tick every SYNC_INTERVAL_MINUTES
                                   (default 15) until SIGTERM or SIGINT.

Operator commands (OAuth mode; off with LINEAR_AUTH=api_key). <name> is a
workspace's organization id or URL key:
  workspaces [--json]              List every workspace: status, install,
                                   purge date, last sync, issues, sessions.
  remove   --workspace <name>      Revoke the app's Linear token, mark the
                                   install removed (purged 30 days later
                                   unless an admin reinstalls) and end its
                                   sessions now.
  purge    --workspace <name> --yes
                                   Delete everything kept for a revoked
                                   workspace now (run remove first).
  block    --workspace <name> [--reason <text>]
                                   Refuse the workspace from now on; removes
                                   it when installed and ends its sessions.
  unblock  --workspace <name>      Lift a block (an admin reinstalls).

Every command except migrate and serve exits 1 when it is still running
TICK_TIMEOUT_MINUTES (default 10, at most 14) after it started; serve
applies that limit to its boot, each tick and its shutdown. A run over
every workspace works on WORKER_CONCURRENCY (default 3) at once, least
recently synced first, and leaves for the next tick any workspace it has
no time left to start.

Options:
  --workspace <id>   One Linear workspace id (default: every installed one;
                     required for allocate --live); for operator commands,
                     an org id or URL key (required).
  --force            daily only: run even if today's run already happened.
  --dry-run, --live  allocate only: required, exactly one.
  --json             workspaces only: print JSON instead of a table.
  --yes              purge only: required.
  --reason <text>    block only: why, kept with the block (at most 500).
  -h, --help         Show this help.

Environment: see .env.example. DAILY_RUN_AT (default 08:00, HH:MM in each
workspace's timezone) sets when the daily job becomes due.

Exit codes: 0 ok (skipped, deferred and chronic workspaces included), 1 a
workspace or the worker failed, 2 usage error.`;

const COMMANDS: readonly CommandName[] = [
  'migrate',
  'sync',
  'daily',
  'allocate',
  'warn',
  'tick',
  'serve',
  ...OPERATOR_COMMANDS,
];

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

interface RawOptions {
  command: CommandName | null;
  workspaceId: string | null;
  force: boolean;
  dryRun: boolean;
  live: boolean;
  json: boolean;
  yes: boolean;
  reason: string | null;
}

// Reads `<flag> <value>` / `<flag>=<value>` starting at argv[index]. A
// separate value may not look like an option. Returns the trimmed value
// and how many tokens it used, or `missing` as the error message.
function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
  missing: string
): { value: string; used: number } | { error: string } {
  const token = argv[index] ?? '';
  if (token.startsWith(`${flag}=`)) {
    const value = token.slice(flag.length + 1).trim();
    return value === '' ? { error: missing } : { value, used: 1 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-') || next.trim() === '') {
    return { error: missing };
  }
  return { value: next.trim(), used: 2 };
}

// The option flags that apply to one command only, with that command.
const SINGLE_COMMAND_FLAGS: ReadonlyArray<
  [keyof Pick<RawOptions, 'force' | 'json' | 'yes'>, string, CommandName]
> = [
  ['force', '--force', 'daily'],
  ['json', '--json', 'workspaces'],
  ['yes', '--yes', 'purge'],
];

// An operator command's --workspace: required, and an org id or URL key.
function operatorWorkspace(
  command: OperatorCommandName,
  workspace: string | null
): { workspace: string } | { error: string } {
  if (workspace === null) {
    return { error: `${command} needs --workspace <org id or URL key>.` };
  }
  if (!WORKSPACE_NAME.test(workspace)) {
    return {
      error:
        '--workspace takes an organization id or URL key (letters, digits and dashes, at most 64).',
    };
  }
  return { workspace };
}

// Builds an operator command once the shared checks passed.
function buildOperatorCommand(
  command: OperatorCommandName,
  raw: RawOptions
): ParseResult {
  if (command === 'workspaces') {
    if (raw.workspaceId !== null) {
      return {
        kind: 'error',
        message:
          'workspaces does not take --workspace (it lists every workspace).',
      };
    }
    return { kind: 'command', command: { name: 'workspaces', json: raw.json } };
  }
  const named = operatorWorkspace(command, raw.workspaceId);
  if ('error' in named) return { kind: 'error', message: named.error };
  const { workspace } = named;
  switch (command) {
    case 'remove':
    case 'unblock':
      return { kind: 'command', command: { name: command, workspace } };
    case 'purge':
      if (!raw.yes) return { kind: 'error', message: PURGE_NEEDS_YES };
      return { kind: 'command', command: { name: 'purge', workspace } };
    case 'block':
      return {
        kind: 'command',
        command: { name: 'block', workspace, reason: raw.reason },
      };
  }
}

// Checks the options make sense for the command and builds the result.
function buildCommand(raw: RawOptions): ParseResult {
  const { command } = raw;
  if (command === null) {
    return { kind: 'error', message: 'No command given.' };
  }
  for (const [key, flag, only] of SINGLE_COMMAND_FLAGS) {
    if (raw[key] && command !== only) {
      return {
        kind: 'error',
        message: `${flag} is only valid for ${only}, not ${command}.`,
      };
    }
  }
  if (raw.reason !== null && command !== 'block') {
    return {
      kind: 'error',
      message: `--reason is only valid for block, not ${command}.`,
    };
  }
  if ((raw.dryRun || raw.live) && command !== 'allocate') {
    const flag = raw.dryRun ? '--dry-run' : '--live';
    return {
      kind: 'error',
      message: `${flag} is only valid for allocate, not ${command}.`,
    };
  }
  if (isOperatorCommandName(command)) {
    return buildOperatorCommand(command, raw);
  }
  const workspaceId = raw.workspaceId;
  switch (command) {
    case 'migrate':
      if (workspaceId !== null) {
        return {
          kind: 'error',
          message: 'migrate does not take --workspace.',
        };
      }
      return { kind: 'command', command: { name: 'migrate' } };
    case 'daily':
      return {
        kind: 'command',
        command: { name: 'daily', workspaceId, force: raw.force },
      };
    case 'allocate':
      if (raw.dryRun === raw.live) {
        return {
          kind: 'error',
          message: raw.dryRun
            ? 'allocate takes either --dry-run or --live, not both.'
            : 'allocate needs --dry-run or --live.',
        };
      }
      if (raw.live && workspaceId === null) {
        return { kind: 'error', message: LIVE_ALLOCATE_NEEDS_WORKSPACE };
      }
      return {
        kind: 'command',
        command: {
          name: 'allocate',
          workspaceId,
          mode: raw.live ? 'live' : 'dry_run',
        },
      };
    case 'sync':
    case 'warn':
    case 'tick':
    case 'serve':
      return { kind: 'command', command: { name: command, workspaceId } };
  }
}

/**
 * Parses the worker's arguments (`process.argv.slice(2)`). Options may come
 * before or after the command. `--help`/`-h` anywhere, or the command
 * `help`, wins over everything else. Unknown commands and options,
 * repeated options, extra arguments and options that do not apply to the
 * command are errors.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  if (argv.some((token) => token === '--help' || token === '-h')) {
    return { kind: 'help' };
  }
  const raw: RawOptions = {
    command: null,
    workspaceId: null,
    force: false,
    dryRun: false,
    live: false,
    json: false,
    yes: false,
    reason: null,
  };
  const seen = new Set<string>();
  // Rejects a repeated flag; returns an error result or null.
  const once = (flag: string): ParseResult | null => {
    if (seen.has(flag)) {
      return { kind: 'error', message: `${flag} was given more than once.` };
    }
    seen.add(flag);
    return null;
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    if (token === '--workspace' || token.startsWith('--workspace=')) {
      const repeated = once('--workspace');
      if (repeated !== null) return repeated;
      const read = readValue(
        argv,
        index,
        '--workspace',
        '--workspace needs a workspace id'
      );
      if ('error' in read) return { kind: 'error', message: read.error };
      raw.workspaceId = read.value;
      index += read.used;
      continue;
    }
    if (token === '--reason' || token.startsWith('--reason=')) {
      const repeated = once('--reason');
      if (repeated !== null) return repeated;
      const read = readValue(argv, index, '--reason', '--reason needs text');
      if ('error' in read) return { kind: 'error', message: read.error };
      if (read.value.length > MAX_REASON_LENGTH) {
        return {
          kind: 'error',
          message: `--reason is at most ${MAX_REASON_LENGTH} characters.`,
        };
      }
      raw.reason = read.value;
      index += read.used;
      continue;
    }
    if (
      token === '--force' ||
      token === '--dry-run' ||
      token === '--live' ||
      token === '--json' ||
      token === '--yes'
    ) {
      const repeated = once(token);
      if (repeated !== null) return repeated;
      if (token === '--force') raw.force = true;
      else if (token === '--dry-run') raw.dryRun = true;
      else if (token === '--live') raw.live = true;
      else if (token === '--json') raw.json = true;
      else raw.yes = true;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      return { kind: 'error', message: `Unknown option: ${token}` };
    }
    if (raw.command !== null) {
      return { kind: 'error', message: `Unexpected argument: ${token}` };
    }
    if (token === 'help') return { kind: 'help' };
    if (!isCommandName(token)) {
      return { kind: 'error', message: `Unknown command: ${token}` };
    }
    raw.command = token;
    index += 1;
  }
  return buildCommand(raw);
}
