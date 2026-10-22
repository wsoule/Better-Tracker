import { describe, expect, test } from 'bun:test';

import type { ApiResult } from '../lib/api-client';
import { issueWriteOutcome } from '../lib/issue-writes';

// How the issue view reads its writes' answers: a refused removal of a
// relation that is already gone, or a blocker that already blocks, is the
// state the person wanted, so it refreshes without "Not saved"; other
// 404/409 answers are failures that also refresh the stale view.

function refused(status: number, message = 'No.'): ApiResult<unknown> {
  return { ok: false, status, code: 'x', message };
}

const OK: ApiResult<unknown> = { ok: true, status: 200, data: {} };

describe('issueWriteOutcome', () => {
  test('a success is saved, whatever the write', () => {
    for (const write of [
      'patch',
      'comment',
      'addBlocker',
      'removeRelation',
    ] as const) {
      expect(issueWriteOutcome(write, OK)).toEqual({ kind: 'saved' });
    }
  });

  test('removing a relation the planner no longer has is already done', () => {
    expect(
      issueWriteOutcome(
        'removeRelation',
        refused(404, 'That blocking relation is not in the planner.')
      )
    ).toEqual({ kind: 'already', note: null });
  });

  test('adding a blocker that already blocks is already done, with a note', () => {
    expect(
      issueWriteOutcome(
        'addBlocker',
        refused(409, 'ENG-13 already blocks ENG-51.')
      )
    ).toEqual({ kind: 'already', note: 'ENG-13 already blocks ENG-51.' });
  });

  test('other stale answers fail and refresh; the rest just fail', () => {
    expect(issueWriteOutcome('addBlocker', refused(404))).toEqual({
      kind: 'failed',
      refresh: true,
    });
    expect(issueWriteOutcome('patch', refused(404))).toEqual({
      kind: 'failed',
      refresh: true,
    });
    expect(issueWriteOutcome('removeRelation', refused(403))).toEqual({
      kind: 'failed',
      refresh: false,
    });
    expect(issueWriteOutcome('patch', refused(400))).toEqual({
      kind: 'failed',
      refresh: false,
    });
    expect(issueWriteOutcome('comment', refused(0))).toEqual({
      kind: 'failed',
      refresh: false,
    });
  });
});
