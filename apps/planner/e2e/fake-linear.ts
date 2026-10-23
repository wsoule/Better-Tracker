// A fake of Linear's GraphQL endpoint for the api-key tests (architecture
// §11): the planner's real gateway talks to it through LINEAR_API_URL (a
// loopback-only, test-only override), the e2e serves it with Bun.serve
// (fake-linear-server.ts), and route tests call its fetch in-process. It
// is built on the linear package's own test fakes (workspaceHandlers,
// graphqlFetch and the node builders), so it answers in the shapes the
// gateway's queries select.
//
// The workspace (org-acme, "Acme"): Ana, Ben and Chloe are members, Gus a
// guest. Three teams: Platform (ENG, public: Ana, Ben, Chloe, and Gus as
// a guest member), Mobile (MOB, public: Ben only) and Security (SEC,
// private: Ana only), one project and one milestone 45 days out per team,
// two issues per team, and ENG-1 blocks ENG-2. Each key sees what its
// account may see in Linear: a member every public team and the private
// ones they belong to, a guest only their own teams.
//
// Authorization must be one of the test keys, raw (a personal key is
// never sent as Bearer). READONLY's writes are refused the way a Read-only
// key's are assumed to be (F7). Every request is logged as {operation,
// auth, who, keyInBodyOrUrl} — never the key itself.

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
import { E2E_KEYS, type E2EKeyLabel } from './leak-needles';

/** What /__requests lists for every request (never the key). */
export interface FakeRequestRecord {
  operation: string;
  auth: 'raw' | 'bearer' | 'none';
  who: E2EKeyLabel | 'unknown' | 'none';
  keyInBodyOrUrl: boolean;
}

const ORG = { id: 'org-acme', name: 'Acme', urlKey: 'acme' };
const OTHER_ORG = { id: 'org-other', name: 'Other Co', urlKey: 'other' };

const USERS: Record<string, Record<string, unknown>> = {
  'user-ana': userNode('user-ana', { name: 'Ana Ruiz', displayName: 'ana' }),
  'user-ben': userNode('user-ben', { name: 'Ben Ortiz', displayName: 'ben' }),
  'user-chloe': userNode('user-chloe', {
    name: 'Chloe Kim',
    displayName: 'chloe',
  }),
  'user-gus': userNode('user-gus', {
    name: 'Gus Hart',
    displayName: 'gus',
    guest: true,
  }),
};
const OTHER_USER = userNode('user-oz', { name: 'Oz Other', displayName: 'oz' });

/** Who each key acts as. */
const KEY_USER: Record<E2EKeyLabel, string> = {
  member: 'user-ana',
  second: 'user-ben',
  readonly: 'user-chloe',
  guest: 'user-gus',
  otherorg: 'user-oz',
  revoked: 'user-ana',
};

interface FakeTeam {
  id: string;
  key: string;
  name: string;
  visibility: 'public' | 'private';
  members: string[];
}

const TEAMS: FakeTeam[] = [
  {
    id: 'team-eng',
    key: 'ENG',
    name: 'Platform',
    visibility: 'public',
    members: ['user-ana', 'user-ben', 'user-chloe', 'user-gus'],
  },
  {
    id: 'team-mob',
    key: 'MOB',
    name: 'Mobile',
    visibility: 'public',
    members: ['user-ben'],
  },
  {
    id: 'team-sec',
    key: 'SEC',
    name: 'Security',
    visibility: 'private',
    members: ['user-ana'],
  },
];

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

/** The fake's mutable state: its issues (as Linear nodes) and comments. */
interface FakeState {
  issues: Map<string, Record<string, unknown>>;
  descriptions: Map<string, string | null>;
  comments: Map<string, Record<string, unknown>[]>;
  commentCount: number;
}

function initialState(today: string): FakeState {
  const issues = new Map<string, Record<string, unknown>>();
  const plan: [string, string, string, string][] = [
    ['ENG', 'team-eng', 'user-ana', 'Ship the billing export'],
    ['ENG', 'team-eng', 'user-chloe', 'Retire the old cron'],
    ['MOB', 'team-mob', 'user-ben', 'Offline mode for the app'],
    ['MOB', 'team-mob', 'user-ben', 'Push notification settings'],
    ['SEC', 'team-sec', 'user-ana', 'Rotate the signing keys'],
    ['SEC', 'team-sec', 'user-ana', 'Audit admin sessions'],
  ];
  const counters = new Map<string, number>();
  for (const [key, teamId, assignee, title] of plan) {
    const number = (counters.get(key) ?? 0) + 1;
    counters.set(key, number);
    const id = `iss-${key.toLowerCase()}-${number}`;
    const team = key.toLowerCase();
    issues.set(
      id,
      issueNode(id, {
        identifier: `${key}-${number}`,
        title,
        url: `https://linear.app/acme/issue/${key}-${number}`,
        createdAt: `${addDays(today, -10)}T10:00:00.000Z`,
        updatedAt: `${addDays(today, -2)}T10:00:00.000Z`,
        team: { id: teamId },
        project: { id: `proj-${team}` },
        projectMilestone: { id: `ms-${team}-1` },
        assignee: { id: assignee },
        state: { id: `state-${team}-unstarted` },
        dueDate: null,
      })
    );
  }
  return {
    issues,
    descriptions: new Map(),
    comments: new Map(),
    commentCount: 0,
  };
}

