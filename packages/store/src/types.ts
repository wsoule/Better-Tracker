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
  /** Set when Linear reports the app authorization was revoked. */
  revokedAt: IsoDateTime | null;
  tokens: StoredTokens;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Session {
  /** Internal id; never the cookie value. */
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  /** The signed-in user's own Linear token, for PM edits attributed to them. */
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
  lastFullSyncAt: IsoDateTime | null;
  lastFullSyncStatus: 'ok' | 'failed' | null;
  lastFullSyncError: string | null;
  lastWebhookAt: IsoDateTime | null;
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
 * in tests). All methods are scoped by workspaceId so one deployment could
 * serve several workspaces (productization, §9).
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

  // --- sessions -----------------------------------------------------------
  /** Returns the opaque cookie token; only its SHA-256 is stored. */
  createSession(
    session: NewSession
  ): Promise<{ token: string; session: Session }>;
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
  recordFullSync(
    workspaceId: string,
    result: { at: IsoDateTime; ok: boolean; error: string | null }
  ): Promise<void>;
  /**
   * Records a webhook delivery keyed by the Linear-Delivery header and bumps
   * sync_state.lastWebhookAt. Returns false when the delivery id was already
   * recorded (Linear retried it), so it is processed at most once.
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

  // --- audit ----------------------------------------------------------------
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(workspaceId: string, limit: number): Promise<AuditEntry[]>;
}
