import type { Actor, Engine } from '@better-tracker/engine';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE, signInLocation } from './auth-cookies';
import { getEngine } from './runtime';

/** httpOnly cookie holding the opaque session token (only its hash is stored). */
export { SESSION_COOKIE };

export interface RequestContext {
  engine: Engine;
  actor: Actor | null;
}

/**
 * Resolves the signed-in person for a page or route, if any. The cookie is
 * read before the engine boots: cookies() marks the route dynamic, so
 * `next build` never prerenders a page into an engine boot (which needs
 * the runtime environment).
 */
export async function getRequestContext(): Promise<RequestContext> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const engine = await getEngine();
  const actor = await engine.authenticate(token);
  return { engine, actor };
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
