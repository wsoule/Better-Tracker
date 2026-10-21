import { EngineAuthError, EngineInputError } from '@better-tracker/engine';

// Engine error checks that survive bundling. The engine is created once
// per process and cached on globalThis (lib/runtime.ts) by whichever route
// or page bundle booted it first, and Next compiles each bundle with its
// own copy of @better-tracker/engine: an error thrown by the cached engine
// is then an instance of another copy's class, and `instanceof` fails.
// These checks fall back to the error's name and string `code`, as
// isLinearApiError does for LinearApiError.

export type EngineAuthCode = EngineAuthError['code'];
export type EngineInputCode = EngineInputError['code'];

function codeIfNamed(error: unknown, name: string): string | null {
  if (!(error instanceof Error) || error.name !== name) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** The code of an EngineAuthError from any bundle copy, else null. */
export function engineAuthCode(error: unknown): EngineAuthCode | null {
  if (error instanceof EngineAuthError) return error.code;
  return codeIfNamed(error, 'EngineAuthError') as EngineAuthCode | null;
}

/** The code of an EngineInputError from any bundle copy, else null. */
export function engineInputCode(error: unknown): EngineInputCode | null {
  if (error instanceof EngineInputError) return error.code;
  return codeIfNamed(error, 'EngineInputError') as EngineInputCode | null;
}
