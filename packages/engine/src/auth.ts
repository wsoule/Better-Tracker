// Sign-in, install and sessions (§7 "auth", §4.1 OAuth).
//
// - signin asks for `read`; grant_write upgrades anyone signed in to
//   `read,write` so their Linear edits (milestone dates, project leads,
//   issue edits) are attributed to them; install is the admin's actor=app
//   grant (`read,write`, prompt=consent). There are no roles (owner
//   decision 2026-10-22): an Actor is the session, its scopes, and
//   whether the person is read-only because Linear makes them a guest
//   (owner decision 2026-10-22, "Guests limited to read only"; a guest's
//   grant_write, or any sign-in that came back with write scope, is
//   refused, and their canWriteLinear is always false).
// - Sessions are cookie tokens whose SHA-256 is stored with the person's
//   own Linear tokens (encrypted). Objects handed back to callers (Actor,
//   SignInResult, Installation) carry redacted tokens so a page can never
//   serialize a Linear credential into HTML by accident; the provider reads
//   real tokens from the store when it needs them.
// - Signing out deletes the session and revokes its Linear refresh token
//   (best effort): Linear may auto-revoke a user's oldest tokens once they
//   hold more than 10 for one app, so abandoned tokens must not pile up.
//   cleanup() does the same for sessions that expired (cleanup.ts).
// - Several workspaces (owner decision 2026-10-25): every sign-in and
//   install is checked against admission (admission.ts) right after Linear
//   says which workspace it is for, and refused with the new grant revoked;
//   authenticate, checkSession and describeSessions treat a session of a
//   refused workspace as signed out. Its row is kept: a workspace left off
//   LINEAR_WORKSPACES is not served but nothing is ended, so its sessions
//   stay unusable until it is admitted again or they expire (blocks and
//   the operator's remove end them). One person may hold
//   sessions in several workspaces at once; each is its own row and grant.

import { type Snapshot, type User, viewerScope } from '@better-tracker/core';
import {
  buildAuthorizeUrl,
  createLinearGateway,
  createOAuthState,
  createPkcePair,
  exchangeCode,
  FIXTURE_WORKSPACE,
  type LinearIdentity,
  type OAuthClientConfig,
  revokeToken,
  type TokenSet,
} from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type {
  Installation,
  Session,
  SessionDescription,
  StoredTokens,
} from '@better-tracker/store';

import {
  admission,
  type AdmissionVerdict,
  createAdmissionPass,
  newerSignInUrlKey,
} from './admission';
import { needsRefresh } from './providers';
import type { EngineRuntime, MirrorView } from './runtime';
import { firstSync, refreshInstallationIdentity } from './sync';
import { authorizeUrlViaTestEndpoint } from './test-endpoint';
import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  type OAuthIntent,
  type OAuthStart,
  type ReadOnlyReason,
  type SignInResult,
  type SignOutResult,
} from './types';

const DAY_MS = 86_400_000;

/**
 * Scopes requested per intent (comma-separated in the authorize URL). The
 * install adds `initiative:read`: Linear's 2025-08-14 changelog gives an
 * actor=app user the workspace's initiatives only through that scope
 * (research.md, Linear OAuth 2.0 scopes), and every full sync reads them
 * (the timeline groups projects by initiative).
 */
export const OAUTH_SCOPES: Record<OAuthIntent, readonly string[]> = {
  signin: ['read'],
  grant_write: ['read', 'write'],
  install: ['read', 'write', 'initiative:read'],
  // One more workspace: a plain sign-in, but with prompt=consent.
  add_workspace: ['read'],
};

/** The intents finishSignIn completes (install has finishInstall). */
const SIGN_IN_INTENTS: readonly OAuthIntent[] = [
  'signin',
  'grant_write',
  'add_workspace',
];

/**
 * How many held tokens describeSessions describes; later ones read as
 * null. A browser holds at most 10 (the active session and 9 stashed).
 */
export const MAX_DESCRIBED_SESSIONS = 20;

