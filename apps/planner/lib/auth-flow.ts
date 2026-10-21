import { type Engine, isLinearApiError } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';

import { engineAuthCode, engineInputCode } from './engine-errors';

// Engine-facing helpers shared by the auth routes: turning a failure into
// the ?auth_error code the landing page explains, and ending a replaced
// session without failing the request that replaced it.

const logger = createLogger({ name: 'planner.auth' });

/**
 * The ?auth_error code for a failed sign-in, install or demo sign-in:
 * engine auth/input codes as they are, Linear failures as linear_<kind>,
 * anything unexpected as `internal` (logged here, since the redirect
 * carries no detail).
 */
export function authErrorCode(error: unknown, op: string): string {
  const engineCode = engineAuthCode(error) ?? engineInputCode(error);
  if (engineCode !== null) return engineCode;
  if (isLinearApiError(error)) {
    logger.warn('Linear refused an auth step', { op, kind: error.kind });
    return `linear_${error.kind}`;
  }
  logger.error('auth step failed', { op, err: error });
  return 'internal';
}

/**
 * Ends a session that a new sign-in replaced (its Linear token is revoked
 * by the engine, best effort). Never throws: the new session already
 * exists, and a stale row expires on its own.
 */
export async function signOutQuietly(
  engine: Engine,
  token: string
): Promise<void> {
  try {
    await engine.signOut(token);
  } catch (error) {
    logger.warn('could not end the previous session', { err: error });
  }
}

/** Logs a configuration problem the redirect cannot show in full. */
export function logConfigError(message: string, error: unknown): void {
  logger.error(message, { err: error });
}
