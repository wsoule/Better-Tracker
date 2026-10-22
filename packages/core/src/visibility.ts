// Per-viewer visibility (§2.13). The mirror is read with the app's token,
// which sees every team the admin granted at install, private ones too.
// A person may see only what Linear would show them: a workspace member
// sees every public team plus the private teams they belong to (and the
// restricted sub-teams inside those); a guest sees only the teams they
// belong to, and no initiatives. Everything a person is shown goes through
// visibleSnapshot (the engine applies it in one place); the worker's own
// jobs (allocation, warnings to leads and watchers) keep the whole mirror.

import { indexWorkspace } from './snapshot';
import type {
  Digest,
  DigestItem,
  Issue,
  Project,
  Snapshot,
  Team,
} from './types';

/** What one person may see of a workspace's mirror. */
export interface ViewerScope {
  userId: string;
  /**
   * A Linear guest, or someone the mirror does not know (treated the
   * same): only the teams they belong to, no initiatives.
   */
  guest: boolean;
  /** Ids of the mirrored teams the viewer may see. */
  teamIds: ReadonlySet<string>;
  /** Every mirrored team is visible and the viewer is no guest. */
  everything: boolean;
}

/** Longest parent chain followed (Linear nests teams five levels deep). */
const MAX_TEAM_DEPTH = 10;

function isMember(team: Team, userId: string): boolean {
  return team.memberIds?.includes(userId) === true;
}

// A restricted team is visible to the members of its private boundary:
// the team itself or any ancestor up to the nearest private one.
function inPrivateBoundary(
  snapshot: Snapshot,
  team: Team,
  userId: string
): boolean {
  let parentId = team.parentId ?? null;
  for (let depth = 0; parentId !== null && depth < MAX_TEAM_DEPTH; depth++) {
    const parent = snapshot.teams.get(parentId);
    if (parent === undefined) return false;
    if (isMember(parent, userId)) return true;
    if (parent.visibility === 'private') return false;
    parentId = parent.parentId ?? null;
  }
  return false;
}

/**
 * The teams `userId` may see, by Linear's rules: a member of a team always
 * sees it; otherwise a guest sees nothing, and a workspace member sees
 * `public` teams and `restricted` ones inside a private boundary they
 * belong to. A team without a known visibility (a mirror written before it
 * was read) is visible to its members only, so an old mirror fails closed.
 */
export function viewerScope(snapshot: Snapshot, userId: string): ViewerScope {
  const user = snapshot.users.get(userId);
  const guest = user === undefined || user.guest === true;
  const teamIds = new Set<string>();
  for (const team of snapshot.data.teams) {
    if (isMember(team, userId)) {
      teamIds.add(team.id);
    } else if (guest) {
      continue;
    } else if (team.visibility === 'public') {
      teamIds.add(team.id);
    } else if (
      team.visibility === 'restricted' &&
      inPrivateBoundary(snapshot, team, userId)
    ) {
      teamIds.add(team.id);
    }
  }
  return {
    userId,
    guest,
    teamIds,
    everything: !guest && teamIds.size === snapshot.teams.size,
  };
}

/** A project is visible when one of its teams is. */
export function scopeSeesProject(
  scope: ViewerScope,
  project: Project
): boolean {
  if (scope.everything) return true;
  return project.teamIds.some((teamId) => scope.teamIds.has(teamId));
}

/**
 * An issue is visible when its team is, and its project (if mirrored) is
 * too, so a view never holds an issue whose project it cannot show.
 */
export function scopeSeesIssue(
  snapshot: Snapshot,
  scope: ViewerScope,
  issue: Issue
): boolean {
  if (scope.everything) return true;
  if (!scope.teamIds.has(issue.teamId)) return false;
  if (issue.projectId === null) return true;
  const project = snapshot.projects.get(issue.projectId);
  return project === undefined || scopeSeesProject(scope, project);
}

/**
 * The mirror as the viewer may see it (§2.13), re-indexed: hidden teams
 * with their workflow states, projects with their milestones, issues, and
 * every relation with a hidden end are left out; a guest also gets no
 * initiatives. Users stay (names of people are not team data). Returns the
 * snapshot itself when the viewer sees everything.
 */
export function visibleSnapshot(
  snapshot: Snapshot,
  scope: ViewerScope
): Snapshot {
  if (scope.everything) return snapshot;
  const { data } = snapshot;
  const projects = data.projects
    .filter((project) => scopeSeesProject(scope, project))
    .map((project) =>
      scope.guest && project.initiativeIds.length > 0
        ? { ...project, initiativeIds: [] }
        : project
    );
  const projectIds = new Set(projects.map((project) => project.id));
  const issues = data.issues.filter((issue) =>
    scopeSeesIssue(snapshot, scope, issue)
  );
  const issueIds = new Set(issues.map((issue) => issue.id));
  return indexWorkspace({
    workspaceId: data.workspaceId,
    users: data.users,
    teams: data.teams.filter((team) => scope.teamIds.has(team.id)),
    states: data.states.filter((state) => scope.teamIds.has(state.teamId)),
    initiatives: scope.guest ? [] : data.initiatives,
    projects,
    milestones: data.milestones.filter((m) => projectIds.has(m.projectId)),
    issues,
    relations: data.relations.filter(
      (r) => issueIds.has(r.blockerId) && issueIds.has(r.blockedId)
    ),
  });
}

// One digest item as the viewer may see it: the open issues it names are
// narrowed to the visible ones (its counts and lines name nothing).
function visibleItem(
  snapshot: Snapshot,
  scope: ViewerScope,
  item: DigestItem
): DigestItem {
  if (scope.everything || item.openIssues === undefined) return item;
  const openIssues = item.openIssues.filter((named) => {
    const issue = snapshot.issues.get(named.id);
    return issue !== undefined && scopeSeesIssue(snapshot, scope, issue);
  });
  return openIssues.length === item.openIssues.length
    ? item
    : { ...item, openIssues };
}

/**
 * A digest as the viewer may see it: items about a project they cannot
 * see are dropped, and each item names only the open issues they can see.
 * Used for the digests people receive (each with its recipient's scope)
 * and for the Settings preview (with the previewing person's scope).
 */
export function visibleDigest(
  snapshot: Snapshot,
  scope: ViewerScope,
  digest: Digest
): Digest {
  if (scope.everything) return digest;
  const items: DigestItem[] = [];
  for (const item of digest.items) {
    const project = snapshot.projects.get(item.notice.projectId);
    if (project === undefined || !scopeSeesProject(scope, project)) continue;
    items.push(visibleItem(snapshot, scope, item));
  }
  return { ...digest, items };
}
