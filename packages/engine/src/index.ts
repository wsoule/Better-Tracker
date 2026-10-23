// Public API of @better-tracker/engine (architecture §7.1): the engine
// factory, the env-driven boot shared by the web app and the worker, the
// error classes the web layer maps to HTTP statuses, and the contract types.

import { LinearApiError } from '@better-tracker/linear';

import { isLinearApiError } from './linear-errors';

export * from './types';
export { createEngine, SCHEDULED_OFF_MESSAGE } from './engine';
export {
  createApiKeyEngine,
  createEngineFromEnv,
  type CreateEngineFromEnvOptions,
} from './boot';
export {
  API_KEY_UNUSED_ENV_VARIABLES,
  apiKeyUnusedEnvVariables,
  DEFAULT_API_KEY_SYNC_INTERVAL_MINUTES,
  DEFAULT_APP_NAME,
  DEFAULT_DAILY_LEASE_MINUTES,
  type EngineEnv,
  fixtureDatasetFromEnv,
  isApiKeyEnv,
  isFixtureEnv,
  linearAuthFromEnv,
  loadEngineConfigFromEnv,
  processFlagProblem,
} from './config';
// api_key mode (owner request 2026-10-23). The key vault itself is not
// exported: only the engine reaches it.
export { API_KEY_IDLE_MS, API_KEY_MAX_MS } from './key-vault';
export { KEY_SHAPE_MESSAGE } from './key-auth';
export {
  isKeyPermissionRefusal,
  KEY_FORGOTTEN_MESSAGE,
  KEY_REJECTED_MESSAGE,
  NO_READER_MESSAGE,
} from './key-provider';
export { KEY_TEXT_MESSAGE } from './issue-edits';
export { OAUTH_OFF_MESSAGE } from './auth';
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
export {
  ISSUE_BULK_CONCURRENCY,
  ISSUE_BULK_MAX,
  normalizeIssueBulkPatch,
} from './bulk-issue-edits';
export { engineErrorFromLinear } from './linear-errors';
// The read-only guard (owner decision 2026-10-22, "Guests limited to read
// only"): the web routes that start actor-less jobs for a person (resync,
// the digest preview) call the same check the engine's methods do.
export {
  READ_ONLY_MESSAGE,
  READ_ONLY_MESSAGES,
  requireCanInstall,
  requireWritable,
} from './permissions';
export { LinearApiError, isLinearApiError };
