import type {
  AllocationMode,
  AllocationPlan,
  DependencyGraph,
  Digest,
  GraphScope,
  IsoDate,
  IsoDateTime,
  MilestoneAssessment,
  MilestoneDetail,
  Snapshot,
  TimelineView,
  User,
  WarningsMode,
  WeekView,
  WorkspaceSettings,
} from '@better-tracker/core';
import type {
  FetchLike,
  LinearGateway,
  OAuthClientConfig,
} from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { NotificationChannel } from '@better-tracker/notify';
import type {
  AllocationRun,
  AuditEntry,
  Installation,
  NotificationRecord,
  RunEntry,
  RunTrigger,
  Session,
  Store,
  SyncState,
} from '@better-tracker/store';

/** Static configuration for one deployment. */
export interface EngineConfig {
  /** Display name used in Linear comments and digests ("Milestone Planner"). */
  appName: string;
  /** Public base URL, no trailing slash (OAuth redirect, deep links). */
  appUrl: string;
  /** Timezone for workspaces without a saved setting. */
  defaultTimezone: string;
  /** Seed PMs/watchers by email the first time a workspace is configured. */
  bootstrapPmEmails: string[];
  bootstrapWatcherEmails: string[];
  /** Absent in fixture (demo) mode. */
  oauth: OAuthClientConfig | null;
  /** Session lifetime in days. */
  sessionDays: number;
}

/**
 * How the engine obtains Linear gateways. The real provider wraps stored
 * OAuth tokens (refreshing them under a row lock); the fixture provider
 * returns in-memory gateways over the demo workspace.
 */
export interface LinearProvider {
  readonly mode: 'linear' | 'fixture';
  /** Acts as the installed app (allocation writes, sync). */
  forApp(workspaceId: string): Promise<LinearGateway>;
  /** Acts as the signed-in human (PM edits). */
  forSession(session: Session): Promise<LinearGateway>;
}

export interface EngineDeps {
  store: Store;
  linear: LinearProvider;
  /** Used when warningsMode is live; the outbox is used otherwise. */
  channel: NotificationChannel;
  logger: Logger;
  config: EngineConfig;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * Additive: the fetch used for OAuth calls the engine makes itself (code
   * exchange, token revocation) and for the identity check right after an
   * exchange. Defaults to the global fetch; tests inject a fake.
   */
  fetch?: FetchLike;
}

/** The signed-in person making a request. */
export interface Actor {
  session: Session;
  isPm: boolean;
  /** Granted Linear scopes of the user's token include `write`. */
  canWriteLinear: boolean;
}

/** A loaded, indexed workspace plus everything derived from it. */
export interface LoadedWorkspace {
  workspaceId: string;
  snapshot: Snapshot;
  settings: WorkspaceSettings;
  today: IsoDate;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  syncState: SyncState | null;
  mirrorVersion: number;
}

export interface SyncResult {
  workspaceId: string;
  ok: boolean;
  version: number;
  counts: Record<string, number>;
  durationMs: number;
  error: string | null;
}

export interface WarningRunResult {
  workspaceId: string;
  day: IsoDate;
  mode: WarningsMode;
  notices: number;
  digests: Digest[];
  delivered: number;
  failed: number;
  /** Recipients who already had today's digest. */
  alreadySent: number;
}

export interface DailyResult {
  workspaceId: string;
  day: IsoDate;
  /** false when today's daily run was already claimed (and force was not set). */
  ran: boolean;
  sync: SyncResult | null;
  allocation: AllocationRun | null;
  warnings: WarningRunResult | null;
}

/** What one cleanup() pass did (also logged as "cleanup finished"). */
export interface CleanupResult {
  /** Expired sessions deleted. */
  expiredSessions: number;
  /**
   * Of those, sessions whose Linear grant was revoked, and revocations
   * that failed (best effort; always 0 in demo mode, which has no grants).
   */
  revokedTokens: number;
  revokeFailures: number;
  /** Webhook delivery records older than the retention window, deleted. */
  oldDeliveries: number;
}

export type OAuthIntent = 'signin' | 'install' | 'grant_write';

export interface OAuthStart {
  url: string;
  /** Store in a short-lived, httpOnly cookie; must round-trip unchanged. */
  state: string;
  codeVerifier: string;
}

export interface SignInResult {
  sessionToken: string;
  session: Session;
  /** The workspace has no app installation yet; send the user to /setup. */
  needsInstall: boolean;
}

/** Thrown for authorization failures; the web layer maps it to 401/403. */
export class EngineAuthError extends Error {
  readonly code:
    | 'not_signed_in'
    | 'not_pm'
    | 'needs_write_scope'
    | 'not_installed'
    | 'wrong_workspace'
    | 'fixture_only';
  constructor(code: EngineAuthError['code'], message: string) {
    super(message);
    this.name = 'EngineAuthError';
    this.code = code;
  }
}

