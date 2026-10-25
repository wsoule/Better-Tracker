// The words for holding several workspaces in one browser (OAuth mode,
// owner decision 2026-10-25; architecture §8.4): switching, connecting
// another workspace, signing out of one, and the stale-tab guard. Plain
// strings and small functions, so the routes, the pages and the tests
// share one copy. Names come from the engine (describeSessions, the
// installation), never from a URL.

/** The connect page's and the landing's hint about which workspace
    Linear connects. */
export const CONNECT_HINT =
  'Linear connects the workspace you have open at linear.app. Open the one you want to add there first.';

/** The switcher's and the palette's connect row. */
export const CONNECT_LABEL = 'Connect another workspace';

/** The palette's hint for the connect row. */
export const CONNECT_PALETTE_HINT = 'Sign in with Linear';

/** "Sign out of all workspaces" (Settings → Status, /setup, the notice). */
export const SIGN_OUT_ALL_LABEL = 'Sign out of all workspaces';

/** The footer's sign-out with two or more workspaces held. */
export function signOutOfLabel(workspaceName: string): string {
  return `Sign out of ${workspaceName}`;
}

/** What a workspace is called when the engine has no name for it. */
export const UNNAMED_WORKSPACE = 'this workspace';

/** The codes POST /api/auth/switch refuses with. */
export type SwitchErrorCode =
  | 'unknown_workspace'
  | 'session_ended'
  | 'invalid_request';

/**
 * The sentence for a refused switch. `name` is the workspace's name when
 * the route knows it (the JSON answer); the pages that read
 * ?switch_error= have only the code and say "that workspace".
 */
export function switchErrorMessage(
  code: SwitchErrorCode,
  name: string | null = null
): string {
  switch (code) {
    case 'unknown_workspace':
      return 'This browser is not signed in to that workspace any more. Connect it again from the workspace menu.';
    case 'session_ended':
      return name === null
        ? 'Your session for that workspace ended. Connect it again from the workspace menu to switch to it.'
        : `Your session for ${name} ended. Connect ${name} again from the workspace menu to switch to it.`;
    case 'invalid_request':
      return 'That switch did not name a workspace. Pick one from the workspace menu.';
  }
}

/** The ?switch_error= value as a known code, else null. */
export function parseSwitchError(
  value: string | undefined
): SwitchErrorCode | null {
  return value === 'unknown_workspace' ||
    value === 'session_ended' ||
    value === 'invalid_request'
    ? value
    : null;
}

/** /week?connect=same: Linear connected a workspace this browser has. */
export function connectSameMessage(workspaceName: string): string {
  return `Linear connected ${workspaceName} again, which this browser already has. To add another workspace, open it at linear.app first, then choose Connect another workspace.`;
}

/**
 * /week?signed_out=1: one workspace signed out, another still active.
 * `signedOutName` is null when the signed notice value did not verify.
 */
export function signedOutOfMessage(
  signedOutName: string | null,
  stillName: string
): string {
  return signedOutName === null
    ? `Signed out. Still signed in to ${stillName}.`
    : `Signed out of ${signedOutName}. Still signed in to ${stillName}.`;
}

/** /week?signed_out=none: the sign-out named a workspace not held. */
export const SIGNED_OUT_NONE_MESSAGE =
  'This browser was not signed in to that workspace any more, so nothing was signed out.';

/** The signed-out landing's lead-in over the "Continue in" forms. */
export function continueListIntro(sessionEnded: boolean): string {
  return sessionEnded
    ? 'Your session for this workspace ended. This browser is still signed in to:'
    : 'This browser is still signed in to:';
}

/** A "Continue in <name>" button's words. */
export function continueInLabel(workspaceName: string): string {
  return `Continue in ${workspaceName}`;
}

/** The open interstitial when the browser holds the link's workspace. */
export function openHeldMessage(workspaceName: string): string {
  return `This link is for ${workspaceName}.`;
}

/** The open interstitial when the browser does not. */
export const OPEN_UNKNOWN_MESSAGE =
  'This link is for a Linear workspace this browser is not signed in to.';

