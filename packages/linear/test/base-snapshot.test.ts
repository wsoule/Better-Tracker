// The base demo workspace (LINEAR_FIXTURE=1) stays byte-for-byte what it
// was before the showcase (LINEAR_FIXTURE=showcase) moved the fixture's
// generic helpers into fixture-kit.ts: hundreds of tests, the browser
// smoke and other branches pin its exact numbers. The JSON file is the
// output of main's builder (commit 6f5e87f, before any showcase change)
// for 2026-10-21, and the hash is that same builder's output for
// 2026-12-30, so a year boundary is covered too. If this fails, the base
// workspace changed: put it back, and grow the showcase instead.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createFixtureStore,
  FIXTURE_APP_USER_ID,
  FIXTURE_GUEST_USER_ID,
  FIXTURE_INSTALLER_USER_ID,
  FIXTURE_MILESTONE_META,
  FIXTURE_WATCHER_USER_IDS,
  FIXTURE_WORKSPACE,
} from '../src/fixture';

/** Main's 2026-12-30 output, JSON.stringify(…, null, 2) plus a newline. */
const MAIN_2026_12_30_SHA256 =
  '44694cd24daeea44cfa03aaa007a43ab0b65a61cbffa3e0fe90f4dbc325ca990';

// Everything the base fixture hands out for `today`, in the shape the
// snapshot was taken in (the store's `now` clock is a function, which JSON
// drops).
function baseOutput(today: string) {
  const store = createFixtureStore(today);
  return {
    today,
    workspace: FIXTURE_WORKSPACE,
    appUserId: FIXTURE_APP_USER_ID,
    watcherUserIds: FIXTURE_WATCHER_USER_IDS,
    installerUserId: FIXTURE_INSTALLER_USER_ID,
    guestUserId: FIXTURE_GUEST_USER_ID,
    milestoneMeta: FIXTURE_MILESTONE_META,
    store: { ...store, now: undefined },
  };
}

describe('base fixture is unchanged', () => {
  test('deep-equals the snapshot of main for 2026-10-21', () => {
    const expected: unknown = JSON.parse(
      readFileSync(
        join(import.meta.dir, 'fixtures', 'base-workspace-2026-10-21.json'),
        'utf8'
      )
    );
    expect(JSON.parse(JSON.stringify(baseOutput('2026-10-21')))).toEqual(
      expected
    );
  });

  test('hashes like main for 2026-12-30', () => {
    const text = `${JSON.stringify(baseOutput('2026-12-30'), null, 2)}\n`;
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      MAIN_2026_12_30_SHA256
    );
  });
});
