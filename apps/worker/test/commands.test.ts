import { silentLogger } from '@better-tracker/logger';
import { describe, expect, test } from 'bun:test';

import {
  type CommandContext,
  type CommandResult,
  exitCodeFor,
  oneLine,
  runCommand,
  summaryLine,
  type WorkspaceOutcome,
} from '../src/commands';
import { loadWorkerConfig } from '../src/config';
import {
  allocationRun,
  type FakeEngine,
  fakeEngine,
  warningResult,
} from './fake-engine';

function context(
  engine: FakeEngine,
  options: { now?: Date; dailyAt?: string } = {}
): CommandContext {
  const now = options.now ?? new Date('2026-10-21T12:00:00Z');
  return {
    engine,
    logger: silentLogger,
    config: loadWorkerConfig({ DAILY_RUN_AT: options.dailyAt ?? '08:00' }),
    now: () => now,
  };
}

const ok = (workspaceId: string): WorkspaceOutcome => ({
  workspaceId,
  ok: true,
  detail: 'synced',
  error: null,
});
const failed = (workspaceId: string): WorkspaceOutcome => ({
  workspaceId,
  ok: false,
  detail: '',
  error: 'boom',
});

describe('exitCodeFor', () => {
  test.each<[string, WorkspaceOutcome[], string[], 0 | 1]>([
    ['no workspaces', [], [], 0],
    ['every workspace ok', [ok('a'), ok('b')], [], 0],
    ['one of several failed', [ok('a'), failed('b'), ok('c')], [], 1],
    ['all failed', [failed('a'), failed('b')], [], 1],
    ['a workspace-independent problem', [ok('a')], ['cleanup: down'], 1],
    ['a problem and no workspaces', [], ['listing workspaces: down'], 1],
  ])('%s', (_label, outcomes, problems, code) => {
    expect(exitCodeFor({ outcomes, problems })).toBe(code);
  });
});

describe('summaryLine', () => {
  const base: CommandResult = {
    command: 'tick',
    outcomes: [],
    problems: [],
    notes: [],
  };

  test('ok with workspaces and notes', () => {
    expect(
      summaryLine({
        ...base,
        outcomes: [ok('a')],
        notes: ['cleanup: 0 expired sessions'],
      })
    ).toBe('tick ok — a: synced; cleanup: 0 expired sessions');
  });

  test('failures are counted and explained', () => {
    expect(
      summaryLine({
        ...base,
        outcomes: [
          ok('a'),
          failed('b'),
          {
            workspaceId: 'c',
            ok: false,
            detail: 'allocation live partial',
            error: '1 assignment(s) failed.',
          },
        ],
      })
    ).toBe(
      'tick FAILED (2 of 3 workspaces) — a: synced; b: FAILED (boom); c: FAILED allocation live partial (1 assignment(s) failed.)'
    );
  });

  test('no workspaces, and workspace-independent problems', () => {
    expect(summaryLine(base)).toBe('tick ok — no installed workspaces');
    expect(summaryLine({ ...base, problems: ['cleanup: down'] })).toBe(
      'tick FAILED — no installed workspaces; FAILED cleanup: down'
    );
    expect(
      summaryLine({ ...base, command: 'migrate', notes: ['schema ok'] })
    ).toBe('migrate ok — schema ok');
  });
});

describe('oneLine', () => {
  test('collapses whitespace and truncates long messages', () => {
    expect(
      oneLine(new Error('Invalid environment:\n- APP_URL is required'))
    ).toBe('Invalid environment: - APP_URL is required');
    expect(oneLine('x'.repeat(500))).toHaveLength(300);
    expect(oneLine(42)).toBe('42');
  });
});

