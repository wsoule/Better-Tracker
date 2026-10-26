import { describe, expect, test } from 'bun:test';

import {
  type CliCommand,
  isOperatorCommand,
  LIVE_ALLOCATE_NEEDS_WORKSPACE,
  parseArgs,
  PURGE_NEEDS_YES,
  USAGE,
} from '../src/cli';

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
    [
      ['allocate', '--live', '--override-mode', '--workspace', 'org-1'],
      {
        name: 'allocate',
        workspaceId: 'org-1',
        mode: 'live',
        overrideMode: true,
      },
    ],
    [['warn'], { name: 'warn', workspaceId: null }],
    [['tick'], { name: 'tick', workspaceId: null }],
    [['tick', '--workspace', 'org-1'], { name: 'tick', workspaceId: 'org-1' }],
    [['serve'], { name: 'serve', workspaceId: null }],
    [['workspaces'], { name: 'workspaces', json: false }],
    [['workspaces', '--json'], { name: 'workspaces', json: true }],
    [['--json', 'workspaces'], { name: 'workspaces', json: true }],
    [['remove', '--workspace', 'acme'], { name: 'remove', workspace: 'acme' }],
    [
      ['remove', '--workspace=0f6c1f8e-1b7a-4c1e-9a52-3c2a5d1e7b90'],
      { name: 'remove', workspace: '0f6c1f8e-1b7a-4c1e-9a52-3c2a5d1e7b90' },
    ],
    [
      ['purge', '--workspace', 'acme', '--yes'],
      { name: 'purge', workspace: 'acme' },
    ],
    [
      ['--yes', 'purge', '--workspace', 'acme'],
      { name: 'purge', workspace: 'acme' },
    ],
    [
      ['block', '--workspace', 'acme'],
      { name: 'block', workspace: 'acme', reason: null },
    ],
    [
      ['block', '--workspace', 'acme', '--reason', 'spam sign-ups'],
      { name: 'block', workspace: 'acme', reason: 'spam sign-ups' },
    ],
    [
      ['block', '--reason=asked by their admin', '--workspace', 'acme'],
      { name: 'block', workspace: 'acme', reason: 'asked by their admin' },
    ],
    [
      ['unblock', '--workspace', 'acme'],
      { name: 'unblock', workspace: 'acme' },
    ],
  ])('%p', (argv, expected) => {
    expect(command(argv)).toEqual(expected);
  });

  test('operator commands are told apart from the rest', () => {
    expect(isOperatorCommand(command(['workspaces']))).toBe(true);
    expect(isOperatorCommand(command(['unblock', '--workspace', 'a']))).toBe(
      true
    );
    expect(isOperatorCommand(command(['tick']))).toBe(false);
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
      'workspaces',
      'remove',
      'purge',
      'block',
      'unblock',
    ]) {
      expect(USAGE).toContain(`  ${name} `);
    }
    expect(USAGE).toContain('WORKER_CONCURRENCY');
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
    // A live run writes to Linear: never across every workspace, whose
    // saved allocation modes may be dry run.
    [['allocate', '--live'], LIVE_ALLOCATE_NEEDS_WORKSPACE],
    [['allocate', '--live', '--override-mode'], LIVE_ALLOCATE_NEEDS_WORKSPACE],
    [
      ['allocate', '--dry-run', '--override-mode'],
      '--override-mode is only valid for allocate --live (a dry run writes nothing).',
    ],
    [
      ['tick', '--override-mode'],
      '--override-mode is only valid for allocate, not tick.',
    ],
    [
      ['allocate', '--live', '--override-mode', '--override-mode'],
      '--override-mode was given more than once.',
    ],
    [['migrate', '--workspace', 'a'], 'migrate does not take --workspace.'],
    [['migrate', '--', 'x'], 'Unknown option: --'],
    [['remove'], 'remove needs --workspace <org id or URL key>.'],
    [['unblock'], 'unblock needs --workspace <org id or URL key>.'],
    [
      ['remove', '--workspace', 'acme.example'],
      '--workspace takes an organization id or URL key (letters, digits and dashes, at most 64).',
    ],
    [
      ['block', '--workspace', 'x'.repeat(65)],
      '--workspace takes an organization id or URL key (letters, digits and dashes, at most 64).',
    ],
    [['purge', '--workspace', 'acme'], PURGE_NEEDS_YES],
    [['purge', '--yes'], 'purge needs --workspace <org id or URL key>.'],
    [
      ['workspaces', '--workspace', 'acme'],
      'workspaces does not take --workspace (it lists every workspace).',
    ],
    [['tick', '--json'], '--json is only valid for workspaces, not tick.'],
    [
      ['remove', '--workspace', 'a', '--yes'],
      '--yes is only valid for purge, not remove.',
    ],
    [
      ['unblock', '--workspace', 'a', '--reason', 'x'],
      '--reason is only valid for block, not unblock.',
    ],
    [['block', '--workspace', 'a', '--reason'], '--reason needs text'],
    [['block', '--workspace', 'a', '--reason='], '--reason needs text'],
    [
      ['block', '--workspace', 'a', '--reason', 'x'.repeat(501)],
      '--reason is at most 500 characters.',
    ],
    [
      ['block', '--workspace', 'a', '--reason', 'x', '--reason', 'y'],
      '--reason was given more than once.',
    ],
    [['workspaces', '--json', '--json'], '--json was given more than once.'],
    [
      ['remove', '--force', '--workspace', 'a'],
      '--force is only valid for daily, not remove.',
    ],
  ])('%p', (argv, message) => {
    expect(error(argv)).toBe(message);
  });
});
