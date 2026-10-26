// The links that start Linear OAuth for a tab's own workspace: "Allow
// edits in Linear" (intent=grant_write) and "Install in Linear"
// (intent=install). Both act for one workspace, and a browser holds
// several (owner decision 2026-10-25), so each link names the workspace
// the tab shows in `workspace=<org id>`; GET /api/auth/linear refuses it
// with workspace_changed when this browser has switched to another one
// since (architecture §8.1 "Start"). Plain strings, no imports: this
// module also runs in the browser (the timeline and issue list adapters,
// the api client's "Allow edits" toast action).

/** The start link's query parameter naming the tab's workspace. */
export const START_WORKSPACE_PARAM = 'workspace';

const START_PREFIX = '/api/auth/linear?';

/**
 * `href` with `workspace=<workspaceId>` when it is an OAuth start link
 * and a workspace is known; anything else comes back unchanged. An
 * existing `workspace` value is replaced.
 */
export function withStartWorkspace(
  href: string,
  workspaceId: string | null | undefined
): string {
  if (
    workspaceId === null ||
    workspaceId === undefined ||
    workspaceId === '' ||
    !href.startsWith(START_PREFIX)
  ) {
    return href;
  }
  const params = new URLSearchParams(href.slice(START_PREFIX.length));
  params.set(START_WORKSPACE_PARAM, workspaceId);
  return `${START_PREFIX}${params.toString()}`;
}

/**
 * The grant_write link (offered to everyone signed in but a guest, owner
 * decisions 2026-10-21 and 2026-10-22), coming back to `returnTo` (a
 * relative path; the start route sanitises it again), for the workspace
 * `workspaceId` names when given.
 */
export function grantWriteHref(
  returnTo: string = '/week',
  workspaceId?: string | null
): string {
  return withStartWorkspace(
    `${START_PREFIX}intent=grant_write&returnTo=${encodeURIComponent(returnTo)}`,
    workspaceId
  );
}

/** The install link (Setup's "Install in Linear"), for `workspaceId`. */
export function installHref(workspaceId?: string | null): string {
  return withStartWorkspace(`${START_PREFIX}intent=install`, workspaceId);
}
