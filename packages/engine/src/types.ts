import type {
  AllocationBlockReason,
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
  IssueBulkPatch,
  IssueLabel,
  IssueListOptions,
  IssueListQuery,
  IssueListView,
  IssuePatch,
  IssuePatchField,
  MilestoneAssessment,
  MilestoneDetail,
  Priority,
  RubricGap,
  Snapshot,
  TimelineView,
  User,
  WarningsMode,
  WeekView,
  WorkflowStateType,
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
  BlockedWorkspace,
  BlockKind,
  Installation,
  IssueRunEntry,
  NotificationRecord,
  RevokedReason,
  RunEntry,
  RunTrigger,
  Session,
  Store,
  SyncState,
  WorkspaceStatus,
  WorkspaceTable,
} from '@better-tracker/store';

import type { KeySyncScheduler } from './key-sync';
import type { KeyVault } from './key-vault';

/**
 * How the planner reaches Linear (`LINEAR_AUTH`, architecture §7.1):
 * `demo` the in-memory demo workspace (LINEAR_FIXTURE), `oauth` an OAuth
 * app with stored, encrypted tokens, `api_key` each person's own personal
 * API key held only in the planner's memory (owner request 2026-10-23).
 */
export type LinearAuthMode = 'demo' | 'oauth' | 'api_key';

/** EngineConfig.apiKey: what api_key mode runs with. */
export interface ApiKeyConfig {
  /** API_KEY_IDLE_MS: a key unused this long is forgotten. */
  idleMs: number;
  /** API_KEY_MAX_MS: a key is forgotten this long after connecting. */
  absoluteMs: number;
  /** SYNC_INTERVAL_MINUTES in ms: background sync while a member is connected. */
  syncIntervalMs: number;
  /** LINEAR_WORKSPACE as given (URL key or organization id), or null. */
  workspacePin: string | null;
  /** The GraphQL endpoint: LINEAR_API_URL (test-only) or Linear's. */
  endpoint: string;
  /** NODE_ENV=production on a non-loopback APP_URL. */
  deployed: boolean;
}

/** Static configuration for one deployment. */
export interface EngineConfig {
  /** Additive: how the planner reaches Linear (LINEAR_AUTH). */
  auth: LinearAuthMode;
  /** Set only when auth is api_key. */
  apiKey: ApiKeyConfig | null;
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
  /**
   * Additive, api_key mode only: the in-memory key vault and its
   * background sync scheduler (boot.ts createApiKeyEngine builds them).
   */
  keys?: ApiKeyDeps;
  /**
   * Additive, api_key mode: builds a gateway around a key getter (the
   * connect check and the vault use the same one). Defaults to the real
   * GraphQL gateway at config.apiKey.endpoint; tests inject the fixture.
   */
  apiKeyGateway?: (credential: () => string | null) => LinearGateway;
}

/** The api_key-mode pieces createEngine wires in (EngineDeps.keys). */
export interface ApiKeyDeps {
  vault: KeyVault;
  scheduler: KeySyncScheduler | null;
}

/**
 * The signed-in person making a request. There are no roles: since the
 * owner decision of 2026-10-22 every signed-in person may make every edit
 * and start every run, with one exception that comes from Linear itself:
 * a Linear guest is read-only (`readOnly`, owner decision 2026-10-22,
 * "Guests limited to read only"). Only edits written to Linear need
 * `canWriteLinear`, because they go out with the person's own token.
 */
