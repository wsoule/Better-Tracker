import { createEngineFromEnv, type Engine } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// The real route files end to end against the demo engine (fictional
// in-memory workspace): requireApiActor's CSRF guard and session lookup,
// zod validation and the engine itself. next/headers' cookies() only works
// inside a Next request, so it is replaced with a jar holding whichever
// session the test signs in as.
//
// Owner decision 2026-10-22: there is no PM role. Chloe, who was never a
// PM, does every formerly PM-only action here; nobody is refused with
// not_pm, and every change is audited under her name.

let sessionToken: string | null = null;
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'mp_session' && sessionToken !== null
          ? { name, value: sessionToken }
          : undefined,
    }),
  // Every next/headers mock defines both exports: Bun keeps one module
  // namespace per specifier across test files, so a mock missing one leaves
  // a later file's `import { headers }` unlinkable (next-headers-mocks test).
  headers: () => Promise.resolve(new Headers()),
}));

const { POST: runsPost } = await import('../app/api/runs/route');
const { POST: syncPost } = await import('../app/api/sync/route');
const { POST: previewPost } = await import('../app/api/warnings/preview/route');
const { PATCH: settingsPatch } = await import('../app/api/settings/route');
const { PATCH: milestonePatch } =
  await import('../app/api/milestones/[id]/route');
const { PATCH: projectPatch } = await import('../app/api/projects/[id]/route');
const { GET: issueGet, PATCH: issuePatch } =
  await import('../app/api/issues/[id]/route');
const { POST: commentPost } =
  await import('../app/api/issues/[id]/comments/route');
const { POST: blockerPost } =
  await import('../app/api/issues/[id]/blockers/route');
const { DELETE: relationDelete } =
  await import('../app/api/relations/[id]/route');

const APP = 'http://localhost:3000';
const WORKSPACE = 'org-northwind';

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
let engine: Engine;
let memberToken: string;
/** Gus Hart, the demo's Linear guest (Operations only, read-only). */
let guestToken: string;

beforeAll(async () => {
  engine = await createEngineFromEnv(
    { LINEAR_FIXTURE: '1', APP_URL: APP },
    { logger: createLogger({ name: 'test', level: 'error' }) }
  );
  holder.__milestonePlannerEngine = Promise.resolve(engine);
  memberToken = (await engine.devSignIn('user-chloe')).sessionToken;
  guestToken = (await engine.devSignIn('user-gus')).sessionToken;
});

afterAll(async () => {
  holder.__milestonePlannerEngine = savedEngine;
  sessionToken = null;
  await engine.close();
});

