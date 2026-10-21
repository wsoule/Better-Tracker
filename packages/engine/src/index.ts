// Public API of @better-tracker/engine (architecture §7.1): the engine
// factory, the env-driven boot shared by the web app and the worker, the
// error classes the web layer maps to HTTP statuses, and the contract types.

import { LinearApiError } from '@better-tracker/linear';

export * from './types';
export { createEngine } from './engine';
export { createEngineFromEnv, type CreateEngineFromEnvOptions } from './boot';
export {
  DEFAULT_APP_NAME,
  DEFAULT_DAILY_LEASE_MINUTES,
  type EngineEnv,
  isFixtureEnv,
  loadEngineConfigFromEnv,
} from './config';
export {
  createFixtureLinearProvider,
  createLinearProvider,
  type LinearProviderOptions,
  needsRefresh,
  REFRESH_MARGIN_MS,
} from './providers';
export {
  ALLOCATION_RUN_STALE_MINUTES,
  STALE_REASON_LABEL,
  type StaleReason,
} from './allocation-run';
export { SLACK_NOT_CONFIGURED } from './warning-run';
export { WEBHOOK_RETENTION_DAYS } from './cleanup';
export { DONE_MEANS_MAX_LENGTH, WEIGHT_MAX, WEIGHT_MIN } from './pm-edits';
export { LinearApiError };

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
