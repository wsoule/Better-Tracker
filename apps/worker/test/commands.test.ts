import type { WorkspaceSettings } from '@better-tracker/core';
import type { Engine } from '@better-tracker/engine';
import {
  createLogger,
  type Logger,
  silentLogger,
} from '@better-tracker/logger';
import { describe, expect, test } from 'bun:test';

import { LIVE_ALLOCATE_NEEDS_WORKSPACE } from '../src/cli';
import {
  apiKeyModeOutcome,
  type CommandContext,
  type CommandResult,
  exitCodeFor,
  oneLine,
  REVOKED_INSTALLATION_ERROR,
  runCommand,
  summaryLine,
  workerEngineFrom,
  type WorkspaceOutcome,
} from '../src/commands';
import { loadWorkerConfig } from '../src/config';
import {
  allocationRun,
  type FakeEngine,
  fakeEngine,
  overview,
  revokedOverview,
  syncResult,
  warningResult,
} from './fake-engine';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The JSON log lines at `level` whose message contains `text`.
function logged(lines: string[], level: string, text: string): string[] {
  return lines.filter((line) => {
    const entry = JSON.parse(line) as { level: string; msg: string };
    return entry.level === level && entry.msg.includes(text);
  });
}

// A logger that keeps every line it writes (JSON), for log assertions.
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      name: 'test',
      level: 'debug',
      sink: (_level, line) => lines.push(line),
    }),
  };
}

// A context over `engine` with a fixed clock and no deadline. One
// workspace at a time unless `concurrency` says otherwise, so the call
// order the tests assert is the run order (scaling.test.ts covers lanes).
function context(
  engine: FakeEngine,
  options: {
    now?: Date;
    dailyAt?: string;
    concurrency?: number;
    deadlineAt?: Date | null;
  } = {}
): CommandContext {
  const now = options.now ?? new Date('2026-10-21T12:00:00Z');
  return {
    engine,
    logger: silentLogger,
    config: loadWorkerConfig({
      DAILY_RUN_AT: options.dailyAt ?? '08:00',
      WORKER_CONCURRENCY: String(options.concurrency ?? 1),
    }),
    now: () => now,
    deadlineAt: options.deadlineAt ?? null,
  };
}

const ok = (workspaceId: string): WorkspaceOutcome => ({
  workspaceId,
  kind: 'done',
  ok: true,
  detail: 'synced',
  error: null,
});
const failed = (workspaceId: string): WorkspaceOutcome => ({
  workspaceId,
  kind: 'failed',
  ok: false,
  detail: '',
  error: 'boom',
});
const chronic = (workspaceId: string): WorkspaceOutcome => ({
  ...failed(workspaceId),
  kind: 'chronic',
});
const skipped = (workspaceId: string): WorkspaceOutcome => ({
  workspaceId,
  kind: 'skipped',
  ok: true,
  detail: 'skipped (removed by the operator)',
  error: null,
});

