import { normalizeIssueListQuery } from '@better-tracker/core';
import {
  createEngineFromEnv,
  type Engine,
  type IssueBulkResult,
} from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { parseIssueListParams } from '../lib/adapters/issue-list';
import { undoRequests } from '../lib/adapters/issue-moves';

// Moving issues end to end on the demo engine (owner request 2026-10-22,
// "… and move them to milestones and stuff"; architecture §8.4 "Issues",
// §7.3): the real PATCH /api/issues route file with requireApiActor's
// CSRF guard and session, zod, the engine, the mirror, the audit log and
// the list read back. Chloe moves Garnet's two unplanned issues (ENG-54,
// ENG-55) into "Push notifications", then undoes it; Gus, the demo's
// Linear guest, is refused and changes nothing, while his own list reads
// Operations only with the no-initiatives fallback. next/headers'
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
  // Every next/headers mock defines both exports: Bun keeps one module
  // namespace per specifier across test files, so a mock missing one leaves
  // a later file's `import { headers }` unlinkable (next-headers-mocks test).
  headers: () => Promise.resolve(new Headers()),
}));

const { PATCH: bulkPatch } = await import('../app/api/issues/route');
const { GET: optionsGet } = await import('../app/api/issues/options/route');

const APP = 'http://localhost:3000';
const WORKSPACE = 'org-northwind';
const PUSH = 'ms-garnet-2';

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;
let engine: Engine;
let chloeToken: string;
let gusToken: string;

beforeAll(async () => {
  engine = await createEngineFromEnv(
    { LINEAR_FIXTURE: '1', APP_URL: APP },
    { logger: createLogger({ name: 'test', level: 'error' }) }
  );
  holder.__milestonePlannerEngine = Promise.resolve(engine);
  chloeToken = (await engine.devSignIn('user-chloe')).sessionToken;
  gusToken = (await engine.devSignIn('user-gus')).sessionToken;
});

afterAll(async () => {
  holder.__milestonePlannerEngine = savedEngine;
  sessionToken = null;
  await engine.close();
});

function patch(body: unknown): Request {
  return new Request(`${APP}/api/issues`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: APP },
    body: JSON.stringify(body),
  });
}

/** Where the mirror (as Chloe sees it) has ENG-54 and ENG-55. */
async function placeOf54and55(): Promise<(string | null)[][]> {
  const { snapshot } = await engine.load(WORKSPACE);
  return ['iss-eng-54', 'iss-eng-55'].map((id) => {
    const issue = snapshot.issues.get(id);
    return [issue?.projectId ?? null, issue?.milestoneId ?? null];
  });
}

/** The keys of the rows the list shows under a milestone's group. */
async function rowsUnder(
  milestoneId: string,
  params: Record<string, string>
): Promise<string[]> {
  const actor = await engine.authenticate(chloeToken);
  if (actor === null) throw new Error('Chloe is not signed in');
  const { view } = await engine.getIssueList(
    WORKSPACE,
    parseIssueListParams(params),
    actor
  );
  return view.sections
    .flatMap((section) => section.groups)
    .filter(
      (group) =>
        group.value.kind === 'milestone' &&
        group.value.milestoneId === milestoneId
    )
    .flatMap((group) => group.rows.map((row) => row.identifier));
}

describe('moving issues on the demo engine', () => {
  test('Chloe moves ENG-54 and ENG-55 into Push notifications, then undoes it', async () => {
    expect(await placeOf54and55()).toEqual([
      ['proj-garnet', null],
      ['proj-garnet', null],
    ]);
    expect(await rowsUnder(PUSH, { project: 'proj-garnet' })).toEqual([]);

    sessionToken = chloeToken;
    const move = {
      move: { projectId: 'proj-garnet', milestoneId: PUSH },
    };
    const response = await bulkPatch(
      patch({
        issueIds: ['iss-eng-54', 'iss-eng-55'],
        patch: move,
        returnTo: '/issues?project=proj-garnet&milestone=none',
      })
    );
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: IssueBulkResult };
    expect(result.counts).toEqual({
      changed: 2,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(result.stopped).toBeNull();

    // The mirror, the list and the audit log all have them.
    expect(await placeOf54and55()).toEqual([
      ['proj-garnet', PUSH],
      ['proj-garnet', PUSH],
    ]);
    expect(await rowsUnder(PUSH, { project: 'proj-garnet' })).toEqual([
      'ENG-54',
      'ENG-55',
    ]);
    const audit = await engine.listAudit(WORKSPACE, 10);
    const moved = audit.filter(
      (entry) => entry.action === 'issue.milestone' && entry.at === result.at
    );
    expect(
      moved
        .map((e) => [e.actorUserId, e.subjectId, e.before, e.after])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    ).toEqual([
      ['user-chloe', 'iss-eng-54', null, PUSH],
      ['user-chloe', 'iss-eng-55', null, PUSH],
    ]);

    // Undo: the inverse, grouped by where they were, through the same route.
    const requests = undoRequests(result, move);
    expect(requests).toEqual([
      {
        issueIds: ['iss-eng-54', 'iss-eng-55'],
        patch: { move: { projectId: 'proj-garnet', milestoneId: null } },
      },
    ]);
    for (const request of requests) {
      const undone = await bulkPatch(patch(request));
      expect(undone.status).toBe(200);
      const back = ((await undone.json()) as { result: IssueBulkResult })
        .result;
      expect(back.counts.changed).toBe(2);
    }
    expect(await placeOf54and55()).toEqual([
      ['proj-garnet', null],
      ['proj-garnet', null],
    ]);
    expect(await rowsUnder(PUSH, { project: 'proj-garnet' })).toEqual([]);
  });

  test('Gus, a Linear guest, is refused and nothing changes; his list reads', async () => {
    const versionBefore = (
      await engine.getIssueList(WORKSPACE, normalizeIssueListQuery({}))
    ).mirrorVersion;
    const auditBefore = (await engine.listAudit(WORKSPACE, 500)).length;
    sessionToken = gusToken;
    const response = await bulkPatch(
      patch({ issueIds: ['iss-ops-1'], patch: { priority: 1 } })
    );
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code
    ).toBe('read_only');
    const { snapshot } = await engine.load(WORKSPACE);
    expect(snapshot.issues.get('iss-ops-1')?.priority).toBe(3);
    expect((await engine.listAudit(WORKSPACE, 500)).length).toBe(auditBefore);
    expect(
      (await engine.getIssueList(WORKSPACE, normalizeIssueListQuery({})))
        .mirrorVersion
    ).toBe(versionBefore);

    // His own list: Operations only, no initiatives (the fallback).
    const gus = await engine.authenticate(gusToken);
    if (gus === null) throw new Error('Gus is not signed in');
    const { view } = await engine.getIssueList(
      WORKSPACE,
      parseIssueListParams({ group: 'initiative' }),
      gus
    );
    expect(view.fallback).toEqual({ reason: 'no_initiatives' });
    expect(view.query.group).toBe('project');
    const keys = view.sections.flatMap((s) =>
      s.groups.flatMap((g) => g.rows.map((r) => r.identifier))
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('OPS-'))).toBe(true);

    // The picker options are his to read, too.
    const options = await optionsGet(
      new Request(`${APP}/api/issues/options`, { method: 'GET' })
    );
    expect(options.status).toBe(200);
    const body = (await options.json()) as {
      options: { initiatives: unknown[]; teams: { id: string }[] };
    };
    expect(body.options.initiatives).toEqual([]);
    expect(body.options.teams.map((t) => t.id)).toEqual(['team-ops']);
  });
});
