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
  bulkUpdateIssues,
  type CommentEngine,
  deleteRelation,
  getIssue,
  getIssueListOptionsRoute,
  type IssueBulkEngine,
  type IssueListOptionsEngine,
  type IssuePatchEngine,
  issuesReturnTo,
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
    readOnly: false,
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

// Owner decision 2026-10-22, "Guests limited to read only": every issue
// write answers a Linear guest 403 read_only right after the session —
// before the body, the id or the write scope is looked at, and with no
// grant_write link (a guest is never offered one) — while the reads stay
// open to them.
describe('a Linear guest', () => {
  const guest = actor({
    session: { userId: 'user-gus', workspaceId: 'org-1' },
    // Claiming write scope changes nothing: readOnly decides.
    canWriteLinear: true,
    readOnly: true,
  } as unknown as Partial<Actor>);

  test.each([
    [
      'PATCH /api/issues/[id]',
      (engine: FakeEngine) =>
        patchIssue(
          send('PATCH', '/api/issues/iss-ops-1', { priority: 2 }),
          'iss-ops-1',
          resolver(engine, guest)
        ),
    ],
    [
      'PATCH /api/issues/[id] (bad body)',
      (engine: FakeEngine) =>
        patchIssue(
          send('PATCH', '/api/issues/iss-ops-1', { priority: 9 }),
          'iss-ops-1',
          resolver(engine, guest)
        ),
    ],
    [
      'POST /api/issues/[id]/comments',
      (engine: FakeEngine) =>
        postComment(
          send('POST', '/api/issues/iss-ops-1/comments', { body: 'Hi' }),
          'iss-ops-1',
          resolver(engine, guest)
        ),
    ],
    [
      'POST /api/issues/[id]/blockers',
      (engine: FakeEngine) =>
        postBlocker(
          send('POST', '/api/issues/iss-ops-5/blockers', {
            blockerIssueId: 'iss-ops-6',
          }),
          'iss-ops-5',
          resolver(engine, guest)
        ),
    ],
    [
      'DELETE /api/relations/[id]',
      (engine: FakeEngine) =>
        deleteRelation(
          send('DELETE', '/api/relations/rel-1'),
          'rel-1',
          resolver(engine, guest)
        ),
    ],
  ])('%s is 403 read_only, engine untouched', async (_name, call) => {
    const { engine, calls } = recordingEngine();
    const response = await call(engine);
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error).toEqual({
      code: 'read_only',
      message: 'Guests in Linear can look but not change anything here.',
    });
    expect(error.grantWriteHref).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a cross-origin write is still refused by the CSRF guard first', async () => {
    const { engine } = recordingEngine();
    const response = await patchIssue(
      send(
        'PATCH',
        '/api/issues/iss-ops-1',
        { priority: 2 },
        'https://evil.example'
      ),
      'iss-ops-1',
      resolver(engine, guest)
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).not.toBe('read_only');
  });

  test('the issue read and the search stay open to a guest', async () => {
    const { engine, calls } = recordingEngine();
    const read = await getIssue(
      send('GET', '/api/issues/OPS-1'),
      'OPS-1',
      resolver(engine, guest)
    );
    expect(read.status).toBe(200);
    expect(calls).toEqual([['getIssueDetail', 'iss-ops-1']]);
    const search = await searchIssues(
      send('GET', '/api/issues/search?q=OPS'),
      resolver(engine, guest)
    );
    expect(search.status).toBe(200);
  });
});

