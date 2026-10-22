import type {
  AllocationMode,
  AllocationPlan,
  BlockingRelation,
  DependencyGraph,
  Digest,
  EstimateOption,
  EstimateScale,
  GraphScope,
  IsoDate,
  IsoDateTime,
  Issue,
  IssueComment,
  IssueDetail,
  IssueExtras,
  IssueLabel,
  IssuePatch,
  IssuePatchField,
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
  IssueRunEntry,
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
  /**
   * Seed the watchers by email (`WATCHER_EMAILS`) the first time a
   * workspace is configured; when none match, the installer becomes the
   * first watcher.
   */
  bootstrapWatcherEmails: string[];
  /** Absent in fixture (demo) mode. */
  oauth: OAuthClientConfig | null;
  /** Session lifetime in days. */
  sessionDays: number;
  /**
   * Additive: minutes an unfinished daily claim holds before another
   * process may take it over (its holder died mid-run). Default
   * DEFAULT_DAILY_LEASE_MINUTES (45). It must be longer than any daily run
   * can live plus ALLOCATION_RUN_STALE_MINUTES (30), so a takeover finds
   * the dead run's allocation stale; the worker therefore caps
   * TICK_TIMEOUT_MINUTES at lease − stale − 1 (14).
   */
  dailyLeaseMinutes?: number;
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
  /** Acts as the signed-in human (their milestone, lead and issue edits). */
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

/**
 * The signed-in person making a request. There are no roles: since the
 * owner decision of 2026-10-22 every signed-in person may make every edit
 * and start every run. Only edits written to Linear need `canWriteLinear`,
 * because they go out with the person's own token.
 */
export interface Actor {
  session: Session;
  /**
   * Granted Linear scopes of the user's token include `write`. Since the
   * owner decision of 2026-10-21 every signed-in person may hold it (the
   * grant_write upgrade is offered to everyone) and edit issues with it.
   */
  canWriteLinear: boolean;
}

/**
 * The issue page (owner decision 2026-10-21): what getIssueDetail returns.
 * `detail` comes from the mirror; everything live is read with the
 * viewer's own token (the app's when theirs cannot be used), and a failed
 * live read leaves `extra` null with `extraError` saying why instead of
 * failing the page.
 */
export interface IssueDetailResult {
  detail: IssueDetail;
  /** Description, labels, estimate, due date, comments; null on failure. */
  extra: IssueExtras | null;
  /** Why `extra` (and `labels`) are missing; null when the read worked. */
  extraError: string | null;
  /** Whose token read `extra`: the viewer's, or the app's as a fallback. */
  extraSource: 'actor' | 'app' | null;
  /** Labels the issue's team can use, by name; empty when the read failed. */
  labels: IssueLabel[];
  /** The team's estimate scale; null when the live read failed. */
  estimateScale: EstimateScale | null;
  /** The estimates that scale allows (empty for no scale or `notUsed`). */
  estimateOptions: EstimateOption[];
  /** Allocation run entries about this issue, newest first (at most 20). */
  allocationHistory: IssueRunEntry[];
  /** The viewer's token may write: show the edit controls. */
  canEdit: boolean;
}

/** What updateIssue changed. */
export interface IssueUpdateResult {
  /** The issue as mirrored after the edit (unchanged when nothing was). */
  issue: Issue;
  /**
   * The fields Linear was asked to change, in patch order; values equal to
   * the current ones are left out (empty: nothing was written). A project
   * change that cleared the old milestone lists projectMilestoneId too.
   */
  changed: IssuePatchField[];
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
    | 'needs_write_scope'
    | 'not_installed'
    | 'wrong_workspace'
    | 'fixture_only'
    /** Additive: Linear's own permissions refused the person's edit. */
    | 'linear_forbidden';
  constructor(code: EngineAuthError['code'], message: string) {
    super(message);
    this.name = 'EngineAuthError';
    this.code = code;
  }
}

/**
 * Thrown for invalid input; the web layer maps it to 400/404/409, and
 * (additive) `rate_limited` to 429.
 */
export class EngineInputError extends Error {
  readonly code: 'invalid' | 'not_found' | 'conflict' | 'rate_limited';
  /** For rate_limited: when Linear says the limit resets, if it said. */
  readonly retryAt: IsoDateTime | null;
  constructor(
    code: EngineInputError['code'],
    message: string,
    options: { retryAt?: IsoDateTime | null } = {}
  ) {
    super(message);
    this.name = 'EngineInputError';
    this.code = code;
    this.retryAt = options.retryAt ?? null;
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
  /**
   * Additive: the workspace's saved settings layered over the defaults
   * (unconfigured workspaces get the defaults with DEFAULT_TIMEZONE), as
   * load() reports them, but without syncing or reading the mirror and
   * without requiring an installation. The timezone is returned as saved,
   * even when invalid.
   */
  getSettings(workspaceId: string): Promise<WorkspaceSettings>;
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
    /**
     * Additive: the workspace-local day to run (claim and warnings), as
     * the scheduler decided it. Defaults to today in the workspace
     * timezone. Must be today or yesterday there (a decision made just
     * before local midnight), else EngineInputError('invalid').
     */
    day?: IsoDate;
  }): Promise<DailyResult>;
  listWorkspaceIds(): Promise<string[]>;

  // --- milestone, project and settings edits ----------------------------------
  // Open to every signed-in person (owner decision 2026-10-22). The Linear
  // writes (target date, lead) need actor.canWriteLinear; weight, "done
  // means…" and settings are the planner's own data. Each is audited.
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

  // --- issue page (owner decision 2026-10-21; additive) ---------------------
  // Reads need only a session. Writes need actor.canWriteLinear (any
  // signed-in person who granted write), are validated
  // against the mirror (and the team's live labels / estimate scale),
  // go to Linear with the person's own token, patch the mirror at once and
  // append an audit entry per changed field.

  /** The issue page: mirror view model, live extras, allocation history. */
  getIssueDetail(actor: Actor, issueId: string): Promise<IssueDetailResult>;
  /** Edits an issue's fields (only the patch's keys). */
  updateIssue(
    actor: Actor,
    issueId: string,
    patch: IssuePatch
  ): Promise<IssueUpdateResult>;
  /** Adds a comment (markdown, 1–10,000 characters) as the person. */
  addComment(
    actor: Actor,
    issueId: string,
    body: string
  ): Promise<IssueComment>;
  /**
   * Adds "blockerIssueId blocks issueId". For "this issue blocks X", call
   * it with X as issueId and this issue as the blocker.
   */
  addBlocker(
    actor: Actor,
    issueId: string,
    blockerIssueId: string
  ): Promise<BlockingRelation>;
  /** Removes a blocks relation (by its Linear id). */
  removeRelation(actor: Actor, relationId: string): Promise<void>;

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
