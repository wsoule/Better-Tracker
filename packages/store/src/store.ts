import type {
  AllocationMode,
  BlockingRelation,
  Digest,
  Initiative,
  IsoDate,
  IsoDateTime,
  Issue,
  Milestone,
  MilestoneMeta,
  Project,
  Team,
  User,
  WarningMemory,
  WorkflowState,
  WorkspaceData,
  WorkspaceSettings,
} from '@better-tracker/core';
import { redactLinearSecrets } from '@better-tracker/core';
// The Store over SQL: one implementation for node-postgres and PGlite. Rows
// are mapped to the camelCase contract types explicitly; instants travel as
// ISO strings bound to `::timestamptz` parameters and come back as Date
// objects that are turned into UTC ISO strings again; calendar days are read
// back with to_char so no driver ever turns them into local-time Dates.
import { randomUUID } from 'node:crypto';

import {
  decryptToken,
  encryptToken,
  generateSessionToken,
  hashSessionToken,
  parseEncryptionKey,
} from './crypto';
import {
  isUniqueViolation,
  openPgliteSql,
  openPgSql,
  type Sql,
  type SqlLogger,
  type SqlParam,
} from './db';
import { StoreCredentialError, StoreNotFoundError } from './errors';
import { runMigrations } from './migrations';
import type {
  AllocationRun,
  AuditEntry,
  BlockedWorkspace,
  BlockKind,
  Installation,
  IssueRunEntry,
  LoadedMirror,
  MilestoneMetaField,
  MirrorEntity,
  MirrorKind,
  MirrorRef,
  NewRunEntry,
  NewSession,
  NotificationRecord,
  NotificationStatus,
  PurgeResult,
  RevokedReason,
  RunEntry,
  RunEntryAction,
  RunEntryOutcome,
  RunStatus,
  RunSummary,
  RunTrigger,
  Session,
  SessionDescription,
  Store,
  StoredTokens,
  SyncState,
  TakenSession,
  WorkspaceStatus,
  WorkspaceTable,
} from './types';

/** Structural logger (compatible with @better-tracker/logger's Logger). */
export type StoreLogger = SqlLogger;

export interface StoreOptions {
  /** Postgres connection string; unset or empty → PGlite. */
  databaseUrl?: string;
  /** PGlite data directory; unset → in-memory (tests). */
  pgliteDir?: string;
  /**
   * TOKEN_ENCRYPTION_KEY: 32 random bytes, base64. Null opens a
   * credential-free store (LINEAR_AUTH=api_key): it refuses every Linear
   * token (StoreCredentialError) and never decrypts a stored one.
   */
  encryptionKey: string | null;
  logger?: StoreLogger;
  /**
   * Clock for timestamps the contract does not pass in (session createdAt,
   * run entry createdAt, token rotation updatedAt). Defaults to the system
   * clock; tests inject a fixed one.
   */
  now?: () => Date;
}

export interface SqlStoreOptions {
  /** As StoreOptions.encryptionKey: null is credential-free. */
  encryptionKey: string | null;
  logger?: StoreLogger;
  now?: () => Date;
}

/** Opens the SQL backend chosen by the options (pg pool or PGlite). */
export async function openSql(options: {
  databaseUrl?: string;
  pgliteDir?: string;
  logger?: StoreLogger;
}): Promise<Sql> {
  if (options.databaseUrl !== undefined && options.databaseUrl !== '') {
    const sql = await openPgSql(options.databaseUrl, options.logger);
    // Never log the URL itself: it carries the database password.
    options.logger?.info('store opened', { driver: 'pg' });
    return sql;
  }
  const sql = await openPgliteSql(options.pgliteDir);
  options.logger?.info('store opened', {
    driver: 'pglite',
    dir: options.pgliteDir ?? 'memory',
  });
  return sql;
}

/**
 * Opens the store: node-postgres when databaseUrl is set, PGlite otherwise.
 * The encryption key is validated before connecting so a bad key fails
 * fast; a null key opens a credential-free store. Call migrate() before
 * first use.
 */
export async function openStore(options: StoreOptions): Promise<Store> {
  if (options.encryptionKey !== null) parseEncryptionKey(options.encryptionKey);
  const sql = await openSql(options);
  return createSqlStore(sql, options);
}

/**
 * Builds a Store over an already-open Sql handle (tests use this to inspect
 * raw tables). close() on the store closes the handle.
 */
export function createSqlStore(sql: Sql, options: SqlStoreOptions): Store {
  return new SqlStore(sql, options);
}

// ---------------------------------------------------------------------------
// Row shapes and value conversion
// ---------------------------------------------------------------------------

/** timestamptz as returned by the drivers (Date), tolerated as a string. */
type DbTimestamp = Date | string;
/** bigint: node-postgres returns a string, PGlite a number. */
type DbBigint = number | string;

interface TokenColumns {
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: DbTimestamp | null;
  token_scopes: unknown;
}

