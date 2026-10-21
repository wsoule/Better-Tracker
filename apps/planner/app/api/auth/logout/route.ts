import {
  clearSessionCookie,
  isSecureUrl,
  readCookie,
  redirectWithCookies,
  SESSION_COOKIE,
} from '../../../../lib/auth-cookies';
import { signOutQuietly } from '../../../../lib/auth-flow';
import { rejectCrossOrigin } from '../../../../lib/origin';
import { getEngine } from '../../../../lib/runtime';

/**
 * POST /api/auth/logout (the sidebar's sign-out form): same-origin only,
 * ends the session (the engine revokes its Linear token, best effort),
 * expires mp_session and goes home with a 303.
 */
export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  const refused = rejectCrossOrigin(request, engine.config.appUrl);
  if (refused !== null) return refused;
  const token = readCookie(request, SESSION_COOKIE);
  if (token !== undefined && token !== '') {
    await signOutQuietly(engine, token);
  }
  return redirectWithCookies('/', [
    clearSessionCookie(isSecureUrl(engine.config.appUrl)),
  ]);
}
