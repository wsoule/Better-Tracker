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

/** A set of OAuth tokens, encrypted at rest by the store. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** null = Linear did not say the token expires. */
  expiresAt: IsoDateTime | null;
  scopes: string[];
}

/** The app-actor authorization for one Linear workspace (§8). */
export interface Installation {
  workspaceId: string;
  workspaceName: string;
  urlKey: string;
  /** The app user's Linear id (who allocation comments come from). */
  appUserId: string;
  installedByUserId: string;
  /**
   * Set when the app has no working grant any more (the reason is in
   * listWorkspaceStatus and describeSessions). revokeInstallation wipes
   * the tokens, which then read back blank: '' and nulls.
   */
  revokedAt: IsoDateTime | null;
  tokens: StoredTokens;
  createdAt: IsoDateTime;
  /** Last write of the grant: install, reinstall or token rotation. */
  updatedAt: IsoDateTime;
}

/**
 * Why an installation was revoked: 'uninstalled' (Linear's OAuthApp
 * revoked webhook), 'removed' (the operator's remove or block, or a block
 * that matched it later; never LINEAR_WORKSPACES alone) or 'grant_dead'
 * (Linear refused the app's token, or the cause is unknown). Only
 * 'uninstalled' and 'removed' are purged automatically.
 */
export type RevokedReason = 'uninstalled' | 'grant_dead' | 'removed';

