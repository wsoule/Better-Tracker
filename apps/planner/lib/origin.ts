// Request guards with no engine dependency, so they are unit-testable alone.

import { redactLinearSecrets } from '@better-tracker/core';

/** Optional facts an error carries beside its code and sentence. */
export interface ApiErrorExtras {
  /**
   * needs_write_scope: where the person grants the planner write access
   * to Linear (the grant_write OAuth upgrade), returning to the page that
   * needed it.
   */
  grantWriteHref?: string;
  /** rate_limited: when Linear said its limit resets, if it said. */
  retryAt?: string | null;
}

/** A JSON error body the client islands can show verbatim. */
export interface ApiErrorBody {
  error: { code: string; message: string } & ApiErrorExtras;
}

/**
 * A JSON error response. The message passes through redactLinearSecrets
 * as the last layer, in every mode: a Linear error relayed to another
 * person (their Resync joining a sync made with someone else's key) can
 * never carry a credential.
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extras: ApiErrorExtras = {},
  headers?: HeadersInit
): Response {
  const body: ApiErrorBody = {
    error: { code, message: redactLinearSecrets(message), ...extras },
  };
  return Response.json(body, { status, headers });
}

/**
 * CSRF guard for mutating routes. Browsers attach Origin to cross-site POST
 * and PATCH requests, so a request is accepted only when Origin matches the
 * configured public URL or the URL the request arrived on. When Origin is
 * absent (some same-origin navigations), Sec-Fetch-Site must say
 * same-origin. Returns a 403 response to send, or null when allowed.
 */
export function rejectCrossOrigin(
  request: Request,
  appUrl: string
): Response | null {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    const allowed = new Set<string>([new URL(request.url).origin]);
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      // A malformed APP_URL only narrows the allow-list.
    }
    return allowed.has(origin)
      ? null
      : jsonError(403, 'cross_origin', 'Cross-origin request refused.');
  }
  const site = request.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none'
    ? null
    : jsonError(403, 'cross_origin', 'Cross-origin request refused.');
}