interface InstallationRow extends TokenColumns {
  workspace_id: string;
  workspace_name: string;
  url_key: string;
  app_user_id: string;
  installed_by_user_id: string;
  revoked_at: DbTimestamp | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

interface SessionRow extends TokenColumns {
  id: string;
  workspace_id: string;
  user_id: string;
  user_name: string;
  created_at: DbTimestamp;
  expires_at: DbTimestamp;
}

interface MilestoneMetaRow {
  milestone_id: string;
  weight: number | null;
  done_means: string | null;
  updated_at: DbTimestamp;
  updated_by: string | null;
}

interface SyncStateRow {
  workspace_id: string;
  version: DbBigint;
  last_full_sync_at: DbTimestamp | null;
  last_full_sync_status: 'ok' | 'failed' | null;
  last_full_sync_error: string | null;
  last_webhook_at: DbTimestamp | null;
  consecutive_failures: number;
  last_full_sync_ms: number | null;
  last_success_at: DbTimestamp | null;
  mirror_issue_count: number | null;
}

/**
 * listWorkspaceStatus: a workspace id with its installation columns (null
 * when never installed), its sync_state columns (null without a row) and
 * its session aggregate. No token column is selected.
 */
interface WorkspaceStatusRow {
  workspace_id: string;
  installation_name: string | null;
  url_key: string | null;
  app_user_id: string | null;
  installed_by_user_id: string | null;
  installed_at: DbTimestamp | null;
  updated_at: DbTimestamp | null;
  revoked_at: DbTimestamp | null;
  revoked_reason: RevokedReason | null;
  session_count: number | null;
  session_workspace_name: string | null;
  session_url_key: string | null;
  sync_workspace_id: string | null;
  version: DbBigint | null;
  last_full_sync_at: DbTimestamp | null;
  last_full_sync_status: 'ok' | 'failed' | null;
  last_full_sync_error: string | null;
  last_webhook_at: DbTimestamp | null;
  consecutive_failures: number | null;
  last_full_sync_ms: number | null;
  last_success_at: DbTimestamp | null;
  mirror_issue_count: number | null;
}

/** describeSessions: one session joined with its workspace; no tokens. */
interface SessionDescriptionRow {
  token_hash: string;
  workspace_id: string;
  workspace_name: string | null;
  workspace_url_key: string | null;
  user_id: string;
  user_name: string;
  expires_at: DbTimestamp;
  guest: boolean | null;
  installed: boolean;
  revoked_at: DbTimestamp | null;
  revoked_reason: RevokedReason | null;
}

interface BlockRow {
  key: string;
  kind: BlockKind;
  reason: string | null;
  created_at: DbTimestamp;
}

interface MirrorLoadRow {
  version: DbBigint;
  mirror_synced_at: DbTimestamp | null;
  kind: MirrorKind | null;
  data: unknown;
}

interface RunRow {
  id: string;
  workspace_id: string;
  mode: AllocationMode;
  run_trigger: RunTrigger;
  started_by_user_id: string | null;
  status: RunStatus;
  started_at: DbTimestamp;
  finished_at: DbTimestamp | null;
  summary: unknown;
  error: string | null;
}

interface EntryRow {
  run_id: string;
  seq: number;
  action: RunEntryAction;
  outcome: RunEntryOutcome;
  project_id: string;
  milestone_id: string | null;
  issue_id: string | null;
  issue_identifier: string | null;
  assignee_id: string | null;
  reason: string | null;
  detail: unknown;
  error: string | null;
  created_at: DbTimestamp;
}

interface WarningMemoryRow {
  subject_kind: 'milestone' | 'project';
  subject_id: string;
  last_key: string | null;
  last_notified_on: IsoDate | null;
  occurrence: number;
}

interface NotificationRow {
  id: string;
  workspace_id: string;
  day: IsoDate;
  recipient_id: string;
  channel: 'slack' | 'outbox';
  status: NotificationStatus;
  digest: unknown;
  error: string | null;
  created_at: DbTimestamp;
}

interface AuditRow {
  workspace_id: string;
  actor_user_id: string;
  action: AuditEntry['action'];
  subject_id: string;
  before_value: unknown;
  after_value: unknown;
  occurred_at: DbTimestamp;
}

/** One mirrored entity flattened for the bulk insert. */
interface MirrorInsertRow {
  kind: MirrorKind;
  id: string;
  data: unknown;
}

/**
 * How long withInstallationLock / withSessionLock wait for the row lock
 * (Postgres lock_timeout, local to the lock's transaction). A holder
 * refreshes tokens with Linear, which the OAuth client bounds at 15 s
 * (OAUTH_TIMEOUT_MS in @better-tracker/linear), so waiters normally get
 * the lock well within this; past it they fail with 55P03 instead of
 * piling up on pool connections behind a stuck holder.
 */
const TOKEN_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '30s'";

const INSTALLATION_COLUMNS = `workspace_id, workspace_name, url_key, app_user_id,
  installed_by_user_id, revoked_at, access_token_enc, refresh_token_enc,
  token_expires_at, token_scopes, created_at, updated_at`;

const SESSION_COLUMNS = `id, workspace_id, user_id, user_name, access_token_enc,
  refresh_token_enc, token_expires_at, token_scopes, created_at, expires_at`;

const SYNC_STATE_COLUMNS = `workspace_id, version, last_full_sync_at,
  last_full_sync_status, last_full_sync_error, last_webhook_at,
  consecutive_failures, last_full_sync_ms, last_success_at,
  mirror_issue_count`;

const REVOKED_REASONS: readonly RevokedReason[] = [
  'uninstalled',
  'grant_dead',
  'removed',
];

const BLOCK_KINDS: readonly BlockKind[] = ['id', 'url_key'];

/**
 * The tables purgeWorkspace empties, in delete order. It matches the
 * order other writers lock rows in, so a purge never deadlocks with them:
 * sync_state before mirror_entities (mirror writers bump the version row
 * first), allocation entries before their runs. The installation row is
 * locked first (FOR UPDATE) and deleted last. A test checks this list
 * against every table with a workspace_id column.
 */
const PURGE_ORDER: readonly WorkspaceTable[] = [
  'sessions',
  'settings',
  'milestone_meta',
  'sync_state',
  'mirror_entities',
  'webhook_deliveries',
  'allocation_entries',
  'allocation_runs',
  'warning_memory',
  'notifications',
  'job_claims',
  'audit_log',
  'admitted_workspaces',
  'installations',
];

const RUN_COLUMNS = `id, workspace_id, mode, run_trigger, started_by_user_id,
  status, started_at, finished_at, summary, error`;

const ENTRY_COLUMNS = `e.run_id, e.seq, e.action, e.outcome, e.project_id,
  e.milestone_id, e.issue_id, e.issue_identifier, e.assignee_id, e.reason,
  e.detail, e.error, e.created_at`;

const NOTIFICATION_COLUMNS = `id, workspace_id,
  to_char(day, 'YYYY-MM-DD') AS day, recipient_id, channel, status, digest,
  error, created_at`;

const MILESTONE_META_COLUMNS = `milestone_id, weight, done_means, updated_at,
  updated_by`;

// One statement per tool-owned meta field (never built from input): insert
// the row with only that field set, or update only that column plus the
// updated_by/updated_at stamp, so an edit of the other field made by
// another process in between is kept.
const UPDATE_META_FIELD_SQL: Record<MilestoneMetaField, string> = {
  weight: `INSERT INTO milestone_meta (workspace_id, milestone_id, weight,
      updated_at, updated_by)
    VALUES ($1, $2, $3::double precision, $4::timestamptz, $5)
    ON CONFLICT (workspace_id, milestone_id) DO UPDATE SET
      weight = EXCLUDED.weight, updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by
    RETURNING ${MILESTONE_META_COLUMNS}`,
  doneMeans: `INSERT INTO milestone_meta (workspace_id, milestone_id,
      done_means, updated_at, updated_by)
    VALUES ($1, $2, $3::text, $4::timestamptz, $5)
    ON CONFLICT (workspace_id, milestone_id) DO UPDATE SET
      done_means = EXCLUDED.done_means, updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by
    RETURNING ${MILESTONE_META_COLUMNS}`,
};

// Checks that a meta field value has the field's type before it is bound
// (a string must never reach the weight column, where Postgres would cast
// "12" to a number).
function checkMetaValue(
  field: MilestoneMetaField,
  value: number | string | null
): void {
  if (!Object.hasOwn(UPDATE_META_FIELD_SQL, field)) {
    throw new TypeError(`Unknown milestone meta field ${String(field)}`);
  }
  if (value === null) return;
  const ok =
    field === 'weight'
      ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === 'string';
  if (!ok) {
    throw new TypeError(
      field === 'weight'
        ? 'Milestone weight must be a finite number or null'
        : '"Done means…" must be a string or null'
    );
  }
}

/** Which WorkspaceData array each mirror kind lives in, in load order. */
const MIRROR_FIELDS = {
  user: 'users',
  team: 'teams',
  state: 'states',
  initiative: 'initiatives',
  project: 'projects',
  milestone: 'milestones',
  issue: 'issues',
  relation: 'relations',
} as const satisfies Record<
  MirrorKind,
  Exclude<keyof WorkspaceData, 'workspaceId'>
>;

const MIRROR_KINDS = Object.keys(MIRROR_FIELDS) as MirrorKind[];

// Bulk upsert of mirror rows from one JSON array parameter ($2). New rows are
// appended after the workspace's current highest ord (the subquery is
// evaluated once against the statement's snapshot), existing rows keep their
// position and take the new data.
const UPSERT_MIRROR_SQL = `
INSERT INTO mirror_entities (workspace_id, kind, id, ord, data, synced_at)
SELECT $1::text, e.value->>'kind', e.value->>'id',
  (SELECT COALESCE(MAX(m.ord), 0) FROM mirror_entities m WHERE m.workspace_id = $1::text) + e.ord,
  e.value->'data', $3::timestamptz
FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY AS e(value, ord)
ON CONFLICT (workspace_id, kind, id)
DO UPDATE SET data = EXCLUDED.data, synced_at = EXCLUDED.synced_at`;

// Drivers return timestamptz as Date; the contract speaks UTC ISO strings.
function toIso(value: DbTimestamp): IsoDateTime {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: DbTimestamp | null): IsoDateTime | null {
  return value === null ? null : toIso(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Settings keys earlier versions saved that no longer exist. `pmUserIds`
 * was the PM list, retired by the owner decision of 2026-10-22 (there is
 * no PM role any more): settings saved before it still carry the key, so
 * reads drop it and writes never store it again.
 */
const RETIRED_SETTINGS_KEYS: readonly string[] = ['pmUserIds'];

// The settings jsonb without the retired keys, so old rows read as the
// current WorkspaceSettings shape and a saved row never keeps them.
function withoutRetiredSettings(
  data: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of RETIRED_SETTINGS_KEYS) delete out[key];
  return out;
}

// A UTF-16 surrogate half without its partner (e.g. an emoji cut in two).
// It has no UTF-8 form, so Postgres cannot store it.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Makes a string storable in jsonb and text columns. jsonb rejects U+0000
// and lone surrogates outright, so a single such character in one mirrored
// title would otherwise fail a whole replaceMirror (and every later full
// sync); text rejects U+0000 too. NUL is dropped; a lone surrogate becomes
// U+FFFD, the same replacement a UTF-8 encoder makes for plain text
// parameters. write() applies it to every string parameter.
function storableString(value: string): string {
  return value.replaceAll('\u0000', '').replace(LONE_SURROGATE, '�');
}

/**
 * Planner-owned or error text with every Linear credential-shaped run
 * replaced (core's redactLinearSecrets), in every mode: a key pasted by
 * mistake into "done means…", a setting or an error message is stored as
 * `lin_api_[redacted]`. Never applied to the mirror (Linear's own data,
 * which must round-trip byte for byte), sessions, installations or
 * webhook records.
 */
function credentialFree(text: string): string;
function credentialFree(text: string | null): string | null;
function credentialFree(text: string | null): string | null {
  return text === null ? null : redactLinearSecrets(text);
}

// Serializes a value for a `::text::jsonb` parameter, cleaning every string
// with storableString (and, for planner-owned values, credentialFree).
// undefined (and other values JSON cannot represent) become JSON null
// rather than SQL NULL so a NOT NULL jsonb column never rejects them.
function jsonParam(
  value: unknown,
  options: { credentialFree?: boolean } = {}
): string {
  const scrub = options.credentialFree === true;
  const text: string | undefined = JSON.stringify(
    value,
    (_key: string, item: unknown): unknown =>
      typeof item === 'string'
        ? storableString(scrub ? credentialFree(item) : item)
        : item
  );
  return text ?? 'null';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The largest value a `$n::int` LIMIT parameter accepts (int4 max). */
const MAX_SQL_LIMIT = 2_147_483_647;

// LIMIT takes a non-negative int4 and callers pass UI-provided numbers:
// NaN and negatives become 0, fractions round down, and anything larger
// (Infinity included) is capped rather than failing the query.
function sqlLimit(limit: number): number {
  if (Number.isNaN(limit)) {
    return 0;
  }
  return Math.min(MAX_SQL_LIMIT, Math.max(0, Math.floor(limit)));
}

// Flattens a workspace into mirror rows in a fixed kind order, so loadMirror
// can rebuild each array in its original order from the ord column.
function flattenWorkspace(data: WorkspaceData): MirrorInsertRow[] {
  const rows: MirrorInsertRow[] = [];
  for (const kind of MIRROR_KINDS) {
    for (const entity of data[MIRROR_FIELDS[kind]]) {
      rows.push({ kind, id: entity.id, data: entity });
    }
  }
  return rows;
}

// Drops repeated (kind, id) pairs: a repeat keeps the first position and the
// last value, because one INSERT … ON CONFLICT cannot touch a row twice.
function dedupeMirrorRows(rows: Iterable<MirrorInsertRow>): MirrorInsertRow[] {
  const byKey = new Map<string, MirrorInsertRow>();
  for (const row of rows) {
    byKey.set(`${row.kind}\u0000${row.id}`, row);
  }
  return [...byKey.values()];
}

function emptyWorkspace(workspaceId: string): WorkspaceData {
  return {
    workspaceId,
    users: [],
    teams: [],
    states: [],
    initiatives: [],
    projects: [],
    milestones: [],
    issues: [],
    relations: [],
  };
}

// Puts one stored mirror row back into its WorkspaceData array. The JSON
// was written from the same typed entity, so the cast restores its type.
function addMirrorEntity(
  data: WorkspaceData,
  kind: MirrorKind,
  entity: unknown
): void {
  switch (kind) {
    case 'user':
      data.users.push(entity as User);
      break;
    case 'team':
      data.teams.push(entity as Team);
      break;
    case 'state':
      data.states.push(entity as WorkflowState);
      break;
    case 'initiative':
      data.initiatives.push(entity as Initiative);
      break;
    case 'project':
      data.projects.push(entity as Project);
      break;
    case 'milestone':
      data.milestones.push(entity as Milestone);
      break;
    case 'issue':
      data.issues.push(entity as Issue);
      break;
    case 'relation':
      data.relations.push(entity as BlockingRelation);
      break;
  }
}

// Increments sync_state.version (creating the row on the first write) and
// returns the new value. Every mirror-writing transaction calls this first:
// the row lock it takes serializes concurrent mirror writers per workspace.
// mirrorSyncedAt is set by full replacements only.
async function bumpMirrorVersion(
  tx: Sql,
  workspaceId: string,
  mirrorSyncedAt: IsoDateTime | null
): Promise<number> {
  const rows = await tx.query<{ version: DbBigint }>(
    `INSERT INTO sync_state (workspace_id, version, mirror_synced_at)
     VALUES ($1, 1, $2::timestamptz)
     ON CONFLICT (workspace_id) DO UPDATE SET
       version = sync_state.version + 1,
       mirror_synced_at = COALESCE(EXCLUDED.mirror_synced_at, sync_state.mirror_synced_at)
     RETURNING version`,
    [workspaceId, mirrorSyncedAt]
  );
  return Number(rows[0]?.version ?? 0);
}

function runFromRow(row: RunRow): AllocationRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode,
    trigger: row.run_trigger,
    startedByUserId: row.started_by_user_id,
    status: row.status,
    startedAt: toIso(row.started_at),
    finishedAt: toIsoOrNull(row.finished_at),
    summary: isRecord(row.summary)
      ? (row.summary as unknown as RunSummary)
      : null,
    error: row.error,
  };
}

function entryFromRow(row: EntryRow): RunEntry {
  return {
    runId: row.run_id,
    seq: Number(row.seq),
    action: row.action,
    outcome: row.outcome,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    assigneeId: row.assignee_id,
    reason: row.reason,
    detail: isRecord(row.detail) ? row.detail : {},
    error: row.error,
    createdAt: toIso(row.created_at),
  };
}

function notificationFromRow(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    day: row.day,
    recipientId: row.recipient_id,
    channel: row.channel,
    status: row.status,
    digest: row.digest as Digest,
    error: row.error,
    createdAt: toIso(row.created_at),
  };
}

