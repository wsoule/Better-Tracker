import {
  isLinearApiError,
  type Actor,
  type Engine,
  requireWritable,
} from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import type { ZodType } from 'zod';

import { readLimitedText } from './body';
import { engineAuthCode, engineInputCode } from './engine-errors';
import { jsonError, rejectCrossOrigin } from './origin';
import { getRequestContext } from './session';

export { jsonError, rejectCrossOrigin };

const logger = createLogger({ name: 'planner.http' });

/**
 * Where a signed-in person grants the planner write access to Linear (the
 * grant_write OAuth upgrade, offered to everyone since the owner decision
 * of 2026-10-21), coming back to `returnTo` (a relative path; the OAuth
 * start route sanitizes it again).
 */
export function grantWriteHref(returnTo: string = '/week'): string {
  return `/api/auth/linear?intent=grant_write&returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * 403 needs_write_scope with the grant_write link, so a client can offer
 * "Allow edits" right where the save failed.
 */
export function needsWriteScope(message: string, returnTo?: string): Response {
  return jsonError(403, 'needs_write_scope', message, {
    grantWriteHref: grantWriteHref(returnTo),
  });
}

/** Whole seconds until `retryAt` (at least 1), or null without a time. */
export function retryAfterSeconds(
  retryAt: string | null,
  now: number = Date.now()
): number | null {
  if (retryAt === null) return null;
  const at = Date.parse(retryAt);
  if (Number.isNaN(at)) return null;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/**
 * Maps engine and Linear errors to HTTP responses; logs the unexpected.
 * Engine errors are recognised by name as well as class (lib/engine-errors:
 * the cached engine may come from another bundle's copy of the package).
 * not_signed_in is a 401; every other auth code is a 403, including
 * read_only (a Linear guest, who may look but not change anything).
 * `returnTo` is the page a needs_write_scope answer's grant link comes
 * back to; the engine's rate_limited is a 429 with Retry-After when Linear
 * said when its limit resets.
 */
export function errorResponse(
  error: unknown,
  options: { returnTo?: string } = {}
): Response {
  const authCode = engineAuthCode(error);
  if (authCode !== null) {
    const message = (error as Error).message;
    if (authCode === 'needs_write_scope') {
      return needsWriteScope(message, options.returnTo);
    }
    const status = authCode === 'not_signed_in' ? 401 : 403;
    return jsonError(status, authCode, message);
  }
  const inputCode = engineInputCode(error);
  if (inputCode !== null) {
    const message = (error as Error).message;
    if (inputCode === 'rate_limited') {
      const raw = (error as { retryAt?: unknown }).retryAt;
      const retryAt = typeof raw === 'string' ? raw : null;
      const seconds = retryAfterSeconds(retryAt);
      return jsonError(
        429,
        inputCode,
        message,
        { retryAt },
        seconds === null ? undefined : { 'Retry-After': String(seconds) }
      );
    }
    const status =
      inputCode === 'not_found' ? 404 : inputCode === 'conflict' ? 409 : 400;
    return jsonError(status, inputCode, message);
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

/**
 * The largest JSON body any planner route reads: an issue description at
 * its 100,000-character limit, escaped, fits with room to spare. Bigger
 * bodies are refused unread (413), before zod's per-field limits.
 */
export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * Parses and validates a JSON body (at most MAX_JSON_BYTES); a Response
 * means "send this" (413 too_large, 400 invalid_json or invalid).
 */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>
): Promise<T | Response> {
  const text = await readLimitedText(request, MAX_JSON_BYTES);
  if (text === null) {
    return jsonError(413, 'too_large', 'Request body is too large.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
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
 * The read-only check of every mutating route (owner decision 2026-10-22,
 * "Guests limited to read only"): 403 read_only for a Linear guest, else
 * null. It runs the engine's own guard (requireWritable), so the routes
 * and the engine refuse with the same code and sentence; it comes right
 * after the CSRF guard and the session, before the body is read.
 */
export function refuseReadOnly(actor: Actor): Response | null {
  try {
    requireWritable(actor);
    return null;
  } catch (error) {
    return errorResponse(error);
  }
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
