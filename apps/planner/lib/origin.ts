// Request guards with no engine dependency, so they are unit-testable alone.

/** A JSON error body the client islands can show verbatim. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function jsonError(
  status: number,
  code: string,
  message: string
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return Response.json(body, { status });
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
