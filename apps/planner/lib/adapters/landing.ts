import type { User } from '@better-tracker/core';

// Copy and rows for the landing page ("/"): what each ?auth_error code
// means in plain words, the demo-mode person picker, and the list of what
// the tool does (design doc §2, said concretely).

const AUTH_ERROR_MESSAGE: Record<string, string> = {
  access_denied:
    'Linear sign-in was cancelled, so nothing changed. Sign in again when you are ready.',
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
    'You are a guest in Linear, so the planner is read-only for you: you can look at everything Linear shows you, but not install the app, allow edits or change anything here.',
  fixture_only: 'Demo sign-in only works on a demo server.',
  invalid: 'Linear sent back a sign-in the planner could not use. Start again.',
  not_found: 'That demo person does not exist.',
  demo_inactive:
    'That demo person cannot sign in: they are deactivated in the demo workspace, or they are the app’s own user. Pick someone from the list.',
  session_secret:
    'This server is missing its SESSION_SECRET (or it is shorter than 32 characters), so it cannot sign anyone in. Whoever runs the deployment needs to set it.',
  linear_rate_limited:
    'Linear is rate-limiting the planner right now. Wait a minute and sign in again.',
  linear_unauthorized:
    'Linear refused the planner’s credentials. Whoever runs the deployment should check the Linear OAuth app settings.',
  internal: 'Something went wrong on the server. It was logged; try again.',
};

const CODE_PATTERN = /^[a-z_]{1,40}$/;

/**
 * The sentence for an ?auth_error code; null when there is none. Codes
 * come from the URL, so only known shapes are echoed back, and Linear API
 * failures without their own sentence share one.
 */
export function authErrorMessage(code: string | undefined): string | null {
  if (code === undefined || code === '') return null;
  if (!CODE_PATTERN.test(code)) {
    return 'Sign-in did not finish. Start again.';
  }
  const known = AUTH_ERROR_MESSAGE[code];
  if (known !== undefined) return known;
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

export interface DemoUserRow {
  id: string;
  name: string;
  email: string | null;
  /** The button's words: "Sign in as Ana". */
  action: string;
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
    .map((user) => {
      // First name from the full name: Linear's displayName is a handle.
      const first = user.name.trim().split(/\s+/)[0] ?? user.name;
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        action: `Sign in as ${first}`,
        label: user.guest === true ? DEMO_GUEST_LABEL : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export interface LandingFeature {
  key: string;
  title: string;
  body: string;
}

/** What the planner does, in the design doc's goal order. */
export const LANDING_FEATURES: readonly LandingFeature[] = [
  {
    key: '01',
    title: 'My week',
    body: 'Your open issues, grouped by milestone and sorted by due date with overdue first. An issue the planner gave you says why.',
  },
  {
    key: '02',
    title: 'Timeline',
    body: 'Every active project’s milestones on one date axis, with progress and risk. Anyone signed in drags a bar’s end to move that milestone’s target date in Linear, as themselves.',
  },
  {
    key: '03',
    title: 'Dependencies',
    body: 'Which issues and milestones block which, across projects, with chains that end in an unassigned or overdue issue marked.',
  },
  {
    key: '04',
    title: 'Allocation',
    body: 'Unassigned issues in a project’s next milestone go to the project lead, with a Linear comment saying why; ones still in Backlog move to Todo. Triage issues are never handed out, later milestones wait their turn, and a dry run comes first.',
  },
  {
    key: '05',
    title: 'Warnings',
    body: 'When a milestone due within a week is at risk, the project lead and the watchers hear about it once, in a daily Slack digest. Overdue milestones keep coming back until they are closed or re-dated.',
  },
  {
    key: '06',
    title: 'Rubric',
    body: 'A milestone counts when it has a target date, a “done means…” line, a project lead and at least one issue. Whatever is missing is shown, and a next milestone with a gap stops allocation for its project.',
  },
];
