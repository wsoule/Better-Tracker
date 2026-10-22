import {
  defaultSettings,
  type Digest,
  type WorkspaceSettings,
} from '@better-tracker/core';
import {
  type Actor,
  type Engine,
  EngineAuthError,
  EngineInputError,
} from '@better-tracker/engine';
import { beforeEach, describe, expect, test } from 'bun:test';

import type { AllocationRun } from '../lib/adapters/runs';
import type { ApiActorResolver } from '../lib/timeline-edits';
import {
  createResyncCooldown,
  patchSettings,
  previewWarnings,
  RESYNC_COOLDOWN_MS,
  resync,
  startRun,
} from '../lib/workspace-routes';

// The workspace routes' handlers (runs, sync, digest preview, settings)
// against a stubbed engine and a fake actor resolver (the real one is
// requireApiActor: CSRF guard + session). Each test checks the status and
// body the client islands rely on, and that a refused request never
// reaches the engine.
//
// Owner decision 2026-10-22: there is no PM role. The actor here is a
// member (Chloe, who was never a PM), and none of these four routes writes
// to Linear with her token, so even a read-only Linear grant may call them.

function actor(canWriteLinear: boolean, readOnly = false): Actor {
  return {
    session: {
      id: 'sess-1',
      workspaceId: 'org-1',
      userId: 'u-chloe',
      userName: 'Chloe Diaz',
      tokens: {
        accessToken: '',
        refreshToken: null,
        expiresAt: null,
        scopes: canWriteLinear ? ['read', 'write'] : ['read'],
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
    },
    canWriteLinear: canWriteLinear && !readOnly,
    readOnly,
  };
}

const RUN: AllocationRun = {
  id: 'run-9',
  workspaceId: 'org-1',
  mode: 'dry_run',
  trigger: 'manual',
  startedByUserId: 'u-ana',
  status: 'succeeded',
  startedAt: '2026-10-21T15:00:00.000Z',
  finishedAt: '2026-10-21T15:00:01.000Z',
  summary: {
    assigned: 0,
    wouldAssign: 2,
    failed: 0,
    blockedProjects: 0,
    skippedIssues: 0,
  },
  error: null,
};

const DIGEST: Digest = {
  recipientId: 'u-ana',
  recipientName: 'Ana Moreno',
  recipientEmail: 'ana@example.com',
  day: '2026-10-21',
  items: [
    {
      notice: {
        kind: 'overdue',
        subjectKind: 'milestone',
        subjectId: 'm1',
        projectId: 'p1',
        milestoneId: 'm1',
        key: 'overdue:2026-10-18',
        targetDate: '2026-10-18',
        daysLeft: -3,
        reasons: ['unassigned_open'],
        gaps: [],
        blockReason: null,
        openIssueIds: ['i1'],
        unassignedIssueIds: ['i1'],
        recipientIds: ['u-ana'],
        occurrence: 1,
      },
      projectName: 'Atlas',
      milestoneName: 'Dual-write',
      leadName: 'Ana Moreno',
      openCount: 1,
      unassignedCount: 1,
      lines: ['1 open issue unassigned'],
      url: 'http://localhost:3000/timeline?milestone=m1',
    },
  ],
};

interface Calls {
  runs: { mode: string; trigger: string }[];
  syncs: string[];
  previews: { workspaceId: string; previewOnly?: boolean; viewer?: unknown }[];
  patches: unknown[];
}

let calls: Calls;
let allocationMode: 'dry_run' | 'live';
let failWith: Error | null;

function engine() {
  return {
    load: (_workspaceId: string) =>
      Promise.resolve({ settings: { allocationMode } }),
    runAllocation: (input: Parameters<Engine['runAllocation']>[0]) => {
      calls.runs.push({ mode: input.mode, trigger: input.trigger });
      if (failWith !== null) return Promise.reject(failWith);
      return Promise.resolve({ ...RUN, mode: input.mode });
    },
    fullSync: (workspaceId: string) => {
      calls.syncs.push(workspaceId);
      if (failWith !== null) return Promise.reject(failWith);
      return Promise.resolve({
        workspaceId,
        ok: true,
        version: 4,
        counts: {},
        durationMs: 12,
        error: null,
      });
    },
    runWarnings: (input: { workspaceId: string; previewOnly?: boolean }) => {
      calls.previews.push(input);
      return Promise.resolve({
        workspaceId: input.workspaceId,
        day: '2026-10-21',
        mode: 'preview' as const,
        notices: 1,
        digests: [DIGEST],
        delivered: 0,
        failed: 0,
        alreadySent: 0,
      });
    },
    updateSettings: (
      _actor: Actor,
      patch: Partial<Omit<WorkspaceSettings, 'workspaceId'>>
    ) => {
      calls.patches.push(patch);
      if (failWith !== null) return Promise.reject(failWith);
      return Promise.resolve({ ...defaultSettings('org-1', 'UTC'), ...patch });
    },
  };
}

type Stub = ReturnType<typeof engine>;

/**
 * A resolver as requireApiActor would answer for a signed-in member; by
 * default with a read-only Linear grant, which these routes never need.
 */
function member(canWriteLinear = false): ApiActorResolver<Stub> {
  return () =>
    Promise.resolve({ engine: engine(), actor: actor(canWriteLinear) });
}

/**
 * A resolver for a Linear guest (owner decision 2026-10-22, "Guests
 * limited to read only"), claiming write scope to show that only readOnly
 * matters.
 */
const guest: ApiActorResolver<Stub> = () =>
  Promise.resolve({
    engine: engine(),
    actor: { ...actor(true, true), canWriteLinear: true },
  });

const signedOut: ApiActorResolver<Stub> = () =>
  Promise.resolve(
    Response.json(
      { error: { code: 'not_signed_in', message: 'Sign in first.' } },
      { status: 401 }
    )
  );

function json(method: string, body: unknown): Request {
  return new Request('http://localhost/api/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(response: Response): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body.error as { code?: unknown } | undefined)?.code;
}

beforeEach(() => {
  calls = { runs: [], syncs: [], previews: [], patches: [] };
  allocationMode = 'dry_run';
  failWith = null;
});

describe('POST /api/runs', () => {
  test('a bad mode is a 400 and never reaches the engine', async () => {
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'fast' }), member())
    );
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid');
    expect(calls.runs).toEqual([]);
  });

  test('malformed JSON and extra keys are 400s', async () => {
    expect((await startRun(json('POST', '{nope'), member())).status).toBe(400);
    expect(
      (await startRun(json('POST', { mode: 'dry_run', force: true }), member()))
        .status
    ).toBe(400);
  });

  test('a member starts a dry run: 201 { run }, manual trigger', async () => {
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'dry_run' }), member())
    );
    expect(status).toBe(201);
    expect((body.run as { id: string }).id).toBe('run-9');
    expect(calls.runs).toEqual([{ mode: 'dry_run', trigger: 'manual' }]);
  });

  test('a live run is refused while allocation is in dry run, never not_pm', async () => {
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'live' }), member())
    );
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('live_runs_off');
    expect((body.error as { message: string }).message).not.toMatch(/\bPM/);
    expect(calls.runs).toEqual([]);
  });

  test('a member starts a live run once allocation is live: 201', async () => {
    allocationMode = 'live';
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'live' }), member())
    );
    expect(status).toBe(201);
    expect((body.run as { mode: string }).mode).toBe('live');
    expect(calls.runs).toEqual([{ mode: 'live', trigger: 'manual' }]);
  });

  test('engine errors map: a run in progress is 409', async () => {
    failWith = new EngineInputError(
      'conflict',
      'An allocation run is already in progress.'
    );
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'dry_run' }), member())
    );
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('conflict');
  });

  test('the resolver’s refusal is passed through', async () => {
    expect(
      (await startRun(json('POST', { mode: 'dry_run' }), signedOut)).status
    ).toBe(401);
  });
});

