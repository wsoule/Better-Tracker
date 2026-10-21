// Client-side calls to the app's own JSON routes. Every mutation from a
// client island goes through sendJson: same-origin fetch with a JSON body
// (the routes' CSRF guard accepts it because the browser sends a matching
// Origin), and a result the caller can show in a toast without parsing.

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string };

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
): { code: string; message: string } {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === 'object' && error !== null) {
      const { code, message } = error as Record<string, unknown>;
      if (typeof message === 'string' && message !== '') {
        return { code: typeof code === 'string' ? code : 'error', message };
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

/** GETs a same-origin JSON route; throws an Error with a showable message. */
export async function getJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
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
  return data;
}
