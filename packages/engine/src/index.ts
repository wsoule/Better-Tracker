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
  DEFAULT_MIRROR_CACHE_WORKSPACES,
  type EngineEnv,
  fixtureDatasetFromEnv,
  isApiKeyEnv,
  isDeployedEnv,
  isFixtureEnv,
  linearAuthFromEnv,
  loadEngineConfigFromEnv,
  MAX_WORKSPACE_ENTRIES,
  MAX_MIRROR_CACHE_WORKSPACES,
  processFlagProblem,
} from './config';
// Several workspaces (owner decision 2026-10-25): admission's verdicts and
// cache window, when a session's own sign-in URL key counts, the Slack
// fail-safe's digest note, and how many held tokens describeSessions
// describes.
export {
  ADMISSION_CACHE_MS,
  type AdmissionVerdict,
  newerSignInUrlKey,
} from './admission';
export { SLACK_SHARED_OFF } from './fail-safes';
export { MAX_DESCRIBED_SESSIONS } from './auth';
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
export {
  JOB_CLAIM_RETENTION_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  PURGE_AFTER_DAYS,
  REVOKE_WORST_MS,
  WEBHOOK_RETENTION_DAYS,
} from './cleanup';
// Several workspaces (owner decision 2026-10-25): the operator commands'
// limits, and the first-sync backoff a page waits out.
export {
  OPERATOR_OFF_MESSAGE,
  OPERATOR_PURGE_MIN_MINUTES,
  SESSION_REVOKE_CONCURRENCY,
} from './workspaces';
export {
  FIRST_SYNC_RETRY_MAX_MS,
  FIRST_SYNC_RETRY_MIN_MS,
  firstSyncRetryAt,
} from './sync';
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
