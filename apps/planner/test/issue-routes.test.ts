import { indexWorkspace } from '@better-tracker/core';
import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  LinearApiError,
} from '@better-tracker/engine';
import { createFixtureWorkspace } from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';

import {
  type BlockerEngine,
  type CommentEngine,
  deleteRelation,
  getIssue,
  type IssuePatchEngine,
  type IssueReadEngine,
  patchIssue,
  postBlocker,
  postComment,
  type RelationEngine,
  searchIssues,
} from '../lib/issue-routes';
import { jsonError, rejectCrossOrigin } from '../lib/origin';
import type { ApiActorResolver } from '../lib/timeline-edits';

// The issue routes' handlers with a fake actor resolver (requireApiActor's
// place) and a recording engine: malformed input answers 400 before any
// engine call, a person without Linear write scope gets 403 with the
// grant_write link (there are no roles), cross-origin writes are refused,
// valid bodies reach the engine as typed, and engine errors map to their
// HTTP statuses (linear_forbidden 403, rate_limited 429).

const APP = 'http://localhost';
const snapshot = indexWorkspace(createFixtureWorkspace('2026-10-21'));

function actor(over: Partial<Actor> = {}): Actor {
  return {
    session: { userId: 'user-chloe', workspaceId: 'org-1' },
    canWriteLinear: true,
    ...over,
  } as unknown as Actor;
}

type Call = [method: string, ...args: unknown[]];

type FakeEngine = IssueReadEngine &
  IssuePatchEngine &
  CommentEngine &
  BlockerEngine &
  RelationEngine;

function recordingEngine(failWith?: Error): {
  engine: FakeEngine;
  calls: Call[];
} {
  const calls: Call[] = [];
  const answer =
    (method: string, value: unknown) =>
    (...args: unknown[]): Promise<unknown> => {
      calls.push([method, ...args.slice(1)]);
      return failWith === undefined
        ? Promise.resolve(value)
        : Promise.reject(failWith);
    };
  return {
    calls,
    engine: {
      load: () => Promise.resolve({ snapshot }),
      getIssueDetail: answer('getIssueDetail', { detail: { ok: true } }),
      updateIssue: answer('updateIssue', {
        issue: { id: 'iss-eng-24' },
        changed: ['title'],
      }),
      addComment: answer('addComment', { id: 'c-1', body: 'Hi' }),
      addBlocker: answer('addBlocker', {
        id: 'rel-1',
        blockerId: 'iss-eng-12',
        blockedId: 'iss-eng-24',
      }),
      removeRelation: answer('removeRelation', undefined),
    } as unknown as FakeEngine,
  };
}

/** requireApiActor's behaviour: the CSRF guard on writes, then the actor. */
function resolver<E>(engine: E, who: Actor = actor()): ApiActorResolver<E> {
  return (request) => {
    if (request.method !== 'GET') {
      const refused = rejectCrossOrigin(request, APP);
      if (refused !== null) return Promise.resolve(refused);
    }
    return Promise.resolve({ engine, actor: who });
  };
}

