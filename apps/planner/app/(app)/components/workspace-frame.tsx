'use client';

import { createContext, type ReactNode, useContext, useEffect } from 'react';

// The navigation guard against stale tabs (owner decision 2026-10-25: a
// browser holds several workspaces; architecture §8.1 "Stale tabs"). The
// (app) layout renders the shell frame once per full page load and never
// again on client navigation, so a tab left on workspace A after the
// browser switched to B in another tab would render B's next page inside
// A's sidebar. Every page renders its own request's workspace id
// (WorkspaceGuard, a server component), and this compares it with the
// frame's: when they differ, the tab reloads. Nothing can be lost by it,
// since a navigation just happened.

// The frame's workspace id inside the signed-in shell; undefined outside
// it (the signed-out frame, which has nothing to guard).
const FrameWorkspaceContext = createContext<string | undefined>(undefined);

/** PlannerShell's provider: the workspace its frame shows. */
export function FrameWorkspaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  return (
    <FrameWorkspaceContext.Provider value={workspaceId}>
      {children}
    </FrameWorkspaceContext.Provider>
  );
}

/**
 * Whether a page whose request read `pageWorkspaceId` (null: signed out)
 * must reload the tab: only inside a signed-in frame that shows another
 * workspace.
 */
export function shouldReload(
  frameWorkspaceId: string | undefined,
  pageWorkspaceId: string | null
): boolean {
  return frameWorkspaceId !== undefined && frameWorkspaceId !== pageWorkspaceId;
}

/** Reloads the tab when the page's workspace is not the frame's. */
export function WorkspaceGuardClient({
  workspaceId,
}: {
  workspaceId: string | null;
}): null {
  const frameWorkspaceId = useContext(FrameWorkspaceContext);
  useEffect(() => {
    if (shouldReload(frameWorkspaceId, workspaceId)) window.location.reload();
  }, [frameWorkspaceId, workspaceId]);
  return null;
}
