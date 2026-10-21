import type {
  BlockingRelation,
  Initiative,
  IsoDate,
  IsoDateTime,
  Issue,
  Milestone,
  Project,
  User,
  WorkspaceData,
} from '@better-tracker/core';

/** Registered Linear OAuth application credentials. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Must match a callback URL registered on the Linear OAuth app. */
  redirectUri: string;
}

/** Result of a token exchange or refresh. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry computed from expires_in; null if not provided. */
  expiresAt: IsoDateTime | null;
  scopes: string[];
}

/** The identity a Linear access token acts as. */
export interface LinearIdentity {
  /** The viewer: the human for actor=user tokens, the app user for actor=app. */
  user: User;
  workspace: { id: string; name: string; urlKey: string };
}

/**
 * Everything the tool reads from or writes to Linear, behind one interface so
 * the engine can run against the real API, the in-memory fixture workspace
 * (demo mode), or test doubles.
 *
 * Writes are limited to exactly the four the design allows (§8): issue
 * assignee + state, issue comment, milestone target date, project lead.
 */
export interface LinearGateway {
  whoAmI(): Promise<LinearIdentity>;

  /**
   * Full mirror of the workspace: all users, teams, workflow states,
   * initiatives, non-archived projects with their milestones, issues that
   * belong to a project (open and closed), open issues without a project,
   * and "blocks" relations. Issue.lastStateChangeAt is the approximation
   * from timestamps; call fetchLastStateChanges to refine it.
   */
  fetchWorkspace(): Promise<WorkspaceData>;

  /** When each issue last changed workflow state, from issue history. */
  fetchLastStateChanges(issueIds: string[]): Promise<Map<string, IsoDateTime>>;

  /** null when the issue no longer exists or is archived. */
  fetchIssue(id: string): Promise<Issue | null>;
  /** Every "blocks" relation the issue takes part in, either side. */
  fetchIssueRelations(issueId: string): Promise<BlockingRelation[]>;
  /** The project and all its milestones; null when gone or archived. */
  fetchProject(
    id: string
  ): Promise<{ project: Project; milestones: Milestone[] } | null>;
  fetchMilestone(id: string): Promise<Milestone | null>;
  fetchUser(id: string): Promise<User | null>;
  fetchInitiative(id: string): Promise<Initiative | null>;

  /** Assigns and/or moves an issue; returns the updated issue. */
  updateIssue(
    id: string,
    input: { assigneeId?: string; stateId?: string }
  ): Promise<Issue>;
  createComment(issueId: string, body: string): Promise<{ id: string }>;
  updateMilestoneTargetDate(
    id: string,
    targetDate: IsoDate | null
  ): Promise<Milestone>;
  updateProjectLead(id: string, leadId: string | null): Promise<Project>;
}

/** Thrown by gateways for API failures, with enough detail to log and show. */
export class LinearApiError extends Error {
  readonly kind:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'invalid_input'
    | 'network'
    | 'server'
    | 'graphql';
  /** For rate_limited: when Linear says the limit resets. */
  readonly retryAt: IsoDateTime | null;

  constructor(
    kind: LinearApiError['kind'],
    message: string,
    options: { retryAt?: IsoDateTime | null; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'LinearApiError';
    this.kind = kind;
    this.retryAt = options.retryAt ?? null;
  }
}
