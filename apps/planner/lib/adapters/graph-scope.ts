import {
  DEFAULT_GRAPH_LEVEL,
  findIssue,
  GRAPH_LEVELS_WITHIN,
  type GraphContainer,
  graphContainer,
  type GraphHighlight,
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
// the drill-up trail, the level tabs, and the highlight (?highlight= and
// the graph-highlight cookie, which never take part in a scope's URL).
// Pure functions; the timeline, projects and issue adapters import their
// graph links from here so every page writes the same URLs.

/** Where the graph lives. */
export const GRAPH_PATH = '/graph';

/** At most this many characters of an id from the URL reach the engine. */
export const MAX_ID_LENGTH = 200;

/**
 * The most a graph draws (§11.2). Every item of a scope is drawn (owner
 * decision 2026-10-23), so a workspace's issue level holds every issue:
 * at 700 boxes and 1,000 arrows the server's work (core, the framed
 * layout, the model) takes 0.35-0.8 s whatever the workspace's shape, from
 * 1 project to 140 (at most 0.94 s; measured after the 2026-10-23 review
 * fixes, architecture §8.4 "Draw limits and cost"), and a hover there
 * still costs about a tenth of a second of frames ("Hover cost"). Past
 * either, the page shows "Too many to draw" and narrower graphs instead
 * of a partial drawing that would hide risk.
 */
export const GRAPH_DRAW_LIMITS: {
  readonly nodes: number;
  readonly edges: number;
} = { nodes: 700, edges: 1000 };

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

/* ---- the highlight (?highlight=, the graph-highlight cookie) ------------- */

/** Each highlight's switch label, in switch order. */
export const GRAPH_HIGHLIGHT_LABEL: Readonly<Record<GraphHighlight, string>> = {
  status: 'Status',
  risk: 'Risk',
  critical: 'Critical path',
};

/** The highlights, in switch order. */
export const GRAPH_HIGHLIGHTS: readonly GraphHighlight[] = [
  'status',
  'risk',
  'critical',
];

/** What a graph is drawn with when neither the URL nor the cookie says. */
export const DEFAULT_GRAPH_HIGHLIGHT: GraphHighlight = 'status';

/**
 * The cookie that remembers the last highlight picked on this device: a
 * viewing preference, unsigned and validated on every read (parseHighlight),
 * scoped to /graph so no other page or API route carries it, and never a
 * session or auth cookie (those are mp_session and mp_oauth, httpOnly).
 */
export const HIGHLIGHT_COOKIE = 'graph-highlight';

/** The highlight cookie's lifetime: a year, in seconds. */
export const HIGHLIGHT_COOKIE_MAX_AGE = 31_536_000;

/** One of the three highlights. An own key only, like isGraphLevel, so
    "constructor" or "__proto__" never pass. */
function isGraphHighlight(value: string): value is GraphHighlight {
  return Object.hasOwn(GRAPH_HIGHLIGHT_LABEL, value);
}

/**
 * ?highlight= (or the cookie's value) read leniently: the first value of a
 * repeated parameter, trimmed, any case, with "critical-path" and
 * "criticalpath" meaning critical. Anything else is null, never a 404.
 */
export function parseHighlight(
  value: string | string[] | undefined | null
): GraphHighlight | null {
  const raw = pickParam(value ?? undefined)?.toLowerCase();
  if (raw === undefined) return null;
  const id =
    raw === 'critical-path' || raw === 'criticalpath' ? 'critical' : raw;
  return isGraphHighlight(id) ? id : null;
}

/**
 * The highlight a /graph request is drawn with: the URL's ?highlight=,
 * else the remembered cookie (an invalid one is ignored), else
 * DEFAULT_GRAPH_HIGHLIGHT.
 */
export function effectiveHighlight(
  param: string | string[] | undefined | null,
  cookie: string | undefined | null
): GraphHighlight {
  return (
    parseHighlight(param) ?? parseHighlight(cookie) ?? DEFAULT_GRAPH_HIGHLIGHT
  );
}

/**
 * `href` with ?highlight= set to `mode`, or removed for the default unless
 * `keepDefault`: only that parameter changes (every repeat of it is
 * dropped first), every other one keeps its place and its exact encoding,
 * and a #fragment stays last. The graph screen writes the address bar
 * (addressHref) and its own links (carryHighlight) through it, without
 * disturbing ?issue=, ?node= or the scope.
 */
export function withHighlightParam(
  href: string,
  mode: GraphHighlight,
  keepDefault = false
): string {
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = queryAt === -1 ? '' : rest.slice(queryAt + 1);
  const kept = query.split('&').filter((part) => {
    if (part === '') return false;
    const name = part.split('=', 1)[0] ?? '';
    return safeDecode(name) !== 'highlight';
  });
  if (keepDefault || mode !== DEFAULT_GRAPH_HIGHLIGHT) {
    kept.push(`highlight=${mode}`);
  }
  return `${path}${kept.length === 0 ? '' : `?${kept.join('&')}`}${hash}`;
}

/**
 * The address bar for `href` showing `mode`, where `bare` is what a URL
 * with no ?highlight= shows on this device (its cookie, else the default):
 * the parameter is left out only when both are the default, so a copied
 * address shows the same to anyone, and a reload shows the same here (an
 * explicit Status survives a cookie that says Risk).
 */
export function addressHref(
  href: string,
  mode: GraphHighlight,
  bare: GraphHighlight
): string {
  return withHighlightParam(href, mode, bare !== DEFAULT_GRAPH_HIGHLIGHT);
}

/**
 * A graph link the screen draws (a level tab, a trail crumb, a panel or
 * narrower-graph link) carrying the mode on screen to the next graph:
 * ?highlight= only when `mode` is not what that page would pick on this
 * device anyway (`bare`), so a mode that came in a shared link survives
 * a click, and links stay canonical otherwise. Links off /graph are left
 * alone.
 */
export function carryHighlight(
  href: string,
  mode: GraphHighlight,
  bare: GraphHighlight
): string {
  if (href !== GRAPH_PATH && !href.startsWith(`${GRAPH_PATH}?`)) return href;
  return mode === bare
    ? withHighlightParam(href, DEFAULT_GRAPH_HIGHLIGHT)
    : withHighlightParam(href, mode, true);
}

/**
 * The highlight a Cookie header (or document.cookie) remembers: the first
 * graph-highlight pair whose value parseHighlight accepts, else null.
 * Browsers send the most specific path first, so a graph-highlight set
 * for a wider path (a parent domain's Path=/) never shadows the reader's
 * own Path=/graph pick; Next's cookies() keeps the last pair instead,
 * which is why the page reads the raw header through this.
 */
export function highlightFromCookies(
  header: string | null | undefined
): GraphHighlight | null {
  if (header === null || header === undefined) return null;
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at === -1 || pair.slice(0, at).trim() !== HIGHLIGHT_COOKIE) continue;
    const mode = parseHighlight(safeDecode(pair.slice(at + 1).trim()));
    if (mode !== null) return mode;
  }
  return null;
}

/** decodeURIComponent that leaves a malformed escape as written. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * The document.cookie assignment that remembers `mode`: Path=/graph, a
 * year, SameSite=Lax, plus Secure on https. Not httpOnly: the graph's
 * client island writes it when the switch changes. Pure, so the attributes
 * are unit-tested.
 */
export function highlightCookie(mode: GraphHighlight, secure: boolean): string {
  return `${HIGHLIGHT_COOKIE}=${mode}; Path=${GRAPH_PATH}; Max-Age=${HIGHLIGHT_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
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