export interface Actor {
  session: Session;
  /**
   * Granted Linear scopes of the user's token include `write`. Since the
   * owner decision of 2026-10-21 every signed-in person may hold it (the
   * grant_write upgrade is offered to everyone but guests) and edit issues
   * with it. Always false while `readOnly`.
   */
  canWriteLinear: boolean;
  /**
   * The person is a Linear guest per the mirror when they were
   * authenticated (`User.guest`), or someone the mirror does not know,
   * who is treated like a guest as per-viewer visibility does (§2.13).
   * A read-only person may look at what Linear lets them see but change
   * nothing through the planner: every mutating engine method refuses
   * them first with EngineAuthError('read_only') (requireWritable).
   */
  readOnly: boolean;
  /**
   * Why `readOnly` is true, so the planner can say it: `guest` (a Linear
   * guest), `unknown` (the mirror has no such person yet) or `not_synced`
   * (an installed workspace whose first sync has not landed, so nobody
   * can be placed; an install or reinstall is still allowed then, since
   * only a Linear admin can approve one). Absent when `readOnly` is false.
   */
  readOnlyReason?: ReadOnlyReason;
}

/**
 * Why an Actor is read-only (Actor.readOnlyReason). Additive:
 * `read_only_key`, a personal API key Linear refused a write for as out of
 * its scope (api_key mode).
 */
export type ReadOnlyReason =
  | 'guest'
  | 'unknown'
  | 'not_synced'
  | 'read_only_key';

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
  /**
   * Additive: the viewer is read-only (a Linear guest, Actor.readOnly):
   * no edit controls and no write grant to offer.
   */
  readOnly: boolean;
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

/**
 * The issue list (owner request 2026-10-22, "every issue in one list"):
 * what getIssueList returns, with the mirror version it was built from.
 */
export interface IssueListResult {
  view: IssueListView;
  mirrorVersion: number;
}

/** The issue list's picker options, with the mirror version. */
export interface IssueListOptionsResult {
  options: IssueListOptions;
  mirrorVersion: number;
}

/** An issue's placement, owner, priority and status before a bulk edit (Undo's input). */
export interface IssueBulkBefore {
  projectId: string | null;
  milestoneId: string | null;
  assigneeId: string | null;
  priority: Priority;
  stateType: WorkflowStateType;
  /** '' when the mirror does not know the state. */
  stateName: string;
}

/** What a bulk edit did to one requested issue. */
export type IssueBulkOutcome =
  | {
      status: 'changed';
      issueId: string;
      identifier: string;
      /** The fields Linear was asked to change, in patch order. */
      changed: IssuePatchField[];
      before: IssueBulkBefore;
    }
  /** It already had every value: nothing was sent. */
  | { status: 'unchanged'; issueId: string; identifier: string }
  | {
      status: 'skipped';
      issueId: string;
      identifier: string;
      /**
       * state_not_in_team: its team has no status of that type and name;
       * not_attempted: a rate limit or a rejected sign-in stopped the run.
       */
      reason: 'state_not_in_team' | 'not_attempted';
      message: string;
    }
  | {
      status: 'failed';
      issueId: string;
      /** Null when the planner does not hold the issue. */
      identifier: string | null;
      code: 'not_found' | 'invalid' | 'linear_forbidden' | 'linear_error';
      message: string;
    };

