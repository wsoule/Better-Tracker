import type { User } from '@better-tracker/core';

// Copy and rows for the landing page ("/"): what each ?auth_error code
// means in plain words, the demo-mode person picker, and the list of what
// the tool does (design doc §2, said concretely). With personal API keys
// (LINEAR_AUTH=api_key) the connect form's codes get their own sentences,
// and the list says what changes in that mode.

const AUTH_ERROR_MESSAGE: Record<string, string> = {
  access_denied:
    'Linear sign-in was cancelled or not granted. If your workspace needs an admin to approve apps, ask an admin to approve {app} in Linear’s settings, then try again.',
  oauth_expired:
    'The sign-in took longer than 10 minutes, or this browser lost its sign-in cookie. Start again.',
  oauth_state:
    'Linear answered a sign-in this browser did not start. Start again from this page.',
  oauth_code: 'Linear did not send an authorization code. Start again.',
  linear_error: 'Linear reported an error during sign-in. Start again.',
  invalid_request: 'That sign-in link is not one the planner offers.',
  sign_in_first:
    'Sign in first; installing the app and granting write access need a signed-in person.',
  not_signed_in:
    'This Linear account cannot sign in: it is deactivated, or it is an app user rather than a person.',
  wrong_workspace:
    'That install was for a different Linear workspace than the one you signed in with, or it did not grant app access. Start the install again from Setup.',
  not_installed:
    'The app is not installed in this workspace yet. A workspace admin installs it from Setup.',
  needs_write_scope:
    'Your Linear sign-in only allows reading. Sign in again and grant write access to edit dates, leads and issues.',
  read_only:
    'The planner is read-only for you: you are a guest in Linear, or the planner has not synced your Linear account yet. You can look at everything Linear shows you, but not install the app, allow edits or change anything here.',
  fixture_only: 'Demo sign-in only works on a demo server.',
  invalid: 'Linear sent back a sign-in the planner could not use. Start again.',
  not_found: 'That demo person does not exist.',
  demo_inactive:
    'That demo person cannot sign in: they are deactivated in the demo workspace, or they are the app’s own user. Pick someone from the list.',
  session_secret:
    'This server is missing its SESSION_SECRET (or it is shorter than 32 characters), so it cannot sign anyone in. Whoever runs the deployment needs to set it.',
  linear_rate_limited:
    'Linear is rate-limiting the planner right now. Wait a minute and sign in again.',
  // Several workspaces (owner decision 2026-10-25).
  workspace_not_allowed:
    'This planner is not open to that Linear workspace yet. Ask the person who runs it.',
  workspace_blocked:
    'This planner does not serve that Linear workspace: the person who runs it has blocked it.',
  grant_wrong_workspace:
    'Linear granted write access for another workspace than the one you were working in, so the planner did not keep it. Open that workspace at linear.app, then choose Allow edits again.',
  too_many_workspaces:
    'This browser is signed in to 10 workspaces, the most it holds. Sign out of a workspace first, then connect another.',
  linear_unauthorized:
    'Linear refused the planner’s credentials. Whoever runs the deployment should check the Linear OAuth app settings.',
  internal: 'Something went wrong on the server. It was logged; try again.',
};

/**
 * The connect form's codes (api_key mode, POST /api/auth/key) and the
 * sentences that differ from OAuth's there.
 */
const API_KEY_ERROR_MESSAGE: Record<string, string> = {
  invalid_request:
    'The connect form did not arrive complete. Paste your key again.',
  key_shape:
    'That does not look like a Linear personal API key (they start with lin_api_). Copy it again from Linear: Settings → Security & access → Personal API keys.',
  key_rejected:
    'Linear did not accept that key: it may be mistyped, revoked or expired. Create a new one in Linear and paste it.',
  key_cannot_read:
    'That key cannot read Linear. The planner needs a key with at least Read access (Read and Write to edit).',
  key_wrong_workspace:
    'That key belongs to a different Linear workspace from the one this planner serves.',
  guest_cannot_bind:
    'A member of the workspace has to connect first: a guest cannot choose the workspace this planner serves.',
  connect_rate_limited:
    'Too many tries from here in the last few minutes. Wait ten minutes, then paste your key again.',
  insecure_transport:
    'The key was sent over an unencrypted connection, so the planner refused it. Open the planner with https:// and try again.',
  key_capacity:
    'Too many people are connected to the planner right now. Try again later.',
  linear_unreachable:
    'Linear could not be reached to check the key. Try again in a minute.',
  linear_rate_limited:
    'Linear is rate-limiting this key right now. Wait a minute and try again.',
  not_signed_in:
    'That Linear account cannot connect: it is deactivated, or it is an app user rather than a person.',
  read_only:
    'The planner is read-only for you: you are a guest in Linear, your key only allows reading, or the planner has not synced your Linear account yet. You can look at everything Linear shows you, but not change anything here.',
  wrong_workspace:
    'That key belongs to a different Linear workspace from the one this planner serves.',
  not_installed:
    'This planner serves no Linear workspace yet: a workspace member connects their key first.',
};

/** The connect form's codes that refuse the key itself (its shape, or
    Linear's answer about it), as opposed to the server, the limits or
    the network: the field is then drawn as refused. */
const KEY_REFUSALS: ReadonlySet<string> = new Set([
  'key_shape',
  'key_rejected',
  'key_cannot_read',
  'key_wrong_workspace',
]);

/** Whether an ?auth_error code refused the pasted key itself. */
export function isKeyRefusal(code: string | undefined): boolean {
  return code !== undefined && KEY_REFUSALS.has(code);
}

const CODE_PATTERN = /^[a-z_]{1,40}$/;

