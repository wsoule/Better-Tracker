import { requireCanInstall, requireWritable } from '@better-tracker/engine';

import {
  authErrorLocation,
  DEFAULT_RETURN_TO,
  parseIntent,
  redirectWithCookies,
  sanitizeReturnTo,
  sessionSecret,
} from '../../../../lib/auth-cookies';
import { authErrorCode, logConfigError } from '../../../../lib/auth-flow';
import { heldCount, readHeldSessions } from '../../../../lib/held-sessions';
import { getEngine } from '../../../../lib/runtime';
import {
  activeSessionToken,
  cookieScheme,
  legacyCookieClears,
  MAX_HELD_WORKSPACES,
  OAUTH_STATE_TTL_MS,
  oauthStateCookie,
} from '../../../../lib/session-cookies';
import { signValue } from '../../../../lib/signed-cookie';

/**
 * GET /api/auth/linear?intent=signin|install|grant_write|add_workspace
 * [&returnTo=/path] starts Linear OAuth (architecture §8.1): the state,
 * the PKCE verifier, the intent, returnTo and (install, grant_write) the
 * workspace it is for go into the signed, 10-minute OAuth state cookie,
 * and the browser is sent to Linear's authorize page. A link, never a
 * form, and not origin-checked: it changes nothing until the callback,
 * which the signed state protects.
 *
 * Installing the app and granting write access need someone signed in
 * already; both act for the active session's workspace, whose id is
 * signed into the state (owner decision 2026-10-25: a browser holds
 * several workspaces, and a switch in another tab during Linear's consent
 * screen must not change which one they act for). Neither is offered to a
 * read-only person (a Linear guest: owner decision 2026-10-22), who lands
 * on "/?auth_error=read_only" instead; the engine refuses both for a guest
 * again when they finish. The one exception is an install while the
 * workspace's first sync has not landed (readOnlyReason `not_synced`).
 * add_workspace (connect another workspace) is a sign-in that asks Linear
 * for its consent screen again; it works signed in or out, and is refused
 * with too_many_workspaces while the browser holds 10. Demo mode and
 * personal API keys have no OAuth and go home.
 */
export async function GET(request: Request): Promise<Response> {
  const engine = await getEngine();
  const scheme = cookieScheme(engine);
  // Demo mode has no OAuth; with personal API keys OAuth is off too.
  if (scheme.mode !== 'oauth') return redirectWithCookies('/');
  const housekeeping = legacyCookieClears(scheme);
  const refuse = (code: string): Response =>
    redirectWithCookies(authErrorLocation(code), housekeeping);

  const params = new URL(request.url).searchParams;
  const intent = parseIntent(params.get('intent'));
  if (intent === null) return refuse('invalid_request');

  let expectWorkspaceId: string | undefined;
  if (intent === 'install' || intent === 'grant_write') {
    const actor = await engine.authenticate(
      activeSessionToken(request, scheme)
    );
    if (actor === null) return refuse('sign_in_first');
    // The engine's own guards, so this refuses exactly what finishing
    // would: an install also stays open while the first sync has not
    // landed (requireCanInstall), since that is how an admin fixes a
    // grant that makes the sync fail.
    try {
      if (intent === 'install') requireCanInstall(actor);
      else requireWritable(actor);
    } catch {
      return refuse('read_only');
    }
    expectWorkspaceId = actor.session.workspaceId;
  } else if (intent === 'add_workspace') {
    const held = await readHeldSessions(engine, request, scheme);
    if (heldCount(held) >= MAX_HELD_WORKSPACES) {
      return refuse('too_many_workspaces');
    }
  }

  let secret: string;
  try {
    secret = sessionSecret(false);
  } catch (error) {
    logConfigError('cannot start OAuth: SESSION_SECRET is unusable', error);
    return refuse('session_secret');
  }

  let start: ReturnType<typeof engine.startOAuth>;
  try {
    start = engine.startOAuth(intent);
  } catch (error) {
    return refuse(authErrorCode(error, 'oauth_start'));
  }
  const returnTo = sanitizeReturnTo(params.get('returnTo'), DEFAULT_RETURN_TO);
  const value = signValue(
    {
      state: start.state,
      codeVerifier: start.codeVerifier,
      intent,
      returnTo,
      ...(expectWorkspaceId === undefined ? {} : { expectWorkspaceId }),
    },
    secret,
    Date.now() + OAUTH_STATE_TTL_MS
  );
  return redirectWithCookies(
    start.url,
    [oauthStateCookie(value, scheme), ...housekeeping],
    302
  );
}
