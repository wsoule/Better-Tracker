import { formatInstant } from '../format';

/** Why an installation was revoked (engine RevokedReason). */
export type SetupRevokedReason = 'uninstalled' | 'removed' | 'grant_dead';

// /setup's mapping: which of the three states the workspace is in, and
// the facts shown for an installation (architecture §8.1 /setup, §7.1:
// `revokedAt` means "the app has no working Linear grant").

/** The installation fields the page reads (tokens never reach it). */
export interface SetupInstallation {
  workspaceName: string;
  urlKey: string;
  installedByUserId: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SetupState = 'installed' | 'revoked' | 'not_installed';

export function setupState(installation: SetupInstallation | null): SetupState {
  if (installation === null) return 'not_installed';
  return installation.revokedAt === null ? 'installed' : 'revoked';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Nov 24, 2026": a calendar day in `timeZone`. */
function formatDay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(date);
}

/**
 * The /setup notice for a revoked installation, by why it was revoked
 * (owner decision 2026-10-25): an admin uninstalled the app in Linear, the
 * person who runs the planner removed the workspace, or Linear refused the
 * app's token (also any revoke from before the reason was recorded). The
 * first two are deleted `purgeAfterDays` after the revoke unless someone
 * reinstalls, and the notice says when; a refused token is never deleted
 * on its own. Every reason can be fixed by a reinstall (a blocked
 * workspace never gets this far: its sign-in is refused).
 */
export function revokedNotice(input: {
  reason: SetupRevokedReason | null;
  revokedAt: string;
  workspaceName: string;
  timeZone: string;
  purgeAfterDays: number;
}): string {
  const when = formatDay(input.revokedAt, input.timeZone);
  const purgeOn = formatDay(
    new Date(
      Date.parse(input.revokedAt) + input.purgeAfterDays * DAY_MS
    ).toISOString(),
    input.timeZone
  );
  const stopped =
    'Until a workspace admin reinstalls it, nothing syncs, nothing is allocated and no warnings go out.';
  const deleted = `Its data is deleted on ${purgeOn} unless someone reinstalls.`;
  switch (input.reason) {
    case 'uninstalled':
      return `An admin uninstalled the app in Linear on ${when}. ${deleted} ${stopped}`;
    case 'removed':
      return `The person who runs this planner removed ${input.workspaceName} on ${when}. ${deleted} ${stopped}`;
    default:
      return `Linear refused the app’s token for ${input.workspaceName} on ${when}. ${stopped}`;
  }
}

export interface SetupFact {
  id: string;
  label: string;
  value: string;
}

/**
 * The property list for an installed workspace: which workspace, who
 * installed it and when, and when it was last reinstalled (only when that
 * differs from the first install).
 */
export function installationFacts(
  installation: SetupInstallation,
  installerName: string | null,
  timeZone: string
): SetupFact[] {
  const facts: SetupFact[] = [
    {
      id: 'workspace',
      label: 'Workspace',
      value: `${installation.workspaceName} · linear.app/${installation.urlKey}`,
    },
    {
      id: 'installer',
      label: 'Installed by',
      value: installerName ?? 'A workspace admin',
    },
    {
      id: 'installed',
      label: 'Installed',
      value: formatInstant(installation.createdAt, timeZone),
    },
  ];
  if (installation.updatedAt !== installation.createdAt) {
    facts.push({
      id: 'updated',
      label: 'Last reinstalled',
      value: formatInstant(installation.updatedAt, timeZone),
    });
  }
  return facts;
}

/** What installing does, in order (shown before the install button). */
export const INSTALL_STEPS: readonly {
  /** A stable id, never shown (the steps are numbered by their order). */
  key: string;
  title: string;
  body: string;
}[] = [
  {
    key: 'admin-approves',
    title: 'Admin approves',
    body: 'A Linear workspace admin approves the app once, for the whole workspace. Anyone else can sign in, but only an admin can install.',
  },
  {
    key: 'pick-teams',
    title: 'Pick teams',
    body: 'Linear asks which teams the app may see. The planner sees only those teams’ issues, projects and milestones; everything else stays invisible to it.',
  },
  {
    key: 'app-user',
    title: 'Its own user',
    body: 'The app gets its own Linear user. Allocation comments come from that user; the date, lead and issue edits people make are made as each of them.',
  },
  {
    key: 'first-sync',
    title: 'First sync',
    body: 'The first full sync starts right after the install, and the timeline opens. The installer becomes the first watcher. Watchers hear about every at-risk milestone, and anyone can change who they are in Settings.',
  },
];
