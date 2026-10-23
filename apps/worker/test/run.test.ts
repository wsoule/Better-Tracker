import { createEngineFromEnv } from '@better-tracker/engine';
import { createLogger, silentLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { USAGE } from '../src/cli';
import { type WorkerEngine, workerEngineFrom } from '../src/commands';
import {
  type CliDeps,
  type CliOutput,
  isEntryPoint,
  runCli,
  sleepUnlessStopped,
  startDeadline,
  warnAboutDemoStorage,
} from '../src/run';
import { type FakeEngine, fakeEngine } from './fake-engine';

interface Captured extends CliOutput {
  outLines: string[];
  errLines: string[];
}

function capture(): Captured {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

// Deps around a fake engine: silent logs, captured output, a fixed clock.
function deps(
  engine: FakeEngine | null,
  extra: Omit<Partial<CliDeps>, 'output'> = {}
): CliDeps & { output: Captured; created: () => number } {
  let created = 0;
  return {
    env: {},
    logger: silentLogger,
    engineLogger: silentLogger,
    now: () => new Date('2026-10-21T12:00:00Z'),
    createEngine: () => {
      created += 1;
      return engine === null
        ? Promise.reject(new Error('no engine in this test'))
        : Promise.resolve(engine);
    },
    ...extra,
    output: capture(),
    created: () => created,
  };
}

// Makes the engine call behind a one-shot `command` hang forever.
function stallCommand(engine: FakeEngine, command: string): void {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  if (command === 'sync') engine.fullSync = never;
  else if (command === 'daily') engine.runDaily = never;
  else if (command === 'allocate') engine.runAllocation = never;
  else if (command === 'warn') engine.runWarnings = never;
  else throw new Error(`no engine call to stall for ${command}`);
}

// The argv that runs a one-shot command (allocate needs its mode).
function argvFor(command: string): string[] {
  return command === 'allocate' ? ['allocate', '--dry-run'] : [command];
}

describe('runCli: arguments and configuration', () => {
  test('--help prints usage and exits 0 without booting', async () => {
    const d = deps(fakeEngine());
    expect(await runCli(['--help'], d)).toBe(0);
    expect(d.output.outLines).toEqual([USAGE]);
    expect(d.created()).toBe(0);
  });

  test('an unknown argument is a usage error (exit 2)', async () => {
    const d = deps(fakeEngine());
    expect(await runCli(['tick', '--frobnicate'], d)).toBe(2);
    expect(d.output.errLines).toEqual([
      'worker: Unknown option: --frobnicate',
      'Run with --help for usage.',
    ]);
    expect(d.created()).toBe(0);
  });

  test('no command is a usage error', async () => {
    expect(await runCli([], deps(fakeEngine()))).toBe(2);
  });

  test('an invalid worker environment exits 1 before booting', async () => {
    const d = deps(fakeEngine(), { env: { DAILY_RUN_AT: '25:00' } });
    expect(await runCli(['tick'], d)).toBe(1);
    expect(d.output.errLines.join('\n')).toContain('DAILY_RUN_AT');
    expect(d.created()).toBe(0);
  });

  test('a boot failure (engine config, database) exits 1', async () => {
    const d = deps(null);
    expect(await runCli(['sync'], d)).toBe(1);
    expect(d.output.errLines).toEqual([
      'worker: could not start: no engine in this test',
    ]);
  });
});

describe('runCli: one-shot commands', () => {
  test('tick prints one summary line, closes the engine and exits 0', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const d = deps(engine);
    expect(await runCli(['tick'], d)).toBe(0);
    expect(d.output.outLines).toHaveLength(1);
    expect(d.output.outLines[0]).toStartWith('tick ok — ws-a: daily ran for');
    expect(engine.calls.at(-1)).toBe('close');
  });

  test('a failed workspace exits 1 and still closes the engine', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a', 'ws-b'] });
    engine.fullSync = (id) => {
      engine.calls.push(`fullSync:${id}`);
      return Promise.reject(new Error(`cannot reach ${id}`));
    };
    const d = deps(engine);
    expect(await runCli(['sync'], d)).toBe(1);
    expect(d.output.outLines).toEqual([
      'sync FAILED (2 of 2 workspaces) — ws-a: FAILED (cannot reach ws-a); ws-b: FAILED (cannot reach ws-b)',
    ]);
    expect(engine.closed).toBe(true);
  });

  test('a failing close turns the exit code into 1', async () => {
    const engine = fakeEngine({ workspaces: [] });
    engine.close = () => Promise.reject(new Error('pool already ended'));
    expect(await runCli(['migrate'], deps(engine))).toBe(1);
  });

  test('a hung tick hits the hard timeout and exits 1', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    engine.workspaceTimezone = () => new Promise<string>(() => undefined);
    const exited = Promise.withResolvers<number>();
    const d = deps(engine, {
      tickTimeoutMs: 20,
      exit: (code) => exited.resolve(code),
    });
    // runCli never resolves here: the real exit would end the process.
    void runCli(['tick'], d);
    expect(await exited.promise).toBe(1);
    expect(d.output.errLines).toEqual([
      expect.stringContaining(
        'tick did not finish within TICK_TIMEOUT_MINUTES'
      ),
    ]);
  });

  test('the deadline is cancelled when tick finishes in time', async () => {
    let exits = 0;
    const d = deps(fakeEngine({ workspaces: ['ws-a'] }), {
      tickTimeoutMs: 30,
      exit: () => {
        exits += 1;
      },
    });
    expect(await runCli(['tick'], d)).toBe(0);
    await Bun.sleep(60);
    expect(exits).toBe(0);
  });

  test('a hanging engine close is covered by the tick deadline', async () => {
    const engine = fakeEngine({ workspaces: [] });
    engine.close = () => new Promise<void>(() => undefined);
    const exited = Promise.withResolvers<number>();
    void runCli(
      ['tick'],
      deps(engine, { tickTimeoutMs: 20, exit: (code) => exited.resolve(code) })
    );
    expect(await exited.promise).toBe(1);
  });

  test('a hung boot hits the deadline too', async () => {
    const exited = Promise.withResolvers<number>();
    const output = capture();
    const d: CliDeps = {
      ...deps(null),
      output,
      createEngine: () => new Promise<WorkerEngine>(() => undefined),
      tickTimeoutMs: 20,
      exit: (code) => exited.resolve(code),
    };
    void runCli(['tick'], d);
    expect(await exited.promise).toBe(1);
    expect(output.errLines).toEqual([expect.stringContaining('while booting')]);
  });

  // The manual commands get tick's budget too: a hung manual `daily` would
  // still hold its claim when a tick takes the day over, and an allocation
  // run that outlived the stale-run threshold would be closed as crashed
  // while it is still writing.
  test.each(['sync', 'daily', 'allocate', 'warn'])(
    'a hung %s hits the hard timeout and exits 1',
    async (name) => {
      const engine = fakeEngine({ workspaces: ['ws-a'] });
      stallCommand(engine, name);
      const exited = Promise.withResolvers<number>();
      const d = deps(engine, {
        tickTimeoutMs: 20,
        exit: (code) => exited.resolve(code),
      });
      void runCli(argvFor(name), d);
      expect(await exited.promise).toBe(1);
      expect(d.output.errLines).toHaveLength(1);
      const [line] = d.output.errLines;
      expect(line).toStartWith(
        `worker: ${name} did not finish within TICK_TIMEOUT_MINUTES`
      );
      expect(line).toContain(`stuck while running ${name}`);
    }
  );

  test('a manual command shares one budget with its boot', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    engine.runDaily = async (input) => {
      await Bun.sleep(100);
      return fakeEngine().runDaily(input);
    };
    const exits: number[] = [];
    const output = capture();
    const d: CliDeps = {
      ...deps(engine),
      output,
      tickTimeoutMs: 150,
      exit: (code) => exits.push(code),
      createEngine: async () => {
        await Bun.sleep(100);
        return engine;
      },
    };
    void runCli(['daily'], d);
    await Bun.sleep(400);
    expect(exits).toEqual([1]);
    expect(output.errLines).toEqual([
      expect.stringContaining('stuck while running daily'),
    ]);
  });

  test('the deadline is cancelled when a manual command finishes in time', async () => {
    let exits = 0;
    const d = deps(fakeEngine({ workspaces: ['ws-a'] }), {
      tickTimeoutMs: 30,
      exit: () => {
        exits += 1;
      },
    });
    expect(await runCli(['allocate', '--live'], d)).toBe(0);
    await Bun.sleep(60);
    expect(exits).toBe(0);
  });

  test('migrate has no hard timeout', async () => {
    // It claims no daily job and starts no allocation run, and it is how
    // an operator applies a migration too long for a tick's budget.
    let exits = 0;
    const engine = fakeEngine({ workspaces: [] });
    const d = deps(engine, {
      tickTimeoutMs: 20,
      exit: () => {
        exits += 1;
      },
      createEngine: async () => {
        await Bun.sleep(80);
        return engine;
      },
    });
    expect(await runCli(['migrate'], d)).toBe(0);
    expect(exits).toBe(0);
  });

  test('boot and the tick share one budget, so a run never outlasts it', async () => {
    // Each phase alone fits in the 150 ms budget; together they do not. A
    // run that may last boot + tick would overlap the next cron slot.
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    engine.workspaceTimezone = async () => {
      await Bun.sleep(100);
      return 'UTC';
    };
    const exits: number[] = [];
    const d = deps(engine, {
      tickTimeoutMs: 150,
      exit: (code) => exits.push(code),
      createEngine: async () => {
        await Bun.sleep(100);
        return engine;
      },
    });
    void runCli(['tick'], d);
    await Bun.sleep(400);
    expect(exits).toEqual([1]);
  });
});

