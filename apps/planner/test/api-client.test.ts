import { describe, expect, test } from 'bun:test';

import {
  errorFromBody,
  getJson,
  notSavedToast,
  sendJson,
  setFrameWorkspace,
  switchWorkspace,
} from '../lib/api-client';

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

  test("the link names the tab's workspace, so a stale tab is refused", () => {
    // A browser holds several workspaces (owner decision 2026-10-25): the
    // start route refuses the grant when the tab's workspace is no longer
    // the active one (workspace_changed) instead of starting it for that.
    const followed: string[] = [];
    try {
      setFrameWorkspace('org-acme');
      notSavedToast(
        {
          ok: false,
          status: 403,
          code: 'needs_write_scope',
          message: 'Allow the planner to edit Linear first.',
          grantWriteHref:
            '/api/auth/linear?intent=grant_write&returnTo=%2Fissues',
        },
        (to) => followed.push(to)
      ).action?.onClick();
    } finally {
      setFrameWorkspace(null);
    }
    expect(followed).toEqual([
      '/api/auth/linear?intent=grant_write&returnTo=%2Fissues&workspace=org-acme',
    ]);
  });
});

// Several workspaces in one browser (owner decision 2026-10-25): every
// request names the tab's workspace, a workspace_changed refusal offers
// a reload, and switching posts the form field and loads the answer.

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string | null;
  method: string;
}

/** Replaces fetch for one test; returns what was sent. */
function stubFetch(answer: () => Response): { sent: Sent[]; restore(): void } {
  const saved = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body:
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : null,
      method: init?.method ?? 'GET',
    });
    return Promise.resolve(answer());
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = saved;
      setFrameWorkspace(null);
    },
  };
}

describe('the tab names its workspace', () => {
  test('every request carries X-Planner-Workspace once the frame set it', async () => {
    const stub = stubFetch(() => Response.json({ ok: true }));
    try {
      await getJson('/api/palette');
      expect(stub.sent[0]?.headers['x-planner-workspace']).toBeUndefined();
      setFrameWorkspace('org-acme');
      await getJson('/api/palette');
      await sendJson('PATCH', '/api/settings', { a: 1 });
      expect(stub.sent[1]?.headers['x-planner-workspace']).toBe('org-acme');
      expect(stub.sent[2]?.headers['x-planner-workspace']).toBe('org-acme');
      expect(stub.sent[2]?.headers['content-type']).toBe('application/json');
    } finally {
      stub.restore();
    }
  });

  test("a workspace_changed answer carries the tab's workspace name, or null", () => {
    expect(
      errorFromBody(409, {
        error: {
          code: 'workspace_changed',
          message: 'This tab shows Globex, but…',
          tabWorkspaceName: 'Globex',
        },
      })
    ).toEqual({
      code: 'workspace_changed',
      message: 'This tab shows Globex, but…',
      tabWorkspaceName: 'Globex',
    });
    for (const tabWorkspaceName of [null, undefined, '', 42]) {
      expect(
        errorFromBody(409, {
          error: {
            code: 'workspace_changed',
            message: 'This tab shows another workspace, but…',
            tabWorkspaceName,
          },
        }).tabWorkspaceName
      ).toBeNull();
    }
    // Only workspace_changed carries it.
    expect(
      errorFromBody(400, {
        error: { code: 'invalid', message: 'No.', tabWorkspaceName: 'Acme' },
      })
    ).toEqual({ code: 'invalid', message: 'No.' });
  });

  test('a workspace_changed refusal offers Reload instead of a grant link', () => {
    let reloaded = 0;
    const toast = notSavedToast(
      {
        ok: false,
        status: 409,
        code: 'workspace_changed',
        message:
          'This tab shows Globex, but this browser switched to Acme in another tab.',
      },
      () => undefined,
      () => {
        reloaded += 1;
      }
    );
    expect(toast.message).toContain('switched to Acme');
    expect(toast.action?.label).toBe('Reload');
    toast.action?.onClick();
    expect(reloaded).toBe(1);
  });
});

describe('switchWorkspace', () => {
  test('posts workspace=<id> asking for JSON, then loads the location and never settles', async () => {
    const stub = stubFetch(() => Response.json({ location: '/week' }));
    const assigned: string[] = [];
    try {
      setFrameWorkspace('org-acme');
      const pending = switchWorkspace('org-globex', (to) => assigned.push(to));
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stub.sent[0]).toMatchObject({
        url: '/api/auth/switch',
        method: 'POST',
        body: 'workspace=org-globex',
      });
      expect(stub.sent[0]?.headers.accept).toBe('application/json');
      expect(assigned).toEqual(['/week']);
      expect(settled).toBe(false);
    } finally {
      stub.restore();
    }
  });

  test('only a same-site path is followed', async () => {
    const stub = stubFetch(() =>
      Response.json({ location: '//evil.example/x' })
    );
    const assigned: string[] = [];
    try {
      void switchWorkspace('org-globex', (to) => assigned.push(to));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(assigned).toEqual(['/week']);
    } finally {
      stub.restore();
    }
  });

  test('a refusal rejects with the route sentence (the switcher says Not switched)', async () => {
    const stub = stubFetch(() =>
      Response.json(
        {
          error: {
            code: 'session_ended',
            message: 'Your session for Globex ended.',
          },
        },
        { status: 410 }
      )
    );
    const assigned: string[] = [];
    try {
      const error: unknown = await switchWorkspace('org-globex', (to) =>
        assigned.push(to)
      ).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Your session for Globex ended.');
      expect(assigned).toEqual([]);
    } finally {
      stub.restore();
    }
  });
});
