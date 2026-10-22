// Public API of @better-tracker/engine (architecture §7.1): the engine
// factory, the env-driven boot shared by the web app and the worker, the
// error classes the web layer maps to HTTP statuses, and the contract types.

import { LinearApiError } from '@better-tracker/linear';

import { isLinearApiError } from './linear-errors';

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
export {
  DONE_MEANS_MAX_LENGTH,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from './milestone-edits';
export { ISSUE_HISTORY_LIMIT } from './issue-detail';
export {
  normalizeCommentBody,
  normalizeIssuePatch,
  textSummary,
} from './issue-edits';
export { engineErrorFromLinear } from './linear-errors';
// The read-only guard (owner decision 2026-10-22, "Guests limited to read
// only"): the web routes that start actor-less jobs for a person (resync,
// the digest preview) call the same check the engine's methods do.
export {
  READ_ONLY_MESSAGE,
  requireCanInstall,
  requireWritable,
} from './permissions';
export { LinearApiError, isLinearApiError };