export interface Session {
  /** Internal id; never the cookie value. */
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  /** The person's own Linear token, so their edits are attributed to them. */
  tokens: StoredTokens;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

/** The tool-owned milestone fields updateMilestoneMetaField can write. */
export type MilestoneMetaField = 'weight' | 'doneMeans';

export interface NewSession {
  workspaceId: string;
  userId: string;
  userName: string;
  tokens: StoredTokens;
  expiresAt: IsoDateTime;
  /**
   * Additive: the workspace's name and URL key from the sign-in identity,
   * which describeSessions and listWorkspaceStatus read back (the
   * installation's values are the fallback). Omitted is stored as null.
   */
  workspaceName?: string | null;
  workspaceUrlKey?: string | null;
}

/**
 * A session takeSessionsForWorkspace deleted. `tokens` is null when the
 * row's tokens no longer decrypt (another TOKEN_ENCRYPTION_KEY): the row
 * is deleted all the same, only its grant cannot be revoked.
 */
export interface TakenSession {
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  tokens: StoredTokens | null;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

/**
 * What describeSessions knows about one held session cookie token,
 * without any Linear credential.
 */
export interface SessionDescription {
  /** The cookie token this describes (the caller's own input). */
  token: string;
  workspaceId: string;
  /**
   * The installation's current value (refreshed by every full sync and
   * sign-in), else the session's sign-in value; null if neither.
   */
  workspaceName: string | null;
  workspaceUrlKey: string | null;
  userId: string;
  userName: string;
  expiresAt: IsoDateTime;
  /**
   * The mirror's User.guest for this person (a mirror row without the
   * field reads as not a guest); null when the mirror has no row for them.
   */
  guest: boolean | null;
  /** An installation row exists (active or revoked). */
  installed: boolean;
  revokedAt: IsoDateTime | null;
  revokedReason: RevokedReason | null;
}

/** Discriminated union of mirrored entities, for incremental writes. */
export type MirrorEntity =
  | { kind: 'user'; entity: User }
  | { kind: 'team'; entity: Team }
  | { kind: 'state'; entity: WorkflowState }
  | { kind: 'initiative'; entity: Initiative }
  | { kind: 'project'; entity: Project }
  | { kind: 'milestone'; entity: Milestone }
  | { kind: 'issue'; entity: Issue }
  | { kind: 'relation'; entity: BlockingRelation };

export type MirrorKind = MirrorEntity['kind'];

export interface MirrorRef {
  kind: MirrorKind;
  id: string;
}

export interface LoadedMirror {
  data: WorkspaceData;
  /** Bumped on every write; lets readers cache the indexed snapshot. */
  version: number;
  lastFullSyncAt: IsoDateTime | null;
}

export interface SyncState {
  workspaceId: string;
  version: number;
  /** The last full sync attempt (successful or not). */
  lastFullSyncAt: IsoDateTime | null;
  lastFullSyncStatus: 'ok' | 'failed' | null;
  lastFullSyncError: string | null;
  lastWebhookAt: IsoDateTime | null;
  // Additive (migration 5), always set by the SQL store; optional only so
  // SyncState values built by hand elsewhere keep compiling.
  /** Failed full syncs in a row; 0 after a success. */
  consecutiveFailures?: number;
  /** Duration of the last full sync that reported one. */
  lastFullSyncMs?: number | null;
  /** When the last successful full sync finished. */
  lastSuccessAt?: IsoDateTime | null;
  /** Issues in the mirror at the last full sync that reported a count. */
  mirrorIssueCount?: number | null;
  /**
   * Additive (migration 7): when the latest full sync attempt started
   * (recordFullSyncStart), finished or not. lastFullSyncAt is written only
   * when an attempt ends, so an attempt killed with its process shows only
   * here. The worker orders workspaces by the later of the two.
   */
  lastFullSyncStartedAt?: IsoDateTime | null;
}

/** An installation without its tokens (listWorkspaceStatus never decrypts). */
export interface InstallationSummary {
  workspaceName: string;
  urlKey: string;
  appUserId: string;
  installedByUserId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
  revokedReason: RevokedReason | null;
}

/**
 * One workspace the store knows: it has an installation row, sessions, or
 * both. For the worker's ordering and the operator commands.
 */
export interface WorkspaceStatus {
  workspaceId: string;
  /** The installation's name, else the newest session's; null if neither. */
  workspaceName: string | null;
  urlKey: string | null;
  /** null: never installed (people signed in, nobody installed the app). */
  installation: InstallationSummary | null;
  /** null: no full sync attempt, mirror write or webhook recorded yet. */
  sync: Required<SyncState> | null;
  /** Session rows (only unexpired ones when listWorkspaceStatus got `now`). */
  sessionCount: number;
}

/**
 * Every table that holds rows keyed by workspace_id, which purgeWorkspace
 * empties for the purged workspace. admitted_workspaces (LINEAR_WORKSPACES
 * pins) is kept, like the blocks: a URL-key entry pinned to a workspace
 * must never admit another org that takes the key after a purge.
 */
export type WorkspaceTable =
  | 'installations'
  | 'sessions'
  | 'settings'
  | 'milestone_meta'
  | 'sync_state'
  | 'mirror_entities'
  | 'webhook_deliveries'
  | 'allocation_entries'
  | 'allocation_runs'
  | 'warning_memory'
  | 'notifications'
  | 'job_claims'
  | 'audit_log';

/**
 * Why purgeWorkspace refused: no installation row, not revoked, revoked
 * at or after `revokedBefore`, or revoked as 'grant_dead' without
 * `allowGrantDead`.
 */
export type PurgeRefusal =
  | 'not_installed'
  | 'not_revoked'
  | 'too_recent'
  | 'grant_dead';

export type PurgeResult =
  | {
      purged: true;
      counts: Record<WorkspaceTable, number>;
      /**
       * The sessions the purge deleted, with their decrypted tokens (null
       * for a row that no longer decrypts), so the caller revokes their
       * Linear grants once the purge has committed. Never print or log it.
       */
      sessions: TakenSession[];
    }
  | { purged: false; reason: PurgeRefusal };

/** How a block entry matches: the org id, or the URL key until pinned. */
export type BlockKind = 'id' | 'url_key';

export interface BlockedWorkspace {
  /** Lower-cased org id or URL key. */
  key: string;
  kind: BlockKind;
  reason: string | null;
  createdAt: IsoDateTime;
  /**
   * Additive: for a block by org id, the lower-cased URL key it was made
   * under or pinned from (null when none is known, and for a URL-key
   * block, whose key is the URL key), so unblock by that key finds it.
   */
  urlKey: string | null;
}

export type RunTrigger = 'schedule' | 'manual';
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export interface RunSummary {
  assigned: number;
  wouldAssign: number;
  failed: number;
  blockedProjects: number;
  skippedIssues: number;
}

export interface AllocationRun {
  id: string;
  workspaceId: string;
  mode: AllocationMode;
  trigger: RunTrigger;
  startedByUserId: string | null;
  status: RunStatus;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  summary: RunSummary | null;
  error: string | null;
}

export type RunEntryAction = 'assign' | 'skip' | 'block';
export type RunEntryOutcome =
  /** Dry run: would have been applied. */
  | 'planned'
  | 'applied'
  /** Live: the Linear write failed. */
  | 'failed'
  /** Live: re-checked against Linear and no longer applicable. */
  | 'stale'
  /** Skip/block entries. */
  | 'noted';

export interface RunEntry {
  runId: string;
  seq: number;
  action: RunEntryAction;
  outcome: RunEntryOutcome;
  projectId: string;
  milestoneId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  assigneeId: string | null;
  /** Reason code (skip/block/stale) or the comment id for applied entries. */
  reason: string | null;
  detail: Record<string, unknown>;
  error: string | null;
  createdAt: IsoDateTime;
}

export type NewRunEntry = Omit<RunEntry, 'runId' | 'seq' | 'createdAt'>;

/**
 * A run entry about one issue together with its run's mode and trigger
 * (the issue page's allocation history: a dry-run entry was never applied).
 */
export interface IssueRunEntry extends RunEntry {
  runMode: AllocationMode;
  runTrigger: RunTrigger;
}

export type NotificationStatus =
  /**
   * Claimed for today and being delivered. A record left 'pending' means the
   * process stopped mid-delivery; it is not retried the same day (the
   * one-digest-per-day guarantee is at-most-once).
   */
  | 'pending'
  /** Delivered. */
  | 'sent'
  /** warningsMode=preview: recorded only. */
  | 'preview'
  | 'failed'
  /** No channel could reach this person (e.g. no Slack account). */
  | 'undeliverable';

export interface NotificationRecord {
  id: string;
  workspaceId: string;
  day: IsoDate;
  recipientId: string;
  channel: 'slack' | 'outbox';
  status: NotificationStatus;
  digest: Digest;
  error: string | null;
  createdAt: IsoDateTime;
}

export interface AuditEntry {
  workspaceId: string;
  actorUserId: string;
  action:
    | 'milestone.target_date'
    | 'milestone.weight'
    | 'milestone.done_means'
    | 'project.lead'
    | 'settings.update'
    // A person's issue edits (owner decision 2026-10-21): one entry per
    // changed field; subjectId is the issue (the blocked issue for
    // relations). Comment and description texts are logged as their
    // length only, never any of their words.
    | 'issue.title'
    | 'issue.description'
    | 'issue.state'
    | 'issue.assignee'
    | 'issue.priority'
    | 'issue.project'
    | 'issue.milestone'
    | 'issue.due_date'
    | 'issue.estimate'
    | 'issue.labels'
    | 'issue.comment'
    | 'issue.blocker_added'
    | 'issue.relation_removed';
  subjectId: string;
  before: unknown;
  after: unknown;
  at: IsoDateTime;
}

/**
 * Persistence for everything the tool owns plus the Linear mirror. One
 * implementation over SQL (node-postgres in production, PGlite locally and
 * in tests). All methods are scoped by workspaceId: one deployment serves
 * several workspaces (owner decision 2026-10-25). The few cross-workspace
 * methods (listWorkspaceStatus, retention, blocks) never return tokens.
 */
export interface Store {
  /** Applies pending migrations; safe to call on every boot. */
  migrate(): Promise<void>;
  close(): Promise<void>;
  /** Cheap liveness probe for /api/health. */
  ping(): Promise<boolean>;

