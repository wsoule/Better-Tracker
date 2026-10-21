// Command-line parsing for the worker (architecture §9). Pure: argv in, a
// typed command or a usage error out. The caller prints USAGE for `--help`
// and exits 2 on a usage error, so a typo in a cron start command fails
// loudly instead of silently doing something else.

import type { AllocationMode } from '@better-tracker/core';

/** The worker's commands, in the order the usage text lists them. */
export type CommandName =
  | 'migrate'
  | 'sync'
  | 'daily'
  | 'allocate'
  | 'warn'
  | 'tick'
  | 'serve';

/** A parsed command line. `workspaceId: null` means every installed workspace. */
export type CliCommand =
  | { name: 'migrate' }
  | { name: 'sync'; workspaceId: string | null }
  | { name: 'daily'; workspaceId: string | null; force: boolean }
  | { name: 'allocate'; workspaceId: string | null; mode: AllocationMode }
  | { name: 'warn'; workspaceId: string | null }
  | { name: 'tick'; workspaceId: string | null }
  | { name: 'serve'; workspaceId: string | null };

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
  allocate --dry-run|--live [--workspace <id>]
                                   Run allocation now in the given mode.
  warn     [--workspace <id>]      Run the warnings and digests now.
  tick     [--workspace <id>]      What the cron runs every 15 minutes: the
                                   daily job when it is due in the workspace's
                                   timezone, otherwise a full resync; then
                                   housekeeping. Exits 1 after
                                   TICK_TIMEOUT_MINUTES (default 10).
  serve    [--workspace <id>]      Run tick every SYNC_INTERVAL_MINUTES
                                   (default 15) until SIGTERM or SIGINT.

Options:
  --workspace <id>   One Linear workspace id (default: every installed one).
  --force            daily only: run even if today's run already happened.
  --dry-run, --live  allocate only: required, exactly one.
  -h, --help         Show this help.

Environment: see .env.example. DAILY_RUN_AT (default 08:00, HH:MM in each
workspace's timezone) sets when the daily job becomes due.

Exit codes: 0 ok, 1 a workspace or the worker failed, 2 usage error.`;

const COMMANDS: readonly CommandName[] = [
  'migrate',
  'sync',
  'daily',
  'allocate',
  'warn',
  'tick',
  'serve',
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
}

// Reads `--workspace <id>` / `--workspace=<id>` starting at argv[index].
// Returns the id and how many tokens it used, or an error message.
function readWorkspace(
  argv: readonly string[],
  index: number
): { value: string; used: number } | { error: string } {
  const token = argv[index] ?? '';
  if (token.startsWith('--workspace=')) {
    const value = token.slice('--workspace='.length).trim();
    return value === ''
      ? { error: '--workspace needs a workspace id' }
      : { value, used: 1 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-') || next.trim() === '') {
    return { error: '--workspace needs a workspace id' };
  }
  return { value: next.trim(), used: 2 };
}

// Checks the options make sense for the command and builds the result.
function buildCommand(raw: RawOptions): ParseResult {
  const { command } = raw;
  if (command === null) {
    return { kind: 'error', message: 'No command given.' };
  }
  if (raw.force && command !== 'daily') {
    return {
      kind: 'error',
      message: `--force is only valid for daily, not ${command}.`,
    };
  }
  if ((raw.dryRun || raw.live) && command !== 'allocate') {
    const flag = raw.dryRun ? '--dry-run' : '--live';
    return {
      kind: 'error',
      message: `${flag} is only valid for allocate, not ${command}.`,
    };
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
      const read = readWorkspace(argv, index);
      if ('error' in read) return { kind: 'error', message: read.error };
      raw.workspaceId = read.value;
      index += read.used;
      continue;
    }
    if (token === '--force' || token === '--dry-run' || token === '--live') {
      const repeated = once(token);
      if (repeated !== null) return repeated;
      if (token === '--force') raw.force = true;
      else if (token === '--dry-run') raw.dryRun = true;
      else raw.live = true;
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
