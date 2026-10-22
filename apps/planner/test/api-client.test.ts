import { describe, expect, test } from 'bun:test';

import { notSavedToast } from '../lib/api-client';

// The "Not saved" toast the timeline's date and lead saves show. A
// needs_write_scope refusal carries the grant_write link, which is offered
// to everyone (owner decision 2026-10-22: no roles), so the toast gets an
// "Allow edits" action; other refusals are a plain error toast.

describe('notSavedToast', () => {
  test('a plain refusal is a plain error toast', () => {
    const toast = notSavedToast(
      { ok: false, status: 400, code: 'invalid', message: 'Bad date.' },
      () => undefined
    );
    expect(toast).toEqual({
      kind: 'error',
      label: 'Not saved',
      message: 'Bad date.',
    });
  });

  test('a missing write grant offers "Allow edits", following the link', () => {
    const followed: string[] = [];
    const href =
      '/api/auth/linear?intent=grant_write&returnTo=%2Ftimeline%3Fmilestone%3Dms-1';
    const toast = notSavedToast(
      {
        ok: false,
        status: 403,
        code: 'needs_write_scope',
        message: 'Allow the planner to edit Linear first.',
        grantWriteHref: href,
      },
      (to) => followed.push(to)
    );
    expect(toast.action?.label).toBe('Allow edits');
    expect(toast.duration).toBe(10_000);
    toast.action?.onClick();
    expect(followed).toEqual([href]);
  });
});