describe('POST /api/sync', () => {
  test('a member resyncs their own workspace: 200 { sync }', async () => {
    const { status, body } = await read(
      await resync(json('POST', {}), member(), createResyncCooldown())
    );
    expect(status).toBe(200);
    expect((body.sync as { ok: boolean }).ok).toBe(true);
    expect(calls.syncs).toEqual(['org-1']);
  });

  test('options are refused; a lost installation is 403', async () => {
    const cooldown = createResyncCooldown();
    expect(
      (await resync(json('POST', { full: 1 }), member(), cooldown)).status
    ).toBe(400);
    failWith = new EngineAuthError('not_installed', 'Install the app first.');
    expect((await resync(json('POST', {}), member(), cooldown)).status).toBe(
      403
    );
  });

  test('a second resync within a minute is 429 with Retry-After, never reaching the engine', async () => {
    let now = Date.parse('2026-10-22T09:00:00.000Z');
    const cooldown = createResyncCooldown(() => now);
    expect((await resync(json('POST', {}), member(), cooldown)).status).toBe(
      200
    );
    now += 15_000;
    const again = await resync(json('POST', {}), member(), cooldown);
    expect(again.status).toBe(429);
    expect(again.headers.get('Retry-After')).toBe('45');
    expect(errorCode((await read(again)).body)).toBe('resync_cooldown');
    expect(calls.syncs).toEqual(['org-1']);
    // Once the minute is over it syncs again.
    now += RESYNC_COOLDOWN_MS;
    expect((await resync(json('POST', {}), member(), cooldown)).status).toBe(
      200
    );
    expect(calls.syncs).toEqual(['org-1', 'org-1']);
  });
});

