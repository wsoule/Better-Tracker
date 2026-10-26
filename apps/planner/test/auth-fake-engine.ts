// A fake engine for the auth route tests (the OAuth start and callback,
// switch, logout): sessions held per workspace, as describeSessions,
// checkSession and authenticate see them, and a record of every sign-in,
// install, sign-out and full sync. Not a test file; the route tests drive
// it (owner decision 2026-10-25: a browser holds a session per workspace).

import type {
  Actor,
  Engine,
  OAuthIntent,
  SessionDescription,
} from '@better-tracker/engine';

export const APP = 'https://planner.example.com';
export const SECRET = 'k'.repeat(40);
export const IN_A_WEEK_MS = 7 * 24 * 3600 * 1000;

/** A store-shaped session token (43 base64url characters). */
export function tok(seed: string): string {
  return `${seed}-${'x'.repeat(43)}`.slice(0, 43);
}

export interface FakeSession {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userName: string;
  /** checkSession says the session (its grant) still works. */
  live: boolean;
  readOnly?: Actor['readOnlyReason'];
  canWriteLinear?: boolean;
  installed?: boolean;
  revokedAt?: string | null;
  revokedReason?: SessionDescription['revokedReason'];
}

export interface FakeCalls {
  signIn: {
    code: string;
    codeVerifier: string;
    intent: string;
    expectWorkspaceId?: string;
  }[];
  install: { code: string; actor: Actor; expectWorkspaceId?: string }[];
  signOut: string[];
  fullSync: string[];
  describe: string[][];
  checked: string[];
}

export interface FakeEngineState {
  sessions: Map<string, FakeSession>;
  calls: FakeCalls;
  /** What the next finishSignIn comes back with. */
  nextSignIn: {
    workspaceId: string;
    workspaceName: string;
    needsInstall: boolean;
    error: Error | null;
  };
  installError: Error | null;
  mode: 'linear' | 'fixture';
  auth: 'oauth' | 'api_key';
  appUrl: string;
  signInCount: number;
}

export function freshState(): FakeEngineState {
  return {
    sessions: new Map(),
    calls: {
      signIn: [],
      install: [],
      signOut: [],
      fullSync: [],
      describe: [],
      checked: [],
    },
    nextSignIn: {
      workspaceId: 'org-acme',
      workspaceName: 'Acme',
      needsInstall: false,
      error: null,
    },
    installError: null,
    mode: 'linear',
    auth: 'oauth',
    appUrl: APP,
    signInCount: 0,
  };
}

const EXPIRES = (): string => new Date(Date.now() + IN_A_WEEK_MS).toISOString();

export function actorOf(token: string, s: FakeSession): Actor {
  const readOnly = s.readOnly !== undefined;
  return {
    session: {
      id: `sess-${token.slice(0, 6)}`,
      workspaceId: s.workspaceId,
      userId: s.userId,
      userName: s.userName,
      tokens: {
        accessToken: '',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: EXPIRES(),
    },
    canWriteLinear: !readOnly && s.canWriteLinear === true,
    readOnly,
    ...(readOnly ? { readOnlyReason: s.readOnly } : {}),
  };
}

/** The engine the routes get (only what they call). */
export function fakeEngine(state: FakeEngineState): Engine {
  const engine = {
    get mode() {
      return state.mode;
    },
    get config() {
      return {
        appUrl: state.appUrl,
        appName: 'Milestone Planner',
        auth: state.auth,
        defaultTimezone: 'UTC',
      };
    },
    // No Slack channel: the landing page's copy names none.
    digestChannel: () => Promise.resolve('outbox' as const),
    startOAuth: (intent: OAuthIntent) => ({
      url: `https://linear.app/oauth/authorize?state=st-${intent}`,
      state: `st-${intent}`,
      codeVerifier: `cv-${intent}`,
    }),
    authenticate: (token: string | undefined) => {
      const s = token === undefined ? undefined : state.sessions.get(token);
      return Promise.resolve(
        token === undefined || s === undefined ? null : actorOf(token, s)
      );
    },
    describeSessions: (tokens: readonly string[]) => {
      state.calls.describe.push([...tokens]);
      if (state.auth !== 'oauth' || state.mode === 'fixture') {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        tokens.map((token): SessionDescription | null => {
          const s = state.sessions.get(token);
          if (s === undefined) return null;
          return {
            token,
            workspaceId: s.workspaceId,
            workspaceName: s.workspaceName,
            workspaceUrlKey: s.workspaceName.toLowerCase(),
            userId: s.userId,
            userName: s.userName,
            expiresAt: EXPIRES(),
            guest: s.readOnly === 'guest',
            installed: s.installed ?? true,
            revokedAt: s.revokedAt ?? null,
            revokedReason: s.revokedReason ?? null,
          };
        })
      );
    },
    checkSession: (token: string | undefined) => {
      if (token !== undefined) state.calls.checked.push(token);
      const s = token === undefined ? undefined : state.sessions.get(token);
      return Promise.resolve(
        s === undefined || !s.live ? null : { workspaceId: s.workspaceId }
      );
    },
    finishSignIn: (input: FakeCalls['signIn'][number]) => {
      state.calls.signIn.push(input);
      if (state.nextSignIn.error !== null) {
        return Promise.reject(state.nextSignIn.error);
      }
      state.signInCount += 1;
      const token = tok(`new${state.signInCount}`);
      const { workspaceId, workspaceName, needsInstall } = state.nextSignIn;
      state.sessions.set(token, {
        workspaceId,
        workspaceName,
        userId: 'user-ana',
        userName: 'Ana Moreno',
        live: true,
      });
      return Promise.resolve({
        sessionToken: token,
        session: {
          ...actorOf(token, state.sessions.get(token)!).session,
          expiresAt: EXPIRES(),
        },
        needsInstall,
        workspaceName,
        workspaceUrlKey: workspaceName.toLowerCase(),
      });
    },
    finishInstall: (input: FakeCalls['install'][number]) => {
      state.calls.install.push({
        code: input.code,
        actor: input.actor,
        ...(input.expectWorkspaceId === undefined
          ? {}
          : { expectWorkspaceId: input.expectWorkspaceId }),
      });
      if (state.installError !== null)
        return Promise.reject(state.installError);
      return Promise.resolve({
        workspaceId: input.actor.session.workspaceId,
        workspaceName: 'Org',
      });
    },
    fullSync: (workspaceId: string) => {
      state.calls.fullSync.push(workspaceId);
      return Promise.resolve({ ok: true });
    },
    signOut: (token: string) => {
      state.calls.signOut.push(token);
      const known = state.sessions.delete(token);
      return Promise.resolve({ known, keysForgotten: 0 });
    },
    getInstallation: () => Promise.resolve(null),
  };
  return engine as unknown as Engine;
}

/** An engine error as the routes recognise it (by name and code). */
export function engineError(name: string, code: string, message = code): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, { code });
}

/** The Set-Cookie header named `name`, or undefined. */
export function setCookie(
  response: Response,
  name: string
): string | undefined {
  return response.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${name}=`));
}

/** A Set-Cookie header's value. */
export function cookieValue(header: string | undefined): string {
  return header?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
}

/** The stash cookie's tokens in a response ([] when expired or absent). */
export function stashOf(response: Response, name: string): string[] {
  const value = cookieValue(setCookie(response, name));
  return value === '' ? [] : value.split('.');
}

/** A Cookie request header from name → value pairs. */
export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