/** Thrown for invalid input; the web layer maps it to 400/404/409. */
export class EngineInputError extends Error {
  readonly code: 'invalid' | 'not_found' | 'conflict';
  constructor(code: EngineInputError['code'], message: string) {
    super(message);
    this.name = 'EngineInputError';
    this.code = code;
  }
}

export interface Engine {
  readonly config: EngineConfig;
  readonly mode: 'linear' | 'fixture';

  // --- auth -----------------------------------------------------------------
  startOAuth(intent: OAuthIntent): OAuthStart;
  /** Completes signin or grant_write: creates (or replaces) a session. */
  finishSignIn(input: {
    code: string;
    codeVerifier: string;
    intent: 'signin' | 'grant_write';
  }): Promise<SignInResult>;
  /** Completes the admin's actor=app install for the actor's workspace. */
  finishInstall(input: {
    code: string;
    codeVerifier: string;
    actor: Actor;
  }): Promise<Installation>;
  /** Fixture mode only: sign in as a demo user without OAuth. */
  devSignIn(userId: string): Promise<SignInResult>;
  /** Resolves a cookie token into an Actor, or null. */
  authenticate(sessionToken: string | undefined): Promise<Actor | null>;
  signOut(sessionToken: string): Promise<void>;
  /** Users offered on the fixture-mode sign-in screen. */
  listDemoUsers(): Promise<User[]>;

  // --- reads ----------------------------------------------------------------
  load(workspaceId: string): Promise<LoadedWorkspace>;
  getWeekView(workspaceId: string, userId: string): Promise<WeekView>;
  getTimelineView(workspaceId: string): Promise<TimelineView>;
  getGraph(workspaceId: string, scope: GraphScope): Promise<DependencyGraph>;
  getMilestoneDetail(
    workspaceId: string,
    milestoneId: string
  ): Promise<MilestoneDetail>;
  listRuns(workspaceId: string, limit: number): Promise<AllocationRun[]>;
  getRun(
    workspaceId: string,
    runId: string
  ): Promise<{ run: AllocationRun; entries: RunEntry[] } | null>;
  listNotifications(
    workspaceId: string,
    limit: number
  ): Promise<NotificationRecord[]>;
  listAudit(workspaceId: string, limit: number): Promise<AuditEntry[]>;
  getInstallation(workspaceId: string): Promise<Installation | null>;

  // --- jobs -------------------------------------------------------------------
  fullSync(workspaceId: string): Promise<SyncResult>;
  /**
   * A verified webhook (signature and timestamp already checked). Records the
   * delivery (deduped by Linear-Delivery id), then refetches the touched
   * entity from Linear and patches the mirror. Linear has no webhooks for
   * project milestones or issue relations, so Issue/Project events also
   * refresh those, and the periodic fullSync heals anything missed.
   */
  handleWebhook(event: {
    deliveryId: string | null;
    workspaceId: string;
    /** Payload `type`: Issue, Project, Initiative, User, OAuthApp, … */
    type: string;
    /** create | update | remove | revoked | … (free-form in Linear). */
    action: string;
    entityId: string | null;
    /** Previous values of updated fields, when Linear sends them. */
    updatedFrom: Record<string, unknown> | null;
  }): Promise<'processed' | 'duplicate' | 'ignored'>;
  runAllocation(input: {
    workspaceId: string;
    mode: AllocationMode;
    trigger: RunTrigger;
    actor: Actor | null;
  }): Promise<AllocationRun>;
  runWarnings(input: {
    workspaceId: string;
    /** Defaults to today in the workspace timezone. */
    day?: IsoDate;
    /** Build digests without recording or sending anything. */
    previewOnly?: boolean;
  }): Promise<WarningRunResult>;
  /** sync -> allocation (settings mode) -> warnings; once per day unless forced. */
  runDaily(input: {
    workspaceId: string;
    force?: boolean;
  }): Promise<DailyResult>;
  listWorkspaceIds(): Promise<string[]>;

  // --- PM edits (engine enforces isPm / canWriteLinear) ----------------------
  setMilestoneTargetDate(
    actor: Actor,
    milestoneId: string,
    targetDate: IsoDate | null
  ): Promise<void>;
  setProjectLead(
    actor: Actor,
    projectId: string,
    leadId: string | null
  ): Promise<void>;
  setMilestoneWeight(
    actor: Actor,
    milestoneId: string,
    weight: number | null
  ): Promise<void>;
  setMilestoneDoneMeans(
    actor: Actor,
    milestoneId: string,
    text: string | null
  ): Promise<void>;
  updateSettings(
    actor: Actor,
    patch: Partial<Omit<WorkspaceSettings, 'workspaceId'>>
  ): Promise<WorkspaceSettings>;

  /**
   * Housekeeping for the worker: deletes expired sessions (revoking their
   * Linear grants, best effort) and webhook delivery records older than
   * 30 days. Additive: resolves with the counts.
   */
  cleanup(): Promise<CleanupResult>;
  now(): IsoDateTime;
  /**
   * Additive: closes the store the engine was built with (the worker exits
   * after each tick; tests release their PGlite instances).
   */
  close(): Promise<void>;
}

export type { IsoDateTime };
