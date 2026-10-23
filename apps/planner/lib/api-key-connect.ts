// POST /api/auth/key: connecting with a personal Linear API key
// (LINEAR_AUTH=api_key, owner request 2026-10-23; architecture §8.1). The
// route is a thin wrapper around handleConnect, so tests drive it with a
// stub engine, limiter and clock.
//
// The key arrives only in this POST's urlencoded body, from the connect
// form on "/". It is never logged, never put in a URL, header or body of
// the answer, and handed only to engine.connectApiKey, which keeps it in
// the server's memory. Every answer is a 303 (or a refusal) whose Location
// carries a fixed code at most. This is a route handler on purpose, not a
// Server Action: Next logs Server Function calls with their arguments in
// development.

import { isLinearApiKeyShape } from '@better-tracker/core';
import { type Engine, isLinearApiError } from '@better-tracker/engine';
import { LINEAR_GRAPHQL_ENDPOINT } from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';

import {
  apiKeySessionCookie,
  authErrorLocation,
  DEFAULT_RETURN_TO,
  isSecureUrl,
  readCookie,
  redirectWithCookies,
  sanitizeReturnTo,
  sessionCookieName,
} from './auth-cookies';
import { readLimitedText } from './body';
import { connectClientKey, type ConnectLimiter } from './connect-limit';
import { engineAuthCode, engineInputCode } from './engine-errors';
import { jsonError, rejectCrossOrigin } from './origin';

const logger = createLogger({ name: 'planner.connect' });

/** The largest connect body read (a key is at most a few hundred bytes). */
export const CONNECT_MAX_BYTES = 4096;

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** What handleConnect needs besides the request. */
export interface ConnectDeps {
  engine: Pick<Engine, 'config' | 'connectApiKey' | 'signOut' | 'fullSync'>;
  limiter: ConnectLimiter;
  /** Runs work after the response (Next's after(); tests record it). */
  schedule: (task: () => Promise<unknown>) => void;
}

// The auth_error code for a failed connectApiKey, by code and kind (never
// instanceof: the cached engine may come from another bundle's copy).
function failureCode(error: unknown): string {
  const auth = engineAuthCode(error);
  if (auth !== null) {
    switch (auth) {
      case 'key_rejected':
      case 'key_cannot_read':
      case 'guest_cannot_bind':
      case 'not_signed_in':
        return auth;
      case 'wrong_workspace':
        return 'key_wrong_workspace';
      default:
        break;
    }
  }
  const input = engineInputCode(error);
  if (input === 'invalid') return 'key_shape';
  if (input === 'rate_limited') return 'linear_rate_limited';
  if (input === 'conflict') return 'key_capacity';
  if (
    isLinearApiError(error) &&
    (error.kind === 'network' || error.kind === 'server')
  ) {
    return 'linear_unreachable';
  }
  logger.error('connecting an API key failed', { err: error });
  return 'internal';
}

