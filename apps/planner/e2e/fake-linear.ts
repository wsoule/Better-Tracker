// A fake of Linear's API for the planner's tests (architecture §11): the
// planner's real gateway talks to it through LINEAR_API_URL (a
// loopback-only, test-only override), the e2e serves it with Bun.serve
// (fake-linear-server.ts), and route tests call its fetch in-process. It
// is built on the linear package's own test fakes (workspaceHandlers,
// graphqlFetch and the node builders), so it answers in the shapes the
// gateway's queries select.
//
// It serves two organizations (fake-linear-data.ts): Acme, the api-key
// suite's, and Globex, a second full workspace for the OAuth suite. Every
// caller sees what its account may see in Linear: a member every public
// team and the private ones they belong to, a guest only their own teams,
// an app user (actor=app) every team.
//
// Two ways in, by the Authorization header:
// - one of the test API keys, raw (a personal key is never sent as
//   Bearer), always into Acme, exactly as the api-key suite expects.
//   READONLY's writes are refused the way a Read-only key's are assumed
//   to be (F7); OTHERORG answers identity only, for another org.
// - `Bearer <access token>` from the fake's OAuth endpoints
//   (fake-linear-oauth.ts): the grant's organization, as its person, or
//   as the org's app user for an actor=app token. A token without the
//   `write` scope cannot write; an unknown, revoked or expired one gets
//   401 like Linear's.
//
// Paths (any host, so the in-process fetch can use Linear's own URLs):
// POST /graphql, POST /oauth/token, POST /oauth/revoke, GET|POST
// /oauth/authorize (the workspace chooser, linear-authorize.ts), and the
// test controls GET /__requests, GET /__health, GET /__oauth/code, GET
// /__oauth/grants and POST /__oauth/authorize-behaviour. Every request is
// logged without its credential: {operation, auth, who, keyInBodyOrUrl}
// for a key, plus the org and actor for a bearer token, and the OAuth
// calls with their secrets left out.

import {
  connection,
  dataResponse,
  graphqlFetch,
  type GraphqlHandler,
  issueNode,
  jsonResponse,
  milestoneNode,
  projectNode,
  relationNode,
  userNode,
  workspaceHandlers,
} from '../../../packages/linear/test/helpers';
import {
  ACME,
  FAKE_ORGS,
  type FakeOrg,
  type FakeOrgKey,
  type FakeTeam,
} from './fake-linear-data';
import type {
  FakeKeyRequestRecord,
  FakeRequestRecord,
} from './fake-linear-log';
import {
  createFakeOAuth,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  E2E_OAUTH_CLIENT,
  type FakeGrantSummary,
  type FakeOAuthClient,
  type FakeRevocation,
  type MintCodeInput,
  type MintCodeResult,
} from './fake-linear-oauth';
import { E2E_KEYS, type E2EKeyLabel } from './leak-needles';
import {
  answerAuthorize,
  type AuthorizeBehaviourChange,
  DEFAULT_AUTHORIZE_BEHAVIOUR,
  withBehaviour,
} from './linear-authorize';

export type { FakeOrgKey } from './fake-linear-data';
export {
  type FakeBearerRequestRecord,
  type FakeKeyRequestRecord,
  type FakeOAuthRequestRecord,
  type FakeRequestRecord,
  isBearerRecord,
  isOAuthRecord,
} from './fake-linear-log';

// An org's people as Linear user nodes (by user id, in listing order), and
// its app user's node.
function userNodesOf(org: FakeOrg): Record<string, Record<string, unknown>> {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const person of org.people) {
    nodes[person.id] = userNode(person.id, {
      name: person.name,
      displayName: person.handle,
      ...(person.email === undefined ? {} : { email: person.email }),
      ...(person.guest === true ? { guest: true } : {}),
    });
  }
  return nodes;
}

function appUserNodeOf(org: FakeOrg): Record<string, unknown> {
  return userNode(org.appUser.id, {
    name: org.appUser.name,
    displayName: org.appUser.handle,
    email: null,
    app: true,
  });
}

