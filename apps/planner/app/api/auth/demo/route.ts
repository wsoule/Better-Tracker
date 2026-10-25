import { after } from 'next/server';
import { z } from 'zod';

import {
  authErrorLocation,
  DEFAULT_RETURN_TO,
  redirectWithCookies,
  sanitizeReturnTo,
} from '../../../../lib/auth-cookies';
import { authErrorCode, signOutQuietly } from '../../../../lib/auth-flow';
import { jsonError, rejectCrossOrigin } from '../../../../lib/origin';
import { getEngine } from '../../../../lib/runtime';
import {
  activeSessionToken,
  cookieScheme,
  legacyCookieClears,
  sessionCookies,
} from '../../../../lib/session-cookies';

const demoForm = z.object({
  userId: z.string().trim().min(1).max(200),
  // Where the picker was opened from (sanitized below; default My week).
  returnTo: z.string().max(2048).optional(),
});

/**
 * POST /api/auth/demo (form fields userId, optional returnTo): demo mode
 * only (404 elsewhere), same-origin only. Signs in as a fictional person,
 * ends the session it replaces (demo mode holds one session: no stash),
 * and opens returnTo (a relative path, else My week) with a 303. Failures
 * go back to the picker with ?auth_error=<code>.
 */
export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  if (engine.mode !== 'fixture') {
    return jsonError(404, 'not_found', 'Demo sign-in is off on this server.');
  }
  const refused = rejectCrossOrigin(request, engine.config.appUrl);
  if (refused !== null) return refused;
  const scheme = cookieScheme(engine);
  const housekeeping = legacyCookieClears(scheme);

  let fields: Record<string, unknown>;
  try {
    fields = Object.fromEntries((await request.formData()).entries());
  } catch {
    return redirectWithCookies(
      authErrorLocation('invalid_request'),
      housekeeping
    );
  }
  const parsed = demoForm.safeParse(fields);
  if (!parsed.success) {
    return redirectWithCookies(
      authErrorLocation('invalid_request'),
      housekeeping
    );
  }

  try {
    const result = await engine.devSignIn(parsed.data.userId);
    const previous = activeSessionToken(request, scheme);
    if (previous !== undefined && previous !== result.sessionToken) {
      after(() => signOutQuietly(engine, previous));
    }
    const target = sanitizeReturnTo(parsed.data.returnTo, DEFAULT_RETURN_TO);
    return redirectWithCookies(
      target,
      sessionCookies(
        {
          active: {
            token: result.sessionToken,
            expiresAt: result.session.expiresAt,
          },
          stash: [],
        },
        scheme,
        Date.now()
      )
    );
  } catch (error) {
    // The engine's `invalid` here means "a deactivated person or the app
    // user": give it its own code, since `invalid` alone reads as "sign-in
    // is unavailable on this server".
    const code = authErrorCode(error, 'demo_signin');
    return redirectWithCookies(
      authErrorLocation(code === 'invalid' ? 'demo_inactive' : code),
      housekeeping
    );
  }
}
