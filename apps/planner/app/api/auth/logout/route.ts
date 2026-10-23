import {
  clearApiKeySessionCookies,
  clearSessionCookie,
  isSecureUrl,
  readCookie,
  redirectWithCookies,
  sessionCookieName,
} from '../../../../lib/auth-cookies';
import { signOutQuietly } from '../../../../lib/auth-flow';
import { rejectCrossOrigin } from '../../../../lib/origin';
import { getEngine } from '../../../../lib/runtime';

/**
 * POST /api/auth/logout (the sidebar's sign-out form, and Settings →
 * Status's "Forget my key and sign out"): same-origin only, ends the
 * session (the engine revokes its Linear token, best effort), expires the
 * session cookie and goes home with a 303. With personal API keys it
 * forgets every connected key of that person, on every device (there is
 * nothing to revoke in Linear), and clears both cookie names. It lands on
 * "/?signed_out=1", which says so, only when the engine knew whose cookie
 * it was; otherwise (no cookie, or this browser's connection had already
 * ended and the planner no longer knows whose it was) on
 * "/?signed_out=ended", which says other browsers may still be connected.
 */
export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  const refused = rejectCrossOrigin(request, engine.config.appUrl);
  if (refused !== null) return refused;
  const secure = isSecureUrl(engine.config.appUrl);
  const token = readCookie(request, sessionCookieName(engine.config));
  if (engine.config.auth === 'api_key') {
    const outcome =
      token !== undefined && token !== ''
        ? await signOutQuietly(engine, token, { everyDevice: true })
        : null;
    return redirectWithCookies(
      outcome?.known === true ? '/?signed_out=1' : '/?signed_out=ended',
      clearApiKeySessionCookies(secure)
    );
  }
  if (token !== undefined && token !== '') {
    await signOutQuietly(engine, token);
  }
  return redirectWithCookies('/', [clearSessionCookie(secure)]);
}
