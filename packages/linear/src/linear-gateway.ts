// The LinearGateway backed by Linear's GraphQL API. It pages every root
// connection, maps nodes into core types (map.ts), refines "last state
// change" from issue history in aliased batches, and performs the four
// writes the design allows. Transport, retries and error mapping live in
// client.ts; dropping relations whose ends are not mirrored is core's job.

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

import {
  createGraphqlClient,
  type FetchLike,
  type GraphqlClient,
  LinearGraphqlErrors,
  type LinearLogger,
} from './client';
import {
  LinearApiError,
  type LinearGateway,
  type LinearIdentity,
} from './gateway';
import {
  isRecord,
  type JsonObject,
  optionalString,
  readConnection,
  requireObject,
  requireString,
} from './json';
import {
  isArchivedNode,
  mapBlockingRelation,
  mapInitiative,
  mapIssue,
  mapMilestone,
  mapProject,
  mapTeam,
  mapUser,
  mapWorkflowState,
} from './map';
import {
  batchAlias,
  batchVariable,
  buildIssueHistoryBatchQuery,
  buildStateHistoryBatchQuery,
  COMMENT_CREATE_MUTATION,
  IDENTITY_QUERY,
  INITIATIVE_QUERY,
  INITIATIVES_QUERY,
  ISSUE_HISTORY_PAGE_QUERY,
  ISSUE_INVERSE_RELATIONS_PAGE_QUERY,
  ISSUE_QUERY,
  ISSUE_RELATIONS_PAGE_QUERY,
  ISSUE_RELATIONS_QUERY,
  ISSUE_UPDATE_MUTATION,
  MILESTONE_QUERY,
  OPEN_ISSUES_WITHOUT_PROJECT_QUERY,
  PAGE_SIZE,
  PROJECT_ISSUES_QUERY,
  PROJECT_MILESTONE_UPDATE_MUTATION,
  PROJECT_MILESTONES_PAGE_QUERY,
  PROJECT_MILESTONES_QUERY,
  PROJECT_QUERY,
  PROJECT_UPDATE_MUTATION,
  PROJECTS_QUERY,
  STATE_CHANGE_BATCH_SIZE,
  STATE_HISTORY_PAGE_QUERY,
  TEAMS_QUERY,
  USER_QUERY,
  USERS_QUERY,
  WORKFLOW_STATES_QUERY,
  WORKSPACE_RELATIONS_QUERY,
} from './queries';

export interface LinearGatewayOptions {
  accessToken: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  logger?: LinearLogger;
  /** Defaults to https://api.linear.app/graphql. */
  endpoint?: string;
  /** Passed to the GraphQL client (tests inject a no-op sleep). */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  now?: () => number;
}

/**
 * Extra pages fetched per issue when its current state span or newest
 * history entry is not on the first page (issues with 50+ state changes).
 */
const MAX_EXTRA_HISTORY_PAGES = 4;

/** Upper bound for a nested connection (relations, milestones) of one entity. */
const MAX_NESTED_PAGES = 100;

const TIMELESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

