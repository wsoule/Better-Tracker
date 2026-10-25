import type { Actor, Engine } from '@better-tracker/engine';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { signInLocation } from './auth-cookies';
import { type HeldSessions, readHeldSessions } from './held-sessions';
import { getEngine } from './runtime';
import { activeSessionToken, cookieScheme } from './session-cookies';

export interface RequestContext {
  engine: Engine;
  actor: Actor | null;
  /**
   * The request carried a session cookie (of the name this mode reads),
   * whether or not it still names a session. The landing page says "your
   * connection ended" (api_key mode) or "your session for this workspace
   * ended" (OAuth mode, with other workspaces still held) when it no
   * longer does; a Server Component cannot clear the stale cookie, so the
   * next sign-in or switch overwrites it and sign-out clears it.
   */
  hadSessionCookie: boolean;
}

/**
 * Resolves the signed-in person for a page or route, if any. The cookies
 * are read before the engine boots: cookies() marks the route dynamic, so
 * `next build` never prerenders a page into an engine boot (which needs
 * the runtime environment). The cookie's name depends on the scheme
 * (lib/session-cookies.ts: `__Host-mp_session` on https).
 */
export async function getRequestContext(): Promise<RequestContext> {
  const jar = await cookies();
  const engine = await getEngine();
  const token = activeSessionToken(jar, cookieScheme(engine));
  const actor = await engine.authenticate(token);
  return {
    engine,
    actor,
    hadSessionCookie: token !== undefined,
  };
}

/**
 * The sessions this browser holds (OAuth mode: the active cookie and the
 * stash, described in one store query; elsewhere only the active token).
 * Carries tokens: for server code only, never handed to the browser.
 */
export async function getHeldSessions(): Promise<HeldSessions> {
  const jar = await cookies();
  const engine = await getEngine();
  return readHeldSessions(engine, jar, cookieScheme(engine));
}

/** For pages: signed-out visitors go to the landing page (with returnTo). */
export async function requireActor(returnTo?: string): Promise<{
  engine: Engine;
  actor: Actor;
}> {
  const { engine, actor } = await getRequestContext();
  if (actor === null) redirect(signInLocation(returnTo));
  return { engine, actor };
}
