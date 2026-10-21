import type { Actor, Engine } from '@better-tracker/engine';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getEngine } from './runtime';

/** httpOnly cookie holding the opaque session token (only its hash is stored). */
export const SESSION_COOKIE = 'mp_session';

export interface RequestContext {
  engine: Engine;
  actor: Actor | null;
}

/** Resolves the signed-in person for a page or route, if any. */
export async function getRequestContext(): Promise<RequestContext> {
  const engine = await getEngine();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const actor = await engine.authenticate(token);
  return { engine, actor };
}

/** For pages: signed-out visitors go to the landing page. */
export async function requireActor(): Promise<{
  engine: Engine;
  actor: Actor;
}> {
  const { engine, actor } = await getRequestContext();
  if (!actor) redirect('/');
  return { engine, actor };
}
