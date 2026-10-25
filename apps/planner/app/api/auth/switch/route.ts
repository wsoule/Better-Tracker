import { after } from 'next/server';
import { z } from 'zod';

import {
  DEFAULT_RETURN_TO,
  redirectWithCookies,
  sanitizeReturnTo,
} from '../../../../lib/auth-cookies';
import { signOutLater } from '../../../../lib/auth-flow';
import {
  activate,
  type Arrangement,
  arrangementCookies,
  heldFor,
  readHeldSessions,
  unchanged,
  without,
} from '../../../../lib/held-sessions';
import { jsonError, rejectCrossOrigin } from '../../../../lib/origin';
import { getEngine } from '../../../../lib/runtime';
import { cookieScheme } from '../../../../lib/session-cookies';
import {
  type SwitchErrorCode,
  switchErrorMessage,
} from '../../../../lib/workspace-copy';

const switchForm = z.object({
  // The org id of the workspace to switch to (never shown back).
  workspace: z.string().trim().min(1).max(100),
  returnTo: z.string().max(2048).optional(),
});

const STATUS: Record<SwitchErrorCode, number> = {
  invalid_request: 400,
  unknown_workspace: 404,
  session_ended: 410,
};

/** The caller asked for JSON (the switcher and the palette do). */
function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '')
    .toLowerCase()
    .includes('application/json');
}

/**
 * POST /api/auth/switch (form fields `workspace` = an org id, optional
 * `returnTo`; architecture §8.1): makes another of this browser's own
 * sessions the active one (owner decision 2026-10-25). OAuth mode only
 * (404 elsewhere), same-origin only. Not a write: no requireWritable, and
 * a Linear guest may switch. The target is found among the browser's held
 * sessions (describeSessions) and checked with engine.checkSession (its
 * Linear token refreshed when near expiry, without syncing); the active
 * session may be missing or dead (a person who looks signed out while
 * other workspaces are held continues from the landing page). On success
 * the target is active, the previous active session goes first in the
 * stash, and sessions that no longer exist are dropped from the cookies
 * and signed out after the response.
 *
 * With `Accept: application/json` (the switcher, the palette) it answers
 * 200 `{ location }` or 4xx `{ error: { code, message } }`
 * (`unknown_workspace` 404, `session_ended` 410, `invalid_request` 400),
 * with the cookies either way; a plain form post gets a 303 to the
 * sanitised returnTo (else /week), or to /week?switch_error=<code> (/ when
 * no session remains active). Never to the Referer. Never cached.
 */
export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  const scheme = cookieScheme(engine);
  if (scheme.mode !== 'oauth') {
    return jsonError(
      404,
      'not_found',
      'Switching workspaces is off on this server.',
      {},
      { 'Cache-Control': 'no-store' }
    );
  }
  const refused = rejectCrossOrigin(request, engine.config.appUrl);
  if (refused !== null) return refused;
  const json = wantsJson(request);

  let fields: Record<string, unknown> = {};
  try {
    fields = Object.fromEntries((await request.formData()).entries());
  } catch {
    fields = {};
  }
  const parsed = switchForm.safeParse(fields);
  const held = await readHeldSessions(engine, request, scheme);
  const schedule = (task: () => Promise<unknown>): void => after(task);

  const answer = (
    arrangement: Arrangement,
    outcome: { location: string } | { code: SwitchErrorCode; name?: string }
  ): Response => {
    signOutLater(engine, arrangement.signOut, schedule);
    const cookies = arrangementCookies(arrangement, scheme, Date.now());
    if ('location' in outcome) {
      if (!json) return redirectWithCookies(outcome.location, cookies);
      return withCookies(
        Response.json({ location: outcome.location }, { status: 200 }),
        cookies
      );
    }
    const message = switchErrorMessage(outcome.code, outcome.name ?? null);
    if (json) {
      return withCookies(
        jsonError(STATUS[outcome.code], outcome.code, message),
        cookies
      );
    }
    const home = arrangement.active === null ? '/' : DEFAULT_RETURN_TO;
    return redirectWithCookies(
      `${home}?switch_error=${encodeURIComponent(outcome.code)}`,
      cookies
    );
  };

  if (!parsed.success) {
    return answer(unchanged(held), { code: 'invalid_request' });
  }
  const target = heldFor(held, parsed.data.workspace);
  if (target === null) {
    return answer(unchanged(held), { code: 'unknown_workspace' });
  }
  if (
    held.active?.token !== target.token &&
    (await engine.checkSession(target.token)) === null
  ) {
    const arrangement = without(held, target.token);
    arrangement.signOut.push(target.token);
    return answer(arrangement, {
      code: 'session_ended',
      ...(target.workspaceName === null ? {} : { name: target.workspaceName }),
    });
  }
  return answer(activate(held, target), {
    location: sanitizeReturnTo(parsed.data.returnTo, DEFAULT_RETURN_TO),
  });
}

/** Adds Set-Cookie headers and no-store to a response built elsewhere. */
function withCookies(response: Response, cookies: readonly string[]): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
}
