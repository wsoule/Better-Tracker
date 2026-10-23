// Test harness for api_key mode (architecture §7 "API-key mode", §11): a
// real api_key engine (createApiKeyEngine) over a credential-free PGlite
// store and the fixture workspace, with a fake gateway factory standing in
// for Linear. The factory gets the vault's key getter and reads it on each
// call, maps the key to a fixture user, records (key label, method, first
// argument) for every call, and can be told to misbehave: refuse writes as
// out of the key's scope, refuse one issue, answer for another org,
// reject a key, fail transiently, or echo the key in an error. Keys are
// obviously fake (TESTKEY). Every test ends with leakScan().

import type { WorkspaceData } from '@better-tracker/core';
import { todayIn } from '@better-tracker/core';
import {
  createFixtureGateway,
  createFixtureStore,
  FIXTURE_MILESTONE_META,
  FIXTURE_WORKSPACE,
  type FixtureStore,
  LINEAR_GRAPHQL_ENDPOINT,
  LinearApiError,
  type LinearGateway,
  LinearGraphqlErrors,
} from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';
import {
  createSqlStore,
  openSql,
  type Sql,
  type Store,
} from '@better-tracker/store';
import { expect } from 'bun:test';

import { createApiKeyEngine } from '../src/boot';
import type { KeySyncTimers } from '../src/key-sync';
import { API_KEY_IDLE_MS, API_KEY_MAX_MS } from '../src/key-vault';
import type { Engine, EngineConfig } from '../src/types';
import { createClock, type TestClock, TEST_CONFIG, TEST_KEY } from './helpers';

export const KEYS = {
  member: 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc',
  second: 'lin_api_TESTKEY_second_f2Jg8Qs4Wn7Xc1Zv5Bk9Mp',
  readonly: 'lin_api_TESTKEY_readonly_h5Rk2Dw9Lp4Gs7Fz1Jx8',
  guest: 'lin_api_TESTKEY_guest_m3Nb6Vq1Yt8Ke4Xa9Pu2Ws7',
  otherorg: 'lin_api_TESTKEY_otherorg_c9Fh4Tz7Lw2Mq5Jn8Sb1',
  revoked: 'lin_api_TESTKEY_revoked_p6Ux1Gr8Hc3Wv5Ny9Bt2Z',
  appuser: 'lin_api_TESTKEY_appuser_k4Lm7Pq2Rs9Tv3Wx6Yz1A',
  hugo: 'lin_api_TESTKEY_hugo_d8Fg2Hj5Kl9Mn3Pq7Rs4Tv6',
} as const;
export type KeyLabel = keyof typeof KEYS;

/** Who each key acts as in the fixture (otherorg: Ana, but in another org). */
export const KEY_USERS: Record<KeyLabel, string> = {
  member: 'user-chloe',
  second: 'user-ben',
  readonly: 'user-dev',
  guest: 'user-gus',
  otherorg: 'user-ana',
  revoked: 'user-ana',
  appuser: 'user-app',
  hugo: 'user-hugo',
};

/** The private team only Chloe is in (holds the Atlas project). */
export const SECURITY_TEAM_ID = 'team-sec';
export const SECURITY_PROJECT_ID = 'proj-atlas';

/** The leak scan's needles: TESTKEY and each key's last 12 characters. */
export const NEEDLES: string[] = [
  'TESTKEY',
  ...Object.values(KEYS).map((key) => key.slice(-12)),
];

const WRITES = new Set([
  'updateIssue',
  'createComment',
  'updateMilestoneTargetDate',
  'updateProjectLead',
  'updateIssueFields',
  'createBlockingRelation',
  'deleteRelation',
]);

export interface RecordedCall {
  key: KeyLabel | 'unknown';
  method: string;
  arg: unknown;
}

/** Misbehaviours the fake can be switched into. */
export interface FakeBehaviour {
  /** Keys Linear now answers `unauthorized` for. */
  revoked: Set<KeyLabel>;
  /** key → writes allowed before every further write is refused as out of scope. */
  scopeRefusalAfter: Map<KeyLabel, number>;
  /** key → issue id whose writes Linear refuses ("permission to perform"). */
  refuseIssue: Map<KeyLabel, string>;
  /** Keys whose reads fail transiently (network). */
  transient: Set<KeyLabel>;
  /** fetchIssue answers null for this issue id. */
  hiddenIssue: string | null;
  /** fetchWorkspace throws an error quoting the calling key. */
  echo: boolean;
}

