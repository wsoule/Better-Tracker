import {
  authErrorLocation,
  DEFAULT_RETURN_TO,
  isSecureUrl,
  OAUTH_COOKIE_TTL_MS,
  oauthCookie,
  parseIntent,
  readCookie,
  redirectWithCookies,
  sanitizeReturnTo,
  SESSION_COOKIE,
  sessionSecret,
} from '../../../../lib/auth-cookies';
import { authErrorCode, logConfigError } from '../../../../lib/auth-flow';
import { getEngine } from '../../../../lib/runtime';
import { signValue } from '../../../../lib/signed-cookie';

/**
 * GET /api/auth/linear?intent=signin|install|grant_write[&returnTo=/path]
 * starts Linear OAuth (architecture §8.1): the state and PKCE verifier go
 * into the signed, 10-minute mp_oauth cookie and the browser is sent to
 * Linear's authorize page. Installing the app and granting write access
 * need someone signed in already. Demo mode has no OAuth and goes home.
 */
export async function GET(request: Request): Promise<Response> {
  const engine = await getEngine();
  if (engine.mode === 'fixture') return redirectWithCookies('/');

  const params = new URL(request.url).searchParams;
  const intent = parseIntent(params.get('intent'));
  if (intent === null) {
    return redirectWithCookies(authErrorLocation('invalid_request'));
  }
  if (intent !== 'signin') {
    const actor = await engine.authenticate(
      readCookie(request, SESSION_COOKIE)
    );
    if (actor === null) {
      return redirectWithCookies(authErrorLocation('sign_in_first'));
    }
  }

  let secret: string;
  try {
    secret = sessionSecret(false);
  } catch (error) {
    logConfigError('cannot start OAuth: SESSION_SECRET is unusable', error);
    return redirectWithCookies(authErrorLocation('session_secret'));
  }

  let start: ReturnType<typeof engine.startOAuth>;
  try {
    start = engine.startOAuth(intent);
  } catch (error) {
    return redirectWithCookies(
      authErrorLocation(authErrorCode(error, 'oauth_start'))
    );
  }
  const returnTo = sanitizeReturnTo(params.get('returnTo'), DEFAULT_RETURN_TO);
  const value = signValue(
    {
      state: start.state,
      codeVerifier: start.codeVerifier,
      intent,
      returnTo,
    },
    secret,
    Date.now() + OAUTH_COOKIE_TTL_MS
  );
  return redirectWithCookies(
    start.url,
    [oauthCookie(value, isSecureUrl(engine.config.appUrl))],
    302
  );
}
