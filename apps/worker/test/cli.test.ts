import { describe, expect, test } from 'bun:test';

import { type CliCommand, parseArgs, USAGE } from '../src/cli';

function command(argv: string[]): CliCommand {
  const result = parseArgs(argv);
  if (result.kind !== 'command') {
    throw new Error(`expected a command, got ${JSON.stringify(result)}`);
  }
  return result.command;
}

function error(argv: string[]): string {
  const result = parseArgs(argv);
  if (result.kind !== 'error') {
    throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  }
  return result.message;
}

describe('parseArgs: commands', () => {
  test.each<[string[], CliCommand]>([
    [['migrate'], { name: 'migrate' }],
    [['sync'], { name: 'sync', workspaceId: null }],
    [['sync', '--workspace', 'org-1'], { name: 'sync', workspaceId: 'org-1' }],
    [['sync', '--workspace=org-1'], { name: 'sync', workspaceId: 'org-1' }],
    [['--workspace', 'org-1', 'sync'], { name: 'sync', workspaceId: 'org-1' }],
    [['daily'], { name: 'daily', workspaceId: null, force: false }],
    [['daily', '--force'], { name: 'daily', workspaceId: null, force: true }],
    [
      ['daily', '--force', '--workspace', 'org-1'],
      { name: 'daily', workspaceId: 'org-1', force: true },
    ],
    [
      ['allocate', '--dry-run'],
      { name: 'allocate', workspaceId: null, mode: 'dry_run' },
    ],
    [
      ['allocate', '--live', '--workspace', 'org-1'],
      { name: 'allocate', workspaceId: 'org-1', mode: 'live' },
    ],
    [['warn'], { name: 'warn', workspaceId: null }],
    [['tick'], { name: 'tick', workspaceId: null }],
    [['tick', '--workspace', 'org-1'], { name: 'tick', workspaceId: 'org-1' }],
    [['serve'], { name: 'serve', workspaceId: null }],
  ])('%p', (argv, expected) => {
    expect(command(argv)).toEqual(expected);
  });

  test('trims a workspace id', () => {
    expect(command(['sync', '--workspace', ' org-1 '])).toEqual({
      name: 'sync',
      workspaceId: 'org-1',
    });
  });
});

describe('parseArgs: help', () => {
  test.each([
    [['--help']],
    [['-h']],
    [['help']],
    [['tick', '--help']],
    // Help wins even over otherwise invalid input.
    [['bogus', '--nope', '-h']],
  ])('%p', (argv) => {
    expect(parseArgs(argv)).toEqual({ kind: 'help' });
  });

  test('usage lists every command and the exit codes', () => {
    for (const name of [
      'migrate',
      'sync',
      'daily',
      'allocate',
      'warn',
      'tick',
      'serve',
    ]) {
      expect(USAGE).toContain(`  ${name} `);
    }
    expect(USAGE).toContain('2 usage error');
  });
});

describe('parseArgs: errors', () => {
  test.each<[string[], string]>([
    [[], 'No command given.'],
    [['bogus'], 'Unknown command: bogus'],
    [['tick', '--bogus'], 'Unknown option: --bogus'],
    [['tick', '-x'], 'Unknown option: -x'],
    [['tick', 'extra'], 'Unexpected argument: extra'],
    [['sync', 'tick'], 'Unexpected argument: tick'],
    [['--force'], 'No command given.'],
    [['sync', '--workspace'], '--workspace needs a workspace id'],
    [['sync', '--workspace='], '--workspace needs a workspace id'],
    [['sync', '--workspace', '--force'], '--workspace needs a workspace id'],
    [['sync', '--workspace', ' '], '--workspace needs a workspace id'],
    [
      ['sync', '--workspace', 'a', '--workspace', 'b'],
      '--workspace was given more than once.',
    ],
    [['daily', '--force', '--force'], '--force was given more than once.'],
    [['tick', '--force'], '--force is only valid for daily, not tick.'],
    [
      ['daily', '--dry-run'],
      '--dry-run is only valid for allocate, not daily.',
    ],
    [['warn', '--live'], '--live is only valid for allocate, not warn.'],
    [['allocate'], 'allocate needs --dry-run or --live.'],
    [['allocate', '--workspace', 'a'], 'allocate needs --dry-run or --live.'],
    [
      ['allocate', '--dry-run', '--live'],
      'allocate takes either --dry-run or --live, not both.',
    ],
    [['migrate', '--workspace', 'a'], 'migrate does not take --workspace.'],
    [['migrate', '--', 'x'], 'Unknown option: --'],
  ])('%p', (argv, message) => {
    expect(error(argv)).toBe(message);
  });
});
