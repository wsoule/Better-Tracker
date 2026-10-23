import { after } from 'next/server';

import {
  authErrorLocation,
  clearOauthCookie,
  isSecureUrl,
  OAUTH_COOKIE,
  parseOAuthPayload,
  readCookie,
  redirectWithCookies,
  SESSION_COOKIE,
  sessionCookie,
  sessionSecret,
} from '../../../../../lib/auth-cookies';
import {
  authErrorCode,
  logConfigError,
  signOutQuietly,
} from '../../../../../lib/auth-flow';
import { getEngine } from '../../../../../lib/runtime';
import { safeEqual, verifyValue } from '../../../../../lib/signed-cookie';

const ERROR_CODE = /^[a-z_]{1,40}$/;

/**
 * GET /api/auth/linear/callback finishes Linear OAuth (architecture §8.1).
 * The mp_oauth cookie must verify (signature, 10-minute expiry) and its
 * state must equal the query's, compared in constant time. Sign-in and
 * write grants create a session (mp_session) and end the one it replaces,
 * then go to /setup when the workspace has no installation, else back to
 * returnTo. An install saves the app's grant, schedules the first full
 * sync after the response, and opens the timeline. Every outcome clears
 * mp_oauth; failures land on "/?auth_error=<code>".
 */
export async function GET(request: Request): Promise<Response> {
  const engine = await getEngine();
  const secure = isSecureUrl(engine.config.appUrl);
  const clear = clearOauthCookie(secure);
  const fail = (code: string): Response =>
    redirectWithCookies(authErrorLocation(code), [clear]);
  if (engine.mode === 'fixture' || engine.config.auth === 'api_key') {
    return redirectWithCookies('/', [clear]);
  }

  let secret: string;
  try {
    secret = sessionSecret(false);
  } catch (error) {
    logConfigError('cannot finish OAuth: SESSION_SECRET is unusable', error);
    return fail('session_secret');
  }

  const params = new URL(request.url).searchParams;
  const payload = parseOAuthPayload(
    verifyValue(readCookie(request, OAUTH_COOKIE), secret, Date.now())
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

  const previousToken = readCookie(request, SESSION_COOKIE);

  if (payload.intent === 'install') {
    const actor = await engine.authenticate(previousToken);
    if (actor === null) return fail('sign_in_first');
    try {
      const installation = await engine.finishInstall({
        code,
        codeVerifier: payload.codeVerifier,
        actor,
      });
      after(async () => {
        try {
          await engine.fullSync(installation.workspaceId);
        } catch (error) {
          logConfigError('first sync after install failed', error);
        }
      });
      return redirectWithCookies('/timeline', [clear]);
    } catch (error) {
      return fail(authErrorCode(error, 'install'));
    }
  }

  try {
    const result = await engine.finishSignIn({
      code,
      codeVerifier: payload.codeVerifier,
      intent: payload.intent,
    });
    if (previousToken !== undefined && previousToken !== result.sessionToken) {
      after(() => signOutQuietly(engine, previousToken));
    }
    return redirectWithCookies(
      result.needsInstall ? '/setup' : payload.returnTo,
      [
        clear,
        sessionCookie(result.sessionToken, result.session.expiresAt, {
          secure,
          nowMs: Date.now(),
        }),
      ]
    );
  } catch (error) {
    return fail(authErrorCode(error, payload.intent));
  }
}
