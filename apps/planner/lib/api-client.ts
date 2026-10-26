// Client-side calls to the app's own JSON routes. Every mutation from a
// client island goes through sendJson: same-origin fetch with a JSON body
// (the routes' CSRF guard accepts it because the browser sends a matching
// Origin), and a result the caller can show in a toast without parsing.
// Every request names the workspace its tab shows (X-Planner-Workspace,
// set by PlannerShell from the shell frame), so a tab left on one
// workspace after the browser switched to another in a second tab is
// answered 409 workspace_changed instead of acting there (architecture
// §8.1 "Stale tabs").

import type { IssueBulkPatch, IssueListOptions } from '@better-tracker/core';
import type { IssueBulkResult } from '@better-tracker/engine';
import type { ToastInput } from '@better-tracker/ui';

import { withStartWorkspace } from './oauth-links';
import { WORKSPACE_HEADER } from './workspace-copy';

// The workspace the tab's shell frame shows; null outside the signed-in
// frame (and on the server, which never calls these).
let frameWorkspaceId: string | null = null;

/**
 * Names the workspace this tab shows, for the X-Planner-Workspace header
 * of every later request (PlannerShell calls it while rendering, in the
 * browser only: the layout, and so the frame, never re-renders on client
 * navigation, which is what makes it the tab's workspace).
 */
export function setFrameWorkspace(workspaceId: string | null): void {
  frameWorkspaceId = workspaceId;
}

/** The headers every request carries, plus `extra`. */
function requestHeaders(extra: Record<string, string>): Record<string, string> {
  return frameWorkspaceId === null
    ? extra
    : { ...extra, [WORKSPACE_HEADER]: frameWorkspaceId };
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      /** needs_write_scope: the grant_write link the route offered. */
      grantWriteHref?: string;
      /**
       * workspace_changed: the name of the workspace this tab shows (null
       * when the browser no longer holds it), as the route named it.
       */
      tabWorkspaceName?: string | null;
    };

const NETWORK_MESSAGE =
  'Could not reach the planner. Check your connection and try again.';

/**
 * The error a failed response carries: the routes answer
 * `{ error: { code, message } }` (lib/origin.ts jsonError), with the
 * grant_write link of needs_write_scope and the tab's workspace name of
 * workspace_changed; anything else gets a sentence built from the status.
 */
export function errorFromBody(
  status: number,
  body: unknown
): {
  code: string;
  message: string;
  grantWriteHref?: string;
  tabWorkspaceName?: string | null;
} {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === 'object' && error !== null) {
      const { code, message, grantWriteHref, tabWorkspaceName } =
        error as Record<string, unknown>;
      if (typeof message === 'string' && message !== '') {
        const found = {
          code: typeof code === 'string' ? code : 'error',
          message,
        };
        if (found.code === 'workspace_changed') {
          return {
            ...found,
            tabWorkspaceName:
              typeof tabWorkspaceName === 'string' && tabWorkspaceName !== ''
                ? tabWorkspaceName
                : null,
          };
        }
        // Only a same-site path is followed (the routes send one).
        return typeof grantWriteHref === 'string' &&
          grantWriteHref.startsWith('/api/auth/linear?')
          ? { ...found, grantWriteHref }
          : found;
      }
    }
  }
  if (status === 401) {
    return {
      code: 'not_signed_in',
      message: 'Your session ended. Sign in again.',
    };
  }
  if (status === 403) {
    return {
      code: 'forbidden',
      message: 'You do not have permission to do that.',
    };
  }
  return {
    code: 'http_error',
    message: `The planner answered ${status}; nothing was changed.`,
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Sends `body` as JSON to a same-origin route and reads the JSON answer. */
export async function sendJson<T = unknown>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body: unknown
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders({
        'content-type': 'application/json',
        accept: 'application/json',
      }),
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, code: 'network', message: NETWORK_MESSAGE };
  }
  const data = await readBody(response);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      ...errorFromBody(response.status, data),
    };
  }
  return { ok: true, status: response.status, data: data as T };
}

/**
 * GETs a same-origin JSON route; throws an Error with a showable message.
 * An aborted request (`signal`) rethrows the browser's AbortError as is,
 * so a caller can tell "stale" from "failed".
 */
export async function getJson(
  url: string,
  signal?: AbortSignal
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: requestHeaders({ accept: 'application/json' }),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new Error(NETWORK_MESSAGE);
  }
  const data = await readBody(response);
  if (!response.ok) {
    throw new Error(errorFromBody(response.status, data).message);
  }
  return data;
}

