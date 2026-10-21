import { createEngineFromEnv, type Engine } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// The real route files end to end against the demo engine (fictional
// in-memory workspace): requireApiActor's CSRF guard and session lookup,
// zod validation, the PM checks and the engine itself. next/headers'
// cookies() only works inside a Next request, so it is replaced with a
// jar holding whichever session the test signs in as.

let sessionToken: string | null = null;
void mock.module('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'mp_session' && sessionToken !== null
          ? { name, value: sessionToken }
          : undefined,
    }),
}));

const { POST: runsPost } = await import('../app/api/runs/route');
const { POST: syncPost } = await import('../app/api/sync/route');
const { POST: previewPost } = await import('../app/api/warnings/preview/route');
const { PATCH: settingsPatch } = await import('../app/api/settings/route');

const APP = 'http://localhost:3000';

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
let engine: Engine;
let pmToken: string;
let memberToken: string;

beforeAll(async () => {
  engine = await createEngineFromEnv(
    { LINEAR_FIXTURE: '1', APP_URL: APP },
    { logger: createLogger({ name: 'test', level: 'error' }) }
  );
  holder.__milestonePlannerEngine = Promise.resolve(engine);
  pmToken = (await engine.devSignIn('user-ana')).sessionToken;
  memberToken = (await engine.devSignIn('user-chloe')).sessionToken;
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

describe('PM routes on the demo engine', () => {
  test('a member cannot resync, preview, run or change settings (403)', async () => {
    sessionToken = memberToken;
    for (const response of [
      await syncPost(request('POST', {})),
      await previewPost(request('POST', {})),
      await runsPost(request('POST', { mode: 'dry_run' })),
      await settingsPatch(request('PATCH', { warningsMode: 'live' })),
    ]) {
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('not_pm');
    }
    expect(await engine.listRuns('org-northwind', 10)).toEqual([]);
  });

  test('cross-origin and signed-out requests are refused first', async () => {
    sessionToken = pmToken;
    const cross = await syncPost(request('POST', {}, 'https://evil.example'));
    expect(cross.status).toBe(403);
    expect(await code(cross)).toBe('cross_origin');
    sessionToken = null;
    const out = await syncPost(request('POST', {}));
    expect(out.status).toBe(401);
  });

  test('a bad mode is 400; a dry run is logged; live is off', async () => {
    sessionToken = pmToken;
    const bad = await runsPost(request('POST', { mode: 'fast' }));
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe('invalid');

    const dry = await runsPost(request('POST', { mode: 'dry_run' }));
    expect(dry.status).toBe(201);
    const { run } = (await dry.json()) as { run: { id: string; mode: string } };
    expect(run.mode).toBe('dry_run');
    const logged = await engine.getRun('org-northwind', run.id);
    expect(logged?.entries.length).toBeGreaterThan(0);

    const live = await runsPost(request('POST', { mode: 'live' }));
    expect(live.status).toBe(409);
    expect(await code(live)).toBe('live_runs_off');
  });

  test('a PM resyncs, previews digests and saves a setting', async () => {
    sessionToken = pmToken;
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
    expect(await engine.listNotifications('org-northwind', 10)).toEqual([]);

    const saved = await settingsPatch(
      request('PATCH', { tuning: { stallDays: 9 } })
    );
    expect(saved.status).toBe(200);
    const loaded = await engine.load('org-northwind');
    expect(loaded.settings.tuning.stallDays).toBe(9);
    expect(loaded.settings.tuning.warnLeadDays).toBe(7);

    const lockout = await settingsPatch(request('PATCH', { pmUserIds: [] }));
    expect(lockout.status).toBe(400);
  });
});
