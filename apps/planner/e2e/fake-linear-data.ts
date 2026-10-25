// The organizations the e2e's fake Linear serves (fake-linear.ts builds
// their Linear nodes from this). Plain data with no imports, so a
// Playwright spec can load it (and linear-authorize.ts) at runtime: the
// test runner cannot load the workspace packages the node builders use.
//
// - Acme (org-acme, urlKey acme): the api-key suite's workspace, exactly
//   as it always was. Ana, Ben and Chloe are members, Gus a guest. Teams
//   Platform (ENG, public: Ana, Ben, Chloe, and Gus as a guest member),
//   Mobile (MOB, public: Ben only) and Security (SEC, private: Ana only);
//   two issues per team; ENG-1 blocks ENG-2. Ana is its admin.
// - Globex (org-globex, urlKey globex): a second full workspace for the
//   OAuth suite's workspace switcher. Every id starts with `gx-`, so no
//   id is shared with Acme, while the keys repeat on purpose (Globex has
//   its own ENG-1, with another title). Gia and Hal are members, Gia its
//   admin; Ana is a GUEST here, under another Linear user id but the same
//   email as in Acme; Ben is not in Globex at all. Teams Storefront (ENG,
//   public: Gia, Hal, and Ana as a guest member) and Operations (OPS,
//   private: Gia only); ENG-1 blocks ENG-2, and OPS-1 blocks ENG-2 (only
//   Gia sees that one, since a relation shows only when both ends do).
//
// Each org also has an app user, the identity an actor=app (install)
// token acts as. Admins are kept apart from the user nodes (the gateway
// never selects User.admin): only an admin may approve an install.

/** The organizations the fake serves, by URL key. */
export type FakeOrgKey = 'acme' | 'globex';

/** One person in one organization. */
export interface FakePerson {
  /** Their Linear user id in this organization. */
  id: string;
  /** What tests call them ('ana'), also their Linear displayName. */
  handle: string;
  name: string;
  /** Defaults to `<id>@example.com`, the linear test builder's. */
  email?: string;
  guest?: boolean;
}

export interface FakeTeam {
  id: string;
  key: string;
  name: string;
  visibility: 'public' | 'private';
  members: string[];
}

/** One organization's fixed data (fake-linear.ts keeps what edits change). */
export interface FakeOrg {
  key: FakeOrgKey;
  organization: { id: string; name: string; urlKey: string };
  /**
   * Prefix of every id the fake derives (projects, milestones, issues,
   * states, comments): '' for Acme, whose ids the api-key suite knows.
   */
  idPrefix: string;
  /** The people, in the order Linear's users connection lists them. */
  people: FakePerson[];
  /** Who approves when a test names nobody (a handle). */
  defaultPerson: string;
  /** The app user an actor=app token acts as. */
  appUser: { id: string; handle: string; name: string };
  /** User ids that may approve an actor=app install (Linear admins). */
  admins: readonly string[];
  teams: FakeTeam[];
  /** Issues in order: [team key, team id, assignee id, title], numbered per team. */
  issues: [string, string, string, string][];
  /** "blocks" relations: [relation id, blocker issue id, blocked issue id]. */
  relations: [string, string, string][];
}

const APP_USER_NAME = 'Milestone Planner';

export const ACME: FakeOrg = {
  key: 'acme',
  organization: { id: 'org-acme', name: 'Acme', urlKey: 'acme' },
  idPrefix: '',
  people: [
    { id: 'user-ana', handle: 'ana', name: 'Ana Ruiz' },
    { id: 'user-ben', handle: 'ben', name: 'Ben Ortiz' },
    { id: 'user-chloe', handle: 'chloe', name: 'Chloe Kim' },
    { id: 'user-gus', handle: 'gus', name: 'Gus Hart', guest: true },
  ],
  defaultPerson: 'ana',
  appUser: {
    id: 'user-acme-app',
    handle: 'milestone-planner',
    name: APP_USER_NAME,
  },
  admins: ['user-ana'],
  teams: [
    {
      id: 'team-eng',
      key: 'ENG',
      name: 'Platform',
      visibility: 'public',
      members: ['user-ana', 'user-ben', 'user-chloe', 'user-gus'],
    },
    {
      id: 'team-mob',
      key: 'MOB',
      name: 'Mobile',
      visibility: 'public',
      members: ['user-ben'],
    },
    {
      id: 'team-sec',
      key: 'SEC',
      name: 'Security',
      visibility: 'private',
      members: ['user-ana'],
    },
  ],
  issues: [
    ['ENG', 'team-eng', 'user-ana', 'Ship the billing export'],
    ['ENG', 'team-eng', 'user-chloe', 'Retire the old cron'],
    ['MOB', 'team-mob', 'user-ben', 'Offline mode for the app'],
    ['MOB', 'team-mob', 'user-ben', 'Push notification settings'],
    ['SEC', 'team-sec', 'user-ana', 'Rotate the signing keys'],
    ['SEC', 'team-sec', 'user-ana', 'Audit admin sessions'],
  ],
  relations: [['rel-1', 'iss-eng-1', 'iss-eng-2']],
};

