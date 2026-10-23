// The api_key-mode background sync scheduler, with injected timers.

import type { LinearGateway } from '@better-tracker/linear';
import { silentLogger } from '@better-tracker/logger';
import { describe, expect, test } from 'bun:test';

import { createKeySyncScheduler, type KeySyncScheduler } from '../src/key-sync';
import { createKeyVault, type KeyVault } from '../src/key-vault';

const KEY = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';
const MINUTE = 60_000;

function setup(options: { failSync?: boolean } = {}) {
  const clock = { ms: 0 };
  const timers = { active: 0, started: 0, stopped: 0 };
  const syncs: string[] = [];
  const warnings: string[] = [];
  let scheduler: KeySyncScheduler | null = null;
  const vault: KeyVault = createKeyVault({
    idleMs: 30 * MINUTE,
    absoluteMs: 600 * MINUTE,
    now: () => clock.ms,
    gateway: () => ({}) as LinearGateway,
    onSizeChange: (size) => scheduler?.onSizeChange(size),
  });
  scheduler = createKeySyncScheduler({
    vault,
    intervalMs: 15 * MINUTE,
    now: () => clock.ms,
    timers: {
      setInterval: () => {
        timers.active += 1;
        timers.started += 1;
        return timers.started;
      },
      clearInterval: () => {
        timers.active -= 1;
        timers.stopped += 1;
      },
    },
    workspaceId: () => Promise.resolve('ws-1'),
    runSync: (workspaceId) => {
      syncs.push(workspaceId);
      return options.failSync === true
        ? Promise.reject(new Error('Linear down'))
        : Promise.resolve();
    },
    logger: {
      ...silentLogger,
      child: () => ({
        ...silentLogger,
        warn: (message: string) => warnings.push(message),
      }),
    },
  });
  const sched = scheduler;
  // Advances the clock minute by minute, ticking like the timer would.
  async function minutes(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      clock.ms += MINUTE;
      if (sched.running()) await sched.tick();
    }
  }
  return { clock, timers, syncs, warnings, vault, scheduler: sched, minutes };
}

function connect(vault: KeyVault, userId: string, guest = false): string {
  return vault.add({
    apiKey: KEY,
    workspaceId: 'ws-1',
    userId,
    userName: userId,
    guest,
  }).token;
}

describe('createKeySyncScheduler', () => {
  test('the timer starts on the first key and stops when the vault empties, and on close', () => {
    const s = setup();
    expect(s.scheduler.running()).toBe(false);
    const token = connect(s.vault, 'u-ana');
    expect(s.scheduler.running()).toBe(true);
    connect(s.vault, 'u-ben');
    expect(s.timers.started).toBe(1);
    s.vault.forgetPerson(token);
    expect(s.scheduler.running()).toBe(true);
    s.vault.clear();
    expect(s.scheduler.running()).toBe(false);
    connect(s.vault, 'u-ana');
    expect(s.scheduler.running()).toBe(true);
    s.scheduler.close();
    expect(s.scheduler.running()).toBe(false);
    connect(s.vault, 'u-ben');
    expect(s.scheduler.running()).toBe(false);
    expect(s.timers.active).toBe(0);
  });

  test('each tick sweeps, and syncs once per interval while a member is connected', async () => {
    const s = setup();
    const token = connect(s.vault, 'u-ana');
    await s.minutes(14);
    expect(s.syncs).toEqual([]);
    await s.minutes(1);
    expect(s.syncs).toEqual(['ws-1']);
    s.vault.use(token);
    await s.minutes(15);
    expect(s.syncs).toEqual(['ws-1', 'ws-1']);
  });

  test('background syncs never keep an idle key alive', async () => {
    const s = setup();
    connect(s.vault, 'u-ana');
    await s.minutes(29);
    expect(s.vault.count()).toBe(1);
    await s.minutes(1);
    // Swept at its idle limit, and the timer stops with the empty vault.
    expect(s.vault.count()).toBe(0);
    expect(s.scheduler.running()).toBe(false);
    expect(s.syncs).toEqual(['ws-1']);
  });

  test('never syncs with only guests connected', async () => {
    const s = setup();
    connect(s.vault, 'u-gus', true);
    await s.minutes(20);
    expect(s.syncs).toEqual([]);
    expect(s.scheduler.running()).toBe(true);
  });

  test('a failing sync is logged and the timer keeps going', async () => {
    const s = setup({ failSync: true });
    const token = connect(s.vault, 'u-ana');
    await s.minutes(15);
    expect(s.syncs).toEqual(['ws-1']);
    expect(s.warnings).toContain('background sync failed');
    expect(s.scheduler.running()).toBe(true);
    // The person's own request keeps the key alive; the next interval
    // tries again.
    s.vault.use(token);
    await s.minutes(15);
    expect(s.syncs).toEqual(['ws-1', 'ws-1']);
  });
});
