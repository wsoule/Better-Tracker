import { after } from 'next/server';
import { z } from 'zod';

import {
  redirectWithCookies,
  sessionSecret,
} from '../../../../lib/auth-cookies';
import { signOutLater, signOutQuietly } from '../../../../lib/auth-flow';
import {
  allHeld,
  arrangementCookies,
  heldFor,
  readHeldSessions,
  unchanged,
  without,
} from '../../../../lib/held-sessions';
import { rejectCrossOrigin } from '../../../../lib/origin';
import {
  limitByIp,
  RATE_LIMITS,
  rateLimitedRedirect,
} from '../../../../lib/rate-limit';
import { getEngine } from '../../../../lib/runtime';
import {
  activeSessionToken,
  clearApiKeySessionCookies,
  clearSessionCookies,
  cookieScheme,
} from '../../../../lib/session-cookies';
import { signedOutNoticeValue } from '../../../../lib/signed-out-notice';

const logoutForm = z.object({
  scope: z.enum(['current', 'all']).default('current'),
  // The org id of the workspace the form's page showed (scope=current).
  workspace: z.string().trim().min(1).max(100).optional(),
});

/**
 * POST /api/auth/logout (the sidebar's sign-out form, "Sign out of all
 * workspaces" on Settings → Status and /setup, and Settings → Status's
 * "Forget my key and sign out"): same-origin only (architecture §8.1).
 *
 * OAuth mode, where a browser holds a session per workspace (owner
 * decision 2026-10-25), takes `scope=current|all` and, for `current`,
 * `workspace=<the org id the form's page showed>` (a tab left open on
 * another workspace never signs out the one switched to since):
 * - current ends that workspace's held session, active or stashed (its
 *   Linear grant revoked by the engine, best effort). When another session
 *   remains (the most recent stashed one takes an ended active one's
 *   place) it lands on /week?signed_out=1, whose notice names the
 *   workspace signed out (a signed, five-minute value) and the one still
 *   active; otherwise both cookies are cleared and it goes home. When the
 *   browser holds no session for that workspace nothing is ended
 *   (/week?signed_out=none says so). Without `workspace` it ends the
 *   active session.
 * - all ends every held session and clears both cookies.
 * Demo mode holds one session: it is ended and the cookie cleared. With
 * personal API keys (unchanged, §7.4) it forgets every connected key of
 * that person, on every device, and clears both cookie names; it lands
 * on "/?signed_out=1" only when the engine knew whose cookie it was,
 * otherwise on "/?signed_out=ended".
 */
export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  const refused = rejectCrossOrigin(request, engine.config.appUrl);
  if (refused !== null) return refused;
  const scheme = cookieScheme(engine);
  const token = activeSessionToken(request, scheme);
  if (scheme.mode === 'api_key') {
    const outcome =
      token !== undefined
        ? await signOutQuietly(engine, token, { everyDevice: true })
        : null;
    return redirectWithCookies(
      outcome?.known === true ? '/?signed_out=1' : '/?signed_out=ended',
      clearApiKeySessionCookies(scheme.secure)
    );
  }
  if (scheme.mode === 'demo') {
    if (token !== undefined) await signOutQuietly(engine, token);
    return redirectWithCookies('/', clearSessionCookies(scheme));
  }
  // OAuth mode: 60 sign-outs per 10 minutes per client IP
  // (lib/rate-limit.ts). Demo mode is exempt like its sign-in (the live
  // showcase and the browser suite share addresses), and api_key mode's
  // sign-out, which forgets keys, is never refused.
  const limited = limitByIp(request, RATE_LIMITS.signOut);
  if (limited !== null) return rateLimitedRedirect(limited.retryAfterSeconds);

  let fields: Record<string, unknown> = {};
  try {
    fields = Object.fromEntries((await request.formData()).entries());
  } catch {
    fields = {};
  }
  const parsed = logoutForm.safeParse(fields);
  const form = parsed.success ? parsed.data : { scope: 'current' as const };
  const held = await readHeldSessions(engine, request, scheme);
  const schedule = (task: () => Promise<unknown>): void => after(task);

  if (form.scope === 'all') {
    await Promise.all(
      [...allHeld(held).map((s) => s.token), ...held.dropped].map((t) =>
        signOutQuietly(engine, t)
      )
    );
    return redirectWithCookies('/', clearSessionCookies(scheme));
  }

  const target =
    form.workspace === undefined ? held.active : heldFor(held, form.workspace);
  if (target === null) {
    // Nothing held for that workspace: nothing is ended. Dead tokens are
    // still dropped from the cookies (and signed out after the response).
    const arrangement = unchanged(held);
    signOutLater(engine, arrangement.signOut, schedule);
    return redirectWithCookies(
      arrangement.active === null ? '/' : '/week?signed_out=none',
      arrangementCookies(arrangement, scheme, Date.now())
    );
  }
  await signOutQuietly(engine, target.token);
  const arrangement = without(held, target.token);
  signOutLater(engine, arrangement.signOut, schedule);
  if (arrangement.active === null && arrangement.stash.length === 0) {
    return redirectWithCookies('/', clearSessionCookies(scheme));
  }
  if (arrangement.active === null) {
    return redirectWithCookies(
      '/',
      arrangementCookies(arrangement, scheme, Date.now())
    );
  }
  const notice = signedOutNotice(
    target.workspaceName,
    arrangement.active.token
  );
  return redirectWithCookies(
    `/week?signed_out=1${notice === null ? '' : `&from=${notice}`}`,
    arrangementCookies(arrangement, scheme, Date.now())
  );
}

/**
 * The signed value /week reads the signed-out workspace's name from (so
 * the URL never carries a name the page would trust unsigned), bound to
 * this browser by the session left active (lib/signed-out-notice.ts: a
 * value replayed into another browser names nothing), or null without a
 * name or a usable SESSION_SECRET.
 */
function signedOutNotice(
  name: string | null,
  activeToken: string
): string | null {
  try {
    return signedOutNoticeValue(name, activeToken, sessionSecret(false));
  } catch {
    return null;
  }
}
