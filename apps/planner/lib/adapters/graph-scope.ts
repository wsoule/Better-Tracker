import {
  DEFAULT_GRAPH_LEVEL,
  findIssue,
  GRAPH_LEVELS_WITHIN,
  type GraphContainer,
  graphContainer,
  type GraphLevel,
  type GraphScope,
  graphScopeFor,
  homeInitiativeIds,
  NO_INITIATIVE_ID,
  type Snapshot,
} from '@better-tracker/core';
import type { NavTabItem, ShellCrumb } from '@better-tracker/ui';

// The /graph URL vocabulary (architecture §8.1, §8.4 "Graph"): reading a
// graph scope from the query string, writing the canonical URL of a scope,
// the drill-up trail and the level tabs. Pure functions; the timeline,
// projects and issue adapters import their graph links from here so every
// page writes the same URLs.

/** Where the graph lives. */
export const GRAPH_PATH = '/graph';

/** At most this many characters of an id from the URL reach the engine. */
export const MAX_ID_LENGTH = 200;

/**
 * The most a graph draws (§11.2): about 0.45 s of layout at 200 boxes and
 * 300 arrows. Past either, the page shows "Too many to draw" and narrower
 * graphs instead of a partial drawing that would hide risk.
 */
export const GRAPH_DRAW_LIMITS: {
  readonly nodes: number;
  readonly edges: number;
} = { nodes: 200, edges: 300 };

/** Rows of the "no blocking relations" register before it is cut. */
export const ISOLATED_MAX_ROWS = 100;

/** Rows of the too-large state's "Narrow to" register. */
export const NARROW_MAX_ROWS = 50;

/** Each level's tab and block-bar name. */
export const GRAPH_LEVEL_LABEL: Readonly<Record<GraphLevel, string>> = {
  initiative: 'Initiatives',
  project: 'Projects',
  milestone: 'Milestones',
  issue: 'Issues',
};

type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a parameter, trimmed; null when blank or too long. */
function pickParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const id = raw.trim();
  return id === '' || id.length > MAX_ID_LENGTH ? null : id;
}

/** ?level= read leniently: any case, a trailing "s" dropped ("Issues"). */
function parseLevel(value: string | string[] | undefined): GraphLevel | null {
  const raw = pickParam(value)?.toLowerCase();
  if (raw === undefined) return null;
  const singular = raw.endsWith('s') ? raw.slice(0, -1) : raw;
  return isGraphLevel(singular) ? singular : null;
}

/** One of the four levels. An own key only: `in` would also accept
    Object.prototype's names ("constructor", "__proto__", "toString"). */
function isGraphLevel(value: string): value is GraphLevel {
  return Object.hasOwn(GRAPH_LEVEL_LABEL, value);
}

/**
 * The graph a /graph URL asks for, and the box to select on arrival.
 * The narrowest container wins (?chain= > ?milestone= > ?project= >
 * ?initiative=, else the whole workspace), which keeps today's "?milestone
 * wins over ?project". ?level= is used only when that container offers it,
 * otherwise the container's default level applies (a bad level never 404s).
 * Ids are passed through as given: the engine checks them, and a chain may
 * name its issue by identifier ("ENG-24").
 */
export function parseGraphParams(params: SearchParams): {
  scope: GraphScope;
  nodeId: string | null;
} {
  const chain = pickParam(params.chain);
  const milestone = pickParam(params.milestone);
  const project = pickParam(params.project);
  const initiative = pickParam(params.initiative);
  const container: GraphContainer =
    chain !== null
      ? { kind: 'chain', id: chain }
      : milestone !== null
        ? { kind: 'milestone', id: milestone }
        : project !== null
          ? { kind: 'project', id: project }
          : initiative !== null
            ? { kind: 'initiative', id: initiative }
            : { kind: 'workspace' };
  const level = parseLevel(params.level) ?? undefined;
  return {
    scope: graphScopeFor(container, level),
    nodeId: pickParam(params.node),
  };
}

/** The graph's scope as read from the URL (parseGraphParams without ?node=). */
export function parseGraphScope(params: SearchParams): GraphScope {
  return parseGraphParams(params).scope;
}

/**
 * The canonical /graph URL of a scope: the container parameter first, then
 * ?level= only when it is not the container's default, then ?node=. A chain
 * is written with whatever its scope carries (the engine's resolved scope
 * carries the issue id); planner links to a chain use chainHref with the
 * identifier instead.
 */