function request(
  method: string,
  body: unknown,
  origin: string | null = APP
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (origin !== null) headers.origin = origin;
  return new Request(`${APP}/api/x`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

async function code(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error?: { code?: unknown } };
  return body.error?.code;
}

/** Route params as Next passes them to a dynamic segment's handler. */
function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('workspace routes on the demo engine', () => {
  test('cross-origin and signed-out requests are refused first', async () => {
    sessionToken = memberToken;
    const cross = await syncPost(request('POST', {}, 'https://evil.example'));
    expect(cross.status).toBe(403);
    expect(await code(cross)).toBe('cross_origin');
    const crossSettings = await settingsPatch(
      request('PATCH', { watcherUserIds: [] }, 'https://evil.example')
    );
    expect(crossSettings.status).toBe(403);
    sessionToken = null;
    expect((await syncPost(request('POST', {}))).status).toBe(401);
    expect((await runsPost(request('POST', { mode: 'dry_run' }))).status).toBe(
      401
    );
  });

  test('a member resyncs, previews digests and saves a setting', async () => {
    sessionToken = memberToken;
    const sync = await syncPost(request('POST', {}));
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as { sync: { ok: boolean } }).sync.ok).toBe(
      true
    );

    const preview = await previewPost(request('POST', {}));
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as {
      preview: { digests: unknown[] };
    };
    expect(body.preview.digests.length).toBeGreaterThan(0);
    // previewOnly records nothing.
    expect(await engine.listNotifications(WORKSPACE, 10)).toEqual([]);

    const saved = await settingsPatch(
      request('PATCH', { tuning: { stallDays: 9 } })
    );
    expect(saved.status).toBe(200);
    const loaded = await engine.load(WORKSPACE);
    expect(loaded.settings.tuning.stallDays).toBe(9);
    expect(loaded.settings.tuning.warnLeadDays).toBe(7);

    const retired = await settingsPatch(request('PATCH', { pmUserIds: [] }));
    expect(retired.status).toBe(400);
  });

  test('a member may empty the watcher list and set it again', async () => {
    sessionToken = memberToken;
    const emptied = await settingsPatch(
      request('PATCH', { watcherUserIds: [] })
    );
    expect(emptied.status).toBe(200);
    expect((await engine.getSettings(WORKSPACE)).watcherUserIds).toEqual([]);
    const set = await settingsPatch(
      request('PATCH', { watcherUserIds: ['user-chloe'] })
    );
    expect(set.status).toBe(200);
    expect((await engine.getSettings(WORKSPACE)).watcherUserIds).toEqual([
      'user-chloe',
    ]);
  });

  test('a dry run is logged; live waits for the mode, which a member switches', async () => {
    sessionToken = memberToken;
    const bad = await runsPost(request('POST', { mode: 'fast' }));
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe('invalid');

    const dry = await runsPost(request('POST', { mode: 'dry_run' }));
    expect(dry.status).toBe(201);
    const { run } = (await dry.json()) as { run: { id: string; mode: string } };
    expect(run.mode).toBe('dry_run');
    const logged = await engine.getRun(WORKSPACE, run.id);
    expect(logged?.entries.length).toBeGreaterThan(0);
    expect(logged?.run.startedByUserId).toBe('user-chloe');

    const off = await runsPost(request('POST', { mode: 'live' }));
    expect(off.status).toBe(409);
    expect(await code(off)).toBe('live_runs_off');

    const switched = await settingsPatch(
      request('PATCH', { allocationMode: 'live' })
    );
    expect(switched.status).toBe(200);
    const live = await runsPost(request('POST', { mode: 'live' }));
    expect(live.status).toBe(201);
    const liveRun = ((await live.json()) as { run: { mode: string } }).run;
    expect(liveRun.mode).toBe('live');

    // The switch is audited under the member who made it.
    const audit = await engine.listAudit(WORKSPACE, 50);
    expect(
      audit.some(
        (entry) =>
          entry.action === 'settings.update' &&
          entry.actorUserId === 'user-chloe' &&
          JSON.stringify(entry.after).includes('"live"')
      )
    ).toBe(true);
  });

  test('a member re-dates a milestone, weights it, says "done means…" and sets a lead', async () => {
    sessionToken = memberToken;
    const timeline = await engine.getTimelineView(WORKSPACE);
    const lane = timeline.groups
      .flatMap((group) => group.lanes)
      .find((l) => l.bars.some((bar) => bar.status !== 'complete'));
    const bar = lane?.bars.find((b) => b.status !== 'complete');
    if (lane === undefined || bar === undefined) {
      throw new Error('the demo timeline has no open milestone');
    }
    const id = bar.milestoneId;
    const edited = await milestonePatch(
      request('PATCH', {
        targetDate: '2026-12-01',
        weight: 2,
        doneMeans: 'Every account reads from the new store.',
      }),
      params(id)
    );
    expect(edited.status).toBe(200);
    const detail = await engine.getMilestoneDetail(WORKSPACE, id);
    expect(detail.milestone.targetDate).toBe('2026-12-01');
    expect(detail.meta?.weight).toBe(2);

    // A lead other than the current one, so the change is a real write.
    const newLead = lane.leadId === 'user-chloe' ? 'user-ben' : 'user-chloe';
    const lead = await projectPatch(
      request('PATCH', { leadId: newLead }),
      params(lane.projectId)
    );
    expect(lead.status).toBe(200);
    const after = await engine.getTimelineView(WORKSPACE);
    expect(
      after.groups
        .flatMap((group) => group.lanes)
        .find((l) => l.projectId === lane.projectId)?.leadId
    ).toBe(newLead);

    const audit = await engine.listAudit(WORKSPACE, 50);
    const mine = new Set(
      audit
        .filter((entry) => entry.actorUserId === 'user-chloe')
        .map((entry) => entry.action)
    );
    for (const action of [
      'milestone.target_date',
      'milestone.weight',
      'milestone.done_means',
      'project.lead',
    ] as const) {
      expect([...mine]).toContain(action);
    }
  });
});