/**
 * Switches this browser to another of its workspaces (POST
 * /api/auth/switch with `workspace=<id>`, asking for JSON): on success
 * the page loads the route's `location` (a full page load, so nothing of
 * the old workspace stays in memory) and the promise never settles, so
 * the switcher keeps saying "Switching to …" until the page goes; a
 * refusal rejects with an Error carrying the route's sentence (the
 * switcher prints "Not switched …", the palette toasts it). `assign`
 * stands in for window.location.assign in tests.
 */
export async function switchWorkspace(
  workspaceId: string,
  assign: (location: string) => void = (location) =>
    window.location.assign(location)
): Promise<never> {
  let response: Response;
  try {
    response = await fetch('/api/auth/switch', {
      method: 'POST',
      headers: requestHeaders({ accept: 'application/json' }),
      body: new URLSearchParams({ workspace: workspaceId }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new Error(NETWORK_MESSAGE);
  }
  const data = await readBody(response);
  if (!response.ok) {
    throw new Error(errorFromBody(response.status, data).message);
  }
  const location =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>).location
      : undefined;
  // Only a same-site path is followed (the route sends one).
  assign(
    typeof location === 'string' &&
      location.startsWith('/') &&
      !location.startsWith('//')
      ? location
      : '/week'
  );
  return new Promise<never>(() => undefined);
}

/**
 * The "Not saved" toast for a refused save. A needs_write_scope answer
 * carries the grant_write link, offered to everyone (there are no roles),
 * so the toast gets an "Allow edits" action and stays up long enough to
 * use it; `navigate` is how the action follows the link (a full page load
 * in the browser, since the OAuth start must never be prefetched). A
 * workspace_changed answer (this tab shows another workspace than the one
 * the browser switched to) gets a "Reload" action instead; `reload` stands
 * in for window.location.reload in tests.
 */
export function notSavedToast(
  result: Extract<ApiResult<unknown>, { ok: false }>,
  navigate: (href: string) => void,
  reload: () => void = () => window.location.reload()
): ToastInput {
  if (result.code === 'workspace_changed') {
    return {
      kind: 'error',
      label: 'Not saved',
      message: result.message,
      action: { label: 'Reload', onClick: reload },
      duration: 10_000,
    };
  }
  const grant = result.grantWriteHref;
  if (grant === undefined) {
    return { kind: 'error', label: 'Not saved', message: result.message };
  }
  return {
    kind: 'error',
    label: 'Not saved',
    message: result.message,
    action: {
      label: 'Allow edits',
      // The tab's workspace: the start route refuses the link when this
      // browser switched to another one in a second tab.
      onClick: () => navigate(withStartWorkspace(grant, frameWorkspaceId)),
    },
    duration: 10_000,
  };
}

/** What GET /api/issues/options answers. */
export interface IssueListOptionsBody {
  options: IssueListOptions;
  mirrorVersion: number;
}

/** The answer has the options' shape (its four lists and the version). */
export function isIssueListOptionsBody(
  body: unknown
): body is IssueListOptionsBody {
  if (typeof body !== 'object' || body === null) return false;
  const { options, mirrorVersion } = body as Record<string, unknown>;
  if (typeof mirrorVersion !== 'number') return false;
  if (typeof options !== 'object' || options === null) return false;
  const lists = options as Record<string, unknown>;
  return ['initiatives', 'projects', 'people', 'teams'].every((key) =>
    Array.isArray(lists[key])
  );
}

/**
 * The Issues page's picker options (GET /api/issues/options), read as the
 * signed-in person. Throws with a sentence when the route refuses or
 * answers something else.
 */
export async function getIssueListOptions(
  signal?: AbortSignal
): Promise<IssueListOptionsBody> {
  const body = await getJson('/api/issues/options', signal);
  if (!isIssueListOptionsBody(body)) {
    throw new Error('The filter options came back in an unexpected shape.');
  }
  return body;
}

/** What PATCH /api/issues takes: the issue list's bulk change. */
export interface IssueBulkRequest {
  issueIds: readonly string[];
  patch: IssueBulkPatch;
  /** The /issues view a grant_write link comes back to. */
  returnTo?: string;
}

/**
 * PATCH /api/issues (the Issues page's bulk change, drop and Undo): one
 * IssueBulkPatch for up to 100 issues, written to Linear as the signed-in
 * person. Resolves with the route's answer; a 200 carries `{ result }`
 * with one outcome per issue (partial results included).
 */
export function patchIssues(
  request: IssueBulkRequest
): Promise<ApiResult<{ result: IssueBulkResult }>> {
  return sendJson<{ result: IssueBulkResult }>('PATCH', '/api/issues', {
    issueIds: [...request.issueIds],
    patch: request.patch,
    ...(request.returnTo === undefined ? {} : { returnTo: request.returnTo }),
  });
}