  // --- installations (app actor tokens) -----------------------------------
  getInstallation(workspaceId: string): Promise<Installation | null>;
  listInstallations(): Promise<Installation[]>;
  saveInstallation(installation: Installation): Promise<void>;
  /**
   * Additive (multi-workspace): sets the installation's workspace name and
   * URL key to what Linear reports now (a full sync, a sign-in), so
   * admission's URL-key matching and the listings follow a rename. One
   * statement; nothing else changes, updated_at included (it keeps meaning
   * the grant's last write, which the stale-revoke guard compares with).
   * True when the row existed and changed; false when there is no row or
   * it already holds these values.
   */
  updateInstallationIdentity(
    workspaceId: string,
    identity: { workspaceName: string; urlKey: string }
  ): Promise<boolean>;
  /**
   * Runs fn while holding a row lock on the installation, so two processes
   * never refresh (and rotate) the same refresh token concurrently. fn's
   * returned tokens, if any, are persisted before the lock is released.
   * Rejects with StoreNotFoundError (kind 'installation') when there is no
   * installation row, without calling fn.
   */
  withInstallationLock<T>(
    workspaceId: string,
    fn: (
      installation: Installation
    ) => Promise<{ result: T; tokens?: StoredTokens }>
  ): Promise<T>;
  /**
   * Additive (multi-workspace): one query over every workspace with an
   * installation row or sessions, joined with its sync_state and session
   * count, ordered by last full sync attempt (the later of its start and
   * its finish; never attempted first), then workspace id. Decrypts
   * nothing, so a row whose tokens no longer decrypt is listed like any
   * other. With `now`, sessionCount counts only unexpired sessions.
   */
  listWorkspaceStatus(now?: IsoDateTime): Promise<WorkspaceStatus[]>;
  /**
   * Additive: revokes the installation as `reason` at `now` and wipes its
   * credentials (access token '', refresh token and expiry null), in one
   * statement. updated_at is left alone: it keeps meaning the grant's last
   * write. Returns true when the row changed. Nothing changes (false)
   * when there is no row; when `ifUpdatedBefore` is given and the row's
   * updated_at is later (the event predates a reinstall or rotation: a
   * stale revoke); or when the row is already revoked, except that a
   * 'grant_dead' row (cause unknown) takes 'uninstalled' or 'removed' and
   * restarts revoked_at at `now`, so the purge grace counts from when the
   * cause became known. A revoked row never goes back to 'grant_dead'.
   */
  revokeInstallation(
    workspaceId: string,
    reason: RevokedReason,
    now: IsoDateTime,
    options?: { ifUpdatedBefore?: IsoDateTime }
  ): Promise<boolean>;
  /**
   * Additive: deletes everything one workspace holds, in one transaction
   * that first locks its installation row (`SELECT … FOR UPDATE`, so an
   * in-flight reinstall finishes first and is then seen). Refuses
   * (`purged: false` with the reason, nothing deleted) unless the row is
   * revoked before `revokedBefore` as 'uninstalled' or 'removed', or as
   * 'grant_dead' when `allowGrantDead` (the operator's purge). Deletes
   * from every WorkspaceTable (allocation entries before their runs) and
   * returns the deleted row count per table, plus the deleted sessions
   * with their tokens, so their grants are revoked only once the purge
   * committed (a refused purge, e.g. a reinstall that won the lock, ends
   * no session). The sessions' DELETE waits for row locks like
   * takeSessionsForWorkspace, so a refresh in flight commits first.
   * blocked_workspaces and admitted_workspaces are kept: a block and a
   * LINEAR_WORKSPACES pin outlive the purge.
   */
  purgeWorkspace(
    workspaceId: string,
    options: { revokedBefore: IsoDateTime; allowGrantDead?: boolean }
  ): Promise<PurgeResult>;