describe('runCli: serve and process signals', () => {
  // serve without an injected stop signal listens to SIGTERM/SIGINT itself.
  // process.emit runs those listeners without delivering a real signal.
  test('a second SIGTERM while the store is closing exits 1 at once', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const closing = Promise.withResolvers<void>();
    engine.close = () => {
      closing.resolve();
      return new Promise<void>(() => undefined);
    };
    const exits: number[] = [];
    const d = deps(engine, {
      exit: (code) => exits.push(code),
      sleep: (_ms, stop) =>
        new Promise<void>((resolve) => {
          stop.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const before = process.listenerCount('SIGTERM');
    void runCli(['serve'], d);
    await Bun.sleep(20);
    process.emit('SIGTERM', 'SIGTERM');
    await closing.promise;
    process.emit('SIGTERM', 'SIGTERM');
    expect(exits).toEqual([1]);
    // The deadline for the hanging close is the only thing left; the
    // listeners stay until close settles, so remove this run's by hand.
    for (const listener of process.listeners('SIGTERM').slice(before)) {
      process.off('SIGTERM', listener);
    }
    for (const listener of process.listeners('SIGINT').slice(before)) {
      process.off('SIGINT', listener);
    }
  });

  test('the signal listeners are removed once serve has closed the store', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const d = deps(engine, {
      sleep: (_ms, stop) =>
        new Promise<void>((resolve) => {
          stop.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const before = process.listenerCount('SIGTERM');
    const running = runCli(['serve'], d);
    await Bun.sleep(20);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    process.emit('SIGTERM', 'SIGTERM');
    expect(await running).toBe(0);
    expect(engine.closed).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('runCli: serve', () => {
  test('ticks on the interval until stopped, then closes and exits 0', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const stop = new AbortController();
    const waits: number[] = [];
    const d = deps(engine, {
      env: { SYNC_INTERVAL_MINUTES: '5' },
      stopSignal: stop.signal,
      sleep: (ms) => {
        waits.push(ms);
        if (waits.length === 3) stop.abort();
        return Promise.resolve();
      },
    });
    expect(await runCli(['serve'], d)).toBe(0);
    expect(engine.calls.filter((c) => c === 'cleanup')).toHaveLength(3);
    expect(d.output.outLines).toHaveLength(3);
    // The daily run happens once; later ticks only resync.
    expect(engine.calls.filter((c) => c.startsWith('runDaily'))).toHaveLength(
      3
    );
    expect(d.output.outLines[1]).toContain('daily already ran for 2026-10-21');
    // Each wait is the rest of the 5-minute interval.
    for (const ms of waits) {
      expect(ms).toBeGreaterThan(4 * 60_000);
      expect(ms).toBeLessThanOrEqual(5 * 60_000);
    }
    expect(engine.calls.at(-1)).toBe('close');
  });

  test('a stop during a tick lets that tick finish, then exits', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const stop = new AbortController();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const realSync = engine.fullSync;
    engine.fullSync = async (id) => {
      entered.resolve();
      await release.promise;
      return realSync(id);
    };
    const d = deps(engine, {
      // Before 08:00 UTC: the tick is a plain resync.
      now: () => new Date('2026-10-21T07:00:00Z'),
      stopSignal: stop.signal,
      sleep: () => {
        throw new Error('serve must not sleep after a stop');
      },
    });
    const running = runCli(['serve'], d);
    await entered.promise;
    stop.abort();
    release.resolve();
    expect(await running).toBe(0);
    expect(d.output.outLines).toEqual([
      expect.stringContaining('tick ok — ws-a: synced'),
    ]);
    expect(engine.closed).toBe(true);
  });

  test('a stop before the first tick runs nothing', async () => {
    const engine = fakeEngine({ workspaces: ['ws-a'] });
    const stop = new AbortController();
    stop.abort();
    expect(
      await runCli(['serve'], deps(engine, { stopSignal: stop.signal }))
    ).toBe(0);
    expect(engine.calls).toEqual(['close']);
  });
});

describe('helpers', () => {
  test('sleepUnlessStopped resolves early when aborted', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const sleeping = sleepUnlessStopped(10_000, stop.signal);
    setTimeout(() => stop.abort(), 10);
    await sleeping;
    expect(Date.now() - started).toBeLessThan(2_000);
    // Already aborted: returns at once.
    await sleepUnlessStopped(10_000, stop.signal);
  });

  test('startDeadline fires once unless cancelled', async () => {
    let fired = 0;
    startDeadline(5, () => {
      fired += 1;
    });
    const cancelled = startDeadline(5, () => {
      fired += 10;
    });
    cancelled.cancel();
    await Bun.sleep(30);
    expect(fired).toBe(1);
  });

  test('warnAboutDemoStorage explains where demo data lives', () => {
    const lines: string[] = [];
    const logger = createLogger({
      name: 'test',
      sink: (_level, line) => lines.push(line),
    });
    const messages = (env: Record<string, string>): string[] => {
      lines.length = 0;
      warnAboutDemoStorage(env, logger);
      return lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
    };
    expect(
      messages({ LINEAR_FIXTURE: '1', DATABASE_URL: 'postgres://db/x' })
    ).toEqual([
      'demo mode ignores DATABASE_URL; demo data never goes to it',
      expect.stringContaining('set PGLITE_DIR to keep it'),
    ]);
    expect(messages({ LINEAR_FIXTURE: '1', PGLITE_DIR: '/tmp/demo' })).toEqual(
      []
    );
    expect(messages({ DATABASE_URL: 'postgres://db/x' })).toEqual([]);
  });

  test('isEntryPoint compares real paths', () => {
    const self = new URL(import.meta.url);
    expect(isEntryPoint(self.href, self.pathname)).toBe(true);
    expect(isEntryPoint(self.href, undefined)).toBe(false);
    expect(isEntryPoint(self.href, '/no/such/file.js')).toBe(false);
  });

  test('isEntryPoint resolves argv[1] the way node resolves its script', () => {
    // `node apps/worker tick` and `node apps/worker/dist tick` run
    // dist/index.js too; the CLI must not silently do nothing then.
    const root = mkdtempSync(join(tmpdir(), 'worker-entry-'));
    try {
      mkdirSync(join(root, 'pkg', 'dist'), { recursive: true });
      writeFileSync(
        join(root, 'pkg', 'package.json'),
        JSON.stringify({ type: 'module', main: './dist/index.js' })
      );
      const script = join(root, 'pkg', 'dist', 'index.js');
      writeFileSync(script, '');
      const url = pathToFileURL(script).href;
      expect(isEntryPoint(url, join(root, 'pkg'))).toBe(true);
      expect(isEntryPoint(url, join(root, 'pkg', 'dist'))).toBe(true);
      expect(isEntryPoint(url, join(root, 'pkg', 'dist', 'index'))).toBe(true);
      expect(isEntryPoint(url, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The real engine in demo mode (fixture workspace, in-memory PGlite), shared
// across runs the way serve shares it, with a controllable clock.
describe('runCli against the demo engine', () => {
  let clock = new Date('2026-10-21T13:00:00Z');
  const now = (): Date => clock;
  let engine: WorkerEngine;
  let shared: WorkerEngine;

  beforeAll(async () => {
    engine = workerEngineFrom(
      await createEngineFromEnv(
        { LINEAR_FIXTURE: '1' },
        { logger: silentLogger, now }
      )
    );
    // runCli closes the engine after each command; keep it for the next.
    shared = { ...engine, close: () => Promise.resolve() };
  });
  afterAll(async () => {
    await engine.close();
  });

  async function run(argv: string[]): Promise<{ code: number; line: string }> {
    const output = capture();
    const code = await runCli(argv, {
      env: { LINEAR_FIXTURE: '1' },
      output,
      logger: silentLogger,
      engineLogger: silentLogger,
      now,
      createEngine: () => Promise.resolve(shared),
    });
    return { code, line: [...output.outLines, ...output.errLines].join('\n') };
  }

  test('tick runs the daily job once per day, then only resyncs', async () => {
    const first = await run(['tick']);
    expect(first.code).toBe(0);
    expect(first.line).toMatch(
      /^tick ok — org-\S+: daily ran for 2026-10-21, allocation dry run succeeded: \d+ would be assigned/
    );
    expect(first.line).toContain('warnings preview:');
    expect(first.line).toContain('cleanup: 0 expired sessions');

    clock = new Date('2026-10-21T13:15:00Z');
    const second = await run(['tick']);
    expect(second.code).toBe(0);
    expect(second.line).toContain('daily already ran for 2026-10-21');
    expect(second.line).not.toContain('daily ran for');
  });

  test('daily --force runs again; plain daily does not', async () => {
    expect((await run(['daily'])).line).toContain(
      'daily already ran for 2026-10-21 (use --force to run it again)'
    );
    const forced = await run(['daily', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.line).toContain('daily ran for 2026-10-21');
  });

  test('allocate --dry-run, warn and sync', async () => {
    const allocate = await run(['allocate', '--dry-run']);
    expect(allocate.code).toBe(0);
    expect(allocate.line).toMatch(
      /allocation dry run succeeded: \d+ would be assigned/
    );
    const warn = await run(['warn']);
    expect(warn.code).toBe(0);
    // The daily runs already announced everything notable: warning memory
    // dedupes, so a repeat has no new notices and sends nothing.
    expect(warn.line).toMatch(/warnings preview: 0 notices, 0 digests$/);
    expect((await run(['sync'])).code).toBe(0);
  });

  test('before DAILY_RUN_AT on the next day, tick only resyncs', async () => {
    clock = new Date('2026-10-22T07:45:00Z');
    const early = await run(['tick']);
    expect(early.code).toBe(0);
    expect(early.line).toContain('daily due at 08:00 UTC');
    clock = new Date('2026-10-22T08:00:00Z');
    expect((await run(['tick'])).line).toContain('daily ran for 2026-10-22');
  });

  test('an unknown workspace fails with exit 1', async () => {
    const result = await run(['sync', '--workspace', 'org-nope']);
    expect(result.code).toBe(1);
    expect(result.line).toStartWith(
      'sync FAILED (1 of 1 workspace) — org-nope: FAILED'
    );
  });
});

describe('runCli with LINEAR_AUTH=api_key', () => {
  test('tick and serve print the note, exit 0 and never boot', async () => {
    for (const argv of [['tick'], ['serve']]) {
      const d = deps(fakeEngine(), { env: { LINEAR_AUTH: 'api_key' } });
      expect(await runCli(argv, d)).toBe(0);
      expect(d.created()).toBe(0);
      expect(d.output.outLines).toEqual([
        "api-key mode: no scheduled sync, allocation or digests (keys live only in the planner's memory)",
      ]);
    }
  });

  test('sync, daily, allocate and warn exit 1 with the sentence and never boot', async () => {
    for (const command of ['sync', 'daily', 'allocate', 'warn']) {
      const d = deps(fakeEngine(), { env: { LINEAR_AUTH: 'api_key' } });
      expect(await runCli(argvFor(command), d)).toBe(1);
      expect(d.created()).toBe(0);
      expect(d.output.errLines).toEqual([
        `${command}: off when LINEAR_AUTH=api_key: keys live only in the planner's memory; start a run or a resync from the planner`,
      ]);
    }
  });

  test('migrate boots the engine', async () => {
    const d = deps(fakeEngine(), { env: { LINEAR_AUTH: 'api_key' } });
    expect(await runCli(['migrate'], d)).toBe(0);
    expect(d.created()).toBe(1);
  });

  test('a deployed migrate needs no workspace pin (it never handles a key)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-apikey-migrate-'));
    try {
      const env = {
        LINEAR_AUTH: 'api_key',
        NODE_ENV: 'production',
        NODE_OPTIONS: '--disable-sigusr1',
        APP_URL: 'https://planner.example.com',
        PGLITE_DIR: join(dir, 'pglite'),
      };
      const real = (extra: Partial<CliDeps> = {}) =>
        deps(null, {
          env,
          createEngine: async (engineEnv, options) =>
            workerEngineFrom(
              await createEngineFromEnv(engineEnv, {
                ...options,
                execArgv: [],
              })
            ),
          ...extra,
        });
      const migrate = real();
      expect(await runCli(['migrate'], migrate)).toBe(0);
      expect(migrate.output.outLines.join('\n')).toContain(
        'database schema is up to date'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
