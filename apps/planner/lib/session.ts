import type { Actor, Engine } from '@better-tracker/engine';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  SESSION_COOKIE,
  sessionCookieName,
  signInLocation,
} from './auth-cookies';
import { getEngine } from './runtime';

/** httpOnly cookie holding the opaque session token (only its hash is stored). */
export { SESSION_COOKIE };

export interface RequestContext {
  engine: Engine;
  actor: Actor | null;
  /**
   * The request carried a session cookie (of the name this mode reads),
   * whether or not it still names a session. In api_key mode the landing
   * page says "your connection ended" when it no longer does; a Server
   * Component cannot clear the stale cookie, so the next connect
   * overwrites it and sign-out clears it.
   */
  hadSessionCookie: boolean;
}

/**
 * Resolves the signed-in person for a page or route, if any. The cookies
 * are read before the engine boots: cookies() marks the route dynamic, so
 * `next build` never prerenders a page into an engine boot (which needs
 * the runtime environment). The cookie's name depends on the mode
 * (sessionCookieName: `__Host-mp_session` in api_key mode on https).
 */
export async function getRequestContext(): Promise<RequestContext> {
  const jar = await cookies();
  const engine = await getEngine();
  const token = jar.get(sessionCookieName(engine.config))?.value;
  const actor = await engine.authenticate(token);
  return {
    engine,
    actor,
    hadSessionCookie: token !== undefined && token !== '',
  };
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