  // --- sessions -----------------------------------------------------------
  /** Returns the opaque cookie token; only its SHA-256 is stored. */
  createSession(
    session: NewSession
  ): Promise<{ token: string; session: Session }>;
  /**
   * Additive: describes held cookie tokens in ONE statement (sessions by
   * token hash, left-joined with the installation and the person's mirror
   * user row), in input order: null for a token with no unexpired
   * session. Reads no token column and decrypts nothing.
   */
  describeSessions(
    tokens: readonly string[],
    now: IsoDateTime
  ): Promise<(SessionDescription | null)[]>;
  /**
   * Additive: deletes up to `limit` of the workspace's sessions (oldest
   * created first; with `createdBefore`, only those created before it) and
   * returns them with their decrypted tokens, so the caller can revoke the
   * grants. Unlike takeExpiredSessions it waits for row locks (no SKIP
   * LOCKED, bounded by the 30 s lock_timeout): a refresh in withSessionLock
   * finishes first and its rotated tokens are the ones returned. A row
   * whose tokens no longer decrypt is still deleted and comes back with
   * `tokens: null` (logged).
   */
  takeSessionsForWorkspace(
    workspaceId: string,
    options: { createdBefore?: IsoDateTime; limit: number }
  ): Promise<TakenSession[]>;
  getSession(token: string, now: IsoDateTime): Promise<Session | null>;
  /**
   * Same locking contract as withInstallationLock, for user tokens
   * (StoreNotFoundError kind 'session' when the session row is gone).
   */
  withSessionLock<T>(
    sessionId: string,
    fn: (session: Session) => Promise<{ result: T; tokens?: StoredTokens }>
  ): Promise<T>;
  deleteSession(token: string): Promise<void>;
  /** Deletes every expired session without reading it; returns the count. */
  deleteExpiredSessions(now: IsoDateTime): Promise<number>;
  /**
   * Additive: deletes up to `limit` expired sessions (oldest expiry first)
   * and returns them with their decrypted Linear tokens, so the caller can
   * revoke those tokens. Rows locked by a concurrent refresh are skipped
   * (taken by a later call). A row whose tokens no longer decrypt (another
   * TOKEN_ENCRYPTION_KEY) is deleted, logged and left out of the result, so
   * fewer than `limit` sessions can come back while more remain.
   */
  takeExpiredSessions(now: IsoDateTime, limit: number): Promise<Session[]>;

