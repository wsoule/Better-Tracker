import type { Actor, Engine } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { parseIssueListSearch } from './adapters/issue-list';
import { buildShellFrame, type ShellFrame } from './adapters/shell';
import { CONNECT_PATH, signInLocation } from './auth-cookies';
import { engineAuthCode } from './engine-errors';
import { allHeld, type HeldSessions } from './held-sessions';
import {
  getHeldSessions,
  getRequestContext,
  type RequestContext,
} from './session';
import { setupLocation } from './workspace-copy';

// Data loading for server components (pages and the (app) layout).
//
// The layout and the page render in the same request and both need the
// actor, often the same views (the sidebar counts My week; the week page
// shows it). React's cache() memoises each loader for one request, so the
// session is authenticated once and each view is built once per render.
//
// Pages call requireInstalledActor(): signed-out visitors go to "/", and a
// workspace without a working Linear installation goes to /setup, before
// any view is read. A view that still fails with not_installed (the grant
// died mid-request) also lands on /setup via orSetup().

const logger = createLogger({ name: 'planner.load' });

type Installation = Awaited<ReturnType<Engine['getInstallation']>>;

/** The engine and signed-in actor (or null), once per request. */
export const getPageContext: () => Promise<RequestContext> =
  cache(getRequestContext);

/**
 * The sessions this browser holds (OAuth mode: the active cookie and the
 * stash, described in one store query), once per request. Holds session
 * tokens: never pass it, or anything copied from it but names and ids, to
 * a client component.
 */
export const loadHeldSessions: () => Promise<HeldSessions> =
  cache(getHeldSessions);

/** The workspace's installation row (tokens redacted), once per request. */
export const loadInstallation: (
  engine: Engine,
  workspaceId: string
) => Promise<Installation> = cache((engine: Engine, workspaceId: string) =>
  engine.getInstallation(workspaceId)
);

/**
 * The signed-in person this request reads for (§2.13: every view is
 * narrowed to what they may see). Pages resolve the actor first, so a
 * missing one is a bug, never a reason to read the whole mirror.
 */
export async function requestViewer(): Promise<Actor> {
  const { actor } = await getPageContext();
  if (actor === null) {
    throw new Error('A view was read without a signed-in person.');
  }
  return actor;
}

/** The timeline view model as the request's person sees it, once per request. */
export const loadTimelineView: (
  engine: Engine,
  workspaceId: string
) => ReturnType<Engine['getTimelineView']> = cache(
  async (engine: Engine, workspaceId: string) =>
    engine.getTimelineView(workspaceId, await requestViewer())
);

/** A person's My week view model, as the request's person sees it. */
export const loadWeekView: (
  engine: Engine,
  workspaceId: string,
  userId: string
) => ReturnType<Engine['getWeekView']> = cache(
  async (engine: Engine, workspaceId: string, userId: string) =>
    engine.getWeekView(workspaceId, userId, await requestViewer())
);

/**
 * The issue list (architecture §2.14) as the request's person sees it,
 * once per request. Keyed by the view's canonical /issues URL (a string:
 * cache() compares arguments by identity, so a query object would never
 * hit), which is parsed again here.
 */
export const loadIssueList: (
  engine: Engine,
  workspaceId: string,
  canonical: string
) => ReturnType<Engine['getIssueList']> = cache(
  async (engine: Engine, workspaceId: string, canonical: string) => {
    const at = canonical.indexOf('?');
    const query = parseIssueListSearch(
      at === -1 ? '' : canonical.slice(at + 1)
    );
    return engine.getIssueList(workspaceId, query, await requestViewer());
  }
);

/** True for an installation the app can use (present and not revoked). */
export function isInstalled(installation: Installation): boolean {
  return installation !== null && installation.revokedAt === null;
}

/** True for the engine's "this workspace has no working installation". */
export function isNotInstalledError(error: unknown): boolean {
  return engineAuthCode(error) === 'not_installed';
}

