import {
  type Actor,
  EngineAuthError,
  EngineInputError,
} from '@better-tracker/engine';
import { describe, expect, test } from 'bun:test';

import { jsonError } from '../lib/origin';
import {
  type ApiActorResolver,
  type MilestoneEditEngine,
  patchMilestone,
  patchProject,
  type ProjectEditEngine,
} from '../lib/timeline-edits';

// The PATCH handlers with a fake actor resolver (requireApiActor's place)
// and a recording engine: validation must answer 400 before any engine
// call, valid bodies reach the engine with the right arguments, and engine
// errors map to their HTTP statuses.

const ACTOR = {
  session: { userId: 'user-ana', workspaceId: 'org-1' },
  isPm: true,
  canWriteLinear: true,
} as unknown as Actor;

type Call = [method: string, ...args: unknown[]];

function recordingEngine(failWith?: Error): {
  engine: MilestoneEditEngine & ProjectEditEngine;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): Promise<void> => {
      calls.push([method, ...args.slice(1)]);
      return failWith === undefined
        ? Promise.resolve()
        : Promise.reject(failWith);
    };
  return {
    calls,
    engine: {
      setMilestoneTargetDate: record('setMilestoneTargetDate'),
      setMilestoneWeight: record('setMilestoneWeight'),
      setMilestoneDoneMeans: record('setMilestoneDoneMeans'),
      setProjectLead: record('setProjectLead'),
    },
  };
}

function resolver<E>(engine: E): ApiActorResolver<E> {
  return () => Promise.resolve({ engine, actor: ACTOR });
}

function patch(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function errorOf(
  response: Response
): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  return body.error;
}

describe('PATCH /api/milestones/[id]', () => {
  test('a malformed date is a 400 before the engine is reached', async () => {
    const { engine, calls } = recordingEngine();
    for (const targetDate of [
      '10/18/2026',
      '2026-02-30',
      '2026-13-01',
      '',
      20261018,
    ]) {
      const response = await patchMilestone(
        patch('/api/milestones/ms-1', { targetDate }),
        'ms-1',
        resolver(engine)
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toStartWith('targetDate:');
    }
    expect(calls).toEqual([]);
  });

  test('other bad bodies are 400s too, and nothing is applied', async () => {
    const { engine, calls } = recordingEngine();
    const bodies: unknown[] = [
      {},
      { weight: 1.5 },
      { weight: 5000 },
      { weight: '2' },
      { doneMeans: 42 },
      { targetDate: '2026-10-30', extra: true },
      'not json',
      [],
    ];
    for (const body of bodies) {
      const response = await patchMilestone(
        patch('/api/milestones/ms-1', body),
        'ms-1',
        resolver(engine)
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('a valid body reaches the engine, date first, and answers ok', async () => {
    const { engine, calls } = recordingEngine();
    const response = await patchMilestone(
      patch('/api/milestones/ms-1', {
        doneMeans: 'Zero drift',
        weight: null,
        targetDate: '2026-10-30',
      }),
      'ms-1',
      resolver(engine)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      ['setMilestoneTargetDate', 'ms-1', '2026-10-30'],
      ['setMilestoneWeight', 'ms-1', null],
      ['setMilestoneDoneMeans', 'ms-1', 'Zero drift'],
    ]);
  });

  test('null clears the date', async () => {
    const { engine, calls } = recordingEngine();
    const response = await patchMilestone(
      patch('/api/milestones/ms-1', { targetDate: null }),
      'ms-1',
      resolver(engine)
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([['setMilestoneTargetDate', 'ms-1', null]]);
  });

  test("the resolver's refusal (CSRF, signed out) is returned untouched", async () => {
    const { engine, calls } = recordingEngine();
    const refused = jsonError(
      403,
      'cross_origin',
      'Cross-origin request refused.'
    );
    const response = await patchMilestone(
      patch('/api/milestones/ms-1', { targetDate: '2026-10-30' }),
      'ms-1',
      () => Promise.resolve(refused)
    );
    expect(response).toBe(refused);
    expect(calls).toEqual([]);
    void engine;
  });

  test('engine errors map to HTTP statuses', async () => {
    const cases: [Error, number, string][] = [
      [
        new EngineAuthError('not_pm', 'Only PMs can change milestones.'),
        403,
        'not_pm',
      ],
      [
        new EngineAuthError('needs_write_scope', 'Allow edits first.'),
        403,
        'needs_write_scope',
      ],
      [
        new EngineInputError('not_found', 'Not in the mirror.'),
        404,
        'not_found',
      ],
      [
        new EngineInputError('invalid', 'Weight must be whole.'),
        400,
        'invalid',
      ],
    ];
    for (const [error, status, code] of cases) {
      const { engine } = recordingEngine(error);
      const response = await patchMilestone(
        patch('/api/milestones/ms-1', { weight: 3 }),
        'ms-1',
        resolver(engine)
      );
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }
  });

  test('a blank id is a 404', async () => {
    const { engine, calls } = recordingEngine();
    const response = await patchMilestone(
      patch('/api/milestones/%20', { weight: 1 }),
      ' ',
      resolver(engine)
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('PATCH /api/projects/[id]', () => {
  test('leadId is required: a string id or null', async () => {
    const { engine, calls } = recordingEngine();
    for (const body of [
      {},
      { leadId: 7 },
      { leadId: '' },
      { leadId: 'u', x: 1 },
    ]) {
      const response = await patchProject(
        patch('/api/projects/proj-1', body),
        'proj-1',
        resolver(engine)
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('sets and clears the lead through the engine', async () => {
    const { engine, calls } = recordingEngine();
    for (const leadId of ['user-chloe', null]) {
      const response = await patchProject(
        patch('/api/projects/proj-1', { leadId }),
        'proj-1',
        resolver(engine)
      );
      expect(response.status).toBe(200);
    }
    expect(calls).toEqual([
      ['setProjectLead', 'proj-1', 'user-chloe'],
      ['setProjectLead', 'proj-1', null],
    ]);
  });

  test('a non-PM is refused by the engine with a 403', async () => {
    const { engine } = recordingEngine(
      new EngineAuthError('not_pm', 'Only PMs can change project leads.')
    );
    const response = await patchProject(
      patch('/api/projects/proj-1', { leadId: null }),
      'proj-1',
      resolver(engine)
    );
    expect(response.status).toBe(403);
  });
});
