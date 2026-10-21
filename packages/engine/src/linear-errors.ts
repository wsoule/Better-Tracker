// Linear failures of a person's own write (issue edits, owner decision
// 2026-10-21), turned into the engine's error codes so the web layer can
// answer with the right status and a sentence the person can act on:
// forbidden → EngineAuthError('linear_forbidden'), a rejected token →
// 'not_signed_in', not found / invalid input / rate limit →
// EngineInputError('not_found' | 'invalid' | 'rate_limited'). Transport
// and server failures stay LinearApiError (the web layer answers 502).

import { LinearApiError } from '@better-tracker/linear';

import { EngineAuthError, EngineInputError } from './types';

/**
 * True for a LinearApiError, including one thrown by another bundled copy
 * of @better-tracker/linear (where instanceof fails): then the error's name
 * and `kind` identify it.
 */
export function isLinearApiError(error: unknown): error is LinearApiError {
  if (error instanceof LinearApiError) return true;
  return (
    error instanceof Error &&
    error.name === 'LinearApiError' &&
    typeof (error as { kind?: unknown }).kind === 'string'
  );
}

// What Linear said, as plainly as the error carries it: the gateway's
// readable message when it already wrote one (its cause is the original
// LinearApiError), else the first GraphQL error's user-presentable text,
// else the error's own message.
function linearDetail(error: LinearApiError): {
  text: string;
  readable: boolean;
} {
  const cause: unknown = error.cause;
  if (isLinearApiError(cause)) return { text: error.message, readable: true };
  if (typeof cause === 'object' && cause !== null && 'errors' in cause) {
    const list = (cause as { errors?: unknown }).errors;
    const first: unknown = Array.isArray(list) ? list[0] : undefined;
    if (typeof first === 'object' && first !== null) {
      const info = first as {
        userPresentableMessage?: unknown;
        message?: unknown;
      };
      const text =
        typeof info.userPresentableMessage === 'string'
          ? info.userPresentableMessage
          : typeof info.message === 'string'
            ? info.message
            : null;
      if (text !== null) return { text, readable: false };
    }
  }
  return { text: error.message, readable: false };
}

/**
 * The engine error for a Linear failure while trying to `action` (worded
 * as a verb phrase: "update the issue", "add the comment"). Errors that
 * are not LinearApiErrors, and transport/server failures, are returned
 * unchanged for the caller to rethrow.
 */
export function engineErrorFromLinear(error: unknown, action: string): unknown {
  if (!isLinearApiError(error)) return error;
  const { text, readable } = linearDetail(error);
  const said = (fallback: string): string => (readable ? text : fallback);
  switch (error.kind) {
    case 'forbidden':
      return new EngineAuthError(
        'linear_forbidden',
        said(`Linear does not let you ${action} (${text}).`)
      );
    case 'unauthorized':
      return new EngineAuthError(
        'not_signed_in',
        'Linear no longer accepts your sign-in. Sign in again, then retry.'
      );
    case 'not_found':
      return new EngineInputError(
        'not_found',
        said(`Linear could not ${action}: ${text}`)
      );
    case 'invalid_input':
      return new EngineInputError(
        'invalid',
        said(`Linear refused to ${action}: ${text}`)
      );
    case 'rate_limited':
      return new EngineInputError(
        'rate_limited',
        error.retryAt === null
          ? `Linear's rate limit was reached; could not ${action}. Try again in a minute.`
          : `Linear's rate limit was reached; could not ${action}. Try again after ${error.retryAt}.`,
        { retryAt: error.retryAt }
      );
    default:
      return error;
  }
}

/** Runs one Linear write, rethrowing its failure as an engine error. */
export async function linearWrite<T>(
  action: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw engineErrorFromLinear(error, action);
  }
}