/**
 * True for api_key mode's "no workspace member has a key connected, so
 * nothing can read Linear" (a quiet state, not a failure to log).
 */
export function isNoReaderError(error: unknown): boolean {
  return engineAuthCode(error) === 'no_reader';
}

/**
 * For pages: the actor, or a redirect to the landing page carrying
 * `returnTo` (the page's own path and query), so signing in comes back to
 * it (a digest's deep link opened signed out, architecture §8.1).
 */
export async function requirePageActor(returnTo?: string): Promise<{
  engine: Engine;
  actor: Actor;
}> {
  const { engine, actor } = await getPageContext();
  if (actor === null) redirect(signInLocation(returnTo));
  return { engine, actor };
}

export interface InstalledContext {
  engine: Engine;
  actor: Actor;
  workspaceId: string;
  installation: NonNullable<Installation>;
}

/**
 * For every page that reads the workspace: signed out → "/", no working
 * installation (never installed, or Linear rejected the grant) → /setup,
 * carrying the workspace notices of `returnTo` (setupLocation: a sign-out,
 * connect or switch that leaves a workspace without one active still says
 * what happened).
 */
export async function requireInstalledActor(
  returnTo?: string
): Promise<InstalledContext> {
  const { engine, actor } = await requirePageActor(returnTo);
  const workspaceId = actor.session.workspaceId;
  const installation = await loadInstallation(engine, workspaceId);
  if (installation === null || installation.revokedAt !== null) {
    redirect(setupLocation(returnTo));
  }
  return { engine, actor, workspaceId, installation };
}

/**
 * Awaits a view and sends not_installed failures to /setup; every other
 * error propagates to the route's error.tsx.
 */
export async function orSetup<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isNotInstalledError(error)) redirect('/setup');
    throw error;
  }
}

/**
 * The sidebar/topbar data for a signed-in person. Reading the views must
 * never take the frame down: a failure is logged and the shell renders
 * without counts (the page itself then shows its error state).
 */
export async function loadShellFrame(
  engine: Engine,
  actor: Actor
): Promise<ShellFrame> {
  const workspaceId = actor.session.workspaceId;
  const installation = await loadInstallation(engine, workspaceId);
  const installed = isInstalled(installation);
  let timeline = null;
  let week = null;
  let loadFailed = false;
  if (installed) {
    try {
      [timeline, week] = await Promise.all([
        loadTimelineView(engine, workspaceId),
        loadWeekView(engine, workspaceId, actor.session.userId),
      ]);
    } catch (error) {
      loadFailed = true;
      if (!isNotInstalledError(error) && !isNoReaderError(error)) {
        logger.error('could not load the sidebar views', {
          workspaceId,
          userId: actor.session.userId,
          err: error,
        });
      }
    }
  }
  // OAuth mode only: api_key and demo mode hold one workspace, so the
  // frame gets no switcher (describeSessions answers nothing there).
  const oauth = engine.mode !== 'fixture' && engine.config.auth !== 'api_key';
  // Only names, ids and states: the frame goes to the browser, the
  // sessions' tokens never do.
  const held = oauth
    ? allHeld(await loadHeldSessions()).map((entry) => ({
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        workspaceUrlKey: entry.workspaceUrlKey,
        installed: entry.installed,
        revokedAt: entry.revokedAt,
        guest: entry.guest,
      }))
    : null;
  return buildShellFrame({
    appName: engine.config.appName,
    workspaceId,
    workspaceName:
      installation?.workspaceName ??
      held?.find((entry) => entry.workspaceId === workspaceId)?.workspaceName ??
      null,
    heldWorkspaces: held,
    connectHref: CONNECT_PATH,
    userName: actor.session.userName,
    readOnly: actor.readOnly,
    readOnlyReason: actor.readOnlyReason,
    apiKeyMode: engine.config.auth === 'api_key',
    installed,
    timeline,
    week,
    loadFailed,
  });
}