/** What updateIssues did (architecture §7.3). */
export interface IssueBulkResult {
  /** The one instant every audit entry of the call shares. */
  at: IsoDateTime;
  /** In request order (repeated ids once). */
  outcomes: IssueBulkOutcome[];
  counts: {
    changed: number;
    unchanged: number;
    skipped: number;
    failed: number;
  };
  /**
   * Set when a rate limit, a rejected sign-in or (api_key mode) a key that
   * may only read stopped the run part-way.
   */
  stopped: null | {
    code: 'rate_limited' | 'not_signed_in' | 'read_only';
    retryAt: IsoDateTime | null;
  };
  /** How the change moved the viewer's allocation plan (the toast's second sentence). */
  allocation: {
    /**
     * Changed issues the next allocation run gives to a lead that the plan
     * before the change did not, by project.
     */
    handedOver: {
      projectId: string;
      projectName: string;
      leadName: string;
      issueIds: string[];
      /** allocationMode is live (else the run is a dry run). */
      live: boolean;
    }[];
    /** Touched projects whose allocation is blocked now but was not before. */
    stopped: {
      projectId: string;
      projectName: string;
      reason: AllocationBlockReason;
      gaps: RubricGap[];
    }[];
  };
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
   * Of the sessions this pass ended (expired ones, and those of
   * workspaces uninstalled or removed), the ones whose Linear grant was
   * revoked, and revocations that failed (best effort; always 0 in demo
   * mode, which has no grants).
   */
  revokedTokens: number;
  revokeFailures: number;
  /** Webhook delivery records older than the retention window, deleted. */
  oldDeliveries: number;
  // Additive (several workspaces, owner decision 2026-10-25), always set
  // by cleanup(); optional only so results built by hand elsewhere keep
  // compiling (read them with `?? 0`).
  /**
   * Sessions of workspaces uninstalled or removed that were created
   * before the revoke, ended (an admin who signed in afterwards to
   * reinstall keeps theirs).
   */
  endedWorkspaceSessions?: number;
  /** Workspaces purged PURGE_AFTER_DAYS after their uninstall or removal. */
  purgedWorkspaces?: number;
  /** Notifications older than NOTIFICATION_RETENTION_DAYS, deleted. */
  oldNotifications?: number;
  /** Daily job claims older than JOB_CLAIM_RETENTION_DAYS, deleted. */
  oldJobClaims?: number;
}

/**
 * What removeWorkspace did (the operator's `remove`, §9). Holds no
 * Linear credential.
 */
export interface WorkspaceRemoval {
  workspaceId: string;
  /**
   * This call revoked the installation as 'removed' (false: there is no
   * installation row, or it was uninstalled or removed already).
   */
  revoked: boolean;
  /**
   * Linear accepted the revocation of the app's token; null when there
   * was no app token to revoke (no active installation, or demo mode).
   */
  appTokenRevoked: boolean | null;
  /** The workspace's sessions ended now, and their grant revocations. */
  endedSessions: number;
  revokedTokens: number;
  revokeFailures: number;
}

/**
 * What purgeWorkspaceNow did (the operator's `purge`, §9): the rows
 * deleted per table, or why nothing was: `not_installed` (no installation
 * row: nothing to purge but sessions, which removeWorkspace ends),
 * `not_revoked` (run remove first) or `too_recent` (revoked less than
 * OPERATOR_PURGE_MIN_MINUTES ago: a sync may still be finishing).
 */
export type WorkspacePurge =
  | {
      purged: true;
      workspaceId: string;
      /** Sessions ended (their grants revoked) just before the purge. */
      endedSessions: number;
      counts: Record<WorkspaceTable, number>;
    }
  | {
      purged: false;
      workspaceId: string;
      reason: 'not_installed' | 'not_revoked' | 'too_recent';
    };