/** Linear's refusal of a write a read-only key attempted (assumed shape, F7). */
export function scopeRefusal(): LinearApiError {
  return new LinearApiError(
    'forbidden',
    'Linear IssueUpdate: Invalid scope: write required',
    {
      cause: new LinearGraphqlErrors([
        {
          message: 'Invalid scope: write required',
          path: [],
          code: 'FORBIDDEN',
          type: 'forbidden',
          userPresentableMessage: null,
        },
      ]),
    }
  );
}

function perIssueRefusal(): LinearApiError {
  return new LinearApiError(
    'forbidden',
    'Linear IssueUpdate: You do not have permission to perform this action',
    {
      cause: new LinearGraphqlErrors([
        {
          message: 'You do not have permission to perform this action',
          path: [],
          code: 'FORBIDDEN',
          type: 'forbidden',
          userPresentableMessage: null,
        },
      ]),
    }
  );
}

/**
 * Moves the fixture's Atlas project into a private Security team that only
 * Chloe belongs to (with its own copy of Engineering's states).
 */
export function addSecurityTeam(fixture: FixtureStore): void {
  const { data } = fixture;
  data.teams.push({
    id: SECURITY_TEAM_ID,
    key: 'SEC',
    name: 'Security',
    visibility: 'private',
    parentId: null,
    memberIds: ['user-chloe'],
  });
  for (const state of data.states.filter((s) => s.teamId === 'team-eng')) {
    data.states.push({
      ...state,
      id: `${state.id}-sec`,
      teamId: SECURITY_TEAM_ID,
    });
  }
  for (const project of data.projects) {
    if (project.id === SECURITY_PROJECT_ID)
      project.teamIds = [SECURITY_TEAM_ID];
  }
  for (const issue of data.issues) {
    if (issue.projectId === SECURITY_PROJECT_ID) {
      issue.teamId = SECURITY_TEAM_ID;
      issue.stateId = `${issue.stateId}-sec`;
    }
  }
}

/** The ids of the fixture's Security issues. */
export function securityIssueIds(fixture: FixtureStore): Set<string> {
  return new Set(
    fixture.data.issues
      .filter((issue) => issue.teamId === SECURITY_TEAM_ID)
      .map((issue) => issue.id)
  );
}

