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
    | 'settings.update';
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
  /** Same locking contract as withInstallationLock, for user tokens. */
  withSessionLock<T>(
    sessionId: string,
    fn: (session: Session) => Promise<{ result: T; tokens?: StoredTokens }>
  ): Promise<T>;
  deleteSession(token: string): Promise<void>;
  deleteExpiredSessions(now: IsoDateTime): Promise<number>;

  // --- settings and tool-owned milestone data ------------------------------
  getSettings(workspaceId: string): Promise<WorkspaceSettings | null>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;
  listMilestoneMeta(workspaceId: string): Promise<MilestoneMeta[]>;
  upsertMilestoneMeta(workspaceId: string, meta: MilestoneMeta): Promise<void>;

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
  /** Claims (workspace, job, day); false if already claimed (idempotent daily run). */
  claimJob(
    workspaceId: string,
    job: 'daily',
    day: IsoDate,
    now: IsoDateTime
  ): Promise<boolean>;
  releaseJob(workspaceId: string, job: 'daily', day: IsoDate): Promise<void>;

  // --- audit ----------------------------------------------------------------
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(workspaceId: string, limit: number): Promise<AuditEntry[]>;
}