export const GLOBEX: FakeOrg = {
  key: 'globex',
  organization: { id: 'org-globex', name: 'Globex', urlKey: 'globex' },
  idPrefix: 'gx-',
  people: [
    {
      id: 'gx-user-gia',
      handle: 'gia',
      name: 'Gia Moreau',
      email: 'gia@globex.example',
    },
    {
      id: 'gx-user-hal',
      handle: 'hal',
      name: 'Hal Brandt',
      email: 'hal@globex.example',
    },
    // The same person as Acme's Ana (same email), a guest here.
    {
      id: 'gx-user-ana',
      handle: 'ana',
      name: 'Ana Ruiz',
      email: 'user-ana@example.com',
      guest: true,
    },
  ],
  defaultPerson: 'ana',
  appUser: {
    id: 'gx-user-app',
    handle: 'milestone-planner',
    name: APP_USER_NAME,
  },
  admins: ['gx-user-gia'],
  teams: [
    {
      id: 'gx-team-eng',
      key: 'ENG',
      name: 'Storefront',
      visibility: 'public',
      members: ['gx-user-gia', 'gx-user-hal', 'gx-user-ana'],
    },
    {
      id: 'gx-team-ops',
      key: 'OPS',
      name: 'Operations',
      visibility: 'private',
      members: ['gx-user-gia'],
    },
  ],
  issues: [
    ['ENG', 'gx-team-eng', 'gx-user-gia', 'Launch the Globex storefront'],
    ['ENG', 'gx-team-eng', 'gx-user-hal', 'Take card payments at checkout'],
    ['OPS', 'gx-team-ops', 'gx-user-gia', 'Rotate the on-call schedule'],
    ['OPS', 'gx-team-ops', 'gx-user-gia', 'Move backups to cold storage'],
  ],
  relations: [
    ['gx-rel-1', 'gx-iss-eng-1', 'gx-iss-eng-2'],
    ['gx-rel-2', 'gx-iss-ops-1', 'gx-iss-eng-2'],
  ],
};

/** Every organization the fake serves, by URL key. */
export const FAKE_ORGS: Readonly<Record<FakeOrgKey, FakeOrg>> = {
  acme: ACME,
  globex: GLOBEX,
};

export function isFakeOrgKey(value: unknown): value is FakeOrgKey {
  return typeof value === 'string' && Object.hasOwn(FAKE_ORGS, value);
}

/** The org for a URL key (or org id), or null when the fake has none. */
export function fakeOrg(keyOrId: string): FakeOrg | null {
  return (
    Object.values(FAKE_ORGS).find(
      (org) => org.key === keyOrId || org.organization.id === keyOrId
    ) ?? null
  );
}

/**
 * The person a handle ('ana') or user id names in `org`, or null when
 * they are not in that org (Ben in Globex).
 */
export function fakePerson(
  org: FakeOrg,
  handleOrId: string
): FakePerson | null {
  return (
    org.people.find(
      (person) => person.handle === handleOrId || person.id === handleOrId
    ) ?? null
  );
}

/** The handle tests know a user id by in `org` ('app' for the app user). */
export function fakeHandleOf(org: FakeOrg, userId: string): string {
  if (userId === org.appUser.id) return 'app';
  return org.people.find((person) => person.id === userId)?.handle ?? userId;
}
