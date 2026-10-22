import type { Actor, Engine } from '@better-tracker/engine';

import {
  buildIssueTaskModel,
  findIssue,
  type IssueTaskModel,
} from './adapters/issue';
import { engineInputCode } from './engine-errors';
import { grantWriteHref } from './http';

// Server-side loading of the issue view (architecture §8.5) for the
// /issues/[id] page and the ?issue= slide-overs: resolves an id or an
// identifier against the mirror, reads the engine's IssueDetailResult as
// the signed-in person (their own token reads the live part) and maps it
// with lib/adapters/issue.ts.

/**
 * The issue's task model, or null when the planner does not hold it (an
 * unknown key, or an issue the mirror dropped between the lookup and the
 * read). `returnTo` is where the "Allow edits in Linear" link comes back
 * to: the page, or the page with the drawer open.
 */
export async function loadIssueModel(
  engine: Engine,
  actor: Actor,
  key: string,
  returnTo: string
): Promise<IssueTaskModel | null> {
  const loaded = await engine.load(actor.session.workspaceId);
  const issue = findIssue(loaded.snapshot.issues, key);
  if (issue === undefined) return null;
  let result: Awaited<ReturnType<Engine['getIssueDetail']>>;
  try {
    result = await engine.getIssueDetail(actor, issue.id);
  } catch (error) {
    if (engineInputCode(error) === 'not_found') return null;
    throw error;
  }
  return buildIssueTaskModel({
    result,
    today: loaded.today,
    timeZone: loaded.settings.timezone,
    viewerId: actor.session.userId,
    grantWriteHref: grantWriteHref(returnTo),
    names: new Map(
      loaded.snapshot.data.users.map((user) => [user.id, user.name])
    ),
  });
}

/**
 * The path and query a page was asked for, rebuilt from its search params
 * (for the grant link's returnTo): `/week?user=…&issue=ENG-24`.
 */
export function currentHref(
  path: string,
  params: Record<string, string | string[] | undefined>
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      query.append(name, one);
    }
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

/**
 * The ?issue= drawer's server half: the requested key and its model (null
 * when the planner does not hold it), or no drawer at all.
 */
export async function loadIssueDrawer(
  engine: Engine,
  actor: Actor,
  key: string | null,
  returnTo: string
): Promise<{ param: string | null; model: IssueTaskModel | null }> {
  if (key === null) return { param: null, model: null };
  return {
    param: key,
    model: await loadIssueModel(engine, actor, key, returnTo),
  };
}