describe('runCommand', () => {
  test('migrate touches no workspace', async () => {
    const engine = fakeEngine();
    const result = await runCommand(context(engine), { name: 'migrate' });
    expect(engine.calls).toEqual([]);
    expect(exitCodeFor(result)).toBe(0);
    expect(result.notes).toEqual(['database schema is up to date']);
  });

  test('sync runs every installed workspace; one failure does not stop the others', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a', 'ws-b', 'ws-c'] });
    const realSync = engine.fullSync;
    engine.fullSync = (id) => {
      if (id === 'ws-b') {
        engine.calls.push(`fullSync:${id}`);
        return Promise.reject(new Error('Linear is down'));
      }
      return realSync(id);
    };
    const result = await runCommand(context(engine), {
      name: 'sync',
      workspaceId: null,
    });
    expect(engine.calls).toEqual([
      'listWorkspaceIds',
      'fullSync:ws-a',
      'fullSync:ws-b',
      'fullSync:ws-c',
    ]);
    expect(result.outcomes.map((o) => [o.workspaceId, o.ok])).toEqual([
      ['ws-a', true],
      ['ws-b', false],
      ['ws-c', true],
    ]);
    expect(result.outcomes[1]?.error).toBe('Linear is down');
    expect(result.outcomes[0]?.detail).toBe(
      'synced (mirror v7, 42 issues, 12 ms)'
    );
    expect(exitCodeFor(result)).toBe(1);
  });

  test('--workspace runs only that workspace without listing', async () => {
    const engine = fakeEngine();
    await runCommand(context(engine), { name: 'sync', workspaceId: 'ws-z' });
    expect(engine.calls).toEqual(['fullSync:ws-z']);
  });

  test('a failure to list workspaces is a problem (exit 1)', async () => {
    const engine = fakeEngine({
      overrides: {
        listWorkspaceIds: () =>
          Promise.reject(new Error('database unreachable')),
      },
    });
    const result = await runCommand(context(engine), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.problems).toEqual([
      'listing workspaces: database unreachable',
    ]);
    expect(exitCodeFor(result)).toBe(1);
  });

  test('no installed workspaces is not a failure', async () => {
    const engine = fakeEngine({ workspaces: [] });
    const result = await runCommand(context(engine), {
      name: 'daily',
      workspaceId: null,
      force: false,
    });
    expect(exitCodeFor(result)).toBe(0);
    expect(summaryLine(result)).toBe('daily ok — no installed workspaces');
  });

  test('daily passes --force and reports an already-claimed day', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const ctx = context(engine);
    const first = await runCommand(ctx, {
      name: 'daily',
      workspaceId: null,
      force: false,
    });
    const second = await runCommand(ctx, {
      name: 'daily',
      workspaceId: null,
      force: false,
    });
    const forced = await runCommand(ctx, {
      name: 'daily',
      workspaceId: null,
      force: true,
    });
    expect(first.outcomes[0]?.detail).toBe(
      'daily ran for 2026-10-21, allocation dry run succeeded: 2 would be assigned, 1 blocked project, warnings preview: 3 notices, 0 digests'
    );
    expect(second.outcomes[0]).toMatchObject({
      ok: true,
      detail: 'daily already ran for 2026-10-21 (use --force to run it again)',
    });
    expect(forced.outcomes[0]?.detail).toStartWith('daily ran for 2026-10-21');
    expect(engine.calls.filter((c) => c.startsWith('runDaily'))).toEqual([
      'runDaily:ws-a',
      'runDaily:ws-a',
      'runDaily:ws-a:force',
    ]);
  });

  test('a daily run whose live allocation was partial fails', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    engine.runDaily = ({ workspaceId }) =>
      Promise.resolve({
        workspaceId,
        day: '2026-10-21',
        ran: true,
        sync: null,
        allocation: allocationRun(workspaceId, {
          mode: 'live',
          status: 'partial',
          error: '1 comment(s) could not be posted.',
        }),
        warnings: warningResult(workspaceId),
      });
    const result = await runCommand(context(engine), {
      name: 'daily',
      workspaceId: null,
      force: false,
    });
    expect(result.outcomes[0]).toMatchObject({
      ok: false,
      error: '1 comment(s) could not be posted.',
    });
    expect(exitCodeFor(result)).toBe(1);
  });

  test('allocate runs the requested mode as a manual run with no actor', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const result = await runCommand(context(engine), {
      name: 'allocate',
      workspaceId: null,
      mode: 'live',
    });
    expect(engine.calls).toContain('runAllocation:ws-a:live:manual:no-actor');
    expect(result.outcomes[0]).toMatchObject({
      ok: true,
      detail:
        'allocation live succeeded: 2 assigned, 0 failed, 1 blocked project',
    });
  });

  test.each(['failed', 'partial'] as const)(
    'an allocation run that ended %s fails',
    async (status) => {
      const engine = fakeEngine({ workspaces: ['ws-a'] });
      engine.runAllocation = (input) =>
        Promise.resolve(
          allocationRun(input.workspaceId, {
            mode: 'live',
            status,
            error: 'writes failed',
          })
        );
      const result = await runCommand(context(engine), {
        name: 'allocate',
        workspaceId: null,
        mode: 'live',
      });
      expect(result.outcomes[0]).toMatchObject({
        ok: false,
        error: 'writes failed',
      });
    }
  );

  test('warn reports undelivered digests without failing', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    engine.runWarnings = ({ workspaceId }) =>
      Promise.resolve(
        warningResult(workspaceId, {
          mode: 'live',
          delivered: 2,
          failed: 1,
          alreadySent: 1,
        })
      );
    const result = await runCommand(context(engine), {
      name: 'warn',
      workspaceId: null,
    });
    expect(result.outcomes[0]).toMatchObject({
      ok: true,
      detail:
        "warnings live: 3 notices, 0 digests, 2 delivered, 1 not delivered, 1 already had today's digest",
    });
    expect(exitCodeFor(result)).toBe(0);
  });
});

