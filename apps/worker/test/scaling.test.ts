import { describe, expect, test } from 'bun:test';

import {
  dailyStartNeedMs,
  formatDuration,
  isChronic,
  MIN_START_MS,
  planFor,
  planWorkspaces,
  recentSyncAgeMs,
  startNeedMs,
  startWantedMs,
} from '../src/scaling';
import { overview, revokedOverview } from './fake-engine';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-10-25T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe('planFor', () => {
  test('active, admitted installations run', () => {
    expect(planFor(overview('org-a'))).toMatchObject({
      kind: 'run',
      workspaceId: 'org-a',
    });
  });

  test('a workspace nobody installed has no plan', () => {
    expect(planFor(overview('org-a', { installation: null }))).toBeNull();
  });

  test.each([
    ['uninstalled', 'uninstalled'],
    ['removed', 'removed'],
  ] as const)('revoked as %s is skipped', (reason, skip) => {
    expect(planFor(revokedOverview('org-a', reason))).toEqual({
      kind: 'skip',
      workspaceId: 'org-a',
      reason: skip,
    });
  });

  test('a dead app grant (or an unknown revoke reason) is a failure', () => {
    expect(planFor(revokedOverview('org-a', 'grant_dead'))).toEqual({
      kind: 'grant_dead',
      workspaceId: 'org-a',
    });
    expect(
      planFor(
        overview('org-a', {
          installation: { revokedAt: ago(HOUR), revokedReason: null },
        })
      )
    ).toEqual({ kind: 'grant_dead', workspaceId: 'org-a' });
  });

  test('blocked and not admitted are skipped, whatever happened to the grant', () => {
    for (const status of [overview('org-a'), revokedOverview('org-a')]) {
      expect(planFor({ ...status, admission: 'blocked' })).toEqual({
        kind: 'skip',
        workspaceId: 'org-a',
        reason: 'blocked',
      });
      expect(planFor({ ...status, admission: 'not_allowed' })).toEqual({
        kind: 'skip',
        workspaceId: 'org-a',
        reason: 'not admitted',
      });
    }
  });
});

describe('planWorkspaces', () => {
  test('runs the least recently attempted first, never attempted first, then the rest', () => {
    const plans = planWorkspaces([
      overview('org-recent', { sync: { lastFullSyncAt: ago(5 * MINUTE) } }),
      revokedOverview('org-gone', 'removed'),
      overview('org-old', { sync: { lastFullSyncAt: ago(2 * HOUR) } }),
      overview('org-new-1'),
      revokedOverview('org-dead'),
      overview('org-mid', { sync: { lastFullSyncAt: ago(HOUR) } }),
      overview('org-new-2', { sync: { lastFullSyncAt: null } }),
      overview('org-people-only', { installation: null }),
    ]);
    expect(plans.map((plan) => [plan.kind, plan.workspaceId])).toEqual([
      ['run', 'org-new-1'],
      ['run', 'org-new-2'],
      ['run', 'org-old'],
      ['run', 'org-mid'],
      ['run', 'org-recent'],
      ['skip', 'org-gone'],
      ['grant_dead', 'org-dead'],
    ]);
  });

  test('ties keep the engine order', () => {
    const at = ago(HOUR);
    const plans = planWorkspaces(
      ['c', 'a', 'b'].map((id) =>
        overview(id, { sync: { lastFullSyncAt: at } })
      )
    );
    expect(plans.map((plan) => plan.workspaceId)).toEqual(['c', 'a', 'b']);
  });
});

describe('start budget', () => {
  const BUDGET = 10 * MINUTE;

  test('a workspace wants max(3 min, 2 × its last full sync)', () => {
    expect(startWantedMs(null)).toBe(MIN_START_MS);
    expect(startWantedMs(MINUTE)).toBe(3 * MINUTE);
    expect(startWantedMs(2.5 * MINUTE)).toBe(5 * MINUTE);
    expect(startNeedMs(null, BUDGET)).toBe(3 * MINUTE);
    expect(startNeedMs(4 * MINUTE, BUDGET)).toBe(8 * MINUTE);
  });

  test('a need beyond the budget is capped so the workspace still starts at the beginning of a run', () => {
    // 2 × 6 min = 12 min could never be left in a 10-minute run.
    expect(startNeedMs(6 * MINUTE, BUDGET)).toBe(9 * MINUTE);
    // A 2-minute TICK_TIMEOUT_MINUTES never has 3 minutes left either.
    expect(startNeedMs(null, 2 * MINUTE)).toBe(MINUTE);
    expect(startNeedMs(null, MINUTE)).toBe(0);
  });

  test('a daily job needs 5 minutes, capped the same way', () => {
    expect(dailyStartNeedMs(BUDGET)).toBe(5 * MINUTE);
    expect(dailyStartNeedMs(4 * MINUTE)).toBe(3 * MINUTE);
  });
});

describe('recentSyncAgeMs', () => {
  test('a successful full sync less than 10 minutes ago is recent', () => {
    const at = (ms: number) =>
      overview('org-a', { sync: { lastSuccessAt: ago(ms) } });
    expect(recentSyncAgeMs(at(4 * MINUTE), NOW)).toBe(4 * MINUTE);
    expect(recentSyncAgeMs(at(0), NOW)).toBe(0);
    expect(recentSyncAgeMs(at(10 * MINUTE), NOW)).toBeNull();
    // A finish in the future (clock skew) does not stop resyncs.
    expect(recentSyncAgeMs(at(-MINUTE), NOW)).toBeNull();
  });

  test('no success, no overview: not recent', () => {
    expect(recentSyncAgeMs(overview('org-a'), NOW)).toBeNull();
    expect(recentSyncAgeMs(null, NOW)).toBeNull();
    expect(
      recentSyncAgeMs(
        overview('org-a', {
          sync: { lastFullSyncAt: ago(MINUTE), lastFullSyncStatus: 'failed' },
        }),
        NOW
      )
    ).toBeNull();
  });
});

describe('isChronic', () => {
  test('no successful full sync for more than 24 hours', () => {
    const lastSuccess = (ms: number) =>
      overview('org-a', {
        sync: {
          lastSuccessAt: ago(ms),
          lastFullSyncAt: ago(MINUTE),
          lastFullSyncStatus: 'failed',
        },
      });
    expect(isChronic(lastSuccess(25 * HOUR), NOW)).toBe(true);
    expect(isChronic(lastSuccess(23 * HOUR), NOW)).toBe(false);
  });

  test('never synced: chronic once installed more than 24 hours ago', () => {
    const installed = (ms: number) =>
      overview('org-a', { installation: { createdAt: ago(ms) } });
    expect(isChronic(installed(25 * HOUR), NOW)).toBe(true);
    expect(isChronic(installed(HOUR), NOW)).toBe(false);
    expect(isChronic(overview('org-a', { installation: null }), NOW)).toBe(
      false
    );
  });
});

test('formatDuration', () => {
  expect(formatDuration(45_000)).toBe('45 s');
  expect(formatDuration(3 * MINUTE)).toBe('3 min');
  expect(formatDuration(2.45 * MINUTE)).toBe('2.5 min');
  expect(formatDuration(-5)).toBe('0 s');
  expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('no limit');
});