// Owner decision 2026-10-22, "Guests limited to read only": through the
// real route files (CSRF guard, session lookup, the read-only check, zod,
// the engine), every mutating route answers the demo's Linear guest 403
// read_only and changes nothing, while his reads still work.
describe('a Linear guest on the demo engine', () => {
  test('every mutating route is 403 read_only and nothing changes', async () => {
    sessionToken = guestToken;
    const settingsBefore = await engine.getSettings(WORKSPACE);
    const auditBefore = await engine.listAudit(WORKSPACE, 100);
    const runsBefore = await engine.listRuns(WORKSPACE, 100);
    const issueBefore = (await engine.load(WORKSPACE)).snapshot.issues.get(
      'iss-ops-1'
    );
    const responses: [string, Response][] = [
      ['runs dry', await runsPost(request('POST', { mode: 'dry_run' }))],
      ['runs live', await runsPost(request('POST', { mode: 'live' }))],
      ['sync', await syncPost(request('POST', {}))],
      ['preview', await previewPost(request('POST', {}))],
      [
        'settings',
        await settingsPatch(request('PATCH', { allocationMode: 'dry_run' })),
      ],
      [
        'milestone',
        await milestonePatch(
          request('PATCH', { targetDate: '2026-12-01', weight: 3 }),
          params('ms-delta-1')
        ),
      ],
      [
        'project',
        await projectPatch(
          request('PATCH', { leadId: 'user-femi' }),
          params('proj-delta')
        ),
      ],
      [
        'issue',
        await issuePatch(
          request('PATCH', { priority: 1 }),
          params('iss-ops-1')
        ),
      ],
      [
        'comment',
        await commentPost(
          request('POST', { body: 'Hello' }),
          params('iss-ops-1')
        ),
      ],
      [
        'blocker',
        await blockerPost(
          request('POST', { blockerIssueId: 'iss-ops-6' }),
          params('iss-ops-5')
        ),
      ],
      [
        'relation',
        await relationDelete(
          new Request(`${APP}/api/relations/rel-atlas`, {
            method: 'DELETE',
            headers: { origin: APP },
          }),
          params('rel-atlas')
        ),
      ],
    ];
    for (const [name, response] of responses) {
      expect([name, response.status]).toEqual([name, 403]);
      expect([name, await code(response)]).toEqual([name, 'read_only']);
    }
    expect(await engine.getSettings(WORKSPACE)).toEqual(settingsBefore);
    expect(await engine.listAudit(WORKSPACE, 100)).toEqual(auditBefore);
    expect(await engine.listRuns(WORKSPACE, 100)).toEqual(runsBefore);
    expect(
      (await engine.load(WORKSPACE)).snapshot.issues.get('iss-ops-1')
    ).toEqual(issueBefore);
  });

  test('the CSRF guard and the session still come first', async () => {
    sessionToken = guestToken;
    const cross = await runsPost(
      request('POST', { mode: 'dry_run' }, 'https://evil.example')
    );
    expect(await code(cross)).toBe('cross_origin');
    sessionToken = null;
    expect((await runsPost(request('POST', { mode: 'dry_run' }))).status).toBe(
      401
    );
  });

  test('he reads an issue of his team, read-only', async () => {
    sessionToken = guestToken;
    const read = await issueGet(
      new Request(`${APP}/api/issues/OPS-1`),
      params('OPS-1')
    );
    expect(read.status).toBe(200);
    const { result } = (await read.json()) as {
      result: { canEdit: boolean; readOnly: boolean };
    };
    expect(result).toMatchObject({ canEdit: false, readOnly: true });
    // An Engineering issue is not his to see.
    const hidden = await issueGet(
      new Request(`${APP}/api/issues/ENG-24`),
      params('ENG-24')
    );
    expect(hidden.status).toBe(404);
  });
});