function milestoneMetaFromRow(row: MilestoneMetaRow): MilestoneMeta {
  return {
    milestoneId: row.milestone_id,
    weight: row.weight === null ? null : Number(row.weight),
    doneMeans: row.done_means,
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
  };
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function syncStateFromRow(row: SyncStateRow): Required<SyncState> {
  return {
    workspaceId: row.workspace_id,
    version: Number(row.version),
    lastFullSyncAt: toIsoOrNull(row.last_full_sync_at),
    lastFullSyncStatus: row.last_full_sync_status,
    lastFullSyncError: row.last_full_sync_error,
    lastWebhookAt: toIsoOrNull(row.last_webhook_at),
    consecutiveFailures: Number(row.consecutive_failures),
    lastFullSyncMs: numberOrNull(row.last_full_sync_ms),
    lastSuccessAt: toIsoOrNull(row.last_success_at),
    mirrorIssueCount: numberOrNull(row.mirror_issue_count),
  };
}

// One listWorkspaceStatus row as the contract type. The installation's
// name and URL key win over the newest session's (sign-in values are the
// fallback for workspaces nobody installed yet).
function workspaceStatusFromRow(row: WorkspaceStatusRow): WorkspaceStatus {
  const installation =
    row.installation_name === null ||
    row.url_key === null ||
    row.installed_at === null ||
    row.updated_at === null
      ? null
      : {
          workspaceName: row.installation_name,
          urlKey: row.url_key,
          appUserId: row.app_user_id ?? '',
          installedByUserId: row.installed_by_user_id ?? '',
          createdAt: toIso(row.installed_at),
          updatedAt: toIso(row.updated_at),
          revokedAt: toIsoOrNull(row.revoked_at),
          revokedReason: row.revoked_reason,
        };
  const sync =
    row.sync_workspace_id === null || row.version === null
      ? null
      : syncStateFromRow({
          workspace_id: row.sync_workspace_id,
          version: row.version,
          last_full_sync_at: row.last_full_sync_at,
          last_full_sync_status: row.last_full_sync_status,
          last_full_sync_error: row.last_full_sync_error,
          last_webhook_at: row.last_webhook_at,
          consecutive_failures: row.consecutive_failures ?? 0,
          last_full_sync_ms: row.last_full_sync_ms,
          last_success_at: row.last_success_at,
          mirror_issue_count: row.mirror_issue_count,
        });
  return {
    workspaceId: row.workspace_id,
    workspaceName: installation?.workspaceName ?? row.session_workspace_name,
    urlKey: installation?.urlKey ?? row.session_url_key,
    installation,
    sync,
    sessionCount: Number(row.session_count ?? 0),
  };
}

// A whole number for an integer column (durations, counts): rounded,
// at least 0 and at most int4's maximum; NaN and undefined become null.
function intOrNull(value: number | undefined): number | null {
  if (value === undefined || Number.isNaN(value)) return null;
  return Math.min(MAX_SQL_LIMIT, Math.max(0, Math.round(value)));
}

function auditFromRow(row: AuditRow): AuditEntry {
  return {
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    subjectId: row.subject_id,
    before: row.before_value,
    after: row.after_value,
    at: toIso(row.occurred_at),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class SqlStore implements Store {
  private readonly sql: Sql;
  /** Null: credential-free (tokenParams refuses tokens, nothing is decrypted). */
  private readonly key: Buffer | null;
  private readonly logger: StoreLogger | undefined;
  private readonly clock: () => Date;

  constructor(sql: Sql, options: SqlStoreOptions) {
    this.sql = sql;
    this.key =
      options.encryptionKey === null
        ? null
        : parseEncryptionKey(options.encryptionKey);
    this.logger = options.logger;
    this.clock = options.now ?? (() => new Date());
  }

  private nowIso(): IsoDateTime {
    return this.clock().toISOString();
  }

  // Runs one writing statement in a transaction of its own. transaction()
  // pins READ COMMITTED in BEGIN, so the write gives the same answer
  // whatever the connection's default isolation (a transaction-mode
  // pooler can drop the startup option that sets it): at REPEATABLE READ,
  // an upsert, update or delete that waited on another writer's row fails
  // with a serialization error instead, and an ON CONFLICT DO NOTHING
  // claim reports that error rather than "already claimed". Plain reads
  // stay single statements.
  // Runs one write statement in its own transaction. String parameters
  // go through storableString first: Postgres rejects U+0000 in text as
  // in jsonb ("invalid byte sequence"), so a NUL in free text (an error
  // message, "done means…") must not fail the write. The engine refuses
  // control characters in what people type; this is the backstop.
  private write<T>(text: string, params?: readonly SqlParam[]): Promise<T[]> {
    const cleaned = params?.map((param) =>
      typeof param === 'string' ? storableString(param) : param
    );
    return this.sql.transaction((tx) => tx.query<T>(text, cleaned));
  }

  // The four token columns shared by installations and sessions, in the
  // order the INSERT/UPDATE statements below bind them. A blank access
  // token is stored as '' (a binding row written in api_key mode). A
  // credential-free store refuses any token at all.
  private tokenParams(tokens: StoredTokens): SqlParam[] {
    const key = this.key;
    if (key === null) {
      if (tokens.accessToken !== '' || tokens.refreshToken !== null) {
        throw new StoreCredentialError(
          'This store keeps no Linear credentials (LINEAR_AUTH=api_key).'
        );
      }
      return ['', null, tokens.expiresAt, jsonParam(tokens.scopes)];
    }
    return [
      tokens.accessToken === '' ? '' : encryptToken(tokens.accessToken, key),
      tokens.refreshToken === null
        ? null
        : encryptToken(tokens.refreshToken, key),
      tokens.expiresAt,
      jsonParam(tokens.scopes),
    ];
  }

  // A credential-free store never decrypts: whatever the columns hold (an
  // OAuth deploy's ciphertexts), it hands back blank tokens.
  private tokensFromRow(row: TokenColumns): StoredTokens {
    const key = this.key;
    if (key === null) {
      return {
        accessToken: '',
        refreshToken: null,
        expiresAt: toIsoOrNull(row.token_expires_at),
        scopes: stringArray(row.token_scopes),
      };
    }
    return {
      accessToken:
        row.access_token_enc === ''
          ? ''
          : decryptToken(row.access_token_enc, key),
      refreshToken:
        row.refresh_token_enc === null
          ? null
          : decryptToken(row.refresh_token_enc, key),
      expiresAt: toIsoOrNull(row.token_expires_at),
      scopes: stringArray(row.token_scopes),
    };
  }

  private installationFromRow(row: InstallationRow): Installation {
    return {
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      urlKey: row.url_key,
      appUserId: row.app_user_id,
      installedByUserId: row.installed_by_user_id,
      revokedAt: toIsoOrNull(row.revoked_at),
      tokens: this.tokensFromRow(row),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private sessionFromRow(row: SessionRow): Session {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      userName: row.user_name,
      tokens: this.tokensFromRow(row),
      createdAt: toIso(row.created_at),
      expiresAt: toIso(row.expires_at),
    };
  }

  // --- lifecycle ------------------------------------------------------------

  async migrate(): Promise<void> {
    await runMigrations(this.sql, undefined, this.logger);
  }

  close(): Promise<void> {
    return this.sql.close();
  }

  async ping(): Promise<boolean> {
    try {
      const rows = await this.sql.query<{ ok: number }>('SELECT 1 AS ok');
      return rows.length === 1;
    } catch (error) {
      this.logger?.warn('store ping failed', { error });
      return false;
    }
  }

  // --- installations ----------------------------------------------------------

  async getInstallation(workspaceId: string): Promise<Installation | null> {
    const rows = await this.sql.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE workspace_id = $1`,
      [workspaceId]
    );
    const row = rows[0];
    return row === undefined ? null : this.installationFromRow(row);
  }

  async listInstallations(): Promise<Installation[]> {
    const rows = await this.sql.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM installations
       ORDER BY created_at, workspace_id`
    );
    return rows.map((row) => this.installationFromRow(row));
  }

  /**
   * Upserts the whole row. revoked_reason follows revoked_at: a reinstall
   * (revokedAt null) clears both; a row saved revoked keeps its recorded
   * reason, or gets 'grant_dead' (cause unknown) when it has none.
   */
  async saveInstallation(installation: Installation): Promise<void> {
    await this.write(
      `INSERT INTO installations (${INSTALLATION_COLUMNS}, revoked_reason)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz,
         $10::text::jsonb, $11::timestamptz, $12::timestamptz,
         CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE 'grant_dead' END)
       ON CONFLICT (workspace_id) DO UPDATE SET
         workspace_name = EXCLUDED.workspace_name,
         url_key = EXCLUDED.url_key,
         app_user_id = EXCLUDED.app_user_id,
         installed_by_user_id = EXCLUDED.installed_by_user_id,
         revoked_at = EXCLUDED.revoked_at,
         revoked_reason = CASE WHEN EXCLUDED.revoked_at IS NULL THEN NULL
           ELSE COALESCE(installations.revoked_reason, EXCLUDED.revoked_reason)
           END,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         token_expires_at = EXCLUDED.token_expires_at,
         token_scopes = EXCLUDED.token_scopes,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        installation.workspaceId,
        installation.workspaceName,
        installation.urlKey,
        installation.appUserId,
        installation.installedByUserId,
        installation.revokedAt,
        ...this.tokenParams(installation.tokens),
        installation.createdAt,
        installation.updatedAt,
      ]
    );
  }

  async updateInstallationIdentity(
    workspaceId: string,
    identity: { workspaceName: string; urlKey: string }
  ): Promise<boolean> {
    const rows = await this.write<{ workspace_id: string }>(
      `UPDATE installations SET workspace_name = $2, url_key = $3
       WHERE workspace_id = $1
         AND (workspace_name <> $2 OR url_key <> $3)
       RETURNING workspace_id`,
      [workspaceId, identity.workspaceName, identity.urlKey]
    );
    return rows.length === 1;
  }

  /**
   * Holds `SELECT … FOR UPDATE` on the installation row while fn runs, and
   * writes fn's rotated tokens in the same transaction, so a concurrent
   * refresher waits and then sees the new refresh token. fn must not call
   * the store itself: on PGlite the transaction owns the only connection.
   * A waiter gives up after 30 s (TOKEN_LOCK_TIMEOUT, Postgres 55P03)
   * instead of holding a pool connection behind a stuck holder.
   */
  withInstallationLock<T>(
    workspaceId: string,
    fn: (
      installation: Installation
    ) => Promise<{ result: T; tokens?: StoredTokens }>
  ): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query(TOKEN_LOCK_TIMEOUT);
      const rows = await tx.query<InstallationRow>(
        `SELECT ${INSTALLATION_COLUMNS} FROM installations
         WHERE workspace_id = $1 FOR UPDATE`,
        [workspaceId]
      );
      const row = rows[0];
      if (row === undefined) {
        throw new StoreNotFoundError('installation', workspaceId);
      }
      const { result, tokens } = await fn(this.installationFromRow(row));
      if (tokens !== undefined) {
        await tx.query(
          `UPDATE installations SET access_token_enc = $2,
             refresh_token_enc = $3, token_expires_at = $4::timestamptz,
             token_scopes = $5::text::jsonb, updated_at = $6::timestamptz
           WHERE workspace_id = $1`,
          [workspaceId, ...this.tokenParams(tokens), this.nowIso()]
        );
      }
      return result;
    });
  }

  async markInstallationRevoked(
    workspaceId: string,
    at: IsoDateTime
  ): Promise<void> {
    await this.write(
      `UPDATE installations SET revoked_at = $2::timestamptz,
         updated_at = $2::timestamptz,
         revoked_reason = COALESCE(revoked_reason, 'grant_dead')
       WHERE workspace_id = $1`,
      [workspaceId, at]
    );
  }

  /**
   * One UPDATE whose WHERE holds every rule (stale guard, already revoked,
   * the grant_dead upgrade), so concurrent revokes and a reinstall racing
   * it resolve on the row lock: the second writer re-checks the WHERE
   * against the first one's commit. The credentials are wiped with the
   * blank sentinel tokensFromRow already reads as "no token".
   */
  async revokeInstallation(
    workspaceId: string,
    reason: RevokedReason,
    now: IsoDateTime,
    options: { ifUpdatedBefore?: IsoDateTime } = {}
  ): Promise<boolean> {
    if (!REVOKED_REASONS.includes(reason)) {
      throw new TypeError(`Unknown revoke reason ${String(reason)}`);
    }
    const rows = await this.write<{ workspace_id: string }>(
      `UPDATE installations SET revoked_at = $3::timestamptz,
         revoked_reason = $2::text,
         access_token_enc = '', refresh_token_enc = NULL,
         token_expires_at = NULL
       WHERE workspace_id = $1
         AND ($4::timestamptz IS NULL OR updated_at <= $4::timestamptz)
         AND (revoked_at IS NULL
           OR (COALESCE(revoked_reason, 'grant_dead') = 'grant_dead'
             AND $2::text <> 'grant_dead'))
       RETURNING workspace_id`,
      [workspaceId, reason, now, options.ifUpdatedBefore ?? null]
    );
    return rows.length === 1;
  }

  /**
   * Workspace ids come from installations and sessions (UNION), so a
   * workspace people signed in to but nobody installed is listed too; its
   * name and URL key are the newest session's sign-in values.
   */
  async listWorkspaceStatus(now?: IsoDateTime): Promise<WorkspaceStatus[]> {
    const rows = await this.sql.query<WorkspaceStatusRow>(
      `WITH s AS (
         SELECT workspace_id,
           count(*) FILTER (WHERE $1::timestamptz IS NULL
             OR expires_at > $1::timestamptz)::int AS session_count,
           (array_agg(workspace_name ORDER BY created_at DESC, id DESC)
             FILTER (WHERE workspace_name IS NOT NULL))[1]
             AS session_workspace_name,
           (array_agg(workspace_url_key ORDER BY created_at DESC, id DESC)
             FILTER (WHERE workspace_url_key IS NOT NULL))[1]
             AS session_url_key
         FROM sessions GROUP BY workspace_id
       ),
       ids AS (
         SELECT workspace_id FROM installations
         UNION SELECT workspace_id FROM s
       )
       SELECT ids.workspace_id,
         i.workspace_name AS installation_name, i.url_key, i.app_user_id,
         i.installed_by_user_id, i.created_at AS installed_at, i.updated_at,
         i.revoked_at, i.revoked_reason,
         s.session_count, s.session_workspace_name, s.session_url_key,
         st.workspace_id AS sync_workspace_id, st.version,
         st.last_full_sync_at, st.last_full_sync_status,
         st.last_full_sync_error, st.last_webhook_at,
         st.consecutive_failures, st.last_full_sync_ms, st.last_success_at,
         st.mirror_issue_count
       FROM ids
       LEFT JOIN installations i ON i.workspace_id = ids.workspace_id
       LEFT JOIN s ON s.workspace_id = ids.workspace_id
       LEFT JOIN sync_state st ON st.workspace_id = ids.workspace_id
       ORDER BY st.last_full_sync_at ASC NULLS FIRST, ids.workspace_id`,
      [now ?? null]
    );
    return rows.map(workspaceStatusFromRow);
  }

  /**
   * Locks the installation row first: a reinstall in flight (its upsert
   * holds the row) commits before the check, which then sees the row
   * active and refuses; a reinstall arriving after the lock waits and, once
   * the purge commits, inserts a fresh row. Each table is emptied with one
   * DELETE whose rows are only counted (a CTE), never sent back.
   */
  purgeWorkspace(
    workspaceId: string,
    options: { revokedBefore: IsoDateTime; allowGrantDead?: boolean }
  ): Promise<PurgeResult> {
    return this.sql.transaction(async (tx): Promise<PurgeResult> => {
      await tx.query(TOKEN_LOCK_TIMEOUT);
      const rows = await tx.query<{
        revoked: boolean;
        before_cutoff: boolean;
        revoked_reason: RevokedReason | null;
      }>(
        `SELECT revoked_at IS NOT NULL AS revoked,
           COALESCE(revoked_at < $2::timestamptz, false) AS before_cutoff,
           revoked_reason
         FROM installations WHERE workspace_id = $1 FOR UPDATE`,
        [workspaceId, options.revokedBefore]
      );
      const row = rows[0];
      if (row === undefined) return { purged: false, reason: 'not_installed' };
      if (!row.revoked) return { purged: false, reason: 'not_revoked' };
      const reason = row.revoked_reason ?? 'grant_dead';
      if (reason === 'grant_dead' && options.allowGrantDead !== true) {
        return { purged: false, reason: 'grant_dead' };
      }
      if (!row.before_cutoff) return { purged: false, reason: 'too_recent' };
      const counts = {} as Record<WorkspaceTable, number>;
      for (const table of PURGE_ORDER) {
        // Table names come from PURGE_ORDER, never from input.
        const deleted = await tx.query<{ n: number }>(
          `WITH d AS (DELETE FROM ${table} WHERE workspace_id = $1 RETURNING 1)
           SELECT count(*)::int AS n FROM d`,
          [workspaceId]
        );
        counts[table] = Number(deleted[0]?.n ?? 0);
      }
      return { purged: true, counts };
    });
  }

  // --- sessions -----------------------------------------------------------------

  async createSession(
    session: NewSession
  ): Promise<{ token: string; session: Session }> {
    const token = generateSessionToken();
    const rows = await this.write<SessionRow>(
      `INSERT INTO sessions (id, token_hash, workspace_id, user_id, user_name,
         access_token_enc, refresh_token_enc, token_expires_at, token_scopes,
         created_at, expires_at, workspace_name, workspace_url_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::text::jsonb,
         $10::timestamptz, $11::timestamptz, $12, $13)
       RETURNING ${SESSION_COLUMNS}`,
      [
        randomUUID(),
        hashSessionToken(token),
        session.workspaceId,
        session.userId,
        session.userName,
        ...this.tokenParams(session.tokens),
        this.nowIso(),
        session.expiresAt,
        session.workspaceName ?? null,
        session.workspaceUrlKey ?? null,
      ]
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Session insert returned no row');
    }
    return { token, session: this.sessionFromRow(row) };
  }

  /**
   * The token hashes travel as one JSON array parameter (SqlParam has no
   * arrays). guest is null without a mirror user row and false for a row
   * that has no guest field (mirrors written before 2026-10-22). The
   * installation's name and URL key win over the session's sign-in values
   * (every full sync and sign-in refreshes them; listWorkspaceStatus picks
   * the same way), so a rename shows, and admits, everywhere at once.
   */
  async describeSessions(
    tokens: readonly string[],
    now: IsoDateTime
  ): Promise<(SessionDescription | null)[]> {
    if (tokens.length === 0) return [];
    const hashes = tokens.map(hashSessionToken);
    const rows = await this.sql.query<SessionDescriptionRow>(
      `SELECT s.token_hash, s.workspace_id,
         COALESCE(i.workspace_name, s.workspace_name) AS workspace_name,
         COALESCE(i.url_key, s.workspace_url_key) AS workspace_url_key,
         s.user_id, s.user_name, s.expires_at,
         CASE WHEN m.id IS NULL THEN NULL
           ELSE COALESCE(m.data->>'guest' = 'true', false) END AS guest,
         i.workspace_id IS NOT NULL AS installed,
         i.revoked_at, i.revoked_reason
       FROM sessions s
       LEFT JOIN installations i ON i.workspace_id = s.workspace_id
       LEFT JOIN mirror_entities m ON m.workspace_id = s.workspace_id
         AND m.kind = 'user' AND m.id = s.user_id
       WHERE s.token_hash = ANY (ARRAY(
           SELECT jsonb_array_elements_text($1::text::jsonb)))
         AND s.expires_at > $2::timestamptz`,
      [jsonParam(hashes), now]
    );
    const byHash = new Map(rows.map((row) => [row.token_hash, row]));
    return tokens.map((token, index): SessionDescription | null => {
      const row = byHash.get(hashes[index] ?? '');
      if (row === undefined) return null;
      return {
        token,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        workspaceUrlKey: row.workspace_url_key,
        userId: row.user_id,
        userName: row.user_name,
        expiresAt: toIso(row.expires_at),
        guest: row.guest,
        installed: row.installed,
        revokedAt: toIsoOrNull(row.revoked_at),
        revokedReason: row.revoked_reason,
      };
    });
  }

  async getSession(token: string, now: IsoDateTime): Promise<Session | null> {
    const rows = await this.sql.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE token_hash = $1 AND expires_at > $2::timestamptz`,
      [hashSessionToken(token), now]
    );
    const row = rows[0];
    return row === undefined ? null : this.sessionFromRow(row);
  }

  /** Same locking contract as withInstallationLock, on the session row. */
  withSessionLock<T>(
    sessionId: string,
    fn: (session: Session) => Promise<{ result: T; tokens?: StoredTokens }>
  ): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query(TOKEN_LOCK_TIMEOUT);
      const rows = await tx.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const row = rows[0];
      if (row === undefined) {
        throw new StoreNotFoundError('session', sessionId);
      }
      const { result, tokens } = await fn(this.sessionFromRow(row));
      if (tokens !== undefined) {
        await tx.query(
          `UPDATE sessions SET access_token_enc = $2, refresh_token_enc = $3,
             token_expires_at = $4::timestamptz, token_scopes = $5::text::jsonb
           WHERE id = $1`,
          [sessionId, ...this.tokenParams(tokens)]
        );
      }
      return result;
    });
  }

  async deleteSession(token: string): Promise<void> {
    await this.write('DELETE FROM sessions WHERE token_hash = $1', [
      hashSessionToken(token),
    ]);
  }

  async deleteExpiredSessions(now: IsoDateTime): Promise<number> {
    const rows = await this.write<{ id: string }>(
      `DELETE FROM sessions WHERE expires_at <= $1::timestamptz RETURNING id`,
      [now]
    );
    return rows.length;
  }

  /**
   * One DELETE … RETURNING over the oldest expired rows. SKIP LOCKED leaves
   * a row alone while withSessionLock holds it (a refresh in flight) and
   * lets two cleaners run at once without taking the same session twice.
   * Tokens are decrypted per row so one unreadable row (encrypted with
   * another key) cannot hide the others' tokens.
   */
  async takeExpiredSessions(
    now: IsoDateTime,
    limit: number
  ): Promise<Session[]> {
    const rows = await this.write<SessionRow>(
      `DELETE FROM sessions WHERE id IN (
         SELECT id FROM sessions WHERE expires_at <= $1::timestamptz
         ORDER BY expires_at, id LIMIT $2::int
         FOR UPDATE SKIP LOCKED)
       RETURNING ${SESSION_COLUMNS}`,
      [now, sqlLimit(limit)]
    );
    const sessions: Session[] = [];
    for (const row of rows) {
      try {
        sessions.push(this.sessionFromRow(row));
      } catch (error) {
        this.logger?.warn(
          'deleted an expired session whose tokens could not be decrypted',
          { sessionId: row.id, workspaceId: row.workspace_id, error }
        );
      }
    }
    // RETURNING has no defined order; hand them back oldest first (UTC ISO
    // strings sort by time).
    return sessions.sort((a, b) => {
      if (a.expiresAt !== b.expiresAt) {
        return a.expiresAt < b.expiresAt ? -1 : 1;
      }
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
  }

  /**
   * One DELETE … RETURNING over the workspace's oldest sessions, whose
   * subquery locks them FOR UPDATE without SKIP LOCKED: a row held by
   * withSessionLock (a refresh in flight) is waited for, and the row
   * deleted is the version that refresh committed (its rotated tokens).
   * lock_timeout bounds the wait as for the token locks. Tokens are
   * decrypted per row, so an unreadable row only loses its own tokens.
   */
  async takeSessionsForWorkspace(
    workspaceId: string,
    options: { createdBefore?: IsoDateTime; limit: number }
  ): Promise<TakenSession[]> {
    const rows = await this.sql.transaction(async (tx) => {
      await tx.query(TOKEN_LOCK_TIMEOUT);
      return tx.query<SessionRow>(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions
           WHERE workspace_id = $1
             AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
           ORDER BY created_at, id LIMIT $3::int
           FOR UPDATE)
         RETURNING ${SESSION_COLUMNS}`,
        [workspaceId, options.createdBefore ?? null, sqlLimit(options.limit)]
      );
    });
    const taken = rows.map((row): TakenSession => {
      let tokens: StoredTokens | null = null;
      try {
        tokens = this.tokensFromRow(row);
      } catch (error) {
        this.logger?.warn(
          'deleted a session whose tokens could not be decrypted',
          { sessionId: row.id, workspaceId: row.workspace_id, error }
        );
      }
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        userName: row.user_name,
        tokens,
        createdAt: toIso(row.created_at),
        expiresAt: toIso(row.expires_at),
      };
    });
    // RETURNING has no defined order; oldest created first, then id.
    return taken.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
  }

  // --- settings and milestone meta ----------------------------------------------

  async getSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
    const rows = await this.sql.query<{ data: unknown }>(
      'SELECT data FROM settings WHERE workspace_id = $1',
      [workspaceId]
    );
    const data = rows[0]?.data;
    if (!isRecord(data)) {
      return null;
    }
    return {
      ...(withoutRetiredSettings(data) as unknown as WorkspaceSettings),
      workspaceId,
    };
  }

  async saveSettings(settings: WorkspaceSettings): Promise<void> {
    // A caller may hand back an object spread from an old row; the retired
    // keys are never written again.
    const data = withoutRetiredSettings({ ...settings });
    await this.write(
      `INSERT INTO settings (workspace_id, data, updated_at)
       VALUES ($1, $2::text::jsonb, $3::timestamptz)
       ON CONFLICT (workspace_id) DO UPDATE SET
         data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [
        settings.workspaceId,
        jsonParam(data, { credentialFree: true }),
        this.nowIso(),
      ]
    );
  }

  async listMilestoneMeta(workspaceId: string): Promise<MilestoneMeta[]> {
    const rows = await this.sql.query<MilestoneMetaRow>(
      `SELECT ${MILESTONE_META_COLUMNS}
       FROM milestone_meta WHERE workspace_id = $1 ORDER BY milestone_id`,
      [workspaceId]
    );
    return rows.map(milestoneMetaFromRow);
  }

  async updateMilestoneMetaField(
    workspaceId: string,
    milestoneId: string,
    field: MilestoneMetaField,
    value: number | string | null,
    updatedBy: string,
    at: IsoDateTime
  ): Promise<MilestoneMeta> {
    checkMetaValue(field, value);
    const rows = await this.write<MilestoneMetaRow>(
      UPDATE_META_FIELD_SQL[field],
      [
        workspaceId,
        milestoneId,
        typeof value === 'string' ? credentialFree(value) : value,
        at,
        updatedBy,
      ]
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Milestone meta upsert returned no row');
    }
    return milestoneMetaFromRow(row);
  }

  async upsertMilestoneMeta(
    workspaceId: string,
    meta: MilestoneMeta
  ): Promise<void> {
    await this.write(
      `INSERT INTO milestone_meta (workspace_id, milestone_id, weight,
         done_means, updated_at, updated_by)
       VALUES ($1, $2, $3::double precision, $4, $5::timestamptz, $6)
       ON CONFLICT (workspace_id, milestone_id) DO UPDATE SET
         weight = EXCLUDED.weight, done_means = EXCLUDED.done_means,
         updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [
        workspaceId,
        meta.milestoneId,
        meta.weight,
        credentialFree(meta.doneMeans),
        meta.updatedAt,
        meta.updatedBy,
      ]
    );
  }

  // --- Linear mirror --------------------------------------------------------------

  replaceMirror(data: WorkspaceData, syncedAt: IsoDateTime): Promise<number> {
    const rows = dedupeMirrorRows(flattenWorkspace(data));
    return this.sql.transaction(async (tx) => {
      const version = await bumpMirrorVersion(tx, data.workspaceId, syncedAt);
      // Delete-then-insert inside one transaction: entities missing from
      // data disappear, and readers see either the old or the new mirror.
      await tx.query('DELETE FROM mirror_entities WHERE workspace_id = $1', [
        data.workspaceId,
      ]);
      if (rows.length > 0) {
        await tx.query(UPSERT_MIRROR_SQL, [
          data.workspaceId,
          jsonParam(rows),
          syncedAt,
        ]);
      }
      return version;
    });
  }

  async loadMirror(workspaceId: string): Promise<LoadedMirror | null> {
    // One statement, so the version and the entities come from the same
    // snapshot even while a replaceMirror commits concurrently.
    const rows = await this.sql.query<MirrorLoadRow>(
      `SELECT s.version, s.mirror_synced_at, m.kind, m.data
       FROM sync_state s
       LEFT JOIN mirror_entities m ON m.workspace_id = s.workspace_id
       WHERE s.workspace_id = $1
       ORDER BY m.ord, m.kind, m.id`,
      [workspaceId]
    );
    const first = rows[0];
    if (first === undefined || Number(first.version) === 0) {
      return null;
    }
    const data = emptyWorkspace(workspaceId);
    for (const row of rows) {
      if (row.kind !== null) {
        addMirrorEntity(data, row.kind, row.data);
      }
    }
    return {
      data,
      version: Number(first.version),
      lastFullSyncAt: toIsoOrNull(first.mirror_synced_at),
    };
  }

  /**
   * Removes `remove` first and then upserts `upsert`, so a caller replacing
   * a set (e.g. every relation touching an issue) can list the old refs in
   * remove and the current entities in upsert, overlaps included.
   */
  async applyMirrorChanges(
    workspaceId: string,
    changes: { upsert: MirrorEntity[]; remove: MirrorRef[] }
  ): Promise<number> {
    if (changes.upsert.length === 0 && changes.remove.length === 0) {
      return (await this.getSyncState(workspaceId))?.version ?? 0;
    }
    const upserts = dedupeMirrorRows(
      changes.upsert.map((change) => ({
        kind: change.kind,
        id: change.entity.id,
        data: change.entity,
      }))
    );
    const syncedAt = this.nowIso();
    return this.sql.transaction(async (tx) => {
      const version = await bumpMirrorVersion(tx, workspaceId, null);
      if (changes.remove.length > 0) {
        await tx.query(
          `DELETE FROM mirror_entities m
           USING jsonb_to_recordset($2::text::jsonb) AS r(kind text, id text)
           WHERE m.workspace_id = $1 AND m.kind = r.kind AND m.id = r.id`,
          [
            workspaceId,
            jsonParam(
              changes.remove.map((ref) => ({ kind: ref.kind, id: ref.id }))
            ),
          ]
        );
      }
      if (upserts.length > 0) {
        await tx.query(UPSERT_MIRROR_SQL, [
          workspaceId,
          jsonParam(upserts),
          syncedAt,
        ]);
      }
      return version;
    });
  }

  async getSyncState(workspaceId: string): Promise<SyncState | null> {
    const rows = await this.sql.query<SyncStateRow>(
      `SELECT ${SYNC_STATE_COLUMNS} FROM sync_state WHERE workspace_id = $1`,
      [workspaceId]
    );
    const row = rows[0];
    return row === undefined ? null : syncStateFromRow(row);
  }

  /**
   * One upsert. The failure count is computed from the row as it is when
   * the upsert takes its lock, so concurrent recorders each count once.
   */
  async recordFullSync(
    workspaceId: string,
    result: {
      at: IsoDateTime;
      ok: boolean;
      error: string | null;
      durationMs?: number;
      issueCount?: number;
    }
  ): Promise<void> {
    await this.write(
      `INSERT INTO sync_state (workspace_id, last_full_sync_at,
         last_full_sync_status, last_full_sync_error, consecutive_failures,
         last_success_at, last_full_sync_ms, mirror_issue_count)
       VALUES ($1, $2::timestamptz, $3::text, $4,
         CASE WHEN $3::text = 'ok' THEN 0 ELSE 1 END,
         CASE WHEN $3::text = 'ok' THEN $2::timestamptz END,
         $5::int, $6::int)
       ON CONFLICT (workspace_id) DO UPDATE SET
         last_full_sync_at = EXCLUDED.last_full_sync_at,
         last_full_sync_status = EXCLUDED.last_full_sync_status,
         last_full_sync_error = EXCLUDED.last_full_sync_error,
         consecutive_failures = CASE
           WHEN EXCLUDED.last_full_sync_status = 'ok' THEN 0
           ELSE sync_state.consecutive_failures + 1 END,
         last_success_at = COALESCE(EXCLUDED.last_success_at,
           sync_state.last_success_at),
         last_full_sync_ms = COALESCE(EXCLUDED.last_full_sync_ms,
           sync_state.last_full_sync_ms),
         mirror_issue_count = COALESCE(EXCLUDED.mirror_issue_count,
           sync_state.mirror_issue_count)`,
      [
        workspaceId,
        result.at,
        result.ok ? 'ok' : 'failed',
        credentialFree(result.error),
        intOrNull(result.durationMs),
        intOrNull(result.issueCount),
      ]
    );
  }

  recordWebhookDelivery(input: {
    deliveryId: string;
    workspaceId: string;
    type: string;
    action: string;
    entityId: string | null;
    receivedAt: IsoDateTime;
  }): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const inserted = await tx.query<{ delivery_id: string }>(
        `INSERT INTO webhook_deliveries (delivery_id, workspace_id, type,
           action, entity_id, received_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING delivery_id`,
        [
          input.deliveryId,
          input.workspaceId,
          input.type,
          input.action,
          input.entityId,
          input.receivedAt,
        ]
      );
      if (inserted.length === 0) {
        return false;
      }
      // GREATEST ignores NULL, so the first webhook sets the time and an
      // out-of-order older delivery never moves it backwards. The row is
      // created only for an installed workspace (or bumped when it exists
      // already): an unknown organization leaves no sync_state stub.
      await tx.query(
        `INSERT INTO sync_state (workspace_id, last_webhook_at)
         SELECT $1::text, $2::timestamptz
         WHERE EXISTS (SELECT 1 FROM installations WHERE workspace_id = $1::text)
           OR EXISTS (SELECT 1 FROM sync_state WHERE workspace_id = $1::text)
         ON CONFLICT (workspace_id) DO UPDATE SET
           last_webhook_at = GREATEST(sync_state.last_webhook_at, EXCLUDED.last_webhook_at)`,
        [input.workspaceId, input.receivedAt]
      );
      return true;
    });
  }

  async pruneWebhookDeliveries(before: IsoDateTime): Promise<number> {
    const rows = await this.write<{ delivery_id: string }>(
      `DELETE FROM webhook_deliveries WHERE received_at < $1::timestamptz
       RETURNING delivery_id`,
      [before]
    );
    return rows.length;
  }

  async markWebhookProcessed(
    deliveryId: string,
    result: { at: IsoDateTime; error: string | null }
  ): Promise<void> {
    await this.write(
      `UPDATE webhook_deliveries SET processed_at = $2::timestamptz, error = $3
       WHERE delivery_id = $1`,
      [deliveryId, result.at, result.error]
    );
  }

  // --- allocation runs --------------------------------------------------------------

  /**
   * First fails runs left 'running' for longer than staleAfterMinutes (a
   * crashed process), then inserts the new run. A run that is still live
   * makes the partial unique index reject the insert: that is the null.
   */
  async startRun(input: {
    workspaceId: string;
    mode: AllocationMode;
    trigger: RunTrigger;
    startedByUserId: string | null;
    now: IsoDateTime;
    staleAfterMinutes: number;
  }): Promise<AllocationRun | null> {
    const expired = await this.write<{ id: string }>(
      `UPDATE allocation_runs
       SET status = 'failed', error = 'stale run', finished_at = $2::timestamptz
       WHERE workspace_id = $1 AND status = 'running'
         AND started_at < $2::timestamptz - ($3::double precision * interval '1 minute')
       RETURNING id`,
      [input.workspaceId, input.now, input.staleAfterMinutes]
    );
    for (const run of expired) {
      this.logger?.warn('marked stale allocation run as failed', {
        workspaceId: input.workspaceId,
        runId: run.id,
      });
    }
    try {
      const rows = await this.write<RunRow>(
        `INSERT INTO allocation_runs (id, workspace_id, mode, run_trigger,
           started_by_user_id, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6::timestamptz)
         RETURNING ${RUN_COLUMNS}`,
        [
          randomUUID(),
          input.workspaceId,
          input.mode,
          input.trigger,
          input.startedByUserId,
          input.now,
        ]
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('Allocation run insert returned no row');
      }
      return runFromRow(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  async appendRunEntries(runId: string, entries: NewRunEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const payload = entries.map((entry) => ({
      action: entry.action,
      outcome: entry.outcome,
      project_id: entry.projectId,
      milestone_id: entry.milestoneId,
      issue_id: entry.issueId,
      issue_identifier: entry.issueIdentifier,
      assignee_id: entry.assigneeId,
      reason: entry.reason,
      detail: entry.detail,
      error: entry.error,
    }));
    const createdAt = this.nowIso();
    await this.sql.transaction(async (tx) => {
      // Locking the run row serializes appenders, so seq stays gap-free and
      // unique even if two callers append to the same run at once.
      const runs = await tx.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM allocation_runs WHERE id = $1 FOR UPDATE',
        [runId]
      );
      const run = runs[0];
      if (run === undefined) {
        throw new Error(`Unknown allocation run ${runId}`);
      }
      await tx.query(
        `INSERT INTO allocation_entries (run_id, seq, workspace_id, action,
           outcome, project_id, milestone_id, issue_id, issue_identifier,
           assignee_id, reason, detail, error, created_at)
         SELECT $1::text,
           (SELECT COALESCE(MAX(x.seq), 0) FROM allocation_entries x WHERE x.run_id = $1::text) + r.ord,
           $2::text, r.value->>'action', r.value->>'outcome',
           r.value->>'project_id', r.value->>'milestone_id',
           r.value->>'issue_id', r.value->>'issue_identifier',
           r.value->>'assignee_id', r.value->>'reason',
           COALESCE(r.value->'detail', '{}'::jsonb), r.value->>'error',
           $4::timestamptz
         FROM jsonb_array_elements($3::text::jsonb) WITH ORDINALITY AS r(value, ord)`,
        [
          runId,
          run.workspace_id,
          jsonParam(payload, { credentialFree: true }),
          createdAt,
        ]
      );
    });
  }

  async finishRun(
    runId: string,
    result: {
      status: Exclude<RunStatus, 'running'>;
      summary: RunSummary;
      error: string | null;
      now: IsoDateTime;
    }
  ): Promise<void> {
    const rows = await this.write<{ id: string }>(
      `UPDATE allocation_runs SET status = $2, summary = $3::text::jsonb,
         error = $4, finished_at = $5::timestamptz
       WHERE id = $1
       RETURNING id`,
      [
        runId,
        result.status,
        jsonParam(result.summary, { credentialFree: true }),
        credentialFree(result.error),
        result.now,
      ]
    );
    if (rows.length === 0) {
      throw new Error(`Unknown allocation run ${runId}`);
    }
  }

  async listRuns(workspaceId: string, limit: number): Promise<AllocationRun[]> {
    const rows = await this.sql.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM allocation_runs WHERE workspace_id = $1
       ORDER BY started_at DESC, id DESC LIMIT $2::int`,
      [workspaceId, sqlLimit(limit)]
    );
    return rows.map(runFromRow);
  }

  async getRun(
    workspaceId: string,
    runId: string
  ): Promise<{ run: AllocationRun; entries: RunEntry[] } | null> {
    const runs = await this.sql.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM allocation_runs
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, runId]
    );
    const run = runs[0];
    if (run === undefined) {
      return null;
    }
    const entries = await this.sql.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM allocation_entries e
       WHERE e.run_id = $1 ORDER BY e.seq`,
      [runId]
    );
    return { run: runFromRow(run), entries: entries.map(entryFromRow) };
  }

  async listRunEntriesForIssue(
    workspaceId: string,
    issueId: string,
    limit: number
  ): Promise<IssueRunEntry[]> {
    const rows = await this.sql.query<
      EntryRow & { run_mode: AllocationMode; run_trigger: RunTrigger }
    >(
      `SELECT ${ENTRY_COLUMNS}, r.mode AS run_mode, r.run_trigger
       FROM allocation_entries e
       JOIN allocation_runs r ON r.id = e.run_id
       WHERE e.workspace_id = $1 AND e.issue_id = $2
       ORDER BY e.created_at DESC, r.started_at DESC, e.run_id DESC, e.seq DESC
       LIMIT $3::int`,
      [workspaceId, issueId, sqlLimit(limit)]
    );
    return rows.map((row) => ({
      ...entryFromRow(row),
      runMode: row.run_mode,
      runTrigger: row.run_trigger,
    }));
  }

  async listAppliedAssignments(
    workspaceId: string,
    since: IsoDateTime
  ): Promise<RunEntry[]> {
    const rows = await this.sql.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM allocation_entries e
       JOIN allocation_runs r ON r.id = e.run_id
       WHERE e.workspace_id = $1 AND e.action = 'assign'
         AND e.outcome = 'applied' AND e.created_at >= $2::timestamptz
         AND r.mode = 'live'
       ORDER BY e.created_at, e.run_id, e.seq`,
      [workspaceId, since]
    );
    return rows.map(entryFromRow);
  }

  // --- warnings and notifications -------------------------------------------------

  async listWarningMemory(workspaceId: string): Promise<WarningMemory[]> {
    const rows = await this.sql.query<WarningMemoryRow>(
      `SELECT subject_kind, subject_id, last_key,
         to_char(last_notified_on, 'YYYY-MM-DD') AS last_notified_on, occurrence
       FROM warning_memory WHERE workspace_id = $1
       ORDER BY subject_kind, subject_id`,
      [workspaceId]
    );
    return rows.map((row) => ({
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      lastKey: row.last_key,
      lastNotifiedOn: row.last_notified_on,
      occurrence: Number(row.occurrence),
    }));
  }

  async saveWarningMemory(
    workspaceId: string,
    rows: WarningMemory[]
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    // Last write wins for a repeated subject: one INSERT … ON CONFLICT
    // cannot update the same row twice.
    const bySubject = new Map<string, WarningMemory>();
    for (const row of rows) {
      bySubject.set(`${row.subjectKind}\u0000${row.subjectId}`, row);
    }
    const payload = [...bySubject.values()].map((row) => ({
      subject_kind: row.subjectKind,
      subject_id: row.subjectId,
      last_key: row.lastKey,
      last_notified_on: row.lastNotifiedOn,
      occurrence: row.occurrence,
    }));
    await this.write(
      `INSERT INTO warning_memory (workspace_id, subject_kind, subject_id,
         last_key, last_notified_on, occurrence)
       SELECT $1::text, r.subject_kind, r.subject_id, r.last_key,
         r.last_notified_on, r.occurrence
       FROM jsonb_to_recordset($2::text::jsonb) AS r(subject_kind text,
         subject_id text, last_key text, last_notified_on date, occurrence integer)
       ON CONFLICT (workspace_id, subject_kind, subject_id) DO UPDATE SET
         last_key = EXCLUDED.last_key,
         last_notified_on = EXCLUDED.last_notified_on,
         occurrence = EXCLUDED.occurrence`,
      [workspaceId, jsonParam(payload)]
    );
  }

  async insertNotification(
    record: Omit<NotificationRecord, 'id' | 'createdAt'> & { now: IsoDateTime }
  ): Promise<boolean> {
    const rows = await this.write<{ id: string }>(
      `INSERT INTO notifications (id, workspace_id, day, recipient_id, channel,
         status, digest, error, created_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7::text::jsonb, $8, $9::timestamptz)
       ON CONFLICT (workspace_id, day, recipient_id) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        record.workspaceId,
        record.day,
        record.recipientId,
        record.channel,
        record.status,
        jsonParam(record.digest, { credentialFree: true }),
        credentialFree(record.error),
        record.now,
      ]
    );
    return rows.length === 1;
  }

  async updateNotificationStatus(input: {
    workspaceId: string;
    day: IsoDate;
    recipientId: string;
    channel: 'slack' | 'outbox';
    status: Exclude<NotificationStatus, 'pending'>;
    error: string | null;
  }): Promise<void> {
    await this.write(
      `UPDATE notifications SET status = $4, channel = $5, error = $6
       WHERE workspace_id = $1 AND day = $2::date AND recipient_id = $3`,
      [
        input.workspaceId,
        input.day,
        input.recipientId,
        input.status,
        input.channel,
        credentialFree(input.error),
      ]
    );
  }

  async listNotifications(
    workspaceId: string,
    options: { limit: number; day?: IsoDate }
  ): Promise<NotificationRecord[]> {
    const rows = await this.sql.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       WHERE workspace_id = $1 AND ($2::date IS NULL OR day = $2::date)
       ORDER BY created_at DESC, id DESC LIMIT $3::int`,
      [workspaceId, options.day ?? null, sqlLimit(options.limit)]
    );
    return rows.map(notificationFromRow);
  }

  async pruneNotifications(
    before: IsoDateTime,
    limit: number
  ): Promise<number> {
    const rows = await this.write<{ n: number }>(
      `WITH d AS (
         DELETE FROM notifications WHERE id IN (
           SELECT id FROM notifications WHERE created_at < $1::timestamptz
           ORDER BY created_at, id LIMIT $2::int)
         RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [before, sqlLimit(limit)]
    );
    return Number(rows[0]?.n ?? 0);
  }

  // --- scheduled jobs ---------------------------------------------------------------

  /**
   * One upsert: a fresh day inserts the claim; an existing claim is taken
   * over only when unfinished and older than the lease (the WHERE is
   * evaluated against the latest committed row, so of several concurrent
   * takeovers exactly one updates it). The CTE reads the previous claim
   * time for the log line.
   */
  async claimJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    now: IsoDateTime,
    options: { leaseMinutes?: number } = {}
  ): Promise<boolean> {
    const rows = await this.write<{ previous: DbTimestamp | null }>(
      `WITH previous AS (
         SELECT claimed_at FROM job_claims
         WHERE workspace_id = $1 AND job = $2 AND day = $3::date
       )
       INSERT INTO job_claims (workspace_id, job, day, claimed_at)
       VALUES ($1, $2, $3::date, $4::timestamptz)
       ON CONFLICT (workspace_id, job, day) DO UPDATE SET
         claimed_at = EXCLUDED.claimed_at, finished_at = NULL
       WHERE job_claims.finished_at IS NULL
         AND $5::double precision IS NOT NULL
         AND job_claims.claimed_at
           < EXCLUDED.claimed_at - ($5::double precision * interval '1 minute')
       RETURNING (SELECT claimed_at FROM previous) AS previous`,
      [workspaceId, job, day, now, options.leaseMinutes ?? null]
    );
    const row = rows[0];
    if (row === undefined) {
      return false;
    }
    if (row.previous !== null) {
      this.logger?.warn('took over a stale job claim', {
        workspaceId,
        job,
        day,
        previousClaimedAt: toIso(row.previous),
        leaseMinutes: options.leaseMinutes,
      });
    }
    return true;
  }

  async finishJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    input: { claimedAt: IsoDateTime; at: IsoDateTime }
  ): Promise<boolean> {
    const rows = await this.write<{ job: string }>(
      `UPDATE job_claims SET finished_at = $5::timestamptz
       WHERE workspace_id = $1 AND job = $2 AND day = $3::date
         AND claimed_at = $4::timestamptz AND finished_at IS NULL
       RETURNING job`,
      [workspaceId, job, day, input.claimedAt, input.at]
    );
    return rows.length === 1;
  }

  async releaseJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    claimedAt?: IsoDateTime
  ): Promise<void> {
    await this.write(
      `DELETE FROM job_claims
       WHERE workspace_id = $1 AND job = $2 AND day = $3::date
         AND ($4::timestamptz IS NULL
           OR (claimed_at = $4::timestamptz AND finished_at IS NULL))`,
      [workspaceId, job, day, claimedAt ?? null]
    );
  }

  async pruneJobClaims(before: IsoDateTime, limit: number): Promise<number> {
    const rows = await this.write<{ n: number }>(
      `WITH d AS (
         DELETE FROM job_claims WHERE (workspace_id, job, day) IN (
           SELECT workspace_id, job, day FROM job_claims
           WHERE claimed_at < $1::timestamptz
           ORDER BY claimed_at, workspace_id, job, day LIMIT $2::int)
         RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [before, sqlLimit(limit)]
    );
    return Number(rows[0]?.n ?? 0);
  }

  // --- admission: blocks and pins ---------------------------------------------------

  async blockWorkspace(
    key: string,
    kind: BlockKind,
    reason: string | null,
    now: IsoDateTime
  ): Promise<void> {
    if (!BLOCK_KINDS.includes(kind)) {
      throw new TypeError(`Unknown block kind ${String(kind)}`);
    }
    await this.write(
      `INSERT INTO blocked_workspaces (key, kind, reason, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (key) DO UPDATE SET
         kind = EXCLUDED.kind, reason = EXCLUDED.reason`,
      [key.toLowerCase(), kind, credentialFree(reason), now]
    );
  }

  async unblockWorkspace(key: string): Promise<boolean> {
    const rows = await this.write<{ key: string }>(
      'DELETE FROM blocked_workspaces WHERE key = $1 RETURNING key',
      [key.toLowerCase()]
    );
    return rows.length === 1;
  }

  async listBlockedWorkspaces(): Promise<BlockedWorkspace[]> {
    const rows = await this.sql.query<BlockRow>(
      `SELECT key, kind, reason, created_at FROM blocked_workspaces
       ORDER BY key`
    );
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      reason: row.reason,
      createdAt: toIso(row.created_at),
    }));
  }

  /**
   * One statement: the URL-key row is deleted and re-inserted under the id
   * (both data-modifying CTEs always run). When the org already has an id
   * block, that one is kept and the URL-key row still goes. A URL key equal
   * to the id only changes the row's kind.
   */
  async pinBlockedUrlKey(
    urlKey: string,
    workspaceId: string
  ): Promise<boolean> {
    const from = urlKey.toLowerCase();
    const to = workspaceId.toLowerCase();
    if (from === to) {
      const rows = await this.write<{ key: string }>(
        `UPDATE blocked_workspaces SET kind = 'id'
         WHERE key = $1 AND kind = 'url_key' RETURNING key`,
        [from]
      );
      return rows.length === 1;
    }
    const rows = await this.write<{ n: number }>(
      `WITH moved AS (
         DELETE FROM blocked_workspaces WHERE key = $1 AND kind = 'url_key'
         RETURNING reason, created_at),
       pinned AS (
         INSERT INTO blocked_workspaces (key, kind, reason, created_at)
         SELECT $2, 'id', reason, created_at FROM moved
         ON CONFLICT (key) DO NOTHING
         RETURNING key)
       SELECT count(*)::int AS n FROM moved`,
      [from, to]
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async getAdmittedPin(entry: string): Promise<string | null> {
    const rows = await this.sql.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM admitted_workspaces WHERE entry = $1',
      [entry.toLowerCase()]
    );
    return rows[0]?.workspace_id ?? null;
  }

  /**
   * Insert-if-absent, then (when another process pinned the entry first)
   * a fresh read in its own statement: the insert's snapshot may predate
   * that pin, so it cannot be read in the same statement. A pin deleted
   * between the two (a purge of the pinned workspace) is retried.
   */
  async pinAdmitted(
    entry: string,
    workspaceId: string,
    now: IsoDateTime
  ): Promise<string> {
    const key = entry.toLowerCase();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await this.write<{ workspace_id: string }>(
        `INSERT INTO admitted_workspaces (entry, workspace_id, created_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (entry) DO NOTHING
         RETURNING workspace_id`,
        [key, workspaceId, now]
      );
      const pinned =
        inserted[0]?.workspace_id ?? (await this.getAdmittedPin(key));
      if (pinned !== null) return pinned;
    }
    throw new Error('Could not pin the admission entry');
  }

  // --- audit ------------------------------------------------------------------------

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.write(
      `INSERT INTO audit_log (workspace_id, actor_user_id, action, subject_id,
         before_value, after_value, occurred_at)
       VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7::timestamptz)`,
      [
        entry.workspaceId,
        entry.actorUserId,
        entry.action,
        entry.subjectId,
        jsonParam(entry.before, { credentialFree: true }),
        jsonParam(entry.after, { credentialFree: true }),
        entry.at,
      ]
    );
  }

  async appendAuditEntries(entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // One statement for the whole list. The ORDER BY over the array's
    // ordinality makes the identity ids follow the given order (an
    // INSERT … SELECT without it promises no row order), so entries that
    // share one occurred_at still list in a stable order. jsonParam cleans
    // every string (U+0000, lone surrogates) as write() does.
    await this.write(
      `INSERT INTO audit_log (workspace_id, actor_user_id, action, subject_id,
         before_value, after_value, occurred_at)
       SELECT e.value->>'workspaceId', e.value->>'actorUserId',
         e.value->>'action', e.value->>'subjectId', e.value->'before',
         e.value->'after', (e.value->>'at')::timestamptz
       FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS e(value, ord)
       ORDER BY e.ord`,
      [
        jsonParam(
          entries.map((entry) => ({
            workspaceId: entry.workspaceId,
            actorUserId: entry.actorUserId,
            action: entry.action,
            subjectId: entry.subjectId,
            // undefined is stored as JSON null, as appendAudit does.
            before: entry.before === undefined ? null : entry.before,
            after: entry.after === undefined ? null : entry.after,
            at: entry.at,
          })),
          { credentialFree: true }
        ),
      ]
    );
  }

  async listAudit(workspaceId: string, limit: number): Promise<AuditEntry[]> {
    const rows = await this.sql.query<AuditRow>(
      `SELECT workspace_id, actor_user_id, action, subject_id, before_value,
         after_value, occurred_at
       FROM audit_log WHERE workspace_id = $1
       ORDER BY occurred_at DESC, id DESC LIMIT $2::int`,
      [workspaceId, sqlLimit(limit)]
    );
    return rows.map(auditFromRow);
  }
}
