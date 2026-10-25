import { after } from 'next/server';

import {
  authErrorLocation,
  CONNECT_SAME_LOCATION,
  parseOAuthPayload,
  redirectWithCookies,
  sessionSecret,
} from '../../../../../lib/auth-cookies';
import {
  authErrorCode,
  logConfigError,
  signOutLater,
  signOutQuietly,
} from '../../../../../lib/auth-flow';
import {
  activate,
  arrangementCookies,
  heldFor,
  readHeldSessions,
} from '../../../../../lib/held-sessions';
import { getEngine } from '../../../../../lib/runtime';
import {
  clearOauthStateCookie,
  cookieScheme,
  legacyCookieClears,
  readOauthState,
} from '../../../../../lib/session-cookies';
import { safeEqual, verifyValue } from '../../../../../lib/signed-cookie';

const ERROR_CODE = /^[a-z_]{1,40}$/;

/**
 * GET /api/auth/linear/callback finishes Linear OAuth (architecture §8.1).
 * Not origin-checked (it is a cross-site redirect from linear.app): the
 * OAuth state cookie must verify (signature, 10-minute expiry) and its
 * state must equal the query's, compared in constant time. Never rate
 * limited, since a refusal here would burn Linear's single-use code.
 *
 * A browser holds a session per workspace (owner decision 2026-10-25):
 * - signin and add_workspace that come back with a workspace the browser
 *   already holds a live session for keep that session (its grant may
 *   allow writes; the new one only reads), end the new one at once
 *   (revoking its grant), make it active and land on /week?connect=same;
 * - grant_write replaces the held session of the workspace it was started
 *   for (the engine refuses a grant for another one, grant_wrong_workspace);
 * - otherwise the new session becomes active, sessions of other
 *   workspaces stay in the stash, and any other held for the same
 *   workspace is replaced (ended after the response);
 * - it lands on /setup when the workspace has no installation, else on
 *   returnTo (add_workspace: /week unless the open interstitial passed
 *   one).
 * An install is finished by the browser's session for the workspace it
 * was started for (active or stashed; sign_in_first when the browser no
 * longer holds it), which becomes active; the first full sync runs after
 * the response, and the timeline opens. Every outcome clears the OAuth
 * state cookie; failures land on "/?auth_error=<code>".
 */
export async function GET(request: Request): Promise<Response> {
  const engine = await getEngine();
  const scheme = cookieScheme(engine);
  const clearState = clearOauthStateCookie(scheme);
  // Failures change no session cookie; successes write all of them
  // (arrangementCookies, which expires the legacy names too).
  const clear = [clearState, ...legacyCookieClears(scheme)];
  const fail = (code: string): Response =>
    redirectWithCookies(authErrorLocation(code), clear);
  if (scheme.mode !== 'oauth') return redirectWithCookies('/', clear);

  let secret: string;
  try {
    secret = sessionSecret(false);
  } catch (error) {
    logConfigError('cannot finish OAuth: SESSION_SECRET is unusable', error);
    return fail('session_secret');
  }

  const params = new URL(request.url).searchParams;
  const payload = parseOAuthPayload(
    verifyValue(readOauthState(request, scheme), secret, Date.now())
  );
  if (payload === null) return fail('oauth_expired');

  const linearError = params.get('error');
  if (linearError !== null) {
    return fail(
      linearError === 'access_denied'
        ? 'access_denied'
        : ERROR_CODE.test(linearError)
          ? `linear_${linearError}`
          : 'linear_error'
    );
  }
  const state = params.get('state');
  if (state === null || !safeEqual(state, payload.state)) {
    return fail('oauth_state');
  }
  const code = params.get('code');
  if (code === null || code === '') return fail('oauth_code');

  const held = await readHeldSessions(engine, request, scheme);
  const schedule = (task: () => Promise<unknown>): void => after(task);

  if (payload.intent === 'install') {
    const expectWorkspaceId = payload.expectWorkspaceId ?? '';
    const installer = heldFor(held, expectWorkspaceId);
    const actor =
      installer === null ? null : await engine.authenticate(installer.token);
    if (installer === null || actor === null) return fail('sign_in_first');
    try {
      const installation = await engine.finishInstall({
        code,
        codeVerifier: payload.codeVerifier,
        actor,
        expectWorkspaceId,
      });
      after(async () => {
        try {
          await engine.fullSync(installation.workspaceId);
        } catch (error) {
          logConfigError('first sync after install failed', error);
        }
      });
      const arrangement = activate(held, installer);
      signOutLater(engine, arrangement.signOut, schedule);
      return redirectWithCookies('/timeline', [
        clearState,
        ...arrangementCookies(arrangement, scheme, Date.now()),
      ]);
    } catch (error) {
      return fail(authErrorCode(error, 'install'));
    }
  }

  try {
    const result = await engine.finishSignIn({
      code,
      codeVerifier: payload.codeVerifier,
      intent: payload.intent,
      ...(payload.intent === 'grant_write'
        ? { expectWorkspaceId: payload.expectWorkspaceId }
        : {}),
    });
    const workspaceId = result.session.workspaceId;
    const existing =
      payload.intent === 'grant_write' ? null : heldFor(held, workspaceId);
    if (
      existing !== null &&
      existing.token !== result.sessionToken &&
      (await engine.checkSession(existing.token)) !== null
    ) {
      // Linear authorized the workspace open at linear.app, which this
      // browser already holds: keep that session and its grant, end the
      // new one now (revoking its grant).
      await signOutQuietly(engine, result.sessionToken);
      const arrangement = activate(held, existing);
      signOutLater(engine, arrangement.signOut, schedule);
      return redirectWithCookies(CONNECT_SAME_LOCATION, [
        clearState,
        ...arrangementCookies(arrangement, scheme, Date.now()),
      ]);
    }
    const arrangement = activate(held, {
      token: result.sessionToken,
      workspaceId,
      expiresAt: result.session.expiresAt,
    });
    signOutLater(engine, arrangement.signOut, schedule);
    return redirectWithCookies(
      result.needsInstall ? '/setup' : payload.returnTo,
      [clearState, ...arrangementCookies(arrangement, scheme, Date.now())]
    );
  } catch (error) {
    return fail(authErrorCode(error, payload.intent));
  }
}
