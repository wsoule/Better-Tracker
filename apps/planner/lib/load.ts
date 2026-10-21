import type { Actor, Engine } from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { buildShellFrame, type ShellFrame } from './adapters/shell';
import { engineAuthCode } from './engine-errors';
import { getRequestContext, type RequestContext } from './session';

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

/** The workspace's installation row (tokens redacted), once per request. */
export const loadInstallation: (
  engine: Engine,
  workspaceId: string
) => Promise<Installation> = cache((engine: Engine, workspaceId: string) =>
  engine.getInstallation(workspaceId)
);

/** The timeline view model, once per request. */
export const loadTimelineView: (
  engine: Engine,
  workspaceId: string
) => ReturnType<Engine['getTimelineView']> = cache(
  (engine: Engine, workspaceId: string) => engine.getTimelineView(workspaceId)
);

/** A person's My week view model, once per request. */
export const loadWeekView: (
  engine: Engine,
  workspaceId: string,
  userId: string
) => ReturnType<Engine['getWeekView']> = cache(
  (engine: Engine, workspaceId: string, userId: string) =>
    engine.getWeekView(workspaceId, userId)
);

/** True for an installation the app can use (present and not revoked). */
export function isInstalled(installation: Installation): boolean {
  return installation !== null && installation.revokedAt === null;
}

/** True for the engine's "this workspace has no working installation". */
export function isNotInstalledError(error: unknown): boolean {
  return engineAuthCode(error) === 'not_installed';
}

/** For pages: the actor, or a redirect to the landing page. */
export async function requirePageActor(): Promise<{
  engine: Engine;
  actor: Actor;
}> {
  const { engine, actor } = await getPageContext();
  if (actor === null) redirect('/');
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
 * installation (never installed, or Linear rejected the grant) → /setup.
 */
export async function requireInstalledActor(): Promise<InstalledContext> {
  const { engine, actor } = await requirePageActor();
  const workspaceId = actor.session.workspaceId;
  const installation = await loadInstallation(engine, workspaceId);
  if (installation === null || installation.revokedAt !== null) {
    redirect('/setup');
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
      if (!isNotInstalledError(error)) {
        logger.error('could not load the sidebar views', {
          workspaceId,
          userId: actor.session.userId,
          err: error,
        });
      }
    }
  }
  return buildShellFrame({
    appName: engine.config.appName,
    workspaceName: installation?.workspaceName ?? null,
    userName: actor.session.userName,
    isPm: actor.isPm,
    installed,
    timeline,
    week,
    loadFailed,
  });
}
