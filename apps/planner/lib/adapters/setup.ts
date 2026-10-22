import { formatInstant } from '../format';

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
  key: string;
  title: string;
  body: string;
}[] = [
  {
    key: '01',
    title: 'Admin approves',
    body: 'A Linear workspace admin approves the app once, for the whole workspace. Anyone else can sign in, but only an admin can install.',
  },
  {
    key: '02',
    title: 'Pick teams',
    body: 'Linear asks which teams the app may see. The planner sees only those teams’ issues, projects and milestones; everything else stays invisible to it.',
  },
  {
    key: '03',
    title: 'Its own user',
    body: 'The app gets its own Linear user. Allocation comments come from that user; the date, lead and issue edits people make are made as each of them.',
  },
  {
    key: '04',
    title: 'First sync',
    body: 'The first full sync starts right after the install, and the timeline opens. Unless the deployment already names watchers, the installer becomes the first one: warned about every at-risk milestone, which anyone can change in Settings.',
  },
];