/**
 * The sentence for an ?auth_error code; null when there is none. Codes
 * come from the URL, so only known shapes are echoed back, and Linear API
 * failures without their own sentence share one. `apiKeyMode` uses the
 * connect form's sentences first; `appName` is the app's name where a
 * sentence says it (default "Milestone Planner").
 */
export function authErrorMessage(
  code: string | undefined,
  options: { apiKeyMode?: boolean; appName?: string } = {}
): string | null {
  if (code === undefined || code === '') return null;
  if (!CODE_PATTERN.test(code)) {
    return options.apiKeyMode === true
      ? 'Connecting did not finish. Paste your key again.'
      : 'Sign-in did not finish. Start again.';
  }
  if (options.apiKeyMode === true) {
    const keyed = API_KEY_ERROR_MESSAGE[code];
    if (keyed !== undefined) return keyed;
  }
  const known = AUTH_ERROR_MESSAGE[code];
  if (known !== undefined) {
    return known.replace('{app}', options.appName ?? 'Milestone Planner');
  }
  if (code.startsWith('linear_')) {
    return 'Linear could not be reached or refused the request. Try again in a minute.';
  }
  return `Sign-in did not finish (${code}). Start again.`;
}

/** The first value of a search param ("?a=1&a=2" → "1"). */
export function firstParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Which sign-out notice "/" shows (api_key mode), from ?signed_out: "1"
 * when the planner forgot the key in every browser, "ended" when it could
 * not tell whose key it was (this browser's connection had already
 * ended), anything else none.
 */
export function signedOutNotice(
  value: string | undefined
): 'everywhere' | 'ended' | null {
  if (value === '1') return 'everywhere';
  if (value === 'ended') return 'ended';
  return null;
}

export interface DemoUserRow {
  id: string;
  name: string;
  email: string | null;
  /**
   * "Guest" for a Linear guest (Gus, in the demo), whom the planner shows
   * read-only (owner decision 2026-10-22, "Guests limited to read only");
   * null for everyone else.
   */
  label: string | null;
}

/** The picker's label for a Linear guest. */
export const DEMO_GUEST_LABEL = 'Guest';

/** What the guest label means, under the guest's name. */
export const DEMO_GUEST_NOTE = 'Guest in Linear · sees one team, read only';

/**
 * Demo people for the picker, by name. Nobody is set apart by role: there
 * are no roles (owner decision 2026-10-22), so every demo person sees the
 * same screens and edit controls, except a Linear guest, who is labelled
 * Guest and sees the planner read-only (that comes from Linear's own guest
 * flag, not a planner role). The engine already dropped app users and
 * deactivated people.
 */
export function demoUserRows(users: readonly User[]): DemoUserRow[] {
  return users
    .map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      label: user.guest === true ? DEMO_GUEST_LABEL : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export interface LandingFeature {
  /** A stable id (the landing page picks each card's icon by it). */
  key: string;
  title: string;
  body: string;
}

/** What the planner does, in the design doc's goal order. */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    key: 'my-week',
    title: 'My week',
    body: 'Your open issues, grouped by milestone and sorted by due date with overdue first. An issue the planner gave you says why.',
  },
  {
    key: 'timeline',
    title: 'Timeline',
    body: 'Every active project’s milestones on one date axis, with progress and risk. Anyone signed in drags a bar’s end to move that milestone’s target date in Linear, as themselves.',
  },
  {
    key: 'dependencies',
    title: 'Dependencies',
    body: 'Which issues and milestones block which, across projects, with chains that end in an unassigned or overdue issue marked.',
  },
  {
    key: 'allocation',
    title: 'Allocation',
    body: 'Unassigned issues in a project’s next milestone go to the project lead, with a Linear comment saying why; ones still in Backlog move to Todo. Triage issues are never handed out, later milestones wait their turn, and a dry run comes first.',
  },
  {
    key: 'warnings',
    title: 'Warnings',
    body: 'When a milestone due within a week is at risk, the project lead and the watchers hear about it once, in a daily Slack digest. Overdue milestones keep coming back until they are closed or re-dated.',
  },
  {
    key: 'rubric',
    title: 'Rubric',
    body: 'A milestone counts when it has a target date, a “done means…” line, a project lead and at least one issue. Whatever is missing is shown, and a next milestone with a gap stops allocation for its project.',
  },
];

/**
 * What the planner does, for the landing page: LANDING_FEATURES, or with
 * personal API keys (`apiKeyMode`) the same list with allocation run only
 * when someone starts it, warnings as a preview only, and "connect"
 * instead of "sign in" (owner request 2026-10-23).
 */
export function landingFeatures(options: {
  apiKeyMode: boolean;
}): readonly LandingFeature[] {
  if (!options.apiKeyMode) return LANDING_FEATURES;
  return LANDING_FEATURES.map((feature) => {
    switch (feature.key) {
      case 'timeline':
        return {
          ...feature,
          body: 'Every active project’s milestones on one date axis, with progress and risk. Anyone connected drags a bar’s end to move that milestone’s target date in Linear, as themselves.',
        };
      case 'allocation':
        return {
          ...feature,
          body: 'Unassigned issues in a project’s next milestone go to the project lead, with a Linear comment saying why; ones still in Backlog move to Todo. It runs when someone starts it, over what they can see, written as that person in Linear. Triage issues are never handed out, and a dry run comes first.',
        };
      case 'warnings':
        return {
          ...feature,
          body: 'Preview only: no digests are sent with personal API keys. Settings shows which milestones due within a week are at risk, and who would hear about them.',
        };
      default:
        return feature;
    }
  });
}