/** What blockWorkspace stored and did (the operator's `block`, §9). */
export interface WorkspaceBlock {
  /** The stored key (lower-cased): the org id, or a URL key nobody here knows yet. */
  key: string;
  kind: BlockKind;
  /** The workspace the name resolved to; null for an unknown URL key. */
  workspaceId: string | null;
  /** Removing the resolved workspace (revoke, sessions); null when unresolved. */
  removal: WorkspaceRemoval | null;
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

/** What connectApiKey returns (api_key mode). */
export interface ApiKeyConnectResult extends SignInResult {
  /** The route should start a sync after responding (§7.7). */
  syncAfter: boolean;
}

/** What signOut did (additive). */
export interface SignOutResult {
  /**
   * Whether the token named anyone: a session row, or (api_key mode) a
   * connected key, live, expired or recently ended on its own. False for
   * a token nobody knows (the logout route then never says the key was
   * forgotten everywhere).
   */
  known: boolean;
  /** Connected API keys forgotten (api_key mode; always 0 otherwise). */
  keysForgotten: number;
}

/**
 * The connected person's key status for Settings (api_key mode). Holds no
 * key or token, by construction.
 */
export interface KeyConnectionStatus {
  connectedAt: IsoDateTime;
  /** The absolute limit. */
  expiresAt: IsoDateTime;
  idleMinutes: number;
  /** Whose key the mirror is read with right now, if anyone's. */
  reader: { userId: string; userName: string } | null;
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
    | 'linear_forbidden'
    /**
     * Additive: the person is a Linear guest (Actor.readOnly), who may
     * look but change nothing through the planner (403).
     */
    | 'read_only'
    /** Additive (api_key mode): Linear did not accept the pasted key. */
    | 'key_rejected'
    /** Additive (api_key mode): the pasted key cannot read Linear. */
    | 'key_cannot_read'
    /** Additive (api_key mode): a guest tried to bind an unbound planner. */
    | 'guest_cannot_bind'
    /**
     * Additive (api_key mode): no workspace member has a key connected,
     * so nothing can read Linear for the mirror (503, not "signed out").
     */
    | 'no_reader';
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
  /**
   * Completes the admin's actor=app install for the actor's workspace. A
   * read-only actor (a Linear guest) is refused first (read_only).
   */
  finishInstall(input: {
    code: string;
    codeVerifier: string;
    actor: Actor;
  }): Promise<Installation>;
  /** Fixture mode only: sign in as a demo user without OAuth. */
  devSignIn(userId: string): Promise<SignInResult>;
  /** Resolves a cookie token into an Actor, or null. */
  authenticate(sessionToken: string | undefined): Promise<Actor | null>;
  /**
   * Ends a session. Additive `everyDevice` (api_key mode only, ignored
   * elsewhere): forget every connected key of that person, not just this
   * browser's, even when this browser's own connection already ended on
   * its own. Additive result: whether the token named anyone, and how many
   * keys were forgotten.
   */
  signOut(
    sessionToken: string,
    options?: { everyDevice?: boolean }
  ): Promise<SignOutResult>;
  /**
   * Additive (api_key mode): checks a pasted personal API key with Linear
   * (viewer and organization), binds the workspace on the first member's
   * connect, and holds the key in memory only. Any other mode refuses it.
   */
  connectApiKey(input: { apiKey: string }): Promise<ApiKeyConnectResult>;
  /** Additive: the actor's key status (null outside api_key mode). */
  getKeyConnection(actor: Actor): Promise<KeyConnectionStatus | null>;
  /** Users offered on the fixture-mode sign-in screen. */
  listDemoUsers(): Promise<User[]>;