  // --- settings and tool-owned milestone data ------------------------------
  getSettings(workspaceId: string): Promise<WorkspaceSettings | null>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;
  listMilestoneMeta(workspaceId: string): Promise<MilestoneMeta[]>;
  /** Writes the whole meta row (both fields); seeding and imports. */
  upsertMilestoneMeta(workspaceId: string, meta: MilestoneMeta): Promise<void>;
  /**
   * Additive: sets one tool-owned field of a milestone's meta (inserting
   * the row when missing, with the other field null) and returns the row
   * as stored. Only that column, updated_by and updated_at are written, so
   * concurrent edits of the two fields from different processes never
   * overwrite each other. `value` must match the field: a finite
   * number or null for weight, a string or null for doneMeans.
   */
  updateMilestoneMetaField(
    workspaceId: string,
    milestoneId: string,
    field: MilestoneMetaField,
    value: number | string | null,
    updatedBy: string,
    at: IsoDateTime
  ): Promise<MilestoneMeta>;

  // --- Linear mirror ------------------------------------------------------
  /**
   * Replaces the whole mirror for data.workspaceId in one transaction
   * (entities missing from data are deleted). Returns the new version.
   */
  replaceMirror(data: WorkspaceData, syncedAt: IsoDateTime): Promise<number>;
  loadMirror(workspaceId: string): Promise<LoadedMirror | null>;
  /** Upserts/deletes individual entities (webhooks). Returns the new version. */
  applyMirrorChanges(
    workspaceId: string,
    changes: { upsert: MirrorEntity[]; remove: MirrorRef[] }
  ): Promise<number>;
  getSyncState(workspaceId: string): Promise<SyncState | null>;
  /**
   * Records a full sync attempt. Additive: a failure adds one to
   * consecutiveFailures and a success resets it to 0 and sets
   * lastSuccessAt to `at`; `durationMs` and `issueCount`, when given, are
   * stored as lastFullSyncMs and mirrorIssueCount (rounded; omitted keeps
   * the previous values).
   */
  recordFullSync(
    workspaceId: string,
    result: {
      at: IsoDateTime;
      ok: boolean;
      error: string | null;
      durationMs?: number;
      issueCount?: number;
    }
  ): Promise<void>;
  /**
   * Additive (migration 7): records that a full sync attempt started at
   * `at` (lastFullSyncStartedAt; never moved back), creating the row when
   * there is none. Changes nothing else: the last attempt's status, error,
   * failure count, finish time and last success stay as they were, so
   * backoff, the chronic rule and the skip-recent rule still read finished
   * attempts only.
   */
  recordFullSyncStart(workspaceId: string, at: IsoDateTime): Promise<void>;
  /**
   * Records a webhook delivery keyed by the Linear-Delivery header and bumps
   * sync_state.lastWebhookAt. Returns false when the delivery id was already
   * recorded (Linear retried it), so it is processed at most once. Additive:
   * the sync_state row is created only for a workspace with an
   * installation row (an existing row is bumped either way), so a delivery
   * for an organization nobody installed leaves no sync_state stub. The
   * delivery row itself is still written (dedupe needs it): the engine
   * checks admission and the installation before calling.
   */
  recordWebhookDelivery(input: {
    deliveryId: string;
    workspaceId: string;
    type: string;
    action: string;
    entityId: string | null;
    receivedAt: IsoDateTime;
  }): Promise<boolean>;
  markWebhookProcessed(
    deliveryId: string,
    result: { at: IsoDateTime; error: string | null }
  ): Promise<void>;
  /**
   * Older revoke kept for its current callers until they move to
   * revokeInstallation: sets revoked_at and updated_at to `at` and leaves
   * the tokens as they are. Additive: records 'grant_dead' (cause unknown,
   * never purged automatically) unless a reason is recorded already.
   */
  markInstallationRevoked(workspaceId: string, at: IsoDateTime): Promise<void>;
  /** Deletes webhook delivery records received before `before`; returns the count. */
  pruneWebhookDeliveries(before: IsoDateTime): Promise<number>;