const USER_NODES: Record<
  FakeOrgKey,
  Record<string, Record<string, unknown>>
> = { acme: userNodesOf(ACME), globex: userNodesOf(FAKE_ORGS.globex) };
const APP_USER_NODES: Record<FakeOrgKey, Record<string, unknown>> = {
  acme: appUserNodeOf(ACME),
  globex: appUserNodeOf(FAKE_ORGS.globex),
};

const OTHER_ORG = { id: 'org-other', name: 'Other Co', urlKey: 'other' };
const OTHER_USER = userNode('user-oz', { name: 'Oz Other', displayName: 'oz' });

/** Who each key acts as (in Acme). */
const KEY_USER: Record<E2EKeyLabel, string> = {
  member: 'user-ana',
  second: 'user-ben',
  readonly: 'user-chloe',
  guest: 'user-gus',
  otherorg: 'user-oz',
  revoked: 'user-ana',
};

const STATE_KINDS: [string, string, number][] = [
  ['Backlog', 'backlog', 0],
  ['Todo', 'unstarted', 1],
  ['In Progress', 'started', 2],
  ['Done', 'completed', 3],
];

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** One org's mutable state: what edits and allocation change. */
interface FakeState {
  issues: Map<string, Record<string, unknown>>;
  descriptions: Map<string, string | null>;
  comments: Map<string, Record<string, unknown>[]>;
  commentCount: number;
  relations: Record<string, unknown>[];
  relationCount: number;
  /** Milestone id → its target date, once someone changed it. */
  milestoneDates: Map<string, string | null>;
  /** Project id → its lead's user id, once someone changed it. */
  projectLeads: Map<string, string | null>;
}

function initialState(org: FakeOrg, today: string): FakeState {
  const issues = new Map<string, Record<string, unknown>>();
  const prefix = org.idPrefix;
  const counters = new Map<string, number>();
  for (const [key, teamId, assignee, title] of org.issues) {
    const number = (counters.get(key) ?? 0) + 1;
    counters.set(key, number);
    const id = `${prefix}iss-${key.toLowerCase()}-${number}`;
    const team = key.toLowerCase();
    issues.set(
      id,
      issueNode(id, {
        identifier: `${key}-${number}`,
        title,
        url: `https://linear.app/${org.organization.urlKey}/issue/${key}-${number}`,
        createdAt: `${addDays(today, -10)}T10:00:00.000Z`,
        updatedAt: `${addDays(today, -2)}T10:00:00.000Z`,
        team: { id: teamId },
        project: { id: `${prefix}proj-${team}` },
        projectMilestone: { id: `${prefix}ms-${team}-1` },
        assignee: { id: assignee },
        state: { id: `${prefix}state-${team}-unstarted` },
        dueDate: null,
      })
    );
  }
  return {
    issues,
    descriptions: new Map(),
    comments: new Map(),
    commentCount: 0,
    relations: org.relations.map(([id, blocker, blocked]) =>
      relationNode(id, 'blocks', blocker, blocked)
    ),
    relationCount: 0,
    milestoneDates: new Map(),
    projectLeads: new Map(),
  };
}

/** Who a GraphQL request acts as, and in which org. */
interface Caller {
  org: FakeOrg;
  state: FakeState;
  userId: string;
  /** An actor=app token: the org's app user, who sees every team. */
  app: boolean;
  /** Refuses a write before it applies (a read-only key, a read-only token). */
  refuseWrite: (() => Response) | null;
  /**
   * Whether Users lists the app user too. Linear lists app users; the
   * api-key suite's Acme never did, and its answers stay as they were.
   */
  listAppUser: boolean;
}

// The teams a caller may see (a member: public + their own; a guest:
// their own; the app user: all).
function visibleTeams(caller: Caller): FakeTeam[] {
  if (caller.app) return caller.org.teams;
  const guest =
    caller.org.people.find((person) => person.id === caller.userId)?.guest ===
    true;
  return caller.org.teams.filter(
    (team) =>
      team.members.includes(caller.userId) ||
      (!guest && team.visibility === 'public')
  );
}