function send(
  method: string,
  url: string,
  body?: unknown,
  origin: string = APP
): Request {
  return new Request(`${APP}${url}`, {
    method,
    headers: { 'content-type': 'application/json', origin },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
}

async function errorOf(
  response: Response
): Promise<{ code: string; message: string; grantWriteHref?: string }> {
  const body = (await response.json()) as {
    error: { code: string; message: string; grantWriteHref?: string };
  };
  return body.error;
}

describe('PATCH /api/issues/[id]', () => {
  test('malformed bodies are 400s before the engine is reached', async () => {
    const { engine, calls } = recordingEngine();
    const bodies: unknown[] = [
      {},
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(2000) },
      { priority: 5 },
      { priority: 1.5 },
      { priority: '1' },
      { dueDate: '2026-13-01' },
      { dueDate: '10/30/2026' },
      { estimate: -1 },
      { estimate: 2.5 },
      { labelIds: 'l-1' },
      { labelIds: [''] },
      { stateId: '' },
      { assigneeId: 42 },
      { description: 'x'.repeat(100_001) },
      { title: 'Fine', extra: true },
      'not json',
      [],
    ];
    for (const body of bodies) {
      const response = await patchIssue(
        send('PATCH', '/api/issues/iss-eng-24', body),
        'iss-eng-24',
        resolver(engine)
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('a valid patch reaches the engine with only the sent fields', async () => {
    const { engine, calls } = recordingEngine();
    const response = await patchIssue(
      send('PATCH', '/api/issues/iss-eng-24', {
        title: 'Search analytics v2',
        assigneeId: null,
        priority: 1,
        dueDate: null,
        estimate: 5,
        labelIds: ['l-bug'],
        projectMilestoneId: 'ms-beacon-2',
      }),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { issue: { id: 'iss-eng-24' }, changed: ['title'] },
    });
    expect(calls).toEqual([
      [
        'updateIssue',
        'iss-eng-24',
        {
          title: 'Search analytics v2',
          assigneeId: null,
          priority: 1,
          projectMilestoneId: 'ms-beacon-2',
          dueDate: null,
          estimate: 5,
          labelIds: ['l-bug'],
        },
      ],
    ]);
  });

  test('anyone with write scope may edit; there is no role check', async () => {
    for (const userId of ['user-chloe', 'user-ana']) {
      const { engine, calls } = recordingEngine();
      const response = await patchIssue(
        send('PATCH', '/api/issues/iss-eng-24', { priority: 2 }),
        'iss-eng-24',
        resolver(
          engine,
          actor({
            session: { userId, workspaceId: 'org-1' } as Actor['session'],
          })
        )
      );
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    }
  });

  test('no write scope: 403 with the grant_write link, engine untouched', async () => {
    const { engine, calls } = recordingEngine();
    const response = await patchIssue(
      send('PATCH', '/api/issues/iss-eng-24', { priority: 2 }),
      'iss-eng-24',
      resolver(engine, actor({ canWriteLinear: false }))
    );
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe('needs_write_scope');
    expect(error.grantWriteHref).toBe(
      '/api/auth/linear?intent=grant_write&returnTo=%2Fissues%2Fiss-eng-24'
    );
    expect(calls).toEqual([]);
    // A malformed body is still a 400 first.
    const bad = await patchIssue(
      send('PATCH', '/api/issues/iss-eng-24', { priority: 9 }),
      'iss-eng-24',
      resolver(engine, actor({ canWriteLinear: false }))
    );
    expect(bad.status).toBe(400);
  });

  test('a cross-origin write is refused before anything else', async () => {
    const { engine, calls } = recordingEngine();
    const response = await patchIssue(
      send(
        'PATCH',
        '/api/issues/iss-eng-24',
        { priority: 2 },
        'https://evil.example'
      ),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('cross_origin');
    expect(calls).toEqual([]);
  });

  test("the resolver's refusal (signed out) is returned untouched", async () => {
    const refused = jsonError(401, 'not_signed_in', 'Sign in first.');
    const response = await patchIssue(
      send('PATCH', '/api/issues/iss-eng-24', { priority: 2 }),
      'iss-eng-24',
      () => Promise.resolve(refused)
    );
    expect(response).toBe(refused);
  });

  test('engine and Linear errors map to HTTP statuses', async () => {
    const cases: [Error, number, string][] = [
      [
        new EngineAuthError('linear_forbidden', 'Linear said no.'),
        403,
        'linear_forbidden',
      ],
      [
        new EngineAuthError('not_signed_in', 'Sign in again.'),
        401,
        'not_signed_in',
      ],
      [
        new EngineInputError('not_found', 'Not in the mirror.'),
        404,
        'not_found',
      ],
      [new EngineInputError('invalid', 'Off the scale.'), 400, 'invalid'],
      [new EngineInputError('conflict', 'Already linked.'), 409, 'conflict'],
      [new EngineInputError('rate_limited', 'Slow down.'), 429, 'rate_limited'],
      [
        new LinearApiError('network', 'Linear did not answer.'),
        502,
        'linear_network',
      ],
    ];
    for (const [error, status, code] of cases) {
      const { engine } = recordingEngine(error);
      const response = await patchIssue(
        send('PATCH', '/api/issues/iss-eng-24', { priority: 2 }),
        'iss-eng-24',
        resolver(engine)
      );
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }
  });

  test('rate_limited carries Retry-After when Linear said when', async () => {
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    const { engine } = recordingEngine(
      new EngineInputError('rate_limited', 'Slow down.', { retryAt })
    );
    const response = await patchIssue(
      send('PATCH', '/api/issues/iss-eng-24', { priority: 2 }),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(429);
    const seconds = Number(response.headers.get('retry-after'));
    expect(seconds).toBeGreaterThanOrEqual(29);
    expect(seconds).toBeLessThanOrEqual(31);
    expect(
      ((await response.json()) as { error: { retryAt: string } }).error
    ).toMatchObject({ retryAt });
  });

  test("the engine's own needs_write_scope also carries the link", async () => {
    const { engine } = recordingEngine(
      new EngineAuthError('needs_write_scope', 'Allow edits first.')
    );
    const response = await patchIssue(
      send('PATCH', '/api/issues/iss-eng-24', { priority: 2 }),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).grantWriteHref).toContain(
      'returnTo=%2Fissues%2Fiss-eng-24'
    );
  });
});

describe('POST /api/issues/[id]/comments', () => {
  test('bad bodies are 400s; nothing is posted', async () => {
    const { engine, calls } = recordingEngine();
    for (const body of [
      {},
      { body: '' },
      { body: '  \n ' },
      { body: 42 },
      { body: 'x'.repeat(20_001) },
      { body: 'Hi', html: '<b>' },
      'nope',
    ]) {
      const response = await postComment(
        send('POST', '/api/issues/iss-eng-24/comments', body),
        'iss-eng-24',
        resolver(engine)
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('a comment is posted as typed: 201 { comment }', async () => {
    const { engine, calls } = recordingEngine();
    const response = await postComment(
      send('POST', '/api/issues/iss-eng-24/comments', {
        body: 'Looks good.\n\n**Shipping** Friday.',
      }),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      comment: { id: 'c-1', body: 'Hi' },
    });
    expect(calls).toEqual([
      ['addComment', 'iss-eng-24', 'Looks good.\n\n**Shipping** Friday.'],
    ]);
  });

  test('no write scope: 403 with the grant link', async () => {
    const { engine, calls } = recordingEngine();
    const response = await postComment(
      send('POST', '/api/issues/iss-eng-24/comments', { body: 'Hi' }),
      'iss-eng-24',
      resolver(engine, actor({ canWriteLinear: false }))
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('needs_write_scope');
    expect(calls).toEqual([]);
  });
});

describe('POST /api/issues/[id]/blockers and DELETE /api/relations/[id]', () => {
  test('a blocker needs exactly { blockerIssueId }', async () => {
    const { engine, calls } = recordingEngine();
    for (const body of [
      {},
      { blockerIssueId: '' },
      { blockerIssueId: 7 },
      { blockerIssueId: 'iss-eng-12', type: 'related' },
    ]) {
      const response = await postBlocker(
        send('POST', '/api/issues/iss-eng-24/blockers', body),
        'iss-eng-24',
        resolver(engine)
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('blocker added: 201 { relation }, the blocker blocks [id]', async () => {
    const { engine, calls } = recordingEngine();
    const response = await postBlocker(
      send('POST', '/api/issues/iss-eng-24/blockers', {
        blockerIssueId: 'iss-eng-12',
      }),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      relation: {
        id: 'rel-1',
        blockerId: 'iss-eng-12',
        blockedId: 'iss-eng-24',
      },
    });
    expect(calls).toEqual([['addBlocker', 'iss-eng-24', 'iss-eng-12']]);
  });

  test('an existing pair is a 409 from the engine', async () => {
    const { engine } = recordingEngine(
      new EngineInputError('conflict', 'These issues already have it.')
    );
    const response = await postBlocker(
      send('POST', '/api/issues/iss-eng-24/blockers', {
        blockerIssueId: 'iss-eng-12',
      }),
      'iss-eng-24',
      resolver(engine)
    );
    expect(response.status).toBe(409);
  });

  test('a relation is removed: 204, no body read', async () => {
    const { engine, calls } = recordingEngine();
    const response = await deleteRelation(
      send('DELETE', '/api/relations/rel-1'),
      'rel-1',
      resolver(engine)
    );
    expect(response.status).toBe(204);
    expect(calls).toEqual([['removeRelation', 'rel-1']]);
  });

  test('removing needs write scope and the same origin', async () => {
    const { engine, calls } = recordingEngine();
    const noScope = await deleteRelation(
      send('DELETE', '/api/relations/rel-1'),
      'rel-1',
      resolver(engine, actor({ canWriteLinear: false }))
    );
    expect(noScope.status).toBe(403);
    expect((await errorOf(noScope)).code).toBe('needs_write_scope');
    const foreign = await deleteRelation(
      send('DELETE', '/api/relations/rel-1', undefined, 'https://evil.example'),
      'rel-1',
      resolver(engine)
    );
    expect(foreign.status).toBe(403);
    expect((await errorOf(foreign)).code).toBe('cross_origin');
    const blank = await deleteRelation(
      send('DELETE', '/api/relations/%20'),
      ' ',
      resolver(engine)
    );
    expect(blank.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/issues/[id] and /api/issues/search', () => {
  test('an issue is read by identifier or id, privately', async () => {
    const { engine, calls } = recordingEngine();
    for (const key of ['ENG-24', 'eng-24', 'iss-eng-24']) {
      const response = await getIssue(
        send('GET', `/api/issues/${key}`),
        key,
        resolver(engine)
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        result: { detail: { ok: true } },
      });
    }
    expect(calls).toEqual([
      ['getIssueDetail', 'iss-eng-24'],
      ['getIssueDetail', 'iss-eng-24'],
      ['getIssueDetail', 'iss-eng-24'],
    ]);
  });

  test('an unknown issue is a 404 without a live read', async () => {
    const { engine, calls } = recordingEngine();
    const response = await getIssue(
      send('GET', '/api/issues/ENG-999'),
      'ENG-999',
      resolver(engine)
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('the issue read and the search load the mirror as the person sees it', async () => {
    // Architecture §2.13: the engine narrows the mirror to the viewer's
    // teams only when it is told who the viewer is.
    const viewers: unknown[] = [];
    const { engine } = recordingEngine();
    engine.load = (_workspaceId, viewer) => {
      viewers.push(viewer);
      return Promise.resolve({ snapshot });
    };
    const who = actor();
    await getIssue(
      send('GET', '/api/issues/ENG-24'),
      'ENG-24',
      resolver(engine, who)
    );
    await searchIssues(
      send('GET', '/api/issues/search?q=analytics'),
      resolver(engine, who)
    );
    expect(viewers).toEqual([who, who]);
  });

  test('search answers mirror hits, private and bounded', async () => {
    const { engine } = recordingEngine();
    const response = await searchIssues(
      send('GET', '/api/issues/search?q=analytics&near=iss-eng-23'),
      resolver(engine)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as {
      results: { key: string }[];
    };
    expect(body.results.map((hit) => hit.key)).toContain('ENG-24');
    const all = await searchIssues(
      send('GET', '/api/issues/search?q='),
      resolver(engine)
    );
    expect(
      ((await all.json()) as { results: unknown[] }).results.length
    ).toBeLessThanOrEqual(20);
    const long = await searchIssues(
      send('GET', `/api/issues/search?q=${'x'.repeat(201)}`),
      resolver(engine)
    );
    expect(long.status).toBe(400);
  });
});