  // --- allocation runs ----------------------------------------------------
  /**
   * Starts a run unless another is already running for the workspace (a run
   * still "running" after staleAfterMinutes is marked failed and ignored).
   * Returns null when blocked by an active run.
   */
  startRun(input: {
    workspaceId: string;
    mode: AllocationMode;
    trigger: RunTrigger;
    startedByUserId: string | null;
    now: IsoDateTime;
    staleAfterMinutes: number;
  }): Promise<AllocationRun | null>;
  appendRunEntries(runId: string, entries: NewRunEntry[]): Promise<void>;
  finishRun(
    runId: string,
    result: {
      status: Exclude<RunStatus, 'running'>;
      summary: RunSummary;
      error: string | null;
      now: IsoDateTime;
    }
  ): Promise<void>;
  listRuns(workspaceId: string, limit: number): Promise<AllocationRun[]>;
  getRun(
    workspaceId: string,
    runId: string
  ): Promise<{ run: AllocationRun; entries: RunEntry[] } | null>;
  /** Live, applied assignments since `since` (for My week's "new" mark). */
  listAppliedAssignments(
    workspaceId: string,
    since: IsoDateTime
  ): Promise<RunEntry[]>;
  /**
   * Additive (issue page): the run entries about one issue, dry runs
   * included, newest first, at most `limit`. The engine asks for 20.
   */
  listRunEntriesForIssue(
    workspaceId: string,
    issueId: string,
    limit: number
  ): Promise<IssueRunEntry[]>;

  // --- warnings and notifications -------------------------------------------
  listWarningMemory(workspaceId: string): Promise<WarningMemory[]>;
  saveWarningMemory(workspaceId: string, rows: WarningMemory[]): Promise<void>;
  /**
   * Inserts the day's notification for a recipient. Returns false (and
   * writes nothing) when one already exists for (workspace, day, recipient):
   * the one-digest-per-person-per-day guarantee.
   */
  insertNotification(
    record: Omit<NotificationRecord, 'id' | 'createdAt'> & { now: IsoDateTime }
  ): Promise<boolean>;
  /**
   * Sets the outcome of the day's notification for a recipient, after
   * delivery (claim-first flow: insertNotification as 'pending', deliver,
   * then update). No-op when no record exists.
   */
  updateNotificationStatus(input: {
    workspaceId: string;
    day: IsoDate;
    recipientId: string;
    channel: 'slack' | 'outbox';
    status: Exclude<NotificationStatus, 'pending'>;
    error: string | null;
  }): Promise<void>;
  listNotifications(
    workspaceId: string,
    options: { limit: number; day?: IsoDate }
  ): Promise<NotificationRecord[]>;
  /**
   * Additive (retention): deletes up to `limit` notifications created
   * before `before`, oldest first, in every workspace; returns the count.
   */
  pruneNotifications(before: IsoDateTime, limit: number): Promise<number>;