/** The palette's and the interstitial's switch words. */
export function switchToLabel(workspaceName: string): string {
  return `Switch to ${workspaceName}`;
}

/** The switcher row's quiet hint for a held workspace. */
export function workspaceHint(entry: {
  installed: boolean;
  revokedAt: string | null;
  guest: boolean | null;
  workspaceUrlKey: string | null;
}): string | undefined {
  if (!entry.installed) return 'Not installed';
  if (entry.revokedAt !== null) return 'Reinstall needed';
  if (entry.guest === true) return 'Guest';
  return entry.workspaceUrlKey === null
    ? undefined
    : `linear.app/${entry.workspaceUrlKey}`;
}

/**
 * The 409 workspace_changed sentence (a tab still showing A after this
 * browser switched to B in another tab). `tabName` is null when the
 * browser no longer holds the tab's workspace.
 */
export function workspaceChangedMessage(
  tabName: string | null,
  activeName: string
): string {
  return tabName === null
    ? `This tab shows another workspace, but this browser switched to ${activeName} in another tab. Reload to continue in ${activeName}.`
    : `This tab shows ${tabName}, but this browser switched to ${activeName} in another tab. Reload to continue in ${activeName}, or switch back to ${tabName}.`;
}

/** The request header every api-client call names its tab's workspace in. */
export const WORKSPACE_HEADER = 'x-planner-workspace';

/** One notice /week shows after a workspace change. */
export interface WorkspaceNotice {
  id: 'connect_same' | 'signed_out' | 'signed_out_none' | 'switch_error';
  label: string;
  tone: 'default' | 'danger';
  message: string;
  /** Offer "Sign out of all workspaces" with it. */
  signOutAll: boolean;
}

/**
 * The notices /week shows from its query after a sign-in, switch or
 * sign-out (OAuth mode): ?connect=same, ?signed_out=1 (with `from`, the
 * signed name of the workspace signed out, which `verifiedName` checks:
 * null when it does not verify), ?signed_out=none and ?switch_error=<code>.
 * `workspaceName` is the active workspace's, from the engine. Unknown
 * values show nothing.
 */
export function weekWorkspaceNotices(input: {
  params: Readonly<Record<string, string | undefined>>;
  workspaceName: string;
  verifiedName: (value: string | undefined) => string | null;
}): WorkspaceNotice[] {
  const { params, workspaceName } = input;
  const notices: WorkspaceNotice[] = [];
  if (params.connect === 'same') {
    notices.push({
      id: 'connect_same',
      label: 'Already connected',
      tone: 'default',
      message: connectSameMessage(workspaceName),
      signOutAll: false,
    });
  }
  if (params.signed_out === '1') {
    notices.push({
      id: 'signed_out',
      label: 'Signed out',
      tone: 'default',
      message: signedOutOfMessage(
        input.verifiedName(params.from),
        workspaceName
      ),
      signOutAll: true,
    });
  } else if (params.signed_out === 'none') {
    notices.push({
      id: 'signed_out_none',
      label: 'Nothing signed out',
      tone: 'default',
      message: SIGNED_OUT_NONE_MESSAGE,
      signOutAll: false,
    });
  }
  const switchError = parseSwitchError(params.switch_error);
  if (switchError !== null) {
    notices.push({
      id: 'switch_error',
      label: 'Not switched',
      tone: 'danger',
      message: switchErrorMessage(switchError),
      signOutAll: false,
    });
  }
  return notices;
}

/** The query parameters of /week's workspace notices. */
const WEEK_NOTICE_PARAMS: readonly string[] = [
  'connect',
  'signed_out',
  'from',
  'switch_error',
];

/**
 * A page's search params without the notice ones, for the links it builds
 * from its own URL (a row's ?issue= link must not show the notice again).
 */
export function withoutNoticeParams<T>(
  params: Readonly<Record<string, T>>
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!WEEK_NOTICE_PARAMS.includes(key)) out[key] = value;
  }
  return out;
}