/** Tokens demo-mode sessions and the demo installation carry. */
const FIXTURE_TOKENS: StoredTokens = {
  accessToken: 'fixture',
  refreshToken: null,
  expiresAt: null,
  scopes: ['read', 'write'],
};

/** Tokens with the credentials blanked; expiry and scopes stay readable. */
export function redactTokens(tokens: StoredTokens): StoredTokens {
  return {
    accessToken: '',
    refreshToken: null,
    expiresAt: tokens.expiresAt,
    scopes: [...tokens.scopes],
  };
}

/** A session safe to hand to the web layer. */
export function publicSession(session: Session): Session {
  return { ...session, tokens: redactTokens(session.tokens) };
}

/** An installation safe to hand to the web layer. */
export function publicInstallation(installation: Installation): Installation {
  return { ...installation, tokens: redactTokens(installation.tokens) };
}

/** What every OAuth entry point says in api_key mode. */
export const OAUTH_OFF_MESSAGE =
  'Linear OAuth is off: this planner uses personal API keys.';

function requireOAuth(rt: EngineRuntime): OAuthClientConfig {
  if (rt.config.auth === 'api_key') {
    throw new EngineInputError('invalid', OAUTH_OFF_MESSAGE);
  }
  if (rt.config.oauth === null) {
    throw new EngineInputError(
      'invalid',
      'Linear sign-in is not available in demo mode; use the demo sign-in.'
    );
  }
  return rt.config.oauth;
}

// Linear sometimes omits `scope` in token responses; fall back to what was
// requested so write access is not silently lost.
function storedTokens(tokens: TokenSet, intent: OAuthIntent): StoredTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes:
      tokens.scopes.length > 0 ? tokens.scopes : [...OAUTH_SCOPES[intent]],
  };
}

/**
 * Revokes a Linear grant the engine no longer keeps (a signed-out or
 * expired session, a refused sign-in): its refresh token when it has one,
 * else its access token. Best effort: reports a failure instead of
 * throwing, and the caller logs the outcome (never the tokens).
 */
