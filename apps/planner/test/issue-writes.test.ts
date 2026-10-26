import { describe, expect, test } from 'bun:test';

import type { ApiResult } from '../lib/api-client';
import { issueWriteOutcome } from '../lib/issue-writes';

// How the issue view reads its writes' answers: a refused removal of a
// relation that is already gone, or a blocker that already blocks, is the
// state the person wanted, so it refreshes without "Not saved"; other
// 404/409 answers are failures that also refresh the stale view, except a
// tab left on another workspace (409 workspace_changed), which never
// refreshes.

function refused(
  status: number,
  message = 'No.',
  code = 'x'
): ApiResult<unknown> {
  return { ok: false, status, code, message };
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

  test('a tab left on another workspace fails every write without a refresh', () => {
    const stale = refused(
      409,
      'This tab shows Acme, but this browser switched to Globex in another tab. Reload to continue in Globex, or switch back to Acme.',
      'workspace_changed'
    );
    for (const write of [
      'patch',
      'comment',
      'addBlocker',
      'removeRelation',
    ] as const) {
      expect(issueWriteOutcome(write, stale)).toEqual({
        kind: 'failed',
        refresh: false,
      });
    }
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