describe('POST /api/warnings/preview', () => {
  test('a member gets the digests mapped for inline display, nothing recorded', async () => {
    const { status, body } = await read(
      await previewWarnings(json('POST', {}), member())
    );
    expect(status).toBe(200);
    // The person asking is the viewer: each digest is narrowed to what
    // they may see (architecture §2.13).
    expect(calls.previews).toEqual([
      {
        workspaceId: 'org-1',
        previewOnly: true,
        viewer: actor(false),
      },
    ]);
    const preview = body.preview as {
      heading: string;
      digests: {
        recipient: string;
        items: { href: string; title: string }[];
      }[];
    };
    expect(preview.heading).toBe('Digests for Wednesday, October 21');
    expect(preview.digests[0]?.recipient).toBe('Ana Moreno');
    expect(preview.digests[0]?.items[0]).toMatchObject({
      title: 'Atlas › Dual-write',
      href: '/timeline?milestone=m1',
    });
  });
});

describe('PATCH /api/settings', () => {
  test.each([
    [{ timezone: 'UTC' }, 'the timezone'],
    [{ allocationMode: 'live' }, 'allocation mode (switching it live)'],
    [{ warningsMode: 'live' }, 'warnings mode'],
    [{ watcherUserIds: ['u-ana', 'u-ben'] }, 'the watchers'],
    [{ watcherUserIds: [] }, 'no watchers at all'],
    [{ tuning: { warnLeadDays: 10 } }, 'a tuning value'],
  ])('a member changes %j (%s): 200', async (patch) => {
    const { status } = await read(
      await patchSettings(json('PATCH', patch), member())
    );
    expect(status).toBe(200);
    expect(calls.patches).toEqual([patch]);
  });

  test.each([
    [{}, 'an empty patch'],
    [{ workspaceId: 'org-2' }, 'an unknown key'],
    [{ allocationMode: 'yolo' }, 'an unknown mode'],
    [{ tuning: { stallDays: 0 } }, 'a tuning value out of range'],
    [{ tuning: { stallDays: 1.5 } }, 'a fractional tuning value'],
    [{ tuning: { activeProjectStatuses: [] } }, 'no active statuses'],
    [{ tuning: { bogus: 3 } }, 'an unknown tuning key'],
    [{ tuning: {} }, 'a tuning object with nothing in it'],
    [{ watcherUserIds: 'u-ana' }, 'people that are not a list'],
    [{ pmUserIds: ['u-ana'] }, 'the retired PM list'],
  ])('%j (%s) is a 400 before the engine', async (patch) => {
    const response = await patchSettings(json('PATCH', patch), member());
    expect(response.status).toBe(400);
    expect(calls.patches).toEqual([]);
  });

  test('only the sent fields reach the engine, tuning stays partial', async () => {
    const { status, body } = await read(
      await patchSettings(
        json('PATCH', { timezone: ' Europe/Oslo ', tuning: { stallDays: 9 } }),
        member()
      )
    );
    expect(status).toBe(200);
    expect(calls.patches).toEqual([
      { timezone: 'Europe/Oslo', tuning: { stallDays: 9 } },
    ]);
    expect((body.settings as { timezone: string }).timezone).toBe(
      'Europe/Oslo'
    );
  });

  test('the engine’s own refusals (bad zone) are 400s', async () => {
    failWith = new EngineInputError(
      'invalid',
      'timezone must be an IANA timezone such as Europe/Oslo.'
    );
    const { status, body } = await read(
      await patchSettings(json('PATCH', { timezone: 'Mars/Olympus' }), member())
    );
    expect(status).toBe(400);
    expect((body.error as { message: string }).message).toContain(
      'IANA timezone'
    );
  });
});