function nameOf(caller: Caller): string {
  if (caller.app) return caller.org.appUser.name;
  return (
    caller.org.people.find((person) => person.id === caller.userId)?.name ?? ''
  );
}

function teamOf(issue: Record<string, unknown>): string {
  return String((issue['team'] as { id: string }).id);
}

function idOf(ref: unknown): string {
  return String((ref as { id: string }).id);
}

function unauthorized(): Response {
  return jsonResponse(
    {
      errors: [
        {
          message: 'Authentication required',
          extensions: {
            code: 'AUTHENTICATION_ERROR',
            type: 'authentication error',
          },
        },
      ],
    },
    { status: 401 }
  );
}

function readOnlyRefusal(): Response {
  return jsonResponse({
    errors: [
      {
        message: 'Invalid scope: write required',
        extensions: {
          code: 'FORBIDDEN',
          type: 'forbidden',
          userPresentableMessage:
            'This API key does not have permission to perform this action',
        },
      },
    ],
  });
}

// An OAuth token granted without `write` (a plain sign-in) that writes.
function scopeRefusal(): Response {
  return jsonResponse({
    errors: [
      {
        message: 'Invalid scope: write required',
        extensions: {
          code: 'FORBIDDEN',
          type: 'forbidden',
          userPresentableMessage:
            'This access token does not have the write scope',
        },
      },
    ],
  });
}

function notFound(field: string): Response {
  return jsonResponse({
    data: null,
    errors: [
      {
        message: 'Entity not found',
        path: [field],
        extensions: { code: 'INPUT_ERROR', type: 'invalid input' },
      },
    ],
  });
}