describe('exitCodeFor', () => {
  test.each<[string, WorkspaceOutcome[], string[], 0 | 1]>([
    ['no workspaces', [], [], 0],
    ['every workspace ok', [ok('a'), ok('b')], [], 0],
    ['one of several failed', [ok('a'), failed('b'), ok('c')], [], 1],
    ['all failed', [failed('a'), failed('b')], [], 1],
    ['a workspace-independent problem', [ok('a')], ['cleanup: down'], 1],
    ['a problem and no workspaces', [], ['listing workspaces: down'], 1],
    ['chronic and skipped workspaces', [chronic('a'), skipped('b')], [], 0],
    ['chronic next to a new failure', [chronic('a'), failed('b')], [], 1],
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
            kind: 'failed',
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

  test('chronic failures keep the run ok and are named', () => {
    expect(
      summaryLine({ ...base, outcomes: [ok('a'), chronic('b'), skipped('c')] })
    ).toBe(
      'tick ok (1 chronic) — a: synced; b: chronic failure (boom); c: skipped (removed by the operator)'
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
      'listWorkspaceStatus',
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
        listWorkspaceStatus: () =>
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

  test('a dead app grant fails the command loudly instead of being skipped', async () => {
    const { logger, lines } = recordingLogger();
    const engine = fakeEngine({ workspaces: ['ws-a'], revoked: ['ws-gone'] });
    const result = await runCommand(
      { ...context(engine, { now: new Date('2026-10-21T07:00:00Z') }), logger },
      { name: 'tick', workspaceId: null }
    );
    expect(result.outcomes.map((o) => [o.workspaceId, o.ok])).toEqual([
      ['ws-a', true],
      ['ws-gone', false],
    ]);
    expect(result.outcomes[1]?.error).toBe(REVOKED_INSTALLATION_ERROR);
    expect(exitCodeFor(result)).toBe(1);
    expect(summaryLine(result)).toContain('FAILED (1 of 2 workspaces)');
    expect(
      lines.some(
        (l) => l.includes('installation is revoked') && l.includes('ws-gone')
      )
    ).toBe(true);
    // Only revoked ones: still a failure, and not "nothing to do".
    const alone = await runCommand(
      {
        ...context(fakeEngine({ workspaces: [], revoked: ['ws-gone'] })),
        logger,
      },
      { name: 'sync', workspaceId: null }
    );
    expect(exitCodeFor(alone)).toBe(1);
    expect(lines.some((l) => l.includes('no installed workspaces'))).toBe(
      false
    );
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

  test('allocate --live over every workspace is refused before any workspace runs', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a', 'ws-b'] });
    const result = await runCommand(context(engine), {
      name: 'allocate',
      workspaceId: null,
      mode: 'live',
    });
    expect(result.problems).toEqual([LIVE_ALLOCATE_NEEDS_WORKSPACE]);
    expect(result.outcomes).toEqual([]);
    expect(engine.calls).toEqual([]);
    expect(exitCodeFor(result)).toBe(1);
  });

  test('allocate runs the requested mode as a manual run with no actor', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const result = await runCommand(context(engine), {
      name: 'allocate',
      workspaceId: 'ws-a',
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
        workspaceId: 'ws-a',
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
  test('due → runDaily; cleanup once, before any workspace', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a', 'ws-b'] });
    const result = await runCommand(
      context(engine, { now: new Date('2026-10-21T08:00:00Z') }),
      { name: 'tick', workspaceId: null }
    );
    // Cleanup first: a workspace too slow for the tick's timeout must not
    // keep the housekeeping of every other workspace from running.
    expect(engine.calls).toEqual([
      'cleanup',
      'listWorkspaceStatus',
      'workspaceTimezone:ws-a',
      'runDaily:ws-a@2026-10-21',
      'workspaceTimezone:ws-b',
      'runDaily:ws-b@2026-10-21',
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
      'cleanup',
      'listWorkspaceStatus',
      'workspaceTimezone:ws-a',
      'fullSync:ws-a',
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
      'cleanup',
      'listWorkspaceStatus',
      'workspaceTimezone:ws-a',
      'runDaily:ws-a@2026-10-21',
      'cleanup',
      'listWorkspaceStatus',
      'workspaceTimezone:ws-a',
      'runDaily:ws-a@2026-10-21',
      'fullSync:ws-a',
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
      'cleanup',
      'listWorkspaceStatus',
      'runDaily:nz@2026-10-21',
      'runDaily:ny@2026-10-20',
      'fullSync:jp',
    ]);
    expect(result.outcomes.map((o) => o.detail)).toEqual([
      expect.stringContaining('daily ran for 2026-10-21'),
      expect.stringContaining('daily ran for 2026-10-20'),
      'synced (mirror v7, 42 issues, 12 ms), daily due at 08:00 Asia/Tokyo',
    ]);
  });

  test('runs the day it decided on, even when the run starts after midnight', async () => {
    // Decided at 23:59:59.9 UTC on Oct 21; the engine's clock has already
    // reached Oct 22 when runDaily starts.
    const engine = fakeEngine({
      workspaces: ['ws-a'],
      now: () => new Date('2026-10-22T00:00:00.100Z'),
    });
    const result = await runCommand(
      context(engine, { now: new Date('2026-10-21T23:59:59.900Z') }),
      { name: 'tick', workspaceId: null }
    );
    expect(engine.calls).toContain('runDaily:ws-a@2026-10-21');
    expect(result.outcomes[0]?.detail).toContain('daily ran for 2026-10-21');
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

describe('runCommand: several workspaces', () => {
  // 07:00 UTC: before DAILY_RUN_AT, so a tick is a plain resync.
  const EARLY = new Date('2026-10-21T07:00:00Z');
  const ago = (ms: number): string =>
    new Date(EARLY.getTime() - ms).toISOString();

  test('works on the least recently synced first, never synced first', async () => {
    const engine = fakeEngine({
      statuses: [
        overview('ws-recent', { sync: { lastFullSyncAt: ago(20 * MINUTE) } }),
        overview('ws-old', { sync: { lastFullSyncAt: ago(3 * HOUR) } }),
        overview('ws-never'),
      ],
    });
    const result = await runCommand(context(engine, { now: EARLY }), {
      name: 'sync',
      workspaceId: null,
    });
    expect(engine.calls.filter((c) => c.startsWith('fullSync'))).toEqual([
      'fullSync:ws-never',
      'fullSync:ws-old',
      'fullSync:ws-recent',
    ]);
    expect(result.outcomes.map((o) => o.workspaceId)).toEqual([
      'ws-never',
      'ws-old',
      'ws-recent',
    ]);
  });

  test('works on WORKER_CONCURRENCY workspaces at once, outcomes in run order', async () => {
    const ids = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'];
    const engine = fakeEngine({ workspaces: ids });
    const started: string[] = [];
    const release = new Map<string, () => void>();
    let inFlight = 0;
    let most = 0;
    const real = engine.fullSync;
    engine.fullSync = async (id) => {
      started.push(id);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => release.set(id, resolve));
      inFlight -= 1;
      return real(id);
    };
    // Waits (bounded) until `count` syncs have started.
    const startedCount = async (count: number): Promise<string[]> => {
      for (let i = 0; i < 1000 && started.length < count; i += 1) {
        await Bun.sleep(1);
      }
      return [...started];
    };
    const finish = (id: string): void => release.get(id)?.();

    const running = runCommand(
      context(engine, { now: EARLY, concurrency: 2 }),
      { name: 'sync', workspaceId: null }
    );
    expect(await startedCount(2)).toEqual(['ws-1', 'ws-2']);
    await Bun.sleep(5);
    expect(started).toHaveLength(2);
    // ws-2 finishes first: its lane takes the next workspace.
    finish('ws-2');
    expect(await startedCount(3)).toEqual(['ws-1', 'ws-2', 'ws-3']);
    finish('ws-1');
    expect(await startedCount(4)).toEqual(ids.slice(0, 4));
    finish('ws-3');
    expect(await startedCount(5)).toEqual(ids);
    finish('ws-5');
    finish('ws-4');
    const result = await running;
    expect(most).toBe(2);
    expect(result.outcomes.map((o) => [o.workspaceId, o.kind])).toEqual(
      ids.map((id) => [id, 'done'])
    );
  });

  test('a workspace starts only with max(3 min, 2 × its last sync) left; the rest wait for the next tick', async () => {
    // Each sync takes 2 minutes on the fake clock; the run has 10.
    let now = EARLY.getTime();
    const engine = fakeEngine({
      statuses: [
        overview('ws-1'),
        overview('ws-2'),
        overview('ws-3'),
        overview('ws-slow', {
          // 4-minute syncs need 8 minutes left.
          sync: { lastFullSyncAt: ago(HOUR), lastFullSyncMs: 4 * MINUTE },
        }),
        overview('ws-4', { sync: { lastFullSyncAt: ago(HOUR) } }),
        overview('ws-5', { sync: { lastFullSyncAt: ago(HOUR) } }),
      ],
    });
    const real = engine.fullSync;
    engine.fullSync = async (id) => {
      now += 2 * MINUTE;
      return real(id);
    };
    const { logger, lines } = recordingLogger();
    const result = await runCommand(
      {
        ...context(engine),
        logger,
        now: () => new Date(now),
        deadlineAt: new Date(EARLY.getTime() + 10 * MINUTE),
      },
      { name: 'tick', workspaceId: null }
    );
    // 10, 8 and 6 minutes left: ws-1..3 start; ws-slow needs 8 with 4
    // left; ws-4 starts with 4 left; ws-5 has 2 left.
    expect(result.outcomes.map((o) => [o.workspaceId, o.kind])).toEqual([
      ['ws-1', 'done'],
      ['ws-2', 'done'],
      ['ws-3', 'done'],
      ['ws-slow', 'deferred'],
      ['ws-4', 'done'],
      ['ws-5', 'deferred'],
    ]);
    expect(result.outcomes[3]?.detail).toBe(
      'workspace deferred to the next tick (4 min left, needs 8 min)'
    );
    expect(result.outcomes[5]?.detail).toBe(
      'workspace deferred to the next tick (2 min left, needs 3 min)'
    );
    expect(exitCodeFor(result)).toBe(0);
    expect(summaryLine(result)).toStartWith('tick ok — ');
    expect(logged(lines, 'info', 'deferred to the next tick')).toHaveLength(2);
    expect(engine.calls).toContain('cleanup');
  });

  test('a command run by hand says to run it again', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const result = await runCommand(
      context(engine, {
        now: EARLY,
        deadlineAt: new Date(EARLY.getTime() + 2 * MINUTE),
      }),
      { name: 'allocate', workspaceId: null, mode: 'dry_run' }
    );
    expect(result.outcomes[0]).toMatchObject({
      kind: 'deferred',
      ok: true,
      detail: 'workspace not started (2 min left, needs 3 min); run it again',
    });
    expect(engine.calls).not.toContain(
      'runAllocation:ws-a:dry_run:manual:no-actor'
    );
  });

  test('a workspace too slow to ever fit starts at the beginning of a run, with a warning', async () => {
    const engine = fakeEngine({
      statuses: [
        overview('ws-huge', {
          sync: { lastFullSyncAt: ago(HOUR), lastFullSyncMs: 6 * MINUTE },
        }),
      ],
    });
    const { logger, lines } = recordingLogger();
    const ctx = {
      ...context(engine, { now: EARLY }),
      logger,
      deadlineAt: new Date(EARLY.getTime() + 9.5 * MINUTE),
    };
    const result = await runCommand(ctx, { name: 'tick', workspaceId: null });
    expect(result.outcomes[0]?.kind).toBe('done');
    expect(logged(lines, 'warn', 'syncs too slowly')).toHaveLength(1);
    // Later in a run it waits: it needs 9 of the 10 minutes.
    const late = await runCommand(
      { ...ctx, deadlineAt: new Date(EARLY.getTime() + 8 * MINUTE) },
      { name: 'tick', workspaceId: null }
    );
    expect(late.outcomes[0]?.detail).toBe(
      'workspace deferred to the next tick (8 min left, needs 9 min)'
    );
  });

  test('a tick never starts a due daily job with less than 5 minutes left; the workspace waits for the next tick', async () => {
    const at8 = new Date('2026-10-21T08:00:00Z');
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const { logger, lines } = recordingLogger();
    const result = await runCommand(
      {
        ...context(engine, { now: at8 }),
        logger,
        deadlineAt: new Date(at8.getTime() + 4 * MINUTE),
      },
      { name: 'tick', workspaceId: null }
    );
    expect(engine.calls.some((c) => c.startsWith('runDaily'))).toBe(false);
    // No plain resync either: it would move the workspace to the back of
    // the next tick's queue.
    expect(engine.calls).not.toContain('fullSync:ws-a');
    expect(result.outcomes[0]).toMatchObject({
      kind: 'deferred',
      ok: true,
      detail: 'daily deferred to the next tick (4 min left, needs 5 min)',
    });
    expect(exitCodeFor(result)).toBe(0);
    expect(logged(lines, 'info', 'daily job deferred')).toHaveLength(1);
    // With 5 minutes left it runs.
    await runCommand(
      {
        ...context(engine, { now: at8 }),
        deadlineAt: new Date(at8.getTime() + 5 * MINUTE),
      },
      { name: 'tick', workspaceId: null }
    );
    expect(engine.calls).toContain('runDaily:ws-a@2026-10-21');
  });

  test('over a morning of ticks, every workspace gets its daily job, none starved by a resync', async () => {
    // 12 workspaces, one lane, a 10-minute budget every 15 minutes: a
    // sync takes 1 minute and a daily job 1.5 (sync and allocation), so a
    // tick reaches the last ones with 3 to 5 minutes left: enough to sync,
    // not to start a daily job.
    const SYNC = MINUTE;
    const DAILY = 1.5 * MINUTE;
    const ids = Array.from({ length: 12 }, (_, i) => `ws-${i + 1}`);
    let now = new Date('2026-10-21T08:00:00Z').getTime();
    const statuses = new Map(ids.map((id) => [id, overview(id)]));
    const ran = new Set<string>();
    // A finished sync records its attempt (and success) time, as the
    // engine's recordFullSync does.
    const synced = (id: string): void => {
      const at = new Date(now).toISOString();
      statuses.set(
        id,
        overview(id, {
          sync: {
            lastFullSyncAt: at,
            lastFullSyncStatus: 'ok',
            lastSuccessAt: at,
            lastFullSyncMs: SYNC,
          },
        })
      );
    };
    const engine = fakeEngine({
      now: () => new Date(now),
      overrides: {
        listWorkspaceStatus: () => Promise.resolve([...statuses.values()]),
        fullSync: (id) => {
          now += SYNC;
          synced(id);
          return Promise.resolve(syncResult(id));
        },
        runDaily: ({ workspaceId, day }) => {
          const key = `${workspaceId}@${day ?? '?'}`;
          if (ran.has(key)) {
            return Promise.resolve({
              workspaceId,
              day: day ?? '',
              ran: false,
              sync: null,
              allocation: null,
              warnings: null,
            });
          }
          ran.add(key);
          now += DAILY;
          synced(workspaceId);
          return Promise.resolve({
            workspaceId,
            day: day ?? '',
            ran: true,
            sync: syncResult(workspaceId),
            allocation: allocationRun(workspaceId),
            warnings: warningResult(workspaceId),
          });
        },
      },
    });
    const start = now;
    for (let tick = 0; tick < 3; tick += 1) {
      now = start + tick * 15 * MINUTE;
      const result = await runCommand(
        {
          ...context(engine),
          now: () => new Date(now),
          deadlineAt: new Date(now + 10 * MINUTE),
        },
        { name: 'tick', workspaceId: null }
      );
      expect(exitCodeFor(result)).toBe(0);
    }
    expect([...ran].toSorted()).toEqual(
      ids.map((id) => `${id}@2026-10-21`).toSorted()
    );
  });

  test('daily run by hand is not started with less than 5 minutes left', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const result = await runCommand(
      context(engine, { deadlineAt: new Date('2026-10-21T12:04:00Z') }),
      { name: 'daily', workspaceId: 'ws-a', force: false }
    );
    expect(engine.calls).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({
      kind: 'deferred',
      detail: 'daily not started (4 min left, needs 5 min); run it again',
    });
    expect(exitCodeFor(result)).toBe(0);
  });

  test('a tick skips a plain resync after a successful one less than 10 minutes ago', async () => {
    const engine = fakeEngine({
      statuses: [
        overview('ws-fresh', {
          sync: {
            lastFullSyncAt: ago(4 * MINUTE),
            lastFullSyncStatus: 'ok',
            lastSuccessAt: ago(4 * MINUTE),
          },
        }),
        overview('ws-stale', {
          sync: {
            lastFullSyncAt: ago(11 * MINUTE),
            lastFullSyncStatus: 'ok',
            lastSuccessAt: ago(11 * MINUTE),
          },
        }),
      ],
    });
    const result = await runCommand(context(engine, { now: EARLY }), {
      name: 'tick',
      workspaceId: null,
    });
    expect(engine.calls.filter((c) => c.startsWith('fullSync'))).toEqual([
      'fullSync:ws-stale',
    ]);
    expect(
      result.outcomes.find((o) => o.workspaceId === 'ws-fresh')
    ).toMatchObject({
      kind: 'done',
      detail:
        'sync skipped (the last full sync finished 4 min ago), daily due at 08:00 UTC',
    });
    // A sync run by hand always syncs.
    await runCommand(context(engine, { now: EARLY }), {
      name: 'sync',
      workspaceId: null,
    });
    expect(engine.calls).toContain('fullSync:ws-fresh');
  });

  test("the daily job's own sync is never skipped", async () => {
    const at8 = new Date('2026-10-21T08:00:00Z');
    const engine = fakeEngine({
      statuses: [
        overview('ws-a', {
          sync: {
            lastFullSyncAt: '2026-10-21T07:58:00.000Z',
            lastFullSyncStatus: 'ok',
            lastSuccessAt: '2026-10-21T07:58:00.000Z',
          },
        }),
      ],
    });
    const result = await runCommand(context(engine, { now: at8 }), {
      name: 'tick',
      workspaceId: null,
    });
    expect(engine.calls).toContain('runDaily:ws-a@2026-10-21');
    expect(result.outcomes[0]?.detail).toStartWith('daily ran for 2026-10-21');
    // Once today's daily ran, the next plain resync is skipped like any.
    const again = await runCommand(context(engine, { now: at8 }), {
      name: 'tick',
      workspaceId: null,
    });
    expect(again.outcomes[0]?.detail).toBe(
      'sync skipped (the last full sync finished 2 min ago), daily already ran for 2026-10-21'
    );
  });

  test('uninstalled, removed, blocked and not admitted workspaces are skipped, never failures', async () => {
    const { logger, lines } = recordingLogger();
    const engine = fakeEngine({
      statuses: [
        overview('ws-a'),
        revokedOverview('ws-uninstalled', 'uninstalled'),
        revokedOverview('ws-removed', 'removed'),
        { ...overview('ws-blocked'), admission: 'blocked' },
        { ...revokedOverview('ws-blocked-dead'), admission: 'blocked' },
        { ...overview('ws-unlisted'), admission: 'not_allowed' },
        overview('ws-people-only', { installation: null }),
      ],
    });
    const result = await runCommand(
      { ...context(engine, { now: EARLY }), logger },
      { name: 'tick', workspaceId: null }
    );
    expect(result.outcomes.map((o) => [o.workspaceId, o.kind])).toEqual([
      ['ws-a', 'done'],
      ['ws-uninstalled', 'skipped'],
      ['ws-removed', 'skipped'],
      ['ws-blocked', 'skipped'],
      ['ws-blocked-dead', 'skipped'],
      ['ws-unlisted', 'skipped'],
    ]);
    expect(exitCodeFor(result)).toBe(0);
    expect(engine.calls.filter((c) => c.startsWith('fullSync'))).toEqual([
      'fullSync:ws-a',
    ]);
    expect(summaryLine(result)).toContain(
      'ws-uninstalled: skipped (uninstalled in Linear); ws-removed: skipped (removed by the operator); ws-blocked: skipped (blocked by the operator)'
    );
    expect(summaryLine(result)).toContain(
      'ws-unlisted: skipped (LINEAR_WORKSPACES does not admit it)'
    );
    expect(logged(lines, 'info', 'workspace skipped')).toHaveLength(5);
    expect(logged(lines, 'error', '')).toEqual([]);
  });

  test('a tick failure is chronic after 24 hours without a successful sync: a warning, not a failed run', async () => {
    const { logger, lines } = recordingLogger();
    const failing = (id: string, lastSuccessAt: string | null) =>
      overview(id, {
        installation: { createdAt: ago(30 * HOUR) },
        sync: {
          lastFullSyncAt: ago(15 * MINUTE),
          lastFullSyncStatus: 'failed',
          consecutiveFailures: 90,
          lastSuccessAt,
        },
      });
    const engine = fakeEngine({
      statuses: [
        failing('ws-chronic', ago(25 * HOUR)),
        failing('ws-never', null),
        overview('ws-ok'),
      ],
    });
    engine.fullSync = (id) =>
      id === 'ws-ok'
        ? Promise.resolve(fakeEngine().fullSync(id))
        : Promise.reject(new Error('Linear says no'));
    const result = await runCommand(
      { ...context(engine, { now: EARLY }), logger },
      { name: 'tick', workspaceId: null }
    );
    // ws-ok was never attempted, so it runs first.
    expect(result.outcomes.map((o) => [o.workspaceId, o.kind])).toEqual([
      ['ws-ok', 'done'],
      ['ws-chronic', 'chronic'],
      ['ws-never', 'chronic'],
    ]);
    expect(exitCodeFor(result)).toBe(0);
    expect(summaryLine(result)).toStartWith('tick ok (2 chronic) — ');
    expect(summaryLine(result)).toContain(
      'ws-chronic: chronic failure (Linear says no); ws-never: chronic failure (Linear says no)'
    );
    expect(logged(lines, 'warn', 'chronic')).toHaveLength(2);
    expect(logged(lines, 'error', 'workspace failed')).toEqual([]);

    // A workspace that synced an hour ago fails the tick.
    const fresh = fakeEngine({
      statuses: [failing('ws-new-failure', ago(HOUR))],
      overrides: {
        fullSync: () => Promise.reject(new Error('Linear says no')),
      },
    });
    const red = await runCommand(context(fresh, { now: EARLY }), {
      name: 'tick',
      workspaceId: null,
    });
    expect(red.outcomes[0]?.kind).toBe('failed');
    expect(exitCodeFor(red)).toBe(1);

    // A command run by hand always reports its failure.
    const manual = await runCommand(context(engine, { now: EARLY }), {
      name: 'sync',
      workspaceId: null,
    });
    expect(manual.outcomes.map((o) => o.kind)).toEqual([
      'done',
      'failed',
      'failed',
    ]);
    expect(exitCodeFor(manual)).toBe(1);
  });

  test("a failure after the run's own sync succeeded is never chronic", async () => {
    const at8 = new Date('2026-10-21T08:00:00Z');
    const engine = fakeEngine({
      statuses: [
        overview('ws-a', {
          installation: { createdAt: '2026-10-01T00:00:00.000Z' },
          sync: {
            lastFullSyncAt: '2026-10-21T07:45:00.000Z',
            lastFullSyncStatus: 'failed',
            lastSuccessAt: '2026-10-19T08:00:00.000Z',
          },
        }),
      ],
    });
    engine.runDaily = ({ workspaceId }) =>
      Promise.resolve({
        workspaceId,
        day: '2026-10-21',
        ran: true,
        sync: fakeEngine().fullSync(workspaceId) as never,
        allocation: allocationRun(workspaceId, {
          mode: 'live',
          status: 'partial',
          error: '1 comment(s) could not be posted.',
        }),
        warnings: warningResult(workspaceId),
      });
    const result = await runCommand(context(engine, { now: at8 }), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.outcomes[0]).toMatchObject({
      kind: 'failed',
      error: '1 comment(s) could not be posted.',
    });
    expect(exitCodeFor(result)).toBe(1);
  });

  test('cleanup lists the counts for several workspaces when there are any', async () => {
    const engine = fakeEngine({ workspaces: [] });
    engine.cleanup = () =>
      Promise.resolve({
        expiredSessions: 1,
        revokedTokens: 3,
        revokeFailures: 0,
        oldDeliveries: 0,
        endedWorkspaceSessions: 2,
        purgedWorkspaces: 1,
        oldNotifications: 120,
        oldJobClaims: 0,
      });
    const result = await runCommand(context(engine), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.notes).toEqual([
      'cleanup: 1 expired session, 0 old webhook delivery records, 2 sessions of uninstalled or removed workspaces, 1 workspace purged, 120 old notifications',
    ]);
  });

  test('cleanup counts installed workspaces LINEAR_WORKSPACES leaves out, without failing the tick', async () => {
    const engine = fakeEngine({ workspaces: [] });
    engine.cleanup = () =>
      Promise.resolve({
        expiredSessions: 0,
        revokedTokens: 0,
        revokeFailures: 0,
        oldDeliveries: 0,
        notServedWorkspaces: 1,
      });
    const result = await runCommand(context(engine), {
      name: 'tick',
      workspaceId: null,
    });
    expect(result.notes).toEqual([
      'cleanup: 0 expired sessions, 0 old webhook delivery records, 1 installed workspace not served (LINEAR_WORKSPACES leaves it out)',
    ]);
    expect(exitCodeFor(result)).toBe(0);
  });

  test('cleanup gets at most 2 minutes and half the time left, and says what it left', async () => {
    const engine = fakeEngine({ workspaces: [] });
    const deadlines: (Date | undefined)[] = [];
    engine.cleanup = (options) => {
      deadlines.push(options?.deadline);
      return Promise.resolve({
        expiredSessions: 7,
        revokedTokens: 7,
        revokeFailures: 0,
        oldDeliveries: 0,
        reAdmittedWorkspaces: 1,
        deferred: ['expired_sessions', 'purges'],
      });
    };
    const now = new Date('2026-10-21T12:00:00Z');
    const after = (ms: number) => new Date(now.getTime() + ms);
    const result = await runCommand(
      context(engine, { now, deadlineAt: after(10 * MINUTE) }),
      { name: 'tick', workspaceId: null }
    );
    await runCommand(context(engine, { now, deadlineAt: after(3 * MINUTE) }), {
      name: 'tick',
      workspaceId: null,
    });
    expect(deadlines).toEqual([after(2 * MINUTE), after(1.5 * MINUTE)]);
    expect(result.notes).toEqual([
      'cleanup: 7 expired sessions, 0 old webhook delivery records, 1 installed workspace admitted again (its URL key read from Linear), left for the next tick: expired sessions, purges',
    ]);
    expect(exitCodeFor(result)).toBe(0);
  });

  test('a workspace cleanup admits again is served in the same tick', async () => {
    let admission: 'ok' | 'not_allowed' = 'not_allowed';
    const engine = fakeEngine({ workspaces: [] });
    engine.listWorkspaceStatus = () => {
      engine.calls.push('listWorkspaceStatus');
      return Promise.resolve([overview('ws-renamed', { admission })]);
    };
    engine.cleanup = () => {
      engine.calls.push('cleanup');
      admission = 'ok';
      return Promise.resolve({
        expiredSessions: 0,
        revokedTokens: 0,
        revokeFailures: 0,
        oldDeliveries: 0,
        reAdmittedWorkspaces: 1,
      });
    };
    const result = await runCommand(
      context(engine, { now: new Date('2026-10-21T07:00:00Z') }),
      { name: 'tick', workspaceId: null }
    );
    expect(engine.calls).toEqual([
      'cleanup',
      'listWorkspaceStatus',
      'workspaceTimezone:ws-renamed',
      'fullSync:ws-renamed',
    ]);
    expect(result.outcomes[0]).toMatchObject({
      workspaceId: 'ws-renamed',
      kind: 'done',
    });
  });
});

describe('runCommand: a workspace whose full sync never finishes', () => {
  // Every 15 minutes a tick with the default 10-minute budget, one
  // workspace at a time, before DAILY_RUN_AT (plain resyncs). ws-stuck
  // has never synced, and its sync outlives every tick: the tick's
  // deadline kills it (here: it takes the clock past the deadline and
  // fails, so the rest of that tick has no time left). The others sync in
  // 4 minutes each. The fake keeps sync state as the store does: the
  // engine stamps an attempt's start (recordFullSyncStart), and only an
  // attempt that ends records its finish.
  test('it no longer goes first on every tick, so the others still sync', async () => {
    const ids = ['ws-stuck', 'ws-a', 'ws-b', 'ws-c'];
    const longAgo = '2026-10-20T03:00:00.000Z';
    const state = new Map(
      ids.map((id) => [
        id,
        {
          lastFullSyncAt: id === 'ws-stuck' ? null : longAgo,
          lastSuccessAt: id === 'ws-stuck' ? null : longAgo,
          lastFullSyncMs: id === 'ws-stuck' ? null : 4 * MINUTE,
          lastFullSyncStartedAt: null as string | null,
        },
      ])
    );
    let now = new Date('2026-10-21T03:00:00Z');
    let deadlineAt = new Date(now.getTime() + 10 * MINUTE);
    const engine = fakeEngine({ workspaces: [] });
    engine.listWorkspaceStatus = () =>
      Promise.resolve(
        ids.map((id) => overview(id, { sync: { ...state.get(id) } }))
      );
    const synced: string[][] = [];
    engine.fullSync = (id) => {
      const entry = state.get(id);
      if (entry === undefined) throw new Error(`unknown ${id}`);
      entry.lastFullSyncStartedAt = now.toISOString();
      if (id === 'ws-stuck') {
        now = new Date(deadlineAt.getTime() + 1000);
        return Promise.reject(new Error('killed at the tick deadline'));
      }
      now = new Date(now.getTime() + 4 * MINUTE);
      entry.lastFullSyncAt = now.toISOString();
      entry.lastSuccessAt = now.toISOString();
      synced.at(-1)?.push(id);
      return Promise.resolve(syncResult(id));
    };

    const firsts: string[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      now = new Date(Date.parse('2026-10-21T03:00:00Z') + tick * 15 * MINUTE);
      deadlineAt = new Date(now.getTime() + 10 * MINUTE);
      synced.push([]);
      // The context's clock reads `now`, which the syncs move on.
      const ctx: CommandContext = {
        ...context(engine, { deadlineAt }),
        now: () => now,
      };
      const result = await runCommand(ctx, {
        name: 'tick',
        workspaceId: null,
      });
      firsts.push(result.outcomes[0]?.workspaceId ?? '');
    }
    // Before attempt starts were recorded, ws-stuck (never finished) was
    // first in every tick and nothing else ever synced.
    expect(firsts[0]).toBe('ws-stuck');
    expect(firsts.slice(1)).not.toContain('ws-stuck');
    expect(new Set(synced.flat())).toEqual(new Set(['ws-a', 'ws-b', 'ws-c']));
  });
});

describe('workerEngineFrom', () => {
  // An engine whose load() must not be called: reading the timezone may
  // not sync a workspace (load syncs one that was never mirrored).
  function engineWith(timezone: string): Engine {
    const partial: Partial<Engine> = {
      mode: 'fixture',
      config: { defaultTimezone: 'Asia/Tokyo' } as Engine['config'],
      load: () => Promise.reject(new Error('load() syncs; not allowed here')),
      getSettings: (workspaceId) =>
        Promise.resolve({ workspaceId, timezone } as WorkspaceSettings),
    };
    return partial as Engine;
  }

  test('reads the timezone from the settings, without loading', async () => {
    expect(
      await workerEngineFrom(engineWith('Europe/Berlin')).workspaceTimezone(
        'ws-a'
      )
    ).toBe('Europe/Berlin');
  });

  test('an invalid saved timezone falls back to DEFAULT_TIMEZONE', async () => {
    expect(
      await workerEngineFrom(engineWith('Mars/Olympus')).workspaceTimezone(
        'ws-a'
      )
    ).toBe('Asia/Tokyo');
  });
});

describe('apiKeyModeOutcome', () => {
  test('tick and serve exit 0, the one-shot jobs exit 1, migrate boots', () => {
    expect(apiKeyModeOutcome('tick')?.code).toBe(0);
    expect(apiKeyModeOutcome('serve')?.line).toContain(
      'api-key mode: no scheduled sync'
    );
    for (const command of ['sync', 'daily', 'allocate', 'warn'] as const) {
      expect(apiKeyModeOutcome(command)).toEqual({
        code: 1,
        line: `${command}: off when LINEAR_AUTH=api_key: keys live only in the planner's memory; start a run or a resync from the planner`,
      });
    }
    expect(apiKeyModeOutcome('migrate')).toBeNull();
  });
});