// Owner decision 2026-10-22, "Guests limited to read only": every one of
// these routes answers a Linear guest 403 read_only right after the
// session (before the body is read, before the cooldown clock starts) and
// never reaches the engine.
describe('a Linear guest', () => {
  test.each([
    [
      'POST /api/runs (dry run)',
      () => startRun(json('POST', { mode: 'dry_run' }), guest),
    ],
    [
      'POST /api/runs (live)',
      () => startRun(json('POST', { mode: 'live' }), guest),
    ],
    ['POST /api/runs (bad body)', () => startRun(json('POST', '{nope'), guest)],
    [
      'POST /api/sync',
      () => resync(json('POST', {}), guest, createResyncCooldown()),
    ],
    [
      'POST /api/warnings/preview',
      () => previewWarnings(json('POST', {}), guest),
    ],
    [
      'PATCH /api/settings',
      () => patchSettings(json('PATCH', { allocationMode: 'live' }), guest),
    ],
    [
      'PATCH /api/settings (bad body)',
      () => patchSettings(json('PATCH', {}), guest),
    ],
  ])('%s is 403 read_only and reaches nothing', async (_name, call) => {
    allocationMode = 'live';
    const { status, body } = await read(await call());
    expect(status).toBe(403);
    expect(errorCode(body)).toBe('read_only');
    expect((body.error as { message: string }).message).toBe(
      'Guests in Linear can look but not change anything here.'
    );
    expect(calls).toEqual({ runs: [], syncs: [], previews: [], patches: [] });
  });

  test('a refused resync does not start the cooldown clock', async () => {
    const cooldown = createResyncCooldown();
    expect((await resync(json('POST', {}), guest, cooldown)).status).toBe(403);
    expect(cooldown.acceptedAt.size).toBe(0);
    expect((await resync(json('POST', {}), member(), cooldown)).status).toBe(
      200
    );
  });

  test("the engine's own read_only refusal maps to 403 too", async () => {
    failWith = new EngineAuthError(
      'read_only',
      'Guests in Linear can look but not change anything here.'
    );
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'dry_run' }), member())
    );
    expect(status).toBe(403);
    expect(errorCode(body)).toBe('read_only');
  });
});