  // --- reads ----------------------------------------------------------------
  // Additive `viewer` (§2.13): the signed-in person a read is for. With it,
  // the mirror is narrowed to the teams that person may see (a member: the
  // public teams and the private ones they belong to; a guest: only their
  // teams) before anything is built. Every read made for a person passes
  // it; only the worker's own jobs and tests read the whole mirror.
  load(workspaceId: string, viewer?: Actor): Promise<LoadedWorkspace>;
  /**
   * Additive: the workspace's saved settings layered over the defaults
   * (unconfigured workspaces get the defaults with DEFAULT_TIMEZONE), as
   * load() reports them, but without syncing or reading the mirror and
   * without requiring an installation. The timezone is returned as saved,
   * even when invalid.
   */
  getSettings(workspaceId: string): Promise<WorkspaceSettings>;
  getWeekView(
    workspaceId: string,
    userId: string,
    viewer?: Actor
  ): Promise<WeekView>;
  getTimelineView(workspaceId: string, viewer?: Actor): Promise<TimelineView>;
  /**
   * A dependency graph for a scope per §2.10: a level inside the
   * workspace, an initiative, a project, a milestone or one issue's chain
   * (by id or identifier). EngineInputError `invalid` or `not_found` per
   * core's resolveGraphScope, over the viewer's mirror (a hidden id is
   * `not_found`, like an unknown one); `fallback` is set when the viewer's
   * mirror has no initiatives (a guest) and the scope named some.
   */
  getGraph(
    workspaceId: string,
    scope: GraphScope,
    viewer?: Actor
  ): Promise<DependencyGraph>;
  getMilestoneDetail(
    workspaceId: string,
    milestoneId: string,
    viewer?: Actor
  ): Promise<MilestoneDetail>;
  /**
   * Additive (owner request 2026-10-22): the issue list (architecture
   * §2.14) as `viewer` may see it; LIST_ME is the viewer. A read: guests
   * get it too.
   */
  getIssueList(
    workspaceId: string,
    query: IssueListQuery,
    viewer?: Actor
  ): Promise<IssueListResult>;
  /** Additive: the issue list's picker options as `viewer` may see them. */
  getIssueListOptions(
    workspaceId: string,
    viewer?: Actor
  ): Promise<IssueListOptionsResult>;
  listRuns(workspaceId: string, limit: number): Promise<AllocationRun[]>;
  /** With `viewer`, entries about what they cannot see are left out. */
  getRun(
    workspaceId: string,
    runId: string,
    viewer?: Actor
  ): Promise<{ run: AllocationRun; entries: RunEntry[] } | null>;
  listNotifications(
    workspaceId: string,
    limit: number
  ): Promise<NotificationRecord[]>;
  /** With `viewer`, entries about what they cannot see are left out. */
  listAudit(
    workspaceId: string,
    limit: number,
    viewer?: Actor
  ): Promise<AuditEntry[]>;
  getInstallation(workspaceId: string): Promise<Installation | null>;