export async function revokeGrant(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  tokens: Pick<StoredTokens, 'accessToken' | 'refreshToken'>
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    if (tokens.refreshToken !== null) {
      await revokeToken(oauth, tokens.refreshToken, 'refresh_token', rt.fetch);
    } else {
      await revokeToken(oauth, tokens.accessToken, 'access_token', rt.fetch);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// Revokes a token Linear just issued when the engine refuses to keep it
// (wrong user, wrong workspace), so a rejected grant does not linger.
async function discardTokens(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  tokens: TokenSet,
  log: Logger
): Promise<void> {
  const revoked = await revokeGrant(rt, oauth, tokens);
  if (!revoked.ok) {
    log.warn('could not revoke a rejected Linear token', {
      error: revoked.error,
    });
  }
}

// Exchanges an authorization code and asks Linear who the token acts as.
async function exchangeAndIdentify(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  input: { code: string; codeVerifier: string },
  log: Logger
): Promise<{ tokens: TokenSet; identity: LinearIdentity }> {
  if (typeof input.code !== 'string' || input.code === '') {
    throw new EngineInputError('invalid', 'The authorization code is missing.');
  }
  const tokens = await exchangeCode(oauth, input, rt.fetch, {
    now: () => rt.clock().getTime(),
  });
  try {
    const identity = await createLinearGateway({
      accessToken: tokens.accessToken,
      fetch: rt.fetch,
      logger: log,
    }).whoAmI();
    return { tokens, identity };
  } catch (error) {
    await discardTokens(rt, oauth, tokens, log);
    throw error;
  }
}

/**
 * The authorize URL plus the state and PKCE verifier the cookie keeps.
 * install adds actor=app; install and add_workspace add prompt=consent,
 * so Linear shows its consent screen (for add_workspace: for the workspace
 * open at linear.app) instead of silently approving the last one.
 */
export function startOAuth(rt: EngineRuntime, intent: OAuthIntent): OAuthStart {
  const oauth = requireOAuth(rt);
  if (typeof intent !== 'string' || !Object.hasOwn(OAUTH_SCOPES, intent)) {
    throw new EngineInputError('invalid', 'Unknown sign-in intent.');
  }
  const scopes = OAUTH_SCOPES[intent];
  const state = createOAuthState();
  const pkce = createPkcePair();
  const install = intent === 'install';
  const consent = install || intent === 'add_workspace';
  const linearUrl = buildAuthorizeUrl(oauth, {
    state,
    scopes: [...scopes],
    codeChallenge: pkce.challenge,
    ...(install ? { actor: 'app' as const } : {}),
    ...(consent ? { prompt: 'consent' as const } : {}),
  });
  // A test's local fake Linear serves the authorize page too.
  const testEndpoint = rt.config.linearTestEndpoint;
  const url =
    testEndpoint === undefined
      ? linearUrl
      : authorizeUrlViaTestEndpoint(linearUrl, testEndpoint);
  return { url, state, codeVerifier: pkce.verifier };
}

/** What a sign-in or install refused by admission is told. */
function refusedByAdmission(
  verdict: Exclude<AdmissionVerdict, 'ok'>,
  workspaceName: string
): EngineAuthError {
  return verdict === 'blocked'
    ? new EngineAuthError(
        'workspace_blocked',
        `This planner does not serve ${workspaceName}: the person who runs it has blocked that workspace.`
      )
    : new EngineAuthError(
        'workspace_not_allowed',
        `This planner is not open to ${workspaceName} yet. Ask the person who runs it to add that workspace.`
      );
}

/**
 * Refuses a grant Linear just issued for a workspace admission does not
 * admit (fresh: blocks, pins and installations read now), revoking it
 * first, so a refused workspace never gets a session or an installation.
 * A store error refuses too (fail closed), also revoking the grant.
 */
async function requireAdmitted(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  tokens: TokenSet,
  workspace: LinearIdentity['workspace'],
  log: Logger
): Promise<void> {
  let verdict: AdmissionVerdict;
  try {
    verdict = await admission(
      rt,
      { id: workspace.id, urlKey: workspace.urlKey },
      { fresh: true }
    );
  } catch (error) {
    await discardTokens(rt, oauth, tokens, log);
    throw error;
  }
  if (verdict === 'ok') return;
  await discardTokens(rt, oauth, tokens, log);
  log.info('refused a workspace admission does not admit', {
    workspaceId: workspace.id,
    admission: verdict,
  });
  throw refusedByAdmission(verdict, workspace.name);
}

async function needsInstall(
  rt: EngineRuntime,
  workspaceId: string
): Promise<boolean> {
  const installation = await rt.store.getInstallation(workspaceId);
  return installation === null || installation.revokedAt !== null;
}

/**
 * Why a person is read-only in the planner (Actor.readOnlyReason), or null
 * when they are not: `guest` for a Linear guest per the mirror, `unknown`
 * for someone the mirror does not know, who is treated like a guest
 * exactly as per-viewer visibility treats them (core's viewerScope,
 * §2.13). Without a mirror nobody is known:
 * - with no active installation (never installed, or uninstalled) nobody
 *   is read-only, so someone can install or reinstall (Linear lets only an
 *   admin approve that, never a guest), and every other change needs an
 *   active installation anyway (requireInstallation);
 * - with one (authenticate tried the first sync and it failed) everybody
 *   is, as `not_synced`, because anyone who got through could start a
 *   run, which syncs first and then acts for a person the planner never
 *   placed. Install and reinstall stay open in that state (engine.ts
 *   finishInstall): a reinstall is how an admin fixes a grant that makes
 *   the sync fail, and Linear still asks for an admin.
 */
export function readOnlyReasonFor(
  snapshot: Snapshot | null,
  userId: string,
  installed: boolean
): ReadOnlyReason | null {
  if (snapshot === null) return installed ? 'not_synced' : null;
  if (!viewerScope(snapshot, userId).guest) return null;
  return snapshot.users.has(userId) ? 'guest' : 'unknown';
}

/**
 * The mirror authenticate places a person with, and whether the workspace
 * has an active installation (only looked up when there is no mirror).
 * An installed workspace without a mirror has not had its first sync land
 * (the minutes after an install): that sync runs here, joined with the one
 * the install started (fullSync is single-flight), as load() would run it
 * for the page anyway. After a failed attempt the next one waits
 * (firstSync's backoff, shared with load()). A failed or waiting sync
 * leaves the mirror null (a failure is logged); readOnlyReasonFor then
 * fails closed (`not_synced`).
 */
export async function mirrorForPerson(
  rt: EngineRuntime,
  workspaceId: string
): Promise<{ view: MirrorView | null; installed: boolean }> {
  const view = await rt.mirror.current(workspaceId);
  if (view !== null) return { view, installed: true };
  if (await needsInstall(rt, workspaceId)) {
    return { view: null, installed: false };
  }
  try {
    const outcome = await firstSync(rt, workspaceId);
    if (outcome.kind === 'waiting') {
      rt.logger.debug('the first sync failed recently; waiting to retry', {
        workspaceId,
        retryAt: outcome.retryAt,
      });
      return { view: null, installed: true };
    }
  } catch (error) {
    // api_key mode with no member connected: expected, not a failure.
    const noReader =
      error instanceof EngineAuthError && error.code === 'no_reader';
    (noReader ? rt.logger.info : rt.logger.warn).call(
      rt.logger,
      'the first sync failed; everyone is read-only until it lands',
      { workspaceId, error }
    );
  }
  return { view: await rt.mirror.current(workspaceId), installed: true };
}

/**
 * Completes signin / add_workspace / grant_write: a new session for the
 * Linear user in the workspace Linear granted, once admission admits that
 * workspace (else workspace_not_allowed / workspace_blocked). A write grant
 * must come back for `expectWorkspaceId` (required for grant_write; the
 * other intents ignore it), else grant_wrong_workspace. Every refusal
 * revokes the grant Linear issued and writes no session.
 */
export async function finishSignIn(
  rt: EngineRuntime,
  input: {
    code: string;
    codeVerifier: string;
    intent: 'signin' | 'grant_write' | 'add_workspace';
    expectWorkspaceId?: string;
  }
): Promise<SignInResult> {
  const oauth = requireOAuth(rt);
  if (!SIGN_IN_INTENTS.includes(input.intent)) {
    throw new EngineInputError('invalid', 'Unknown sign-in intent.');
  }
  const expected =
    input.intent === 'grant_write' ? input.expectWorkspaceId : undefined;
  if (
    input.intent === 'grant_write' &&
    (typeof expected !== 'string' || expected === '')
  ) {
    throw new EngineInputError(
      'invalid',
      'A write grant needs the workspace it is for (expectWorkspaceId).'
    );
  }
  const log = rt.logger.child({ op: 'signin', intent: input.intent });
  const { tokens, identity } = await exchangeAndIdentify(rt, oauth, input, log);
  const { user, workspace } = identity;
  await requireAdmitted(rt, oauth, tokens, workspace, log);
  if (expected !== undefined && workspace.id !== expected) {
    await discardTokens(rt, oauth, tokens, log);
    log.warn('refused a write grant for another workspace', {
      workspaceId: workspace.id,
      expectedWorkspaceId: expected,
      userId: user.id,
    });
    throw new EngineAuthError(
      'grant_wrong_workspace',
      `Linear granted write access for ${workspace.name}, not for the workspace you were working in. Open that workspace at linear.app, then allow editing again.`
    );
  }
  if (user.app || !user.active) {
    await discardTokens(rt, oauth, tokens, log);
    log.warn('refused sign-in', {
      workspaceId: workspace.id,
      userId: user.id,
      reason: user.app ? 'app user' : 'deactivated user',
    });
    throw new EngineAuthError(
      'not_signed_in',
      user.app
        ? 'App users cannot sign in; sign in with your own Linear account.'
        : 'Your Linear account is deactivated.'
    );
  }
  // A guest is read-only (owner decision 2026-10-22): the planner never
  // keeps a write grant for one, whether Linear or the mirror says so, and
  // whatever the intent (a plain sign-in whose authorize URL was edited to
  // ask for `write` comes back with write scope too).
  const stored = storedTokens(tokens, input.intent);
  if (input.intent === 'grant_write' || stored.scopes.includes('write')) {
    const mirrored = (
      await rt.mirror.current(workspace.id)
    )?.snapshot.users.get(user.id);
    if (user.guest === true || mirrored?.guest === true) {
      await discardTokens(rt, oauth, tokens, log);
      log.warn('refused a write grant', {
        workspaceId: workspace.id,
        userId: user.id,
        reason: 'guest',
      });
      throw new EngineAuthError(
        'read_only',
        'Guests in Linear can look but not change anything here, so the planner does not take write access for a guest.'
      );
    }
  }
  // An installed workspace's row follows a rename, and records that its
  // key was read now (no other write).
  await refreshInstallationIdentity(
    rt,
    workspace.id,
    workspace,
    rt.nowIso(),
    log
  );
  const expiresAt = new Date(
    rt.clock().getTime() + rt.config.sessionDays * DAY_MS
  ).toISOString();
  const created = await rt.store.createSession({
    workspaceId: workspace.id,
    userId: user.id,
    userName: user.name,
    tokens: stored,
    expiresAt,
    workspaceName: workspace.name,
    workspaceUrlKey: workspace.urlKey,
  });
  log.info('signed in', {
    workspaceId: workspace.id,
    userId: user.id,
    sessionId: created.session.id,
    scopes: created.session.tokens.scopes,
  });
  return {
    sessionToken: created.token,
    session: publicSession(created.session),
    needsInstall: await needsInstall(rt, workspace.id),
    workspaceName: workspace.name,
    workspaceUrlKey: workspace.urlKey,
  };
}

/**
 * Completes the admin's actor=app install for the actor's workspace. The
 * token must act as an app user of that same workspace. Anyone signed in
 * may install or reinstall (there is no PM role since the owner decision
 * of 2026-10-22); only a Linear admin can produce an actor=app grant, which
 * is what keeps this to admins. Settings are not touched here: the first
 * full sync bootstraps the watchers (WATCHER_EMAILS, else this installer)
 * and a reinstall keeps the saved ones. The first full sync is left to the
 * caller (the web route schedules it after responding).
 */
export async function finishInstall(
  rt: EngineRuntime,
  input: {
    code: string;
    codeVerifier: string;
    actor: Actor;
    expectWorkspaceId?: string;
  }
): Promise<Installation> {
  const oauth = requireOAuth(rt);
  const { actor } = input;
  const workspaceId = actor.session.workspaceId;
  // The install was started for one workspace (the signed OAuth state);
  // the session finishing it must be of that workspace. Checked before the
  // code is exchanged, so no grant is issued.
  if (
    input.expectWorkspaceId !== undefined &&
    input.expectWorkspaceId !== workspaceId
  ) {
    throw new EngineAuthError(
      'wrong_workspace',
      'This install was started for another workspace than the session finishing it. Start the install again.'
    );
  }
  const log = rt.logger.child({
    op: 'install',
    workspaceId,
    userId: actor.session.userId,
  });
  const existing = await rt.store.getInstallation(workspaceId);

  const { tokens, identity } = await exchangeAndIdentify(rt, oauth, input, log);
  await requireAdmitted(rt, oauth, tokens, identity.workspace, log);
  if (!identity.user.app || identity.workspace.id !== workspaceId) {
    await discardTokens(rt, oauth, tokens, log);
    log.warn('refused install', {
      tokenWorkspaceId: identity.workspace.id,
      appUser: identity.user.app,
    });
    throw new EngineAuthError(
      'wrong_workspace',
      identity.user.app
        ? `That install was for ${identity.workspace.name}, not the workspace you are signed in to.`
        : 'The install did not grant app access (actor=app). Start the install again.'
    );
  }

  const now = rt.nowIso();
  const installation: Installation = {
    workspaceId,
    workspaceName: identity.workspace.name,
    urlKey: identity.workspace.urlKey,
    appUserId: identity.user.id,
    installedByUserId: actor.session.userId,
    revokedAt: null,
    tokens: storedTokens(tokens, 'install'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await rt.store.saveInstallation(installation);
  rt.mirror.forget(workspaceId);
  log.info('installed', {
    appUserId: identity.user.id,
    reinstall: existing !== null,
  });
  return publicInstallation(installation);
}

/** Fixture mode only: a session for a demo user, no OAuth. */
export async function devSignIn(
  rt: EngineRuntime,
  userId: string
): Promise<SignInResult> {
  if (rt.linear.mode !== 'fixture') {
    throw new EngineAuthError(
      'fixture_only',
      'Demo sign-in only works in demo mode.'
    );
  }
  const workspaceId = FIXTURE_WORKSPACE.id;
  const gateway = await rt.linear.forApp(workspaceId);
  const user =
    typeof userId === 'string' ? await gateway.fetchUser(userId) : null;
  if (user === null)
    throw new EngineInputError('not_found', 'No such demo user.');
  if (user.app || !user.active) {
    throw new EngineInputError('invalid', `${user.name} cannot sign in.`);
  }
  const created = await rt.store.createSession({
    workspaceId,
    userId: user.id,
    userName: user.name,
    tokens: FIXTURE_TOKENS,
    expiresAt: new Date(
      rt.clock().getTime() + rt.config.sessionDays * DAY_MS
    ).toISOString(),
    workspaceName: FIXTURE_WORKSPACE.name,
    workspaceUrlKey: FIXTURE_WORKSPACE.urlKey,
  });
  rt.logger.info('demo sign-in', { workspaceId, userId: user.id });
  return {
    sessionToken: created.token,
    session: publicSession(created.session),
    needsInstall: await needsInstall(rt, workspaceId),
    workspaceName: FIXTURE_WORKSPACE.name,
    workspaceUrlKey: FIXTURE_WORKSPACE.urlKey,
  };
}

// The URL keys admission matches a session's workspace with when a URL key
// block or an unpinned LINEAR_WORKSPACES URL key needs them (one query, no
// decryption): the installation's (refreshed by every full sync, sign-in
// and cleanup identity read), else the session's sign-in value, and the
// session's own sign-in value when it is newer than the installation's
// (newerSignInUrlKey), which an unpinned entry is matched against only
// when the first matches no entry.
async function sessionUrlKeys(
  rt: EngineRuntime,
  sessionToken: string
): Promise<{ urlKey: string | null; signInUrlKey: string | null }> {
  const [described] = await rt.store.describeSessions(
    [sessionToken],
    rt.nowIso()
  );
  return {
    urlKey: described?.workspaceUrlKey ?? null,
    signInUrlKey:
      described === null || described === undefined
        ? null
        : newerSignInUrlKey(described),
  };
}

/**
 * Whether admission (cached reads) admits the session's workspace. A
 * refused session reads as signed out; its row is kept (a list refusal
 * ends nothing: re-admitting the workspace signs it back in, and expiry
 * cleanup revokes its grant otherwise).
 */
async function sessionAdmitted(
  rt: EngineRuntime,
  sessionToken: string,
  session: Session
): Promise<boolean> {
  const verdict = await admission(
    rt,
    {
      id: session.workspaceId,
      lookupUrlKeys: () => sessionUrlKeys(rt, sessionToken),
    },
    { fresh: false }
  );
  if (verdict === 'ok') return true;
  rt.logger.info('session refused: admission refuses its workspace', {
    workspaceId: session.workspaceId,
    userId: session.userId,
    admission: verdict,
  });
  return false;
}

/**
 * Refreshes the session's Linear token when it is near expiry (under the
 * session lock, rt.linear.forSession). A dead grant ends the session
 * (false); a transient failure keeps it (logged, retried on the person's
 * next Linear edit). Demo sessions never refresh.
 */
async function refreshSessionIfNeeded(
  rt: EngineRuntime,
  sessionToken: string,
  session: Session
): Promise<boolean> {
  if (rt.linear.mode === 'fixture' || !needsRefresh(session.tokens, rt.clock()))
    return true;
  try {
    await rt.linear.forSession(session);
  } catch (error) {
    if (error instanceof EngineAuthError && error.code === 'not_signed_in') {
      await rt.store.deleteSession(sessionToken);
      return false;
    }
    rt.logger.warn('could not refresh the session token; continuing', {
      workspaceId: session.workspaceId,
      userId: session.userId,
      error,
    });
  }
  return true;
}

/**
 * Whether a held cookie token is a live session of an admitted workspace
 * (Engine.checkSession, for switching): admission (cached), the session
 * row unexpired, and its Linear token refreshed when near expiry (a dead
 * grant ends it). Never places the person: no mirror read, no sync.
 */
export async function checkSession(
  rt: EngineRuntime,
  sessionToken: string | undefined
): Promise<{ workspaceId: string } | null> {
  if (rt.config.auth === 'api_key') return null;
  if (typeof sessionToken !== 'string' || sessionToken === '') return null;
  const session = await rt.store.getSession(sessionToken, rt.nowIso());
  if (session === null) return null;
  if (!(await sessionAdmitted(rt, sessionToken, session))) return null;
  if (!(await refreshSessionIfNeeded(rt, sessionToken, session))) return null;
  return { workspaceId: session.workspaceId };
}

/**
 * Engine.describeSessions: the store's one-query description of each held
 * token (no credential, no Linear call, no mirror cache), in input order,
 * with null for an unknown or expired token, one past
 * MAX_DESCRIBED_SESSIONS, or one whose workspace admission refuses (cached
 * reads). [] in api_key and demo modes, which hold one session.
 */
export async function describeSessions(
  rt: EngineRuntime,
  sessionTokens: readonly string[]
): Promise<(SessionDescription | null)[]> {
  if (rt.config.auth !== 'oauth' || rt.linear.mode === 'fixture') return [];
  if (!Array.isArray(sessionTokens)) return [];
  const asked = sessionTokens.map((token, index) =>
    typeof token === 'string' && token !== '' && index < MAX_DESCRIBED_SESSIONS
      ? token
      : null
  );
  const tokens = asked.filter((token): token is string => token !== null);
  const described = await rt.store.describeSessions(tokens, rt.nowIso());
  const byToken = new Map<string, SessionDescription>();
  for (const entry of described)
    if (entry !== null) byToken.set(entry.token, entry);
  const check = createAdmissionPass(rt, { fresh: false });
  const out: (SessionDescription | null)[] = [];
  for (const token of asked) {
    const entry = token === null ? undefined : byToken.get(token);
    if (entry === undefined) {
      out.push(null);
      continue;
    }
    const verdict = await check({
      id: entry.workspaceId,
      urlKey: entry.workspaceUrlKey,
      signInUrlKey: newerSignInUrlKey(entry),
      installed: entry.installed,
    });
    out.push(verdict === 'ok' ? entry : null);
  }
  return out;
}

/**
 * Resolves a cookie token into an Actor. A session of a workspace
 * admission refuses (cached reads, checked before anything else) reads as
 * signed out, its row kept (sessionAdmitted). A user token about to expire is
 * refreshed (single-flight under the session lock); a dead grant ends the
 * session (null), while a transient refresh failure keeps the person signed
 * in for reads and is retried on their next Linear edit. A person the
 * mirror shows as deactivated in Linear is signed out the same way, since
 * sign-in refuses them too: otherwise someone who left could keep running
 * live allocation and changing settings until the session expired. The
 * Actor says whether the person is read-only (readOnlyReasonFor: a Linear
 * guest, or unknown to the mirror; an installed workspace with no mirror
 * yet gets its first sync here first, mirrorForPerson); a read-only person
 * never holds canWriteLinear.
 */
export async function authenticate(
  rt: EngineRuntime,
  sessionToken: string | undefined
): Promise<Actor | null> {
  if (typeof sessionToken !== 'string' || sessionToken === '') return null;
  const session = await rt.store.getSession(sessionToken, rt.nowIso());
  if (session === null) return null;
  const fixture = rt.linear.mode === 'fixture';
  // Before mirrorForPerson, which may start a refused workspace's sync.
  if (!(await sessionAdmitted(rt, sessionToken, session))) return null;

  const { view, installed } = await mirrorForPerson(rt, session.workspaceId);
  const mirrored = view?.snapshot.users.get(session.userId);
  if (mirrored !== undefined && (!mirrored.active || mirrored.app)) {
    rt.logger.warn('ended the session of a deactivated Linear user', {
      workspaceId: session.workspaceId,
      userId: session.userId,
    });
    await rt.store.deleteSession(sessionToken);
    return null;
  }

  if (!(await refreshSessionIfNeeded(rt, sessionToken, session))) return null;

  // Decided per request from the mirror, so a person Linear turns into a
  // guest (or back) is read-only (or not) from their next page on.
  const reason = readOnlyReasonFor(
    view?.snapshot ?? null,
    session.userId,
    installed
  );
  const readOnly = reason !== null;
  return {
    session: publicSession(session),
    canWriteLinear:
      !readOnly && (fixture || session.tokens.scopes.includes('write')),
    readOnly,
    ...(reason === null ? {} : { readOnlyReason: reason }),
  };
}

/**
 * Ends a session; revoking its Linear token is best effort. A token that
 * names no live session (expired, or unknown) is answered `known: false`,
 * and with OAuth an expired row is left in place: cleanup's
 * takeExpiredSessions deletes it and revokes its grant. Deleting it here
 * would leave that grant alive with nothing left to revoke it from (the
 * stash cookie lives as long as its newest session, so the routes sign
 * out expired tokens it still carries).
 */
export async function signOut(
  rt: EngineRuntime,
  sessionToken: string
): Promise<SignOutResult> {
  const unknown: SignOutResult = { known: false, keysForgotten: 0 };
  if (typeof sessionToken !== 'string' || sessionToken === '') return unknown;
  const session = await rt.store.getSession(sessionToken, rt.nowIso());
  if (session === null) {
    // Without OAuth there is no grant to revoke: the row can go now.
    if (rt.linear.mode === 'fixture' || rt.config.oauth === null) {
      await rt.store.deleteSession(sessionToken);
    }
    return unknown;
  }
  await rt.store.deleteSession(sessionToken);
  const result: SignOutResult = { known: true, keysForgotten: 0 };
  if (rt.linear.mode === 'fixture' || rt.config.oauth === null) return result;
  const log = rt.logger.child({
    workspaceId: session.workspaceId,
    userId: session.userId,
    op: 'signout',
  });
  const revoked = await revokeGrant(rt, rt.config.oauth, session.tokens);
  if (revoked.ok) {
    log.info('signed out and revoked the Linear token');
  } else {
    log.warn('signed out, but revoking the Linear token failed', {
      error: revoked.error,
    });
  }
  return result;
}

/** Fixture mode: the active people of the demo workspace, by name. */
export async function listDemoUsers(rt: EngineRuntime): Promise<User[]> {
  if (rt.linear.mode !== 'fixture') return [];
  const view = await rt.mirror.current(FIXTURE_WORKSPACE.id);
  const users = view?.snapshot.data.users ?? [];
  return users
    .filter((user) => user.active && !user.app)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