// Everything one caller can read and write, as the gateway's queries and
// mutations ask for it.
function handlersFor(
  caller: Caller,
  today: string
): Record<string, GraphqlHandler> {
  const { org, state, userId } = caller;
  const prefix = org.idPrefix;
  const teams = visibleTeams(caller);
  const teamIds = new Set(teams.map((team) => team.id));
  const projects = teams.map((team) => {
    const id = `${prefix}proj-${team.key.toLowerCase()}`;
    const lead = state.projectLeads.get(id);
    return projectNode(id, {
      name: `${team.name} roadmap`,
      url: `https://linear.app/${org.organization.urlKey}/project/${team.key.toLowerCase()}`,
      startDate: addDays(today, -20),
      targetDate: addDays(today, 60),
      lead:
        lead === undefined
          ? { id: team.members[0] }
          : lead === null
            ? null
            : { id: lead },
      initiatives: { nodes: [] },
      teams: { nodes: [{ id: team.id }] },
    });
  });
  const milestones = teams.map((team) => {
    const id = `${prefix}ms-${team.key.toLowerCase()}-1`;
    const date = state.milestoneDates.get(id);
    return milestoneNode(id, {
      name: `${team.name} beta`,
      description: `Done means: the ${team.name.toLowerCase()} beta is in users' hands.`,
      targetDate: date === undefined ? addDays(today, 45) : date,
      project: { id: `${prefix}proj-${team.key.toLowerCase()}` },
    });
  });
  const issues = [...state.issues.values()].filter((issue) =>
    teamIds.has(teamOf(issue))
  );
  const issueIds = new Set(issues.map((issue) => String(issue['id'])));
  const relations = state.relations.filter(
    (r) =>
      issueIds.has(idOf(r['issue'])) && issueIds.has(idOf(r['relatedIssue']))
  );
  const users = Object.values(USER_NODES[org.key]);
  const appUser = APP_USER_NODES[org.key];
  const handlers = workspaceHandlers({
    identity: {
      viewer: (caller.app ? appUser : USER_NODES[org.key][userId]) ?? {},
      organization: org.organization,
    },
    pages: {
      Users: [caller.listAppUser ? [...users, appUser] : users],
      Teams: [
        teams.map((team) => ({
          id: team.id,
          key: team.key,
          name: team.name,
          visibility: team.visibility,
          parent: null,
        })),
      ],
      WorkflowStates: [
        teams.flatMap((team) =>
          STATE_KINDS.map(([name, type, position]) => ({
            id: `${prefix}state-${team.key.toLowerCase()}-${type}`,
            name,
            type,
            position,
            team: { id: team.id },
          }))
        ),
      ],
      Initiatives: [[]],
      Projects: [projects],
      ProjectMilestones: [milestones],
      ProjectIssues: [issues],
      OpenIssuesWithoutProject: [[]],
      IssueRelations: [relations],
      TeamMemberships: [
        teams.flatMap((team) =>
          team.members.map((member) => ({
            team: { id: team.id },
            user: { id: member },
          }))
        ),
      ],
    },
  });

  const visibleIssue = (id: unknown): Record<string, unknown> | null => {
    const issue = state.issues.get(String(id));
    return issue !== undefined && teamIds.has(teamOf(issue)) ? issue : null;
  };
  const comments = (id: string) => connection(state.comments.get(id) ?? []);

  handlers['Issue'] = (variables) => {
    const issue = visibleIssue(variables['id']);
    return issue === null
      ? notFound('issue')
      : dataResponse({
          issue: { ...issue, archivedAt: null, trashed: false },
        });
  };
  handlers['IssueDetail'] = (variables) => {
    const issue = visibleIssue(variables['id']);
    if (issue === null) return notFound('issue');
    const id = String(issue['id']);
    return dataResponse({
      issue: {
        id,
        description: state.descriptions.get(id) ?? null,
        estimate: null,
        dueDate: null,
        archivedAt: null,
        trashed: false,
        team: {
          id: teamOf(issue),
          issueEstimationType: 'notUsed',
          issueEstimationAllowZero: false,
          issueEstimationExtended: false,
          inheritIssueEstimation: false,
          parent: null,
        },
        labels: connection([]),
        comments: comments(id),
      },
    });
  };
  handlers['IssueCommentsPage'] = (variables) =>
    dataResponse({
      issue: {
        id: variables['id'],
        comments: comments(String(variables['id'])),
      },
    });
  handlers['IssueLabelsPage'] = (variables) =>
    dataResponse({ issue: { id: variables['id'], labels: connection([]) } });
  handlers['TeamIssueLabels'] = () =>
    dataResponse({ issueLabels: connection([]) });
  handlers['IssueRelationsForIssue'] = (variables) => {
    const id = String(variables['id']);
    return dataResponse({
      issue: {
        id,
        relations: connection(relations.filter((r) => idOf(r['issue']) === id)),
        inverseRelations: connection(
          relations.filter((r) => idOf(r['relatedIssue']) === id)
        ),
      },
    });
  };
  const spans: GraphqlHandler = (variables) => {
    const data: Record<string, unknown> = {};
    for (const [name, id] of Object.entries(variables)) {
      data[`i${name.slice(2)}`] = {
        id,
        stateHistory: connection([]),
        history: connection([]),
      };
    }
    return dataResponse(data);
  };
  handlers['IssueStateSpans'] = spans;
  handlers['IssueStateHistory'] = spans;

  handlers['IssueUpdate'] = (variables) => {
    if (caller.refuseWrite !== null) return caller.refuseWrite();
    const issue = visibleIssue(variables['id']);
    if (issue === null) return notFound('issue');
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...issue,
      updatedAt: new Date().toISOString(),
    };
    if (typeof input['title'] === 'string') next['title'] = input['title'];
    if (typeof input['stateId'] === 'string') {
      next['state'] = { id: input['stateId'] };
    }
    if (input['assigneeId'] !== undefined) {
      next['assignee'] =
        input['assigneeId'] === null ? null : { id: input['assigneeId'] };
    }
    if (typeof input['priority'] === 'number')
      next['priority'] = input['priority'];
    if (input['description'] !== undefined) {
      state.descriptions.set(
        String(issue['id']),
        (input['description'] as string | null) ?? null
      );
    }
    state.issues.set(String(issue['id']), next);
    return dataResponse({ issueUpdate: { success: true, issue: next } });
  };
  handlers['CommentCreate'] = (variables) => {
    if (caller.refuseWrite !== null) return caller.refuseWrite();
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const issue = visibleIssue(input['issueId']);
    if (issue === null) return notFound('issue');
    state.commentCount += 1;
    const comment = {
      id: `${prefix}comment-${state.commentCount}`,
      body: typeof input['body'] === 'string' ? input['body'] : '',
      createdAt: new Date().toISOString(),
      url: null,
      parent: null,
      user: { id: userId, name: nameOf(caller) },
      botActor: null,
      externalUser: null,
    };
    const id = String(issue['id']);
    state.comments.set(id, [...(state.comments.get(id) ?? []), comment]);
    return dataResponse({
      commentCreate: { success: true, comment: { id: comment.id } },
    });
  };
  handlers['ProjectMilestoneUpdate'] = (variables) => {
    if (caller.refuseWrite !== null) return caller.refuseWrite();
    const id = String(variables['id']);
    const milestone = milestones.find((m) => m['id'] === id);
    if (milestone === undefined) return notFound('projectMilestoneUpdate');
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const targetDate =
      typeof input['targetDate'] === 'string' ? input['targetDate'] : null;
    state.milestoneDates.set(id, targetDate);
    return dataResponse({
      projectMilestoneUpdate: {
        success: true,
        projectMilestone: { ...milestone, targetDate },
      },
    });
  };
  handlers['ProjectUpdate'] = (variables) => {
    if (caller.refuseWrite !== null) return caller.refuseWrite();
    const id = String(variables['id']);
    const project = projects.find((p) => p['id'] === id);
    if (project === undefined) return notFound('projectUpdate');
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const leadId = typeof input['leadId'] === 'string' ? input['leadId'] : null;
    state.projectLeads.set(id, leadId);
    return dataResponse({
      projectUpdate: {
        success: true,
        project: { ...project, lead: leadId === null ? null : { id: leadId } },
      },
    });
  };
  handlers['IssueRelationCreate'] = (variables) => {
    if (caller.refuseWrite !== null) return caller.refuseWrite();
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const blocker = visibleIssue(input['issueId']);
    const blocked = visibleIssue(input['relatedIssueId']);
    if (blocker === null || blocked === null) {
      return notFound('issueRelationCreate');
    }
    state.relationCount += 1;
    const relation = relationNode(
      `${prefix}rel-new-${state.relationCount}`,
      typeof input['type'] === 'string' ? input['type'] : 'blocks',
      String(blocker['id']),
      String(blocked['id'])
    );
    state.relations.push(relation);
    return dataResponse({
      issueRelationCreate: { success: true, issueRelation: relation },
    });
  };
  handlers['IssueRelationDelete'] = (variables) => {
    if (caller.refuseWrite !== null) return caller.refuseWrite();
    const id = String(variables['id']);
    if (!relations.some((r) => r['id'] === id)) {
      return notFound('issueRelationDelete');
    }
    state.relations = state.relations.filter((r) => r['id'] !== id);
    return dataResponse({
      issueRelationDelete: { success: true, entityId: id },
    });
  };
  return handlers;
}