/** Handles POST /api/auth/key (see the file comment for the order of checks). */
export async function handleConnect(
  request: Request,
  deps: ConnectDeps
): Promise<Response> {
  const { engine, limiter } = deps;
  const config = engine.config;
  // 1. Only in api_key mode; nothing is read otherwise.
  if (config.auth !== 'api_key') {
    return jsonError(
      404,
      'not_found',
      'Personal API keys are off on this server.'
    );
  }
  // 2. A test endpoint only ever answers loopback requests.
  const endpoint = config.apiKey?.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
  if (
    endpoint !== LINEAR_GRAPHQL_ENDPOINT &&
    !LOOPBACK_HOSTS.includes(new URL(request.url).hostname)
  ) {
    return new Response(null, { status: 404 });
  }
  // 3. The app's CSRF protection: a cross-site page cannot submit a key.
  const refused = rejectCrossOrigin(request, config.appUrl);
  if (refused !== null) return refused;
  // 4. Keys travel over HTTPS only.
  const secure = isSecureUrl(config.appUrl);
  const forwarded = request.headers.get('x-forwarded-proto');
  if (
    secure &&
    forwarded !== null &&
    forwarded.split(',')[0]?.trim().toLowerCase() !== 'https'
  ) {
    return redirectWithCookies(authErrorLocation('insecure_transport'));
  }
  // 5. A plain form post only.
  const type = (request.headers.get('content-type') ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    return jsonError(
      415,
      'unsupported_media_type',
      'Send the connect form as application/x-www-form-urlencoded.'
    );
  }

  const client = connectClientKey(request);
  // Every failure lands on "/" with its code (and the posted returnTo).
  let returnTo: string | null = null;
  // The rate limits' count of this try, once it has begun (step 7).
  let attempt: { finish(outcome: string): void } | null = null;
  const fail = (
    code: string,
    headers: Record<string, string> = {}
  ): Response => {
    attempt?.finish(code);
    const safe =
      returnTo === null ? DEFAULT_RETURN_TO : sanitizeReturnTo(returnTo);
    const location =
      safe === DEFAULT_RETURN_TO
        ? authErrorLocation(code)
        : `${authErrorLocation(code)}&returnTo=${encodeURIComponent(safe)}`;
    const response = redirectWithCookies(location);
    for (const [name, value] of Object.entries(headers)) {
      response.headers.set(name, value);
    }
    return response;
  };

  // 6. The body, at most CONNECT_MAX_BYTES; never logged.
  const text = await readLimitedText(request, CONNECT_MAX_BYTES);
  if (text === null) {
    // Counted like any failure (unless the client is already over).
    const counted = limiter.begin(client);
    if (counted.ok) attempt = counted;
    return fail('invalid_request');
  }
  const params = new URLSearchParams(text);
  returnTo = params.get('returnTo');
  const apiKey = (params.get('apiKey') ?? '').trim();

  // 7. Rate limits: the try is counted now, before anything is awaited,
  // so concurrent posts cannot all pass while Linear answers.
  const allowed = limiter.begin(client);
  if (!allowed.ok) {
    logger.warn('connect rate limited', { scope: allowed.scope });
    const safe =
      returnTo === null ? DEFAULT_RETURN_TO : sanitizeReturnTo(returnTo);
    const location =
      safe === DEFAULT_RETURN_TO
        ? authErrorLocation('connect_rate_limited')
        : `${authErrorLocation('connect_rate_limited')}&returnTo=${encodeURIComponent(safe)}`;
    const response = redirectWithCookies(location);
    response.headers.set('Retry-After', String(allowed.retryAfterSeconds));
    return response;
  }
  attempt = allowed;

  // 8. The shape, without calling the engine.
  if (apiKey === '') return fail('invalid_request');
  if (!isLinearApiKeyShape(apiKey)) return fail('key_shape');

  // 9. Ask Linear (through the engine) whose key it is.
  let result: Awaited<ReturnType<ConnectDeps['engine']['connectApiKey']>>;
  try {
    result = await engine.connectApiKey({ apiKey });
  } catch (error) {
    return fail(failureCode(error));
  }
  allowed.finish('success');

  // 10. The new session replaces the one this browser had.
  const previous = readCookie(request, sessionCookieName(config));
  if (
    previous !== undefined &&
    previous !== '' &&
    previous !== result.sessionToken
  ) {
    try {
      await engine.signOut(previous);
    } catch (error) {
      logger.warn('could not forget the replaced connection', { err: error });
    }
  }
  if (result.syncAfter) {
    const workspaceId = result.session.workspaceId;
    deps.schedule(() =>
      engine.fullSync(workspaceId).catch((error: unknown) => {
        logger.warn('the sync after a connect failed', {
          workspaceId,
          err: error,
        });
      })
    );
  }
  return redirectWithCookies(sanitizeReturnTo(returnTo, DEFAULT_RETURN_TO), [
    apiKeySessionCookie(result.sessionToken, { secure }),
  ]);
}
