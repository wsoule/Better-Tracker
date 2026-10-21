import {
  ALLOCATION_RUN_STALE_MINUTES,
  DEFAULT_DAILY_LEASE_MINUTES,
} from '@better-tracker/engine';
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_TICK_TIMEOUT_MINUTES,
  loadWorkerConfig,
  MAX_TICK_TIMEOUT_MINUTES,
} from '../src/config';

describe('loadWorkerConfig', () => {
  test('defaults: 08:00, 10-minute timeout, 15-minute interval', () => {
    expect(loadWorkerConfig({})).toEqual({
      dailyAt: '08:00',
      dailyTime: { hour: 8, minute: 0 },
      tickTimeoutMinutes: 10,
      syncIntervalMinutes: 15,
    });
  });

  test('blank values count as unset', () => {
    expect(
      loadWorkerConfig({
        DAILY_RUN_AT: ' ',
        TICK_TIMEOUT_MINUTES: '',
        SYNC_INTERVAL_MINUTES: '  ',
      }).dailyAt
    ).toBe('08:00');
  });

  test('reads every variable', () => {
    expect(
      loadWorkerConfig({
        DAILY_RUN_AT: '06:30',
        TICK_TIMEOUT_MINUTES: '12',
        SYNC_INTERVAL_MINUTES: '5',
      })
    ).toEqual({
      dailyAt: '06:30',
      dailyTime: { hour: 6, minute: 30 },
      tickTimeoutMinutes: 12,
      syncIntervalMinutes: 5,
    });
  });

  test('reports every problem in one error', () => {
    let message = '';
    try {
      loadWorkerConfig({
        DAILY_RUN_AT: '8am',
        TICK_TIMEOUT_MINUTES: '0',
        SYNC_INTERVAL_MINUTES: '1.5',
      });
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toContain('Invalid worker environment');
    expect(message).toContain('DAILY_RUN_AT must be a 24-hour time HH:MM');
    expect(message).toContain('"8am"');
    expect(message).toContain('TICK_TIMEOUT_MINUTES must be a whole number');
    expect(message).toContain('SYNC_INTERVAL_MINUTES must be a whole number');
  });

  test.each(['24:00', '7:30', '-5', 'abc'])(
    'rejects DAILY_RUN_AT=%p',
    (value) => {
      expect(() => loadWorkerConfig({ DAILY_RUN_AT: value })).toThrow(
        'DAILY_RUN_AT'
      );
    }
  );

  test('a tick may last up to the daily lease minus the stale-run threshold, minus a minute', () => {
    expect(
      loadWorkerConfig({ TICK_TIMEOUT_MINUTES: '14' }).tickTimeoutMinutes
    ).toBe(14);
    expect(() => loadWorkerConfig({ TICK_TIMEOUT_MINUTES: '15' })).toThrow(
      'TICK_TIMEOUT_MINUTES must be a whole number of minutes from 1 to 14'
    );
  });

  test("a dead run's allocation is stale before its daily claim can be taken over", () => {
    // A run lives at most MAX_TICK_TIMEOUT_MINUTES after it starts, and it
    // claims the day after it starts, so its allocation run started at
    // most that long after the claim. That run stops blocking new ones
    // ALLOCATION_RUN_STALE_MINUTES later; a takeover needs a claim older
    // than the lease.
    expect(
      MAX_TICK_TIMEOUT_MINUTES + ALLOCATION_RUN_STALE_MINUTES
    ).toBeLessThan(DEFAULT_DAILY_LEASE_MINUTES);
    expect(MAX_TICK_TIMEOUT_MINUTES).toBe(
      DEFAULT_DAILY_LEASE_MINUTES - ALLOCATION_RUN_STALE_MINUTES - 1
    );
    // The default fits, and a run ends before the next 15-minute cron slot.
    expect(DEFAULT_TICK_TIMEOUT_MINUTES).toBeLessThanOrEqual(
      MAX_TICK_TIMEOUT_MINUTES
    );
    expect(MAX_TICK_TIMEOUT_MINUTES).toBeLessThan(15);
  });

  test.each(['15', '30', '721', '-1', '10m'])(
    'rejects TICK_TIMEOUT_MINUTES=%p',
    (value) => {
      expect(() => loadWorkerConfig({ TICK_TIMEOUT_MINUTES: value })).toThrow(
        'TICK_TIMEOUT_MINUTES'
      );
    }
  );
});