/** Options for createFakeLinear; only `today` is required. */
export interface FakeLinearOptions {
  /** The day the data is laid out around (YYYY-MM-DD). */
  today: string;
  /** The OAuth client the token and revoke endpoints accept (E2E_OAUTH_CLIENT). */
  oauthClient?: FakeOAuthClient;
  /** Access token lifetime in seconds (Linear's 86399 by default). */
  accessTokenTtlSeconds?: number;
  /** Clock (epoch ms) for code and token expiry; Date.now by default. */
  now?: () => number;
  /** How GET /oauth/authorize answers at first (linear-authorize.ts). */
  authorize?: AuthorizeBehaviourChange;
}

/** A fake Linear (see the file comment). */
export function createFakeLinear(options: FakeLinearOptions): {
  /** For an in-process gateway or engine (FetchLike), by URL path. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** For Bun.serve: every path in the file comment. */
  handle: (request: Request) => Promise<Response>;
  requests: FakeRequestRecord[];
  /** Mints an authorization code, as GET /__oauth/code does. */
  mintCode: (input: MintCodeInput) => MintCodeResult;
  /** Every grant so far (no tokens), as GET /__oauth/grants lists them. */
  grants: () => FakeGrantSummary[];
  /** Every revoke call so far, oldest first. */
  revocations: FakeRevocation[];
  /** Changes how /oauth/authorize answers from now on. */
  setAuthorizeBehaviour: (changes: AuthorizeBehaviourChange) => void;
} {
  const { today } = options;
  const states: Record<FakeOrgKey, FakeState> = {
    acme: initialState(ACME, today),
    globex: initialState(FAKE_ORGS.globex, today),
  };
  const requests: FakeRequestRecord[] = [];
  const holdsApiKey = (text: string): boolean =>
    Object.values(E2E_KEYS).some((key) => text.includes(key));
  const oauth = createFakeOAuth({
    client: options.oauthClient ?? E2E_OAUTH_CLIENT,
    now: options.now ?? Date.now,
    accessTokenTtlSeconds:
      options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    record: (record) => requests.push(record),
    holdsApiKey,
  });
  let behaviour = withBehaviour(DEFAULT_AUTHORIZE_BEHAVIOUR, options.authorize);

  // A key's handlers: Acme as that key's person, or OTHERORG's identity.
  function keyHandlers(label: E2EKeyLabel): Record<string, GraphqlHandler> {
    if (label === 'otherorg') {
      return workspaceHandlers({
        identity: { viewer: OTHER_USER, organization: OTHER_ORG },
      });
    }
    return handlersFor(
      {
        org: ACME,
        state: states.acme,
        userId: KEY_USER[label],
        app: false,
        refuseWrite: label === 'readonly' ? readOnlyRefusal : null,
        listAppUser: false,
      },
      today
    );
  }

  async function answer(
    handlers: Record<string, GraphqlHandler>,
    url: string,
    body: string,
    operation: string
  ): Promise<Response> {
    const fake = graphqlFetch(handlers);
    try {
      return await fake.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      return jsonResponse({
        errors: [{ message: `The fake does not answer ${operation}` }],
      });
    }
  }

  async function graphql(request: Request): Promise<Response> {
    const url = request.url;
    const body = await request.text();
    const header = request.headers.get('authorization');
    const keyInBodyOrUrl = holdsApiKey(body) || holdsApiKey(url);
    let operation = '';
    try {
      const parsed = JSON.parse(body) as { query?: unknown };
      const match =
        typeof parsed.query === 'string'
          ? /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(parsed.query)
          : null;
      operation = match?.[2] ?? 'anonymous';
    } catch {
      operation = 'unparseable';
    }

    if (header !== null && header.startsWith('Bearer ')) {
      const check = oauth.checkAccess(header.slice('Bearer '.length));
      const grant = check.grant;
      requests.push({
        operation,
        auth: 'bearer',
        who: grant?.who ?? 'unknown',
        org: grant?.org ?? null,
        actor: grant?.actor ?? null,
        status: check.state === 'ok' ? 200 : 401,
        refused: check.state === 'ok' ? null : check.state,
        keyInBodyOrUrl,
        tokenInBodyOrUrl: oauth.holdsIssued(body) || oauth.holdsIssued(url),
      });
      if (check.state !== 'ok') return unauthorized();
      const org = FAKE_ORGS[check.grant.org];
      return answer(
        handlersFor(
          {
            org,
            state: states[org.key],
            userId: check.grant.userId,
            app: check.grant.actor === 'app',
            refuseWrite: check.grant.scopes.includes('write')
              ? null
              : scopeRefusal,
            listAppUser: true,
          },
          today
        ),
        url,
        body,
        operation
      );
    }

    let auth: FakeKeyRequestRecord['auth'] = 'none';
    let who: FakeKeyRequestRecord['who'] = 'none';
    if (header !== null && header !== '') {
      auth = 'raw';
      const found = (Object.keys(E2E_KEYS) as E2EKeyLabel[]).find(
        (label) => E2E_KEYS[label] === header
      );
      who = found ?? 'unknown';
    }
    requests.push({ operation, auth, who, keyInBodyOrUrl });
    if (
      auth !== 'raw' ||
      who === 'unknown' ||
      who === 'none' ||
      who === 'revoked'
    ) {
      return unauthorized();
    }
    return answer(keyHandlers(who), url, body, operation);
  }

  // GET /__oauth/code?org=globex&user=ana&scope=read&actor=user (plus
  // client_id, redirect_uri, code_challenge, code_challenge_method and
  // prompt, as an authorize URL carries them).
  function mintFromQuery(params: URLSearchParams): Response {
    const actor = params.get('actor');
    const result = oauth.mintCode({
      org: params.get('org') ?? '',
      user: params.get('user'),
      scope: params.get('scope'),
      actor: actor === 'app' ? 'app' : 'user',
      clientId: params.get('client_id'),
      redirectUri: params.get('redirect_uri'),
      codeChallenge: params.get('code_challenge'),
      codeChallengeMethod: params.get('code_challenge_method'),
      prompt: params.get('prompt'),
    });
    if (!result.ok) {
      return jsonResponse(
        { error: result.error, error_description: result.description },
        { status: result.status }
      );
    }
    const { ok: _ok, ...minted } = result;
    return jsonResponse(minted);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    if (method === 'POST' && pathname === '/graphql') return graphql(request);
    if (method === 'POST' && pathname === '/oauth/token') {
      return oauth.token(request);
    }
    if (method === 'POST' && pathname === '/oauth/revoke') {
      return oauth.revoke(request);
    }
    if (
      (method === 'GET' || method === 'POST') &&
      pathname === '/oauth/authorize'
    ) {
      const form =
        method === 'POST' ? new URLSearchParams(await request.text()) : null;
      const reply = await answerAuthorize(
        { url: request.url, method, form },
        behaviour,
        (input) => Promise.resolve(oauth.mintCode(input))
      );
      return new Response(reply.body, {
        status: reply.status,
        headers: reply.headers,
      });
    }
    if (method === 'GET' && pathname === '/__requests') {
      return Response.json(requests);
    }
    if (method === 'GET' && pathname === '/__health') {
      return new Response('ok');
    }
    if (method === 'GET' && pathname === '/__oauth/code') {
      return mintFromQuery(url.searchParams);
    }
    if (method === 'GET' && pathname === '/__oauth/grants') {
      return Response.json(oauth.grants());
    }
    if (method === 'POST' && pathname === '/__oauth/authorize-behaviour') {
      try {
        behaviour = withBehaviour(
          behaviour,
          (await request.json()) as AuthorizeBehaviourChange
        );
      } catch {
        return jsonResponse({ error: 'invalid behaviour' }, { status: 400 });
      }
      return Response.json(behaviour);
    }
    return new Response('not found', { status: 404 });
  }

  return {
    handle,
    requests,
    mintCode: (input) => oauth.mintCode(input),
    grants: () => oauth.grants(),
    revocations: oauth.revocations,
    setAuthorizeBehaviour: (changes) => {
      behaviour = withBehaviour(behaviour, changes);
    },
    fetch: (url, init) =>
      handle(
        new Request(url, {
          method: init.method ?? 'POST',
          headers: init.headers,
          body: init.body,
        })
      ),
  };
}

export { ACME, FAKE_ORGS, GLOBEX } from './fake-linear-data';
export { E2E_OAUTH_CLIENT, OAUTH_TOKEN_PREFIX } from './fake-linear-oauth';
