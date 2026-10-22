// Client-side calls to the app's own JSON routes. Every mutation from a
// client island goes through sendJson: same-origin fetch with a JSON body
// (the routes' CSRF guard accepts it because the browser sends a matching
// Origin), and a result the caller can show in a toast without parsing.

import type { ToastInput } from '@better-tracker/ui';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      /** needs_write_scope: the grant_write link the route offered. */
      grantWriteHref?: string;
    };

const NETWORK_MESSAGE =
  'Could not reach the planner. Check your connection and try again.';

/**
 * The error a failed response carries: the routes answer
 * `{ error: { code, message } }` (lib/origin.ts jsonError); anything else
 * gets a sentence built from the status.
 */
export function errorFromBody(
  status: number,
  body: unknown
): { code: string; message: string; grantWriteHref?: string } {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === 'object' && error !== null) {
      const { code, message, grantWriteHref } = error as Record<
        string,
        unknown
      >;
      if (typeof message === 'string' && message !== '') {
        const found = {
          code: typeof code === 'string' ? code : 'error',
          message,
        };
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
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
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
      headers: { accept: 'application/json' },
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
 * The "Not saved" toast for a refused save. A needs_write_scope answer
 * carries the grant_write link, offered to everyone (there are no roles),
 * so the toast gets an "Allow edits" action and stays up long enough to
 * use it; `navigate` is how the action follows the link (a full page load
 * in the browser, since the OAuth start must never be prefetched).
 */
export function notSavedToast(
  result: Extract<ApiResult<unknown>, { ok: false }>,
  navigate: (href: string) => void
): ToastInput {
  const grant = result.grantWriteHref;
  if (grant === undefined) {
    return { kind: 'error', label: 'Not saved', message: result.message };
  }
  return {
    kind: 'error',
    label: 'Not saved',
    message: result.message,
    action: { label: 'Allow edits', onClick: () => navigate(grant) },
    duration: 10_000,
  };
}
