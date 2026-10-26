'use client';

import { withWorkspaceParam } from '@better-tracker/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
} from 'react';

import { withStartWorkspace } from '../../../lib/oauth-links';

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

// The workspace a copied link names (`ws=<org id>`, architecture §7
// "Links that leave the app"): the frame's in OAuth and demo mode, where
// the proxy sends such a link through /open; undefined with personal API
// keys (one workspace, the proxy ignores `ws`) and outside the shell.
const LinkWorkspaceContext = createContext<string | undefined>(undefined);

/**
 * PlannerShell's provider: the workspace its frame shows, and whether the
 * links people copy from it name that workspace (`linksNameWorkspace`,
 * false with personal API keys).
 */
export function FrameWorkspaceProvider({
  workspaceId,
  linksNameWorkspace,
  children,
}: {
  workspaceId: string;
  linksNameWorkspace: boolean;
  children: ReactNode;
}) {
  return (
    <FrameWorkspaceContext.Provider value={workspaceId}>
      <LinkWorkspaceContext.Provider
        value={linksNameWorkspace ? workspaceId : undefined}
      >
        {children}
      </LinkWorkspaceContext.Provider>
    </FrameWorkspaceContext.Provider>
  );
}

/**
 * The absolute URL a "Copy link" action puts on the clipboard: `path` (a
 * planner path, or the page's own URL) on `origin`, with `ws=<org id>`
 * when the frame names its workspace. Keys repeat across workspaces
 * (Acme and Globex both have ENG-1), so a pasted link without it would
 * open the same key in whichever workspace that browser has active; with
 * it the proxy sends the link through /open, which opens it in the
 * workspace it names.
 */
export function shareableLink(
  path: string,
  origin: string,
  workspaceId: string | undefined
): string {
  const url = new URL(path, origin).toString();
  return workspaceId === undefined ? url : withWorkspaceParam(url, workspaceId);
}

/**
 * An OAuth start link ("Allow edits in Linear", "Install in Linear") for
 * this tab's frame: it names the workspace the tab shows, so the start
 * route refuses it with workspace_changed when the browser switched to
 * another in a second tab, instead of acting for that one
 * (lib/oauth-links.ts). Other links come back unchanged.
 */
export function useStartHref(): (href: string) => string {
  const workspaceId = useContext(FrameWorkspaceContext);
  return useCallback(
    (href: string) => withStartWorkspace(href, workspaceId),
    [workspaceId]
  );
}

/** shareableLink for this tab's frame and origin (every copy action). */
export function useShareableLink(): (path: string) => string {
  const workspaceId = useContext(LinkWorkspaceContext);
  return useCallback(
    (path: string) => shareableLink(path, window.location.origin, workspaceId),
    [workspaceId]
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