  // --- scheduled job bookkeeping ------------------------------------------
  /**
   * Claims (workspace, job, day) for the caller, recording `now` as the
   * claim time, which identifies this claim to finishJob and releaseJob.
   * False when the day is already claimed: finished, or unfinished and not
   * older than `leaseMinutes`. Additive: an unfinished claim older than
   * the lease (its holder died mid-run) is taken over, gets `now` as its
   * claim time, and the call returns true. Without a lease a claim is never
   * taken over.
   */
  claimJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    now: IsoDateTime,
    options?: { leaseMinutes?: number }
  ): Promise<boolean>;
  /**
   * Additive: marks the claim made at `claimedAt` finished, so it is never
   * taken over. False (nothing written) when the day's claim is no longer
   * that one: another process took it over, or it was released.
   */
  finishJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    input: { claimedAt: IsoDateTime; at: IsoDateTime }
  ): Promise<boolean>;
  /**
   * Frees the day so it can be claimed again. Additive: with `claimedAt`,
   * only while the claim is still that one and unfinished, so a holder
   * whose claim was taken over never frees the new holder's.
   */
  releaseJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    claimedAt?: IsoDateTime
  ): Promise<void>;
  /**
   * Additive (retention): deletes up to `limit` job claims claimed before
   * `before`, oldest first, in every workspace; returns the count.
   */
  pruneJobClaims(before: IsoDateTime, limit: number): Promise<number>;

  // --- admission: operator blocks and LINEAR_WORKSPACES pins ---------------
  /**
   * Additive: blocks a workspace by org id or URL key (stored lower-cased).
   * Blocking a key again updates its kind and reason and keeps createdAt.
   * `urlKey` (an id block's URL key, lower-cased) is recorded so the block
   * can be found by it later; blocking again without one keeps the old.
   */
  blockWorkspace(
    key: string,
    kind: BlockKind,
    reason: string | null,
    now: IsoDateTime,
    options?: { urlKey?: string | null }
  ): Promise<void>;
  /** Additive: removes a block (key matched lower-cased); true if one existed. */
  unblockWorkspace(key: string): Promise<boolean>;
  /** Additive: every block, ordered by key. */
  listBlockedWorkspaces(): Promise<BlockedWorkspace[]>;
  /**
   * Additive: turns the 'url_key' block on `urlKey` into an 'id' block on
   * `workspaceId` (both lower-cased; reason and createdAt kept, and the URL
   * key recorded as the id block's urlKey), so it keeps matching that org
   * after a rename and never matches another org that takes the URL key
   * later. True when a URL-key block was pinned.
   */
  pinBlockedUrlKey(urlKey: string, workspaceId: string): Promise<boolean>;
  /**
   * Additive: the org id a LINEAR_WORKSPACES URL-key entry is pinned to
   * (entry matched lower-cased), or null when it was never pinned.
   */
  getAdmittedPin(entry: string): Promise<string | null>;
  /**
   * Additive: pins the entry (lower-cased) to `workspaceId` unless it is
   * pinned already, and returns the id it is pinned to after the call: the
   * first pin wins, so a caller whose id differs was not admitted by it.
   */
  pinAdmitted(
    entry: string,
    workspaceId: string,
    now: IsoDateTime
  ): Promise<string>;

  // --- audit ----------------------------------------------------------------
  appendAudit(entry: AuditEntry): Promise<void>;
  /**
   * Additive: appends many entries in one statement (a bulk issue edit),
   * in the given order: their ids follow it, so listAudit (occurred_at
   * DESC, id DESC) reads entries sharing one `at` back in reverse. An
   * empty list writes nothing.
   */
  appendAuditEntries(entries: readonly AuditEntry[]): Promise<void>;
  listAudit(workspaceId: string, limit: number): Promise<AuditEntry[]>;
}