// What a key's account can see of the workspace: private teams it is not
// in (and their projects, milestones, issues and relations) are left out,
// as Linear leaves them out of that account's reads.
function narrowFor(data: WorkspaceData, userId: string): WorkspaceData {
  const hiddenTeams = new Set(
    data.teams
      .filter(
        (team) =>
          team.visibility === 'private' &&
          team.memberIds?.includes(userId) !== true
      )
      .map((team) => team.id)
  );
  if (hiddenTeams.size === 0) return data;
  const projects = data.projects.filter(
    (project) => !project.teamIds.every((id) => hiddenTeams.has(id))
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const issues = data.issues.filter(
    (issue) =>
      !hiddenTeams.has(issue.teamId) &&
      (issue.projectId === null || projectIds.has(issue.projectId))
  );
  const issueIds = new Set(issues.map((issue) => issue.id));
  return {
    ...data,
    teams: data.teams.filter((team) => !hiddenTeams.has(team.id)),
    states: data.states.filter((state) => !hiddenTeams.has(state.teamId)),
    projects,
    milestones: data.milestones.filter((m) => projectIds.has(m.projectId)),
    issues,
    relations: data.relations.filter(
      (r) => issueIds.has(r.blockerId) && issueIds.has(r.blockedId)
    ),
  };
}

function labelOf(key: string | null): KeyLabel | 'unknown' {
  for (const [label, value] of Object.entries(KEYS)) {
    if (value === key) return label as KeyLabel;
  }
  return 'unknown';
}

/** The fake gateway factory (see the file comment). */
export function fakeKeyGatewayFactory(
  fixture: FixtureStore,
  behaviour: FakeBehaviour,
  calls: RecordedCall[]
): (credential: () => string | null) => LinearGateway {
  const writesSoFar = new Map<KeyLabel, number>();
  return (credential) => {
    const methods = Object.keys(
      createFixtureGateway(fixture, { kind: 'app' })
    ) as (keyof LinearGateway)[];
    const wrapped: Record<string, unknown> = {};
    for (const method of methods) {
      wrapped[method] = async (...args: unknown[]): Promise<unknown> => {
        const key = credential();
        if (key === null) {
          throw new LinearApiError(
            'unauthorized',
            `No Linear credential is held for ${method}`
          );
        }
        const label = labelOf(key);
        calls.push({ key: label, method, arg: args[0] });
        if (
          label === 'unknown' ||
          label === 'revoked' ||
          behaviour.revoked.has(label)
        ) {
          throw new LinearApiError(
            'unauthorized',
            `Linear rejected the API key (${method})`
          );
        }
        const userId = KEY_USERS[label];
        const gateway = createFixtureGateway(fixture, { kind: 'user', userId });
        if (method === 'whoAmI' && label === 'otherorg') {
          const identity = await gateway.whoAmI();
          return {
            user: identity.user,
            workspace: { id: 'org-other', name: 'Other Co', urlKey: 'other' },
          };
        }
        if (behaviour.transient.has(label) && !WRITES.has(method)) {
          throw new LinearApiError(
            'network',
            `Linear ${method} request failed: fetch failed`
          );
        }
        if (WRITES.has(method)) {
          if (label === 'readonly') throw scopeRefusal();
          const allowed = behaviour.scopeRefusalAfter.get(label);
          const done = writesSoFar.get(label) ?? 0;
          if (allowed !== undefined && done >= allowed) throw scopeRefusal();
          writesSoFar.set(label, done + 1);
          if (behaviour.refuseIssue.get(label) === args[0])
            throw perIssueRefusal();
        }
        if (method === 'fetchWorkspace') {
          if (behaviour.echo) {
            throw new Error(`Linear echoed the credential ${key} in an error`);
          }
          return narrowFor(await gateway.fetchWorkspace(), userId);
        }
        if (method === 'fetchIssue' && args[0] === behaviour.hiddenIssue) {
          return null;
        }
        const call = gateway[method] as (...a: unknown[]) => Promise<unknown>;
        return call.apply(gateway, args);
      };
    }
    return wrapped as unknown as LinearGateway;
  };
}

/** Timers that never fire (the tests tick the scheduler themselves). */
export const NO_TIMERS: KeySyncTimers = {
  setInterval: () => 0,
  clearInterval: () => undefined,
};

export interface ApiKeyHarness {
  engine: Engine;
  store: Store;
  sql: Sql;
  fixture: FixtureStore;
  clock: TestClock;
  calls: RecordedCall[];
  behaviour: FakeBehaviour;
  logs: string[];
  config: EngineConfig;
  /** Values returned by the engine, for the leak scan. */
  returned: unknown[];
  /** Records `value` for the leak scan and returns it. */
  keep<T>(value: T): T;
  /** A second engine over the same database (a restart). */
  restart(): ApiKeyHarness;
  /** A keyed (OAuth-mode) store over the same database. */
  keyedStore(): Store;
  close(): Promise<void>;
}

export function apiKeyConfig(pin: string | null = null): EngineConfig {
  return {
    ...TEST_CONFIG,
    auth: 'api_key',
    apiKey: {
      idleMs: API_KEY_IDLE_MS,
      absoluteMs: API_KEY_MAX_MS,
      syncIntervalMs: 15 * 60_000,
      workspacePin: pin,
      endpoint: LINEAR_GRAPHQL_ENDPOINT,
      deployed: false,
    },
  };
}

function buildEngine(input: {
  sql: Sql;
  fixture: FixtureStore;
  clock: TestClock;
  behaviour: FakeBehaviour;
  calls: RecordedCall[];
  logs: string[];
  config: EngineConfig;
}): { engine: Engine; store: Store } {
  const store = createSqlStore(input.sql, {
    encryptionKey: null,
    now: input.clock.now,
  });
  const logger = createLogger({
    name: 'engine-test',
    level: 'debug',
    sink: (_level, line) => {
      input.logs.push(line);
    },
  });
  const engine = createApiKeyEngine({
    store,
    config: input.config,
    logger,
    now: input.clock.now,
    apiKeyGateway: fakeKeyGatewayFactory(
      input.fixture,
      input.behaviour,
      input.calls
    ),
    timers: NO_TIMERS,
  });
  return { engine, store };
}

/** A fresh api_key engine (unbound unless `seed` binds it). */
export async function createApiKeyHarness(
  options: { pin?: string | null; clock?: TestClock } = {}
): Promise<ApiKeyHarness> {
  const clock = options.clock ?? createClock();
  const sql = await openSql({});
  const migrator = createSqlStore(sql, { encryptionKey: null, now: clock.now });
  await migrator.migrate();
  // The demo's weights and "done means…" (planner-owned data), so the
  // fixture's projects have allocatable milestones as in demo mode.
  for (const meta of FIXTURE_MILESTONE_META) {
    await migrator.upsertMilestoneMeta(FIXTURE_WORKSPACE.id, {
      milestoneId: meta.milestoneId,
      weight: meta.weight,
      doneMeans: meta.doneMeans,
      updatedAt: clock.now().toISOString(),
      updatedBy: null,
    });
  }
  const fixture = createFixtureStore(todayIn('UTC', clock.now()));
  fixture.now = clock.now;
  addSecurityTeam(fixture);
  const behaviour: FakeBehaviour = {
    revoked: new Set(),
    scopeRefusalAfter: new Map(),
    refuseIssue: new Map(),
    transient: new Set(),
    hiddenIssue: null,
    echo: false,
  };
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const config = apiKeyConfig(options.pin ?? null);
  const returned: unknown[] = [];

  function make(): ApiKeyHarness {
    const { engine, store } = buildEngine({
      sql,
      fixture,
      clock,
      behaviour,
      calls,
      logs,
      config,
    });
    return {
      engine,
      store,
      sql,
      fixture,
      clock,
      calls,
      behaviour,
      logs,
      config,
      returned,
      keep<T>(value: T): T {
        returned.push(value);
        return value;
      },
      restart: make,
      keyedStore: () =>
        createSqlStore(sql, { encryptionKey: TEST_KEY, now: clock.now }),
      async close() {
        await engine.close();
      },
    };
  }
  return make();
}

/** Connects a key and authenticates it; both results are kept for the scan. */
export async function connect(
  h: ApiKeyHarness,
  label: KeyLabel
): Promise<{
  token: string;
  actor: NonNullable<Awaited<ReturnType<Engine['authenticate']>>>;
}> {
  const result = h.keep(await h.engine.connectApiKey({ apiKey: KEYS[label] }));
  const actor = h.keep(await h.engine.authenticate(result.sessionToken));
  if (actor === null) throw new Error(`could not authenticate ${label}`);
  return { token: result.sessionToken, actor };
}

/** The recorded calls of one key (and method, when given). */
export function callsOf(
  h: ApiKeyHarness,
  key: KeyLabel,
  method?: string
): RecordedCall[] {
  return h.calls.filter(
    (call) =>
      call.key === key && (method === undefined || call.method === method)
  );
}

/** Writes recorded since `from` (an index into h.calls). */
export function writesSince(h: ApiKeyHarness, from: number): RecordedCall[] {
  return h.calls.slice(from).filter((call) => WRITES.has(call.method));
}

/**
 * The leak scan (§11 case 16): no table row, log line or returned value
 * holds any needle.
 */
export async function leakScan(h: ApiKeyHarness): Promise<void> {
  const tables = await h.sql.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  expect(tables.length).toBeGreaterThan(5);
  for (const { table_name: table } of tables) {
    for (const needle of NEEDLES) {
      const rows = await h.sql.query<{ n: number | string }>(
        `SELECT count(*) AS n FROM "${table}" t WHERE CAST(t.* AS text) LIKE $1`,
        [`%${needle}%`]
      );
      expect({ table, needle, n: Number(rows[0]?.n ?? 0) }).toEqual({
        table,
        needle,
        n: 0,
      });
    }
  }
  const logText = h.logs.join('\n');
  const returnedText = JSON.stringify(h.returned);
  for (const needle of NEEDLES) {
    expect(logText.includes(needle)).toBe(false);
    expect(returnedText.includes(needle)).toBe(false);
  }
}

export { FIXTURE_WORKSPACE };