const noopLogger: LinearLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function asData(value: unknown, operation: string): JsonObject {
  if (!isRecord(value)) {
    throw new LinearApiError(
      'graphql',
      `Malformed Linear response: ${operation} returned no data object`
    );
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return error instanceof LinearApiError && error.kind === 'not_found';
}

// GraphQL-level failures a fallback can work around (a field the token may
// not use, a malformed page); transport, auth and rate-limit errors are not.
function isQueryFailure(error: unknown): error is LinearApiError {
  return (
    error instanceof LinearApiError &&
    (error.kind === 'graphql' || error.kind === 'invalid_input')
  );
}

function maxIso(
  a: IsoDateTime | null,
  b: IsoDateTime | null
): IsoDateTime | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function normalizeIso(raw: string | null): IsoDateTime | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Start of the span the issue is in now: stateHistory spans whose endedAt
// is null. Linear does not document the order, so search every node.
function currentSpanStart(nodes: readonly JsonObject[]): IsoDateTime | null {
  let latest: IsoDateTime | null = null;
  for (const node of nodes) {
    const endedAt = node['endedAt'];
    if (endedAt !== null && endedAt !== undefined) continue;
    latest = maxIso(latest, normalizeIso(optionalString(node, 'startedAt')));
  }
  return latest;
}

// Fallback from Issue.history: the newest entry that changed the state
// (toStateId set). Order is not relied on either.
function latestStateChangeEntry(
  nodes: readonly JsonObject[]
): IsoDateTime | null {
  let latest: IsoDateTime | null = null;
  for (const node of nodes) {
    if (optionalString(node, 'toStateId') === null) continue;
    latest = maxIso(latest, normalizeIso(optionalString(node, 'createdAt')));
  }
  return latest;
}

// Which batch aliases (i0, i1…) a GraphQL error points at. Returns null when
// any error cannot be pinned to an alias, so the caller rethrows instead of
// silently dropping issues.
function failedAliasIndexes(error: unknown): Set<number> | null {
  if (!(error instanceof LinearApiError)) return null;
  if (
    !(
      error.kind === 'not_found' ||
      error.kind === 'graphql' ||
      error.kind === 'invalid_input'
    )
  ) {
    return null;
  }
  if (!(error.cause instanceof LinearGraphqlErrors)) return null;
  const indexes = new Set<number>();
  for (const info of error.cause.errors) {
    const head = info.path[0];
    const match = typeof head === 'string' ? /^i(\d+)$/.exec(head) : null;
    if (match?.[1] === undefined) return null;
    indexes.add(Number(match[1]));
  }
  return indexes.size > 0 ? indexes : null;
}

interface AliasedBatchResult {
  /** Issue node per id that came back. */
  nodes: Map<string, JsonObject>;
  /** Ids whose alias failed (deleted issue, field unavailable…). */
  failed: string[];
}

/** Creates a gateway that talks to Linear with one access token. */
export function createLinearGateway(
  options: LinearGatewayOptions
): LinearGateway {
  const logger = options.logger ?? noopLogger;
  const client: GraphqlClient = createGraphqlClient({
    accessToken: options.accessToken,
    fetch: options.fetch,
    endpoint: options.endpoint,
    logger,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    now: options.now,
  });

  // Pages a root connection (`field` in the response) to the end, following
  // pageInfo.endCursor. A repeated cursor aborts instead of looping forever.
  async function fetchAllPages(
    query: string,
    field: string
  ): Promise<JsonObject[]> {
    const nodes: JsonObject[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const data = asData(
        await client.request<unknown>(query, { first: PAGE_SIZE, after }),
        field
      );
      const page = readConnection(data[field], field);
      for (const node of page.nodes) nodes.push(node);
      if (!page.hasNextPage || page.endCursor === null) return nodes;
      if (seenCursors.has(page.endCursor)) {
        throw new LinearApiError(
          'graphql',
          `Linear returned a repeated ${field} cursor`
        );
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }
  }

  // Follows a nested connection of one entity (e.g. a project's milestones)
  // after its first page, using a page query keyed by the entity id. Stops
  // at `maxPages` or on a repeated cursor so a bad response cannot loop.
  async function fetchRemainingNested(
    pageQuery: string,
    root: string,
    field: string,
    id: string,
    firstCursor: string | null,
    maxPages: number
  ): Promise<JsonObject[]> {
    const nodes: JsonObject[] = [];
    const seenCursors = new Set<string>();
    let after = firstCursor;
    for (let page = 0; after !== null && page < maxPages; page++) {
      if (seenCursors.has(after)) {
        throw new LinearApiError(
          'graphql',
          `Linear returned a repeated ${root}.${field} cursor`
        );
      }
      seenCursors.add(after);
      const data = asData(
        await client.request<unknown>(pageQuery, { id, after }),
        root
      );
      const entity = requireObject(data, root, root);
      const connection = readConnection(entity[field], `${root}.${field}`);
      for (const node of connection.nodes) nodes.push(node);
      after = connection.hasNextPage ? connection.endCursor : null;
    }
    return nodes;
  }

  // Runs one aliased batch (`i0: issue(id: $id0) …`). When Linear rejects
  // specific aliases (e.g. a deleted issue makes the non-null root fail),
  // those ids are set aside and the rest are retried.
  async function runAliasedBatch(
    ids: readonly string[],
    build: (count: number) => string
  ): Promise<AliasedBatchResult> {
    let remaining = [...ids];
    const failed: string[] = [];
    while (remaining.length > 0) {
      const variables: Record<string, unknown> = {};
      remaining.forEach((id, i) => {
        variables[batchVariable(i)] = id;
      });
      try {
        const data = asData(
          await client.request<unknown>(build(remaining.length), variables),
          'batch'
        );
        const nodes = new Map<string, JsonObject>();
        remaining.forEach((id, i) => {
          const node = data[batchAlias(i)];
          if (isRecord(node)) nodes.set(id, node);
          else failed.push(id);
        });
        return { nodes, failed };
      } catch (error) {
        const indexes = failedAliasIndexes(error);
        if (indexes === null) throw error;
        const kept: string[] = [];
        remaining.forEach((id, i) => {
          if (indexes.has(i)) failed.push(id);
          else kept.push(id);
        });
        if (kept.length === remaining.length) throw error;
        remaining = kept;
      }
    }
    return { nodes: new Map(), failed };
  }

  // Refines up to STATE_CHANGE_BATCH_SIZE issues: current state span first,
  // then Issue.history for the issues stateHistory could not answer.
  async function refineBatch(
    batch: readonly string[],
    out: Map<string, IsoDateTime>
  ): Promise<void> {
    let spans: AliasedBatchResult;
    try {
      spans = await runAliasedBatch(batch, buildStateHistoryBatchQuery);
    } catch (error) {
      if (!isQueryFailure(error)) throw error;
      logger.warn(
        'linear stateHistory lookup failed; falling back to history',
        { issues: batch.length, error: error.message }
      );
      spans = { nodes: new Map(), failed: [...batch] };
    }

    const needHistory = [...spans.failed];
    for (const [id, node] of spans.nodes) {
      const connection = readConnection(
        node['stateHistory'],
        'Issue.stateHistory'
      );
      let started = currentSpanStart(connection.nodes);
      if (started === null && connection.hasNextPage) {
        try {
          const more = await fetchRemainingNested(
            STATE_HISTORY_PAGE_QUERY,
            'issue',
            'stateHistory',
            id,
            connection.endCursor,
            MAX_EXTRA_HISTORY_PAGES
          );
          started = currentSpanStart(more);
        } catch (error) {
          if (!isQueryFailure(error)) throw error;
        }
      }
      if (started === null) needHistory.push(id);
      else out.set(id, started);
    }
    if (needHistory.length === 0) return;

    const history = await runAliasedBatch(
      needHistory,
      buildIssueHistoryBatchQuery
    );
    for (const [id, node] of history.nodes) {
      const connection = readConnection(node['history'], 'Issue.history');
      let latest = latestStateChangeEntry(connection.nodes);
      if (connection.hasNextPage) {
        const more = await fetchRemainingNested(
          ISSUE_HISTORY_PAGE_QUERY,
          'issue',
          'history',
          id,
          connection.endCursor,
          MAX_EXTRA_HISTORY_PAGES
        );
        latest = maxIso(latest, latestStateChangeEntry(more));
      }
      if (latest !== null) out.set(id, latest);
    }
    if (history.failed.length > 0) {
      logger.debug('linear issues skipped in state-change lookup', {
        issueIds: history.failed,
      });
    }
  }

  // Wraps a single-entity read: Linear answers a missing id with an
  // "Entity not found" error, which the gateway contract turns into null.
  async function readSingle(
    query: string,
    id: string,
    field: string
  ): Promise<JsonObject | null> {
    let data: JsonObject;
    try {
      data = asData(await client.request<unknown>(query, { id }), field);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const node = data[field];
    if (!isRecord(node) || isArchivedNode(node)) return null;
    return node;
  }

  // Checks a mutation payload's `success` flag and returns the entity field.
  function payloadEntity(
    data: JsonObject,
    mutation: string,
    field: string
  ): unknown {
    const payload = requireObject(data, mutation, mutation);
    if (payload['success'] !== true) {
      throw new LinearApiError(
        'graphql',
        `Linear ${mutation} reported success=false`
      );
    }
    const entity = payload[field];
    if (!isRecord(entity)) {
      throw new LinearApiError(
        'graphql',
        `Linear ${mutation} returned no ${field}`
      );
    }
    return entity;
  }

  const gateway: LinearGateway = {
    async whoAmI(): Promise<LinearIdentity> {
      const data = asData(
        await client.request<unknown>(IDENTITY_QUERY),
        'Identity'
      );
      const organization = requireObject(data, 'organization', 'Identity');
      return {
        user: mapUser(data['viewer']),
        workspace: {
          id: requireString(organization, 'id', 'Organization'),
          name: requireString(organization, 'name', 'Organization'),
          urlKey: requireString(organization, 'urlKey', 'Organization'),
        },
      };
    },

    async fetchWorkspace(): Promise<WorkspaceData> {
      const [
        identity,
        userNodes,
        teamNodes,
        stateNodes,
        initiativeNodes,
        projectNodes,
        milestoneNodes,
        projectIssueNodes,
        looseIssueNodes,
        relationNodes,
      ] = await Promise.all([
        client.request<unknown>(IDENTITY_QUERY),
        fetchAllPages(USERS_QUERY, 'users'),
        fetchAllPages(TEAMS_QUERY, 'teams'),
        fetchAllPages(WORKFLOW_STATES_QUERY, 'workflowStates'),
        fetchAllPages(INITIATIVES_QUERY, 'initiatives'),
        fetchAllPages(PROJECTS_QUERY, 'projects'),
        fetchAllPages(PROJECT_MILESTONES_QUERY, 'projectMilestones'),
        fetchAllPages(PROJECT_ISSUES_QUERY, 'issues'),
        fetchAllPages(OPEN_ISSUES_WITHOUT_PROJECT_QUERY, 'issues'),
        fetchAllPages(WORKSPACE_RELATIONS_QUERY, 'issueRelations'),
      ]);

      const organization = requireObject(
        asData(identity, 'Identity'),
        'organization',
        'Identity'
      );
      const projects = projectNodes.map((node) => mapProject(node, logger));
      const projectIds = new Set(projects.map((p) => p.id));

      // The server-side filters already restrict milestones and issues to
      // mirrored projects; this keeps the mirror consistent if a project
      // was archived between pages.
      const milestones = milestoneNodes
        .map(mapMilestone)
        .filter((m) => projectIds.has(m.projectId));

      const issuesById = new Map<string, Issue>();
      for (const node of [...projectIssueNodes, ...looseIssueNodes]) {
        const issue = mapIssue(node);
        if (issue.projectId !== null && !projectIds.has(issue.projectId))
          continue;
        issuesById.set(issue.id, issue);
      }

      const relationsById = new Map<string, BlockingRelation>();
      for (const node of relationNodes) {
        const relation = mapBlockingRelation(node);
        if (relation !== null) relationsById.set(relation.id, relation);
      }

      return {
        workspaceId: requireString(organization, 'id', 'Organization'),
        users: userNodes.map(mapUser),
        teams: teamNodes.map(mapTeam),
        states: stateNodes.map((node) => mapWorkflowState(node, logger)),
        initiatives: initiativeNodes.map(mapInitiative),
        projects,
        milestones,
        issues: [...issuesById.values()],
        relations: [...relationsById.values()],
      };
    },

    async fetchLastStateChanges(
      issueIds: string[]
    ): Promise<Map<string, IsoDateTime>> {
      const unique = [...new Set(issueIds)];
      const out = new Map<string, IsoDateTime>();
      // Sequential batches keep a large refresh from bursting the rate limit.
      for (let i = 0; i < unique.length; i += STATE_CHANGE_BATCH_SIZE) {
        await refineBatch(unique.slice(i, i + STATE_CHANGE_BATCH_SIZE), out);
      }
      return out;
    },

    async fetchIssue(id: string): Promise<Issue | null> {
      const node = await readSingle(ISSUE_QUERY, id, 'issue');
      return node === null ? null : mapIssue(node);
    },

    async fetchIssueRelations(issueId: string): Promise<BlockingRelation[]> {
      const node = await readSingle(ISSUE_RELATIONS_QUERY, issueId, 'issue');
      if (node === null) return [];
      const owned = readConnection(node['relations'], 'Issue.relations');
      const inverse = readConnection(
        node['inverseRelations'],
        'Issue.inverseRelations'
      );
      const [moreOwned, moreInverse] = await Promise.all([
        owned.hasNextPage
          ? fetchRemainingNested(
              ISSUE_RELATIONS_PAGE_QUERY,
              'issue',
              'relations',
              issueId,
              owned.endCursor,
              MAX_NESTED_PAGES
            )
          : Promise.resolve([]),
        inverse.hasNextPage
          ? fetchRemainingNested(
              ISSUE_INVERSE_RELATIONS_PAGE_QUERY,
              'issue',
              'inverseRelations',
              issueId,
              inverse.endCursor,
              MAX_NESTED_PAGES
            )
          : Promise.resolve([]),
      ]);
      const byId = new Map<string, BlockingRelation>();
      for (const relationNode of [
        ...owned.nodes,
        ...moreOwned,
        ...inverse.nodes,
        ...moreInverse,
      ]) {
        const relation = mapBlockingRelation(relationNode);
        if (relation !== null) byId.set(relation.id, relation);
      }
      return [...byId.values()];
    },

    async fetchProject(
      id: string
    ): Promise<{ project: Project; milestones: Milestone[] } | null> {
      const node = await readSingle(PROJECT_QUERY, id, 'project');
      if (node === null) return null;
      const project = mapProject(node, logger);
      const first = readConnection(
        node['projectMilestones'],
        'Project.projectMilestones'
      );
      const rest = first.hasNextPage
        ? await fetchRemainingNested(
            PROJECT_MILESTONES_PAGE_QUERY,
            'project',
            'projectMilestones',
            id,
            first.endCursor,
            MAX_NESTED_PAGES
          )
        : [];
      return {
        project,
        milestones: [...first.nodes, ...rest].map(mapMilestone),
      };
    },

    async fetchMilestone(id: string): Promise<Milestone | null> {
      const node = await readSingle(MILESTONE_QUERY, id, 'projectMilestone');
      return node === null ? null : mapMilestone(node);
    },

    async fetchUser(id: string): Promise<User | null> {
      const node = await readSingle(USER_QUERY, id, 'user');
      return node === null ? null : mapUser(node);
    },

    async fetchInitiative(id: string): Promise<Initiative | null> {
      const node = await readSingle(INITIATIVE_QUERY, id, 'initiative');
      return node === null ? null : mapInitiative(node);
    },

    async updateIssue(
      id: string,
      input: { assigneeId?: string; stateId?: string }
    ): Promise<Issue> {
      // Only the provided fields are sent, so Linear leaves the rest alone.
      const patch: Record<string, string> = {};
      if (input.assigneeId !== undefined)
        patch['assigneeId'] = input.assigneeId;
      if (input.stateId !== undefined) patch['stateId'] = input.stateId;
      if (Object.keys(patch).length === 0) {
        throw new LinearApiError(
          'invalid_input',
          'updateIssue needs assigneeId or stateId'
        );
      }
      const data = asData(
        await client.request<unknown>(ISSUE_UPDATE_MUTATION, {
          id,
          input: patch,
        }),
        'issueUpdate'
      );
      const issue = mapIssue(payloadEntity(data, 'issueUpdate', 'issue'));
      // The state just changed, so the issue entered it at updatedAt; the
      // timestamp approximation alone would miss moves between open states.
      if (input.stateId !== undefined) {
        issue.lastStateChangeAt =
          maxIso(issue.lastStateChangeAt, issue.updatedAt) ?? issue.updatedAt;
      }
      return issue;
    },

    async createComment(
      issueId: string,
      body: string
    ): Promise<{ id: string }> {
      // Not idempotent: a retried 5xx could post the comment twice.
      const data = asData(
        await client.request<unknown>(
          COMMENT_CREATE_MUTATION,
          { input: { issueId, body } },
          { idempotent: false }
        ),
        'commentCreate'
      );
      const comment = payloadEntity(data, 'commentCreate', 'comment');
      return { id: requireString(asData(comment, 'Comment'), 'id', 'Comment') };
    },

    async updateMilestoneTargetDate(
      id: string,
      targetDate: IsoDate | null
    ): Promise<Milestone> {
      if (targetDate !== null && !TIMELESS_DATE.test(targetDate)) {
        throw new LinearApiError(
          'invalid_input',
          `targetDate must be YYYY-MM-DD: ${targetDate}`
        );
      }
      const data = asData(
        await client.request<unknown>(PROJECT_MILESTONE_UPDATE_MUTATION, {
          id,
          input: { targetDate },
        }),
        'projectMilestoneUpdate'
      );
      return mapMilestone(
        payloadEntity(data, 'projectMilestoneUpdate', 'projectMilestone')
      );
    },

    async updateProjectLead(
      id: string,
      leadId: string | null
    ): Promise<Project> {
      const data = asData(
        await client.request<unknown>(PROJECT_UPDATE_MUTATION, {
          id,
          input: { leadId },
        }),
        'projectUpdate'
      );
      return mapProject(
        payloadEntity(data, 'projectUpdate', 'project'),
        logger
      );
    },
  };

  return gateway;
}
