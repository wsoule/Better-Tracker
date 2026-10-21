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
import {
  patchSettings,
  previewWarnings,
  resync,
  startRun,
} from '../lib/pm-routes';
import type { ApiActorResolver } from '../lib/timeline-edits';

// The PM routes' handlers against a stubbed engine and a fake actor
// resolver (the real one is requireApiActor: CSRF guard + session). Each
// test checks the status and body the client islands rely on, and that a
// refused request never reaches the engine.

function actor(isPm: boolean): Actor {
  return {
    session: {
      id: 'sess-1',
      workspaceId: 'org-1',
      userId: isPm ? 'u-ana' : 'u-chloe',
      userName: isPm ? 'Ana Moreno' : 'Chloe Diaz',
      tokens: {
        accessToken: '',
        refreshToken: null,
        expiresAt: null,
        scopes: ['read', 'write'],
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
    },
    isPm,
    canWriteLinear: true,
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
  previews: { workspaceId: string; previewOnly?: boolean }[];
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

/** A resolver as requireApiActor would answer for this actor. */
function as(isPm: boolean): ApiActorResolver<Stub> {
  return () => Promise.resolve({ engine: engine(), actor: actor(isPm) });
}

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
      await startRun(json('POST', { mode: 'fast' }), as(true))
    );
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid');
    expect(calls.runs).toEqual([]);
  });

  test('malformed JSON and extra keys are 400s', async () => {
    expect((await startRun(json('POST', '{nope'), as(true))).status).toBe(400);
    expect(
      (await startRun(json('POST', { mode: 'dry_run', force: true }), as(true)))
        .status
    ).toBe(400);
  });

  test('non-PMs get 403 not_pm', async () => {
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'dry_run' }), as(false))
    );
    expect(status).toBe(403);
    expect(errorCode(body)).toBe('not_pm');
    expect(calls.runs).toEqual([]);
  });

  test('a dry run as a PM is 201 { run }, manual trigger', async () => {
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'dry_run' }), as(true))
    );
    expect(status).toBe(201);
    expect((body.run as { id: string }).id).toBe('run-9');
    expect(calls.runs).toEqual([{ mode: 'dry_run', trigger: 'manual' }]);
  });

  test('a live run is refused while allocation is in dry run', async () => {
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'live' }), as(true))
    );
    expect(status).toBe(409);
    expect(errorCode(body)).toBe('live_runs_off');
    expect(calls.runs).toEqual([]);
    allocationMode = 'live';
    expect(
      (await startRun(json('POST', { mode: 'live' }), as(true))).status
    ).toBe(201);
    expect(calls.runs).toEqual([{ mode: 'live', trigger: 'manual' }]);
  });

  test('engine errors map: a run in progress is 409', async () => {
    failWith = new EngineInputError(
      'conflict',
      'An allocation run is already in progress.'
    );
    const { status, body } = await read(
      await startRun(json('POST', { mode: 'dry_run' }), as(true))
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
  test('non-PMs get 403 and nothing syncs', async () => {
    const { status, body } = await read(
      await resync(json('POST', {}), as(false))
    );
    expect(status).toBe(403);
    expect(errorCode(body)).toBe('not_pm');
    expect(calls.syncs).toEqual([]);
  });

  test('a PM resyncs their own workspace: 200 { sync }', async () => {
    const { status, body } = await read(
      await resync(json('POST', {}), as(true))
    );
    expect(status).toBe(200);
    expect((body.sync as { ok: boolean }).ok).toBe(true);
    expect(calls.syncs).toEqual(['org-1']);
  });

  test('options are refused; a lost installation is 403', async () => {
    expect((await resync(json('POST', { full: 1 }), as(true))).status).toBe(
      400
    );
    failWith = new EngineAuthError('not_installed', 'Install the app first.');
    expect((await resync(json('POST', {}), as(true))).status).toBe(403);
  });
});

describe('POST /api/warnings/preview', () => {
  test('non-PMs get 403', async () => {
    expect((await previewWarnings(json('POST', {}), as(false))).status).toBe(
      403
    );
    expect(calls.previews).toEqual([]);
  });

  test('a PM gets the digests mapped for inline display, nothing recorded', async () => {
    const { status, body } = await read(
      await previewWarnings(json('POST', {}), as(true))
    );
    expect(status).toBe(200);
    expect(calls.previews).toEqual([
      { workspaceId: 'org-1', previewOnly: true },
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
  test('non-PMs get 403 and nothing is saved', async () => {
    const { status, body } = await read(
      await patchSettings(json('PATCH', { timezone: 'UTC' }), as(false))
    );
    expect(status).toBe(403);
    expect(errorCode(body)).toBe('not_pm');
    expect(calls.patches).toEqual([]);
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
    [{ pmUserIds: 'u-ana' }, 'people that are not a list'],
  ])('%j (%s) is a 400 before the engine', async (patch) => {
    const response = await patchSettings(json('PATCH', patch), as(true));
    expect(response.status).toBe(400);
    expect(calls.patches).toEqual([]);
  });

  test('only the sent fields reach the engine, tuning stays partial', async () => {
    const { status, body } = await read(
      await patchSettings(
        json('PATCH', { timezone: ' Europe/Oslo ', tuning: { stallDays: 9 } }),
        as(true)
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

  test('the engine’s own refusals (lockout, bad zone) are 400s', async () => {
    failWith = new EngineInputError(
      'invalid',
      'At least one active PM must remain, or nobody could change settings.'
    );
    const { status, body } = await read(
      await patchSettings(json('PATCH', { pmUserIds: [] }), as(true))
    );
    expect(status).toBe(400);
    expect((body.error as { message: string }).message).toContain(
      'At least one active PM'
    );
  });
});