// The teams `userId` may see (a member: public + their own; a guest:
// their own).
function visibleTeams(userId: string): FakeTeam[] {
  const guest = USERS[userId]?.['guest'] === true;
  return TEAMS.filter(
    (team) =>
      team.members.includes(userId) || (!guest && team.visibility === 'public')
  );
}

function nameOf(userId: string): string {
  const name = USERS[userId]?.['name'];
  return typeof name === 'string' ? name : '';
}

function teamOf(issue: Record<string, unknown>): string {
  return String((issue['team'] as { id: string }).id);
}

/** A fake Linear (see the file comment). */
export function createFakeLinear(options: { today: string }): {
  /** For an in-process gateway (FetchLike). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** For Bun.serve. */
  handle: (request: Request) => Promise<Response>;
  requests: FakeRequestRecord[];
} {
  const { today } = options;
  const state = initialState(today);
  const requests: FakeRequestRecord[] = [];

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

  // Everything one account can read, as the gateway's handlers serve it.
  function handlersFor(label: E2EKeyLabel): Record<string, GraphqlHandler> {
    if (label === 'otherorg') {
      return workspaceHandlers({
        identity: { viewer: OTHER_USER, organization: OTHER_ORG },
      });
    }
    const userId = KEY_USER[label];
    const teams = visibleTeams(userId);
    const teamIds = new Set(teams.map((team) => team.id));
    const projects = teams.map((team) =>
      projectNode(`proj-${team.key.toLowerCase()}`, {
        name: `${team.name} roadmap`,
        url: `https://linear.app/acme/project/${team.key.toLowerCase()}`,
        startDate: addDays(today, -20),
        targetDate: addDays(today, 60),
        lead: { id: team.members[0] },
        initiatives: { nodes: [] },
        teams: { nodes: [{ id: team.id }] },
      })
    );
    const milestones = teams.map((team) =>
      milestoneNode(`ms-${team.key.toLowerCase()}-1`, {
        name: `${team.name} beta`,
        description: `Done means: the ${team.name.toLowerCase()} beta is in users' hands.`,
        targetDate: addDays(today, 45),
        project: { id: `proj-${team.key.toLowerCase()}` },
      })
    );
    const issues = [...state.issues.values()].filter((issue) =>
      teamIds.has(teamOf(issue))
    );
    const issueIds = new Set(issues.map((issue) => String(issue['id'])));
    const relations = [
      relationNode('rel-1', 'blocks', 'iss-eng-1', 'iss-eng-2'),
    ].filter(
      (r) =>
        issueIds.has(String((r['issue'] as { id: string }).id)) &&
        issueIds.has(String((r['relatedIssue'] as { id: string }).id))
    );
    const handlers = workspaceHandlers({
      identity: { viewer: USERS[userId] ?? {}, organization: ORG },
      pages: {
        Users: [Object.values(USERS)],
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
              id: `state-${team.key.toLowerCase()}-${type}`,
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
    const notFound = (): Response =>
      jsonResponse({
        data: null,
        errors: [
          {
            message: 'Entity not found',
            path: ['issue'],
            extensions: { code: 'INPUT_ERROR', type: 'invalid input' },
          },
        ],
      });
    const comments = (id: string) => connection(state.comments.get(id) ?? []);

    handlers['Issue'] = (variables) => {
      const issue = visibleIssue(variables['id']);
      return issue === null
        ? notFound()
        : dataResponse({
            issue: { ...issue, archivedAt: null, trashed: false },
          });
    };
    handlers['IssueDetail'] = (variables) => {
      const issue = visibleIssue(variables['id']);
      if (issue === null) return notFound();
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
          relations: connection(
            relations.filter((r) => (r['issue'] as { id: string }).id === id)
          ),
          inverseRelations: connection(
            relations.filter(
              (r) => (r['relatedIssue'] as { id: string }).id === id
            )
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
      if (label === 'readonly') return readOnlyRefusal();
      const issue = visibleIssue(variables['id']);
      if (issue === null) return notFound();
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
      if (label === 'readonly') return readOnlyRefusal();
      const input = (variables['input'] ?? {}) as Record<string, unknown>;
      const issue = visibleIssue(input['issueId']);
      if (issue === null) return notFound();
      state.commentCount += 1;
      const comment = {
        id: `comment-${state.commentCount}`,
        body: typeof input['body'] === 'string' ? input['body'] : '',
        createdAt: new Date().toISOString(),
        url: null,
        parent: null,
        user: { id: userId, name: nameOf(userId) },
        botActor: null,
        externalUser: null,
      };
      const id = String(issue['id']);
      state.comments.set(id, [...(state.comments.get(id) ?? []), comment]);
      return dataResponse({
        commentCreate: { success: true, comment: { id: comment.id } },
      });
    };
    return handlers;
  }

  async function handle(request: Request): Promise<Response> {
    const url = request.url;
    const body = await request.text();
    const header = request.headers.get('authorization');
    const keyInBodyOrUrl = Object.values(E2E_KEYS).some(
      (key) => body.includes(key) || url.includes(key)
    );
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
    let auth: FakeRequestRecord['auth'] = 'none';
    let who: FakeRequestRecord['who'] = 'none';
    if (header !== null && header !== '') {
      auth = header.startsWith('Bearer ') ? 'bearer' : 'raw';
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
    const fake = graphqlFetch(handlersFor(who));
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

  return {
    handle,
    requests,
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