export function graphHref(
  scope: GraphScope,
  options: { node?: string | null } = {}
): string {
  const container = graphContainer(scope);
  const parts: string[] = [];
  switch (container.kind) {
    case 'workspace':
      break;
    case 'initiative':
      parts.push(`initiative=${encodeURIComponent(container.id)}`);
      break;
    case 'project':
      parts.push(`project=${encodeURIComponent(container.id)}`);
      break;
    case 'milestone':
      parts.push(`milestone=${encodeURIComponent(container.id)}`);
      break;
    case 'chain':
      parts.push(`chain=${encodeURIComponent(container.id)}`);
      break;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  if (scope.level !== DEFAULT_GRAPH_LEVEL[container.kind]) {
    parts.push(`level=${scope.level}`);
  }
  const node = options.node ?? null;
  if (node !== null) parts.push(`node=${encodeURIComponent(node)}`);
  return parts.length === 0 ? GRAPH_PATH : `${GRAPH_PATH}?${parts.join('&')}`;
}

/** One issue's blocking chain, by identifier ("/graph?chain=ENG-24"). */
export function chainHref(key: string): string {
  return graphHref({ level: 'issue', issueId: key });
}

/**
 * The graph of one initiative group, for the group links of the timeline
 * and the projects register (§8.4): its projects
 * (`/graph?initiative=<id|none>`), or the workspace's projects
 * (`/graph?level=project`) when the viewer has no initiatives (a guest, or
 * a workspace without them), which is what such a viewer gets for any
 * initiative anyway.
 */
export function initiativeGraphHref(
  groupId: string,
  hasInitiatives: boolean
): string {
  return hasInitiatives
    ? graphHref({ level: 'project', initiativeId: groupId })
    : graphHref({ level: 'project' });
}

/** "Platform reliability", or "No initiative" for NO_INITIATIVE_ID. */
export function initiativeName(snapshot: Snapshot, id: string): string {
  if (id === NO_INITIATIVE_ID) return 'No initiative';
  return snapshot.initiatives.get(id)?.name ?? 'Unknown initiative';
}

/**
 * The drill-up trail above the heading (§8.1 of the graph spec):
 * Workspace › first initiative › project › milestone › issue key, built
 * from the viewer's mirror, empty for the four workspace levels. Missing
 * levels are skipped (an issue with no milestone reads "… › Atlas ›
 * ENG-18"), and the initiative crumb is left out when the viewer has no
 * initiatives (guests). Each ancestor links to itself at its natural level,
 * one below it, so drilling up zooms out; the last crumb is the page.
 */
export function graphTrail(
  snapshot: Snapshot,
  scope: GraphScope
): ShellCrumb[] {
  const container = graphContainer(scope);
  const hasInitiatives = snapshot.initiatives.size > 0;
  let initiativeId: string | null = null;
  let projectId: string | null = null;
  let milestoneId: string | null = null;
  let issueKey: string | null = null;
  switch (container.kind) {
    case 'workspace':
      return [];
    case 'initiative':
      initiativeId = container.id;
      break;
    case 'project':
      projectId = container.id;
      break;
    case 'milestone':
      milestoneId = container.id;
      projectId = snapshot.milestones.get(container.id)?.projectId ?? null;
      break;
    case 'chain': {
      const issue = findIssue(snapshot.issues, container.id);
      issueKey = issue?.identifier ?? container.id;
      projectId = issue?.projectId ?? null;
      milestoneId = issue?.milestoneId ?? null;
      break;
    }
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  if (projectId !== null && !snapshot.projects.has(projectId)) {
    projectId = null;
  }
  if (milestoneId !== null && !snapshot.milestones.has(milestoneId)) {
    milestoneId = null;
  }
  if (projectId !== null && hasInitiatives) {
    initiativeId =
      homeInitiativeIds(snapshot).get(projectId) ?? NO_INITIATIVE_ID;
  }

  const trail: ShellCrumb[] = [
    {
      label: 'Workspace',
      href: graphHref({ level: hasInitiatives ? 'initiative' : 'project' }),
    },
  ];
  if (initiativeId !== null && hasInitiatives) {
    trail.push({
      label: initiativeName(snapshot, initiativeId),
      href: graphHref({ level: 'project', initiativeId }),
    });
  }
  if (projectId !== null) {
    trail.push({
      label: snapshot.projects.get(projectId)?.name ?? 'Unknown project',
      href: graphHref({ level: 'milestone', projectId }),
    });
  }
  if (milestoneId !== null) {
    trail.push({
      label: snapshot.milestones.get(milestoneId)?.name ?? 'Unknown milestone',
      href: graphHref({ level: 'issue', milestoneId }),
    });
  }
  if (issueKey !== null) trail.push({ label: issueKey });
  // The last crumb is the page itself: shown, not linked.
  const last = trail[trail.length - 1];
  if (last !== undefined) trail[trail.length - 1] = { label: last.label };
  return trail;
}

/**
 * The level tabs (route links) of a scope: exactly the levels its container
 * offers (GRAPH_LEVELS_WITHIN), the scope's own marked current. The
 * workspace leaves out Initiatives when the viewer has none (guests). A
 * milestone or a chain offers one level, so it gets no tabs: the trail is
 * the way up.
 */
export function levelTabs(
  scope: GraphScope,
  options: { hasInitiatives: boolean }
): NavTabItem[] {
  const container = graphContainer(scope);
  const levels = GRAPH_LEVELS_WITHIN[container.kind].filter(
    (level) =>
      options.hasInitiatives ||
      container.kind !== 'workspace' ||
      level !== 'initiative'
  );
  if (levels.length <= 1) return [];
  return levels.map((level) => ({
    id: level,
    label: GRAPH_LEVEL_LABEL[level],
    href: graphHref(graphScopeFor(container, level)),
    current: level === scope.level,
  }));
}