  // --- jobs -------------------------------------------------------------------
  /**
   * Takes no actor: the web's resync route refuses a read-only person
   * (requireWritable) before calling it.
   */
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
    /**
     * Additive: the payload's `createdAt` (LinearWebhookEvent.createdAt).
     * An OAuthApp revoked event created before the installation's last
     * update (a reinstall since) is ignored as stale; without it the
     * revoke always applies.
     */
    createdAt?: string | null;
  }): Promise<'processed' | 'duplicate' | 'ignored'>;
  /**
   * A person's run (`actor` set) refuses a read-only actor (a Linear
   * guest) first with read_only; the worker's runs pass null.
   */
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
    /**
     * Additive, with previewOnly: the person previewing (§2.13). Each
     * digest then shows only the items and issues that person may see. A
     * read-only viewer (a Linear guest) is refused with read_only: the
     * preview is computed from everyone's digests.
     */
    viewer?: Actor;
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
  /**
   * Additive: workspaces whose installation lost its Linear grant
   * (revokedAt set: uninstalled, or a refresh Linear rejected), which
   * listWorkspaceIds leaves out. The worker reports each one as a failed
   * workspace until an admin reinstalls, so allocation and warnings never
   * stop silently.
   */
  listRevokedWorkspaceIds(): Promise<string[]>;

  // --- milestone, project and settings edits ----------------------------------
  // Open to every signed-in person (owner decision 2026-10-22) except a
  // read-only one (a Linear guest), who is refused first with read_only.
  // The Linear writes (target date, lead) need actor.canWriteLinear;
  // weight, "done means…" and settings are the planner's own data. Each
  // is audited.
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
  // Reads need only a session. Writes refuse a read-only actor (a Linear
  // guest) first with read_only, then need actor.canWriteLinear (any
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
   * Additive (owner request 2026-10-22, architecture §7.3): moves up to
   * ISSUE_BULK_MAX issues at once (milestone and project, assignee,
   * status by name, priority) with the person's own token, each issue
   * the single edit's write, all audited with one shared `at`. A guest is
   * refused first (read_only), then write scope is needed. Per-issue
   * failures are outcomes; a stop with nothing changed throws
   * not_signed_in or rate_limited.
   */
  updateIssues(
    actor: Actor,
    issueIds: readonly string[],
    patch: IssueBulkPatch
  ): Promise<IssueBulkResult>;

  // --- workspaces: lifecycle and operator commands (additive, §7, §9) ------
  // Several workspaces share one deployment (owner decision 2026-10-25).
  // These act on whole workspaces, across sessions: they are for the
  // worker and its operator CLI only, and no planner route may call them
  // (there is no operator role in the planner; the planner reads its own
  // workspace's state through getInstallation and authenticate). None
  // returns a Linear credential. With personal API keys every one but the
  // two listings refuses (EngineInputError 'invalid'). A workspace is
  // named by its org id or URL key (matched without case; the
  // installation's URL key, else the newest session's): unknown →
  // EngineInputError 'not_found', a URL key two workspaces share →
  // 'conflict', a malformed name → 'invalid'.

  /**
   * Every workspace the store knows (installed, or only signed in to),
   * ordered by last full sync attempt (never attempted first), with its
   * installation summary, sync state and unexpired session count. No
   * tokens, no emails.
   */
  listWorkspaceStatus(): Promise<WorkspaceStatus[]>;
  /**
   * Revokes the installation as `reason` (wiping its credentials) and
   * forgets this process's cached mirror of it; true when the row changed
   * (store.revokeInstallation's rules: `ifUpdatedBefore` ignores a stale
   * revoke, an existing revoke is kept, 'grant_dead' may become
   * 'uninstalled' or 'removed'). No Linear call, no session ended (cleanup
   * ends them).
   */
  revokeWorkspace(
    workspaceId: string,
    reason: RevokedReason,
    options?: { ifUpdatedBefore?: IsoDateTime }
  ): Promise<boolean>;
  /**
   * The operator's `remove`: revokes the app's token with Linear (best
   * effort), revokes the installation as 'removed' (purged
   * PURGE_AFTER_DAYS later unless someone reinstalls, which stays
   * allowed), and ends every session of the workspace now, revoking
   * each grant (best effort).
   */
  removeWorkspace(idOrUrlKey: string): Promise<WorkspaceRemoval>;
  /**
   * The operator's `purge`: deletes everything the workspace holds now
   * (store.purgeWorkspace, 'grant_dead' allowed), after ending its
   * remaining sessions. Refuses a workspace that is not revoked, or was
   * revoked less than OPERATOR_PURGE_MIN_MINUTES before `now` (default:
   * the engine clock).
   */
  purgeWorkspaceNow(
    idOrUrlKey: string,
    options?: { now?: IsoDateTime }
  ): Promise<WorkspacePurge>;
  /**
   * The operator's `block`: stores a block by org id when the name
   * resolves to a workspace here (an unknown org-id-shaped name too),
   * else by URL key (pinned to the org id on its first match). Then a
   * resolved workspace is removed (removeWorkspace) when it has an
   * installation, and its sessions are ended either way. A blocked
   * workspace cannot sign in or reinstall until unblocked.
   */
  blockWorkspace(
    idOrUrlKey: string,
    reason?: string | null
  ): Promise<WorkspaceBlock>;
  /**
   * Removes the block on the name and on the org id it resolves to; true
   * when one existed. The workspace stays revoked: an admin reinstalls.
   */
  unblockWorkspace(idOrUrlKey: string): Promise<boolean>;
  /** Every block, ordered by key. */
  listBlockedWorkspaces(): Promise<BlockedWorkspace[]>;

  /**
   * Housekeeping for the worker: deletes expired sessions (revoking their
   * Linear grants, best effort) and webhook delivery records older than
   * 30 days. Additive: resolves with the counts. Additive (several
   * workspaces): ends the sessions of workspaces uninstalled or removed
   * that predate the revoke, purges such workspaces PURGE_AFTER_DAYS after
   * the revoke (a few per call; never 'grant_dead'), and prunes
   * notifications and job claims past their retention (bounded per call).
   * The audit log and the run log are never pruned.
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
