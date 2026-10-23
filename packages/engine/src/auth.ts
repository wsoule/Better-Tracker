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
  StoredTokens,
} from '@better-tracker/store';

import { needsRefresh } from './providers';
import type { EngineRuntime, MirrorView } from './runtime';
import { fullSync } from './sync';
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
};

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

/** The authorize URL plus the state and PKCE verifier the cookie keeps. */
export function startOAuth(rt: EngineRuntime, intent: OAuthIntent): OAuthStart {
  const oauth = requireOAuth(rt);
  const scopes = OAUTH_SCOPES[intent];
  if (scopes === undefined) {
    throw new EngineInputError('invalid', 'Unknown sign-in intent.');
  }
  const state = createOAuthState();
  const pkce = createPkcePair();
  const install = intent === 'install';
  const url = buildAuthorizeUrl(oauth, {
    state,
    scopes: [...scopes],
    codeChallenge: pkce.challenge,
    ...(install ? { actor: 'app' as const, prompt: 'consent' as const } : {}),
  });
  return { url, state, codeVerifier: pkce.verifier };
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
 * for the page anyway. A failed sync leaves the mirror null and is logged;
 * readOnlyReasonFor then fails closed (`not_synced`).
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
    await fullSync(rt, workspaceId);
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

/** Completes signin / grant_write: a new session for the Linear user. */
export async function finishSignIn(
  rt: EngineRuntime,
  input: {
    code: string;
    codeVerifier: string;
    intent: 'signin' | 'grant_write';
  }
): Promise<SignInResult> {
  const oauth = requireOAuth(rt);
  if (input.intent !== 'signin' && input.intent !== 'grant_write') {
    throw new EngineInputError('invalid', 'Unknown sign-in intent.');
  }
  const log = rt.logger.child({ op: 'signin', intent: input.intent });
  const { tokens, identity } = await exchangeAndIdentify(rt, oauth, input, log);
  const { user, workspace } = identity;
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
  const expiresAt = new Date(
    rt.clock().getTime() + rt.config.sessionDays * DAY_MS
  ).toISOString();
  const created = await rt.store.createSession({
    workspaceId: workspace.id,
    userId: user.id,
    userName: user.name,
    tokens: stored,
    expiresAt,
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
  input: { code: string; codeVerifier: string; actor: Actor }
): Promise<Installation> {
  const oauth = requireOAuth(rt);
  const { actor } = input;
  const workspaceId = actor.session.workspaceId;
  const log = rt.logger.child({
    op: 'install',
    workspaceId,
    userId: actor.session.userId,
  });
  const existing = await rt.store.getInstallation(workspaceId);

  const { tokens, identity } = await exchangeAndIdentify(rt, oauth, input, log);
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
  });
  rt.logger.info('demo sign-in', { workspaceId, userId: user.id });
  return {
    sessionToken: created.token,
    session: publicSession(created.session),
    needsInstall: await needsInstall(rt, workspaceId),
  };
}

/**
 * Resolves a cookie token into an Actor. A user token about to expire is
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

  if (!fixture && needsRefresh(session.tokens, rt.clock())) {
    try {
      await rt.linear.forSession(session);
    } catch (error) {
      if (error instanceof EngineAuthError && error.code === 'not_signed_in') {
        await rt.store.deleteSession(sessionToken);
        return null;
      }
      rt.logger.warn('could not refresh the session token; continuing', {
        workspaceId: session.workspaceId,
        userId: session.userId,
        error,
      });
    }
  }

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

/** Ends a session; revoking its Linear token is best effort. */
export async function signOut(
  rt: EngineRuntime,
  sessionToken: string
): Promise<SignOutResult> {
  const unknown: SignOutResult = { known: false, keysForgotten: 0 };
  if (typeof sessionToken !== 'string' || sessionToken === '') return unknown;
  const session = await rt.store.getSession(sessionToken, rt.nowIso());
  await rt.store.deleteSession(sessionToken);
  if (session === null) return unknown;
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