describe('runCommand: tick', () => {
  test('due → runDaily; then cleanup once after every workspace', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a', 'ws-b'] });
    const result = await runCommand(
      context(engine, { now: new Date('2026-10-21T08:00:00Z') }),
      { name: 'tick', workspaceId: null }
    );
    expect(engine.calls).toEqual([
      'listWorkspaceIds',
      'workspaceTimezone:ws-a',
      'runDaily:ws-a',
      'workspaceTimezone:ws-b',
      'runDaily:ws-b',
      'cleanup',
    ]);
    expect(result.notes).toEqual([
      'cleanup: 0 expired sessions, 0 old webhook delivery records',
    ]);
    expect(exitCodeFor(result)).toBe(0);
  });

  test('not due → a plain full resync, no daily run', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const result = await runCommand(
      context(engine, { now: new Date('2026-10-21T07:59:00Z') }),
      { name: 'tick', workspaceId: null }
    );
    expect(engine.calls).toEqual([
      'listWorkspaceIds',
      'workspaceTimezone:ws-a',
      'fullSync:ws-a',
      'cleanup',
    ]);
    expect(result.outcomes[0]?.detail).toBe(
      'synced (mirror v7, 42 issues, 12 ms), daily due at 08:00 UTC'
    );
  });

  test('a second tick the same day resyncs instead of running daily again', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    let now = new Date('2026-10-21T08:00:00Z');
    const ctx: CommandContext = { ...context(engine), now: () => now };
    await runCommand(ctx, { name: 'tick', workspaceId: null });
    now = new Date('2026-10-21T08:15:00Z');
    const second = await runCommand(ctx, { name: 'tick', workspaceId: null });
    expect(engine.calls).toEqual([
      'listWorkspaceIds',
      'workspaceTimezone:ws-a',
      'runDaily:ws-a',
      'cleanup',
      'listWorkspaceIds',
      'workspaceTimezone:ws-a',
      'runDaily:ws-a',
      'fullSync:ws-a',
      'cleanup',
    ]);
    expect(second.outcomes[0]?.detail).toBe(
      'synced (mirror v7, 42 issues, 12 ms), daily already ran for 2026-10-21'
    );
  });

  test('each workspace is judged in its own timezone', async () => {
    // 19:30Z on Oct 20: 08:30 Oct 21 in Auckland (due), 15:30 in New York
    // (its 08:00 already passed: due), 04:30 Oct 21 in Tokyo (not yet).
    const engine = fakeEngine({
      workspaces: ['nz', 'ny', 'jp'],
      timezones: {
        nz: 'Pacific/Auckland',
        ny: 'America/New_York',
        jp: 'Asia/Tokyo',
      },
      now: () => new Date('2026-10-20T19:30:00Z'),
    });
    const result = await runCommand(
      context(engine, { now: new Date('2026-10-20T19:30:00Z') }),
      { name: 'tick', workspaceId: null }
    );
    expect(
      engine.calls.filter((c) => !c.startsWith('workspaceTimezone'))
    ).toEqual([
      'listWorkspaceIds',
      'runDaily:nz',
      'runDaily:ny',
      'fullSync:jp',
      'cleanup',
    ]);
    expect(result.outcomes.map((o) => o.detail)).toEqual([
      expect.stringContaining('daily ran for 2026-10-21'),
      expect.stringContaining('daily ran for 2026-10-20'),
      'synced (mirror v7, 42 issues, 12 ms), daily due at 08:00 Asia/Tokyo',
    ]);
  });

  test('a failing workspace is reported and cleanup still runs', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a', 'ws-b'] });
    engine.workspaceTimezone = (id) =>
      id === 'ws-a'
        ? Promise.reject(new Error('not installed'))
        : Promise.resolve('UTC');
    const result = await runCommand(context(engine), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.outcomes.map((o) => o.ok)).toEqual([false, true]);
    expect(engine.calls).toContain('cleanup');
    expect(exitCodeFor(result)).toBe(1);
  });

  test('a cleanup failure fails the tick', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    engine.cleanup = () => Promise.reject(new Error('prune failed'));
    const result = await runCommand(context(engine), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.outcomes[0]?.ok).toBe(true);
    expect(result.problems).toEqual(['cleanup: prune failed']);
    expect(exitCodeFor(result)).toBe(1);
  });

  test('cleanup counts and revocation failures are summarized', async () => {
    const engine = fakeEngine({ workspaces: [] });
    engine.cleanup = () =>
      Promise.resolve({
        expiredSessions: 3,
        revokedTokens: 2,
        revokeFailures: 1,
        oldDeliveries: 1,
      });
    const result = await runCommand(context(engine), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.notes).toEqual([
      'cleanup: 3 expired sessions (1 revocation failed), 1 old webhook delivery record',
    ]);
  });
});
