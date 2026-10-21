// Sign-in, install and sessions (§7 "auth", §4.1 OAuth).
//
// - signin asks for `read`; grant_write upgrades a PM to `read,write` so
//   their Linear edits are attributed to them; install is the admin's
//   actor=app grant (`read,write`, prompt=consent).
// - Sessions are cookie tokens whose SHA-256 is stored with the person's
//   own Linear tokens (encrypted). Objects handed back to callers (Actor,
//   SignInResult, Installation) carry redacted tokens so a page can never
//   serialize a Linear credential into HTML by accident; the provider reads
//   real tokens from the store when it needs them.
// - Signing out deletes the session and revokes its Linear refresh token
//   (best effort): Linear may auto-revoke a user's oldest tokens once they
//   hold more than 10 for one app, so abandoned tokens must not pile up.
//   cleanup() does the same for sessions that expired (cleanup.ts).

import { defaultSettings, type User } from '@better-tracker/core';
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
import { type EngineRuntime, readSettings } from './runtime';
import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  type OAuthIntent,
  type OAuthStart,
  type SignInResult,
} from './types';

const DAY_MS = 86_400_000;

/** Scopes requested per intent (comma-separated in the authorize URL). */
export const OAUTH_SCOPES: Record<OAuthIntent, readonly string[]> = {
  signin: ['read'],
  grant_write: ['read', 'write'],
  install: ['read', 'write'],
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

function requireOAuth(rt: EngineRuntime): OAuthClientConfig {
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
  const expiresAt = new Date(
    rt.clock().getTime() + rt.config.sessionDays * DAY_MS
  ).toISOString();
  const created = await rt.store.createSession({
    workspaceId: workspace.id,
    userId: user.id,
    userName: user.name,
    tokens: storedTokens(tokens, input.intent),
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

// Makes sure the installer is a PM. Brand-new settings get only the
// installer; the first full sync adds the bootstrap email lists.
async function ensureInstallerIsPm(
  rt: EngineRuntime,
  workspaceId: string,
  installerId: string
): Promise<void> {
  const { settings, stored } = await readSettings(rt, workspaceId);
  if (!stored) {
    await rt.store.saveSettings({
      ...defaultSettings(workspaceId, rt.config.defaultTimezone),
      pmUserIds: [installerId],
    });
    return;
  }
  if (!settings.pmUserIds.includes(installerId)) {
    await rt.store.saveSettings({
      ...settings,
      pmUserIds: [...settings.pmUserIds, installerId],
    });
  }
}

// Whether at least one configured PM is still an active person in the
// mirror. When none is (every PM left or was deactivated in Linear), nobody
// could change settings any more, so a reinstall is the way back in.
async function hasActivePm(
  rt: EngineRuntime,
  workspaceId: string
): Promise<boolean> {
  const [{ settings }, view] = await Promise.all([
    readSettings(rt, workspaceId),
    rt.mirror.current(workspaceId),
  ]);
  if (view === null) return settings.pmUserIds.length > 0;
  return settings.pmUserIds.some((id) => {
    const user = view.snapshot.users.get(id);
    return user !== undefined && user.active && !user.app;
  });
}

/**
 * Completes the admin's actor=app install for the actor's workspace. The
 * token must act as an app user of that same workspace. Reinstalling over
 * an active installation requires a PM, unless no active PM is left (the
 * lockout recovery: only a Linear admin can produce an actor=app grant).
 * The first full sync is left to the caller (the web route schedules it
 * after responding).
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
  if (
    existing !== null &&
    existing.revokedAt === null &&
    !actor.isPm &&
    (await hasActivePm(rt, workspaceId))
  ) {
    throw new EngineAuthError(
      'not_pm',
      'The app is already installed; only a PM can reinstall it.'
    );
  }

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
  await ensureInstallerIsPm(rt, workspaceId, actor.session.userId);
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
 * sign-in refuses them too: otherwise a removed PM could keep running live
 * allocation and changing settings until the session expired.
 */
export async function authenticate(
  rt: EngineRuntime,
  sessionToken: string | undefined
): Promise<Actor | null> {
  if (typeof sessionToken !== 'string' || sessionToken === '') return null;
  const session = await rt.store.getSession(sessionToken, rt.nowIso());
  if (session === null) return null;
  const fixture = rt.linear.mode === 'fixture';

  const mirrored = (
    await rt.mirror.current(session.workspaceId)
  )?.snapshot.users.get(session.userId);
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

  const { settings } = await readSettings(rt, session.workspaceId);
  return {
    session: publicSession(session),
    isPm: settings.pmUserIds.includes(session.userId),
    canWriteLinear: fixture || session.tokens.scopes.includes('write'),
  };
}

/** Ends a session; revoking its Linear token is best effort. */
export async function signOut(
  rt: EngineRuntime,
  sessionToken: string
): Promise<void> {
  if (typeof sessionToken !== 'string' || sessionToken === '') return;
  const session = await rt.store.getSession(sessionToken, rt.nowIso());
  await rt.store.deleteSession(sessionToken);
  if (
    session === null ||
    rt.linear.mode === 'fixture' ||
    rt.config.oauth === null
  ) {
    return;
  }
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
