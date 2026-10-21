import {
  isLinearApiError,
  type Actor,
  type Engine,
} from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import type { ZodType } from 'zod';

import { engineAuthCode, engineInputCode } from './engine-errors';
import { jsonError, rejectCrossOrigin } from './origin';
import { getRequestContext } from './session';

export { jsonError, rejectCrossOrigin };

const logger = createLogger({ name: 'planner.http' });

/**
 * Maps engine and Linear errors to HTTP responses; logs the unexpected.
 * Engine errors are recognised by name as well as class (lib/engine-errors:
 * the cached engine may come from another bundle's copy of the package).
 */
export function errorResponse(error: unknown): Response {
  const authCode = engineAuthCode(error);
  if (authCode !== null) {
    const status = authCode === 'not_signed_in' ? 401 : 403;
    return jsonError(status, authCode, (error as Error).message);
  }
  const inputCode = engineInputCode(error);
  if (inputCode !== null) {
    const status =
      inputCode === 'not_found' ? 404 : inputCode === 'conflict' ? 409 : 400;
    return jsonError(status, inputCode, (error as Error).message);
  }
  if (isLinearApiError(error)) {
    const status =
      error.kind === 'rate_limited'
        ? 429
        : error.kind === 'not_found'
          ? 404
          : error.kind === 'invalid_input'
            ? 400
            : 502;
    return jsonError(status, `linear_${error.kind}`, error.message);
  }
  logger.error('unhandled route error', { err: error });
  return jsonError(500, 'internal', 'Something went wrong. It was logged.');
}

/** Parses and validates a JSON body; a Response means "send this 400". */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, 'invalid_json', 'Request body must be JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') ?? '';
    return jsonError(
      400,
      'invalid',
      `${where === '' ? 'Body' : where}: ${first?.message ?? 'invalid'}`
    );
  }
  return parsed.data;
}

/**
 * Resolves the signed-in actor for an API route and applies the CSRF guard
 * for non-GET methods. A Response means "send this".
 */
export async function requireApiActor(
  request: Request
): Promise<{ engine: Engine; actor: Actor } | Response> {
  const { engine, actor } = await getRequestContext();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const refused = rejectCrossOrigin(request, engine.config.appUrl);
    if (refused !== null) return refused;
  }
  if (actor === null) return jsonError(401, 'not_signed_in', 'Sign in first.');
  return { engine, actor };
}