// GET /api/issues/options (owner request 2026-10-22, "every issue in one
// list"): the Issues page's picker options, read as the signed-in person
// (a guest too), private and never cached.
describe('GET /api/issues/options', () => {
  const OPTIONS = {
    initiatives: [],
    projects: [],
    people: [],
    teams: [{ id: 'team-ops', key: 'OPS', name: 'Operations', states: [] }],
  };

  function optionsEngine(failWith?: Error): {
    engine: IssueListOptionsEngine;
    calls: unknown[][];
  } {
    const calls: unknown[][] = [];
    return {
      calls,
      engine: {
        getIssueListOptions: (workspaceId: string, viewer?: Actor) => {
          calls.push([workspaceId, viewer]);
          return failWith === undefined
            ? Promise.resolve({ options: OPTIONS, mirrorVersion: 7 })
            : Promise.reject(failWith);
        },
      },
    };
  }

  test('answers the options and the mirror version, privately', async () => {
    const { engine, calls } = optionsEngine();
    const who = actor();
    const response = await getIssueListOptionsRoute(
      send('GET', '/api/issues/options'),
      resolver(engine, who)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      options: OPTIONS,
      mirrorVersion: 7,
    });
    // The viewer is passed, so the options are what the person may see.
    expect(calls).toEqual([['org-1', who]]);
  });

  test('a Linear guest reads them too', async () => {
    const { engine, calls } = optionsEngine();
    const guest = actor({
      session: { userId: 'user-gus', workspaceId: 'org-1' },
      canWriteLinear: false,
      readOnly: true,
    } as unknown as Partial<Actor>);
    const response = await getIssueListOptionsRoute(
      send('GET', '/api/issues/options'),
      resolver(engine, guest)
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([['org-1', guest]]);
  });

  test('a signed-out request never reaches the engine', async () => {
    const { calls } = optionsEngine();
    const response = await getIssueListOptionsRoute(
      send('GET', '/api/issues/options'),
      () =>
        Promise.resolve(
          jsonError(401, 'not_signed_in', 'Sign in to use the planner.')
        )
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('engine errors map to their statuses', async () => {
    const { engine } = optionsEngine(
      new EngineAuthError('wrong_workspace', 'That workspace is not yours.')
    );
    const response = await getIssueListOptionsRoute(
      send('GET', '/api/issues/options'),
      resolver(engine)
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('wrong_workspace');
  });
});

// PATCH /api/issues (owner request 2026-10-22, "every issue in one list";
// architecture §7.3): the Issues page's bulk change, drop and Undo. The
// order is the CSRF guard, the session, a guest's read_only (before the
// body), the strict body, write scope (with the grant link back to the
// sanitized /issues view), then engine.updateIssues.
describe('PATCH /api/issues', () => {
  const RESULT = {
    at: '2026-10-22T12:00:00.000Z',
    outcomes: [
      {
        status: 'changed',
        issueId: 'iss-eng-54',
        identifier: 'ENG-54',
        changed: ['projectMilestoneId'],
        before: {
          projectId: 'proj-garnet',
          milestoneId: null,
          assigneeId: 'user-ben',
          priority: 1,
          stateType: 'unstarted',
          stateName: 'Todo',
        },
      },
      {
        status: 'failed',
        issueId: 'iss-eng-55',
        identifier: 'ENG-55',
        code: 'linear_forbidden',
        message: 'Linear refused.',
      },
    ],
    counts: { changed: 1, unchanged: 0, skipped: 0, failed: 1 },
    stopped: null,
    allocation: { handedOver: [], stopped: [] },
  };

  function bulkEngine(failWith?: Error): {
    engine: IssueBulkEngine;
    calls: unknown[][];
  } {
    const calls: unknown[][] = [];
    return {
      calls,
      engine: {
        updateIssues: (who: Actor, ids: readonly string[], patch: unknown) => {
          calls.push([who.session.userId, ids, patch]);
          return failWith === undefined
            ? Promise.resolve(RESULT as never)
            : Promise.reject(failWith);
        },
      },
    };
  }

  const MOVE = {
    issueIds: ['iss-eng-54', 'iss-eng-55'],
    patch: { move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-2' } },
    returnTo: '/issues?project=proj-garnet&milestone=none',
  };

  test('a move reaches the engine as typed: 200 { result }, partial results included', async () => {
    const { engine, calls } = bulkEngine();
    const response = await bulkUpdateIssues(
      send('PATCH', '/api/issues', MOVE),
      resolver(engine)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ result: RESULT });
    expect(calls).toEqual([
      [
        'user-chloe',
        ['iss-eng-54', 'iss-eng-55'],
        { move: { projectId: 'proj-garnet', milestoneId: 'ms-garnet-2' } },
      ],
    ]);
  });

  test('every field, and only the sent ones', async () => {
    const { engine, calls } = bulkEngine();
    await bulkUpdateIssues(
      send('PATCH', '/api/issues', {
        issueIds: ['iss-ops-1'],
        patch: {
          assigneeId: null,
          priority: 0,
          state: { type: 'started', name: '  In Review ' },
        },
      }),
      resolver(engine)
    );
    expect(calls).toEqual([
      [
        'user-chloe',
        ['iss-ops-1'],
        {
          assigneeId: null,
          priority: 0,
          state: { type: 'started', name: 'In Review' },
        },
      ],
    ]);
  });

  test('malformed bodies are 400s before the engine is reached', async () => {
    const { engine, calls } = bulkEngine();
    const many = Array.from({ length: 101 }, (_, i) => `iss-${i}`);
    const bodies: unknown[] = [
      {},
      { issueIds: [], patch: { priority: 1 } },
      { issueIds: many, patch: { priority: 1 } },
      { issueIds: ['iss-1', 'iss-1'], patch: { priority: 1 } },
      { issueIds: ['iss-1'], patch: {} },
      { issueIds: ['iss-1'], patch: { priority: 5 } },
      { issueIds: ['iss-1'], patch: { title: 'Renamed' } },
      { issueIds: ['iss-1'], patch: { stateId: 'st-eng-done' } },
      {
        issueIds: ['iss-1'],
        patch: { state: { type: 'doing', name: 'Doing' } },
      },
      {
        issueIds: ['iss-1'],
        patch: { state: { type: 'started', name: '   ' } },
      },
      { issueIds: ['iss-1'], patch: { move: { projectId: 'p' } } },
      {
        issueIds: ['iss-1'],
        patch: { move: { projectId: 'p', milestoneId: null, extra: 1 } },
      },
      { issueIds: ['iss-1'], patch: { priority: 1 }, other: true },
    ];
    for (const body of bodies) {
      const response = await bulkUpdateIssues(
        send('PATCH', '/api/issues', body),
        resolver(engine)
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid');
    }
    const notJson = await bulkUpdateIssues(
      send('PATCH', '/api/issues', '{nope'),
      resolver(engine)
    );
    expect(notJson.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('the order: cross-origin, then signed out, then a guest before the body', async () => {
    const { engine, calls } = bulkEngine();
    const crossOrigin = await bulkUpdateIssues(
      send('PATCH', '/api/issues', MOVE, 'https://evil.example'),
      resolver(engine)
    );
    expect(crossOrigin.status).toBe(403);
    expect((await errorOf(crossOrigin)).code).not.toBe('read_only');
    const signedOut = await bulkUpdateIssues(
      send('PATCH', '/api/issues', MOVE),
      () =>
        Promise.resolve(
          jsonError(401, 'not_signed_in', 'Sign in to use the planner.')
        )
    );
    expect(signedOut.status).toBe(401);
    const guest = actor({
      session: { userId: 'user-gus', workspaceId: 'org-1' },
      canWriteLinear: true,
      readOnly: true,
    } as unknown as Partial<Actor>);
    // A malformed body still answers read_only: the body is never read.
    const refused = await bulkUpdateIssues(
      send('PATCH', '/api/issues', { nonsense: true }),
      resolver(engine, guest)
    );
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toEqual({
      code: 'read_only',
      message: 'Guests in Linear can look but not change anything here.',
    });
    expect(calls).toEqual([]);
  });

  test('no write scope: 403 with the grant link back to the /issues view', async () => {
    const { engine, calls } = bulkEngine();
    const response = await bulkUpdateIssues(
      send('PATCH', '/api/issues', MOVE),
      resolver(engine, actor({ canWriteLinear: false }))
    );
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe('needs_write_scope');
    expect(error.grantWriteHref).toBe(
      `/api/auth/linear?intent=grant_write&returnTo=${encodeURIComponent('/issues?project=proj-garnet&milestone=none')}`
    );
    const foreign = await bulkUpdateIssues(
      send('PATCH', '/api/issues', {
        ...MOVE,
        returnTo: 'https://evil.example/issues',
      }),
      resolver(engine, actor({ canWriteLinear: false }))
    );
    expect((await errorOf(foreign)).grantWriteHref).toBe(
      `/api/auth/linear?intent=grant_write&returnTo=${encodeURIComponent('/issues')}`
    );
    expect(calls).toEqual([]);
  });

  test('returnTo is kept only as an /issues path', () => {
    expect(issuesReturnTo('/issues')).toBe('/issues');
    expect(issuesReturnTo('/issues?project=a')).toBe('/issues?project=a');
    expect(issuesReturnTo('/issues/ENG-12')).toBe('/issues/ENG-12');
    expect(issuesReturnTo(undefined)).toBe('/issues');
    expect(issuesReturnTo('/issuesx')).toBe('/issues');
    expect(issuesReturnTo('/week')).toBe('/issues');
    expect(issuesReturnTo('//evil.example/issues')).toBe('/issues');
    expect(issuesReturnTo('/issues\\evil')).toBe('/issues');
    expect(issuesReturnTo('/issues?x=1\ny')).toBe('/issues');
  });

  test('a stop with nothing changed: 401, or 429 with Retry-After; an unknown target 404', async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const cases: [Error, number, string][] = [
      [
        new EngineAuthError('not_signed_in', 'Sign in again.'),
        401,
        'not_signed_in',
      ],
      [
        new EngineInputError('rate_limited', 'Slow down.', { retryAt }),
        429,
        'rate_limited',
      ],
      [
        new EngineInputError(
          'not_found',
          'That milestone is not in the planner.'
        ),
        404,
        'not_found',
      ],
      [
        new EngineInputError(
          'invalid',
          'Push notifications is not a milestone of Atlas billing migration.'
        ),
        400,
        'invalid',
      ],
    ];
    for (const [error, status, code] of cases) {
      const { engine } = bulkEngine(error);
      const response = await bulkUpdateIssues(
        send('PATCH', '/api/issues', MOVE),
        resolver(engine)
      );
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
      if (status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        expect(seconds).toBeGreaterThanOrEqual(59);
        expect(seconds).toBeLessThanOrEqual(61);
      }
    }
  });

  test('a body over 1 MiB is 413, unread', async () => {
    const { engine, calls } = bulkEngine();
    const response = await bulkUpdateIssues(
      send(
        'PATCH',
        '/api/issues',
        JSON.stringify({ ...MOVE, returnTo: 'x'.repeat(1024 * 1024 + 10) })
      ),
      resolver(engine)
    );
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });
});
