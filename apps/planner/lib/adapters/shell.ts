import type {
  TimelineBar,
  TimelineLane,
  TimelineView,
  WeekView,
} from '@better-tracker/core';
import type {
  PaletteItem,
  ShellCrumb,
  ShellIcon,
  ShellSectionItem,
  UiStatus,
} from '@better-tracker/ui';

import { formatDate, plural } from '../format';
import { assessmentMark, statusLabel, uiStatus } from './status';

// The app frame's core → ui mapping (architecture §8.3): the sidebar's
// PROJECTS section and My week count, the topbar breadcrumb, and the
// command palette's "Jump to" index. Pure functions over engine view
// models; the layout (server) and PlannerShell (client) stay thin.

/** localStorage key for the collapsed sidebar rail (AppShell + script). */
export const SIDEBAR_STORAGE_KEY = 'milestone-planner-sidebar';

/** Palette section names, in display order. */
export const PALETTE_SECTIONS = {
  suggestions: 'Suggestions',
  jump: 'Jump to',
  navigation: 'Navigation',
} as const;

export const PALETTE_SECTION_ORDER: string[] = [
  PALETTE_SECTIONS.suggestions,
  PALETTE_SECTIONS.jump,
  PALETTE_SECTIONS.navigation,
];

export type NavTargetId =
  | 'week'
  | 'timeline'
  | 'projects'
  | 'graph'
  | 'runs'
  | 'settings';

export interface NavTarget {
  id: NavTargetId;
  label: string;
  href: string;
  /** Two-key shortcut registered by the palette (G then W …). */
  shortcut: string[];
}

/** Every top-level destination, in sidebar order (Settings sits in the footer). */
export const NAV_TARGETS: readonly NavTarget[] = [
  { id: 'week', label: 'My week', href: '/week', shortcut: ['G', 'W'] },
  {
    id: 'timeline',
    label: 'Timeline',
    href: '/timeline',
    shortcut: ['G', 'T'],
  },
  {
    id: 'projects',
    label: 'Projects',
    href: '/projects',
    shortcut: ['G', 'P'],
  },
  { id: 'graph', label: 'Graph', href: '/graph', shortcut: ['G', 'G'] },
  { id: 'runs', label: 'Runs', href: '/runs', shortcut: ['G', 'R'] },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    shortcut: ['G', 'S'],
  },
];

/** Breadcrumb roots for paths that are not in the nav. */
const EXTRA_CRUMBS: Record<string, string> = { setup: 'Setup' };

/** True when `pathname` is `href` or a page below it. */
export function isCurrentPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The topbar breadcrumb: the section the path is in, then the page's own
 * crumb when it set one (a project, a run). A detail path without a page
 * crumb ("/runs/abc") still links back to its section.
 */
export function crumbsFor(
  pathname: string,
  pageCrumb: string | null
): ShellCrumb[] {
  const [first = '', ...rest] = pathname.split('/').filter((p) => p !== '');
  const target = NAV_TARGETS.find((t) => t.href === `/${first}`);
  const rootLabel = target?.label ?? EXTRA_CRUMBS[first];
  if (rootLabel === undefined) {
    return pageCrumb !== null && pageCrumb !== '' ? [{ label: pageCrumb }] : [];
  }
  const root = `/${first}`;
  if (pageCrumb !== null && pageCrumb !== '') {
    return [{ label: rootLabel, href: root }, { label: pageCrumb }];
  }
  if (rest.length > 0) return [{ label: rootLabel, href: root }];
  return [{ label: rootLabel }];
}

/** A status mark and its spoken label. */
export interface Mark {
  status: UiStatus;
  label: string;
}

/** The lane's next milestone (dated or not), if it has one. */
export function laneNextMilestone(lane: TimelineLane): TimelineBar | null {
  return (
    lane.bars.find((bar) => bar.isNext) ??
    lane.undated.find((bar) => bar.isNext) ??
    null
  );
}

/**
 * The sidebar mark for a project: its next milestone's mark (rubric gaps
 * hatch an on-track one, via the status adapter). Without a next
 * milestone every milestone is complete, or there are none, which is a
 * missing input.
 */
export function laneMark(lane: TimelineLane): Mark {
  const next = laneNextMilestone(lane);
  if (next !== null) return assessmentMark(next);
  if (lane.bars.length + lane.undated.length > 0) {
    return { status: 'done', label: 'All milestones complete' };
  }
  return { status: 'missing', label: 'No milestones' };
}

function allLanes(timeline: TimelineView): TimelineLane[] {
  return timeline.groups.flatMap((group) => group.lanes);
}

function projectHref(projectId: string): string {
  return `/timeline?project=${encodeURIComponent(projectId)}`;
}

function milestoneHref(milestoneId: string): string {
  return `/timeline?milestone=${encodeURIComponent(milestoneId)}`;
}

/**
 * The sidebar PROJECTS list: active projects (the ones allocation and
 * warnings apply to) in timeline order, each marked with its next
 * milestone's status. `current` is left to the client, which knows the URL.
 */
export function projectSectionItems(
  timeline: TimelineView
): ShellSectionItem[] {
  return allLanes(timeline)
    .filter((lane) => lane.active)
    .map((lane) => {
      const mark = laneMark(lane);
      return {
        id: lane.projectId,
        label: lane.name,
        href: projectHref(lane.projectId),
        status: mark.status,
        statusLabel: mark.label,
      };
    });
}

/** The My week nav count: the signed-in person's issues due this week. */
export function weekNavCount(week: WeekView): { count: number; label: string } {
  const count = week.totals.thisWeek;
  return { count, label: `${plural(count, 'issue')} due this week` };
}

/** Everything the sidebar and topbar show, as plain serializable data. */
export interface ShellFrame {
  appName: string;
  workspaceName: string | null;
  userName: string;
  isPm: boolean;
  /** Null when the week view could not be read (not installed, error). */
  weekCount: number | null;
  weekCountLabel: string | null;
  projects: ShellSectionItem[];
  /** Shown when `projects` is empty; says why. */
  projectsEmptyLabel: string;
}

export interface ShellFrameInput {
  appName: string;
  workspaceName: string | null;
  userName: string;
  isPm: boolean;
  /** The app has a working Linear installation for this workspace. */
  installed: boolean;
  timeline: TimelineView | null;
  week: WeekView | null;
  /** Reading the views failed (logged by the caller). */
  loadFailed: boolean;
}

/** Builds the frame data; the empty-section copy says what is missing. */
export function buildShellFrame(input: ShellFrameInput): ShellFrame {
  const count = input.week === null ? null : weekNavCount(input.week);
  const projects =
    input.timeline === null ? [] : projectSectionItems(input.timeline);
  const projectsEmptyLabel = !input.installed
    ? 'Install the app to see projects'
    : input.loadFailed
      ? 'Projects could not be loaded'
      : 'No active projects';
  return {
    appName: input.appName,
    workspaceName: input.workspaceName,
    userName: input.userName,
    isPm: input.isPm,
    weekCount: count?.count ?? null,
    weekCountLabel: count?.label ?? null,
    projects,
    projectsEmptyLabel,
  };
}

// ---------------------------------------------------------------------------
// Command palette index (GET /api/palette)
// ---------------------------------------------------------------------------

/** One "Jump to" target, serializable (no callbacks, no icons). */
export interface PaletteEntry {
  id: string;
  label: string;
  /** Matched by the fuzzy search too: identifiers, project names. */
  hint: string;
  href: string;
  /** Opens outside the app (an issue in Linear), in a new tab. */
  external: boolean;
  status?: UiStatus;
  statusLabel?: string;
}

/** The GET /api/palette body. */
export interface PaletteIndex {
  projects: PaletteEntry[];
  milestones: PaletteEntry[];
  issues: PaletteEntry[];
}

function milestoneHint(
  lane: TimelineLane,
  bar: TimelineBar,
  today: string
): string {
  const when =
    bar.end === null ? 'no target date' : `due ${formatDate(bar.end, today)}`;
  return `${lane.name} · ${when}`;
}

/**
 * The palette's jump targets: every project lane and milestone on the
 * timeline (marked like the sidebar), and the person's open issues from
 * My week (opening in Linear, marked with their milestone's status).
 */
export function buildPaletteIndex(input: {
  timeline: TimelineView;
  week: WeekView;
}): PaletteIndex {
  const { timeline, week } = input;
  const lanes = allLanes(timeline);
  const projects = lanes.map((lane): PaletteEntry => {
    const mark = laneMark(lane);
    return {
      id: `project:${lane.projectId}`,
      label: lane.name,
      hint: `Project · ${lane.leadName ?? 'No lead'}`,
      href: projectHref(lane.projectId),
      external: false,
      status: mark.status,
      statusLabel: mark.label,
    };
  });
  const milestones = lanes.flatMap((lane) =>
    [...lane.bars, ...lane.undated].map((bar): PaletteEntry => {
      const mark = assessmentMark(bar);
      return {
        id: `milestone:${bar.milestoneId}`,
        label: bar.name,
        hint: milestoneHint(lane, bar, timeline.today),
        href: milestoneHref(bar.milestoneId),
        external: false,
        status: mark.status,
        statusLabel: mark.label,
      };
    })
  );
  const issues = week.sections.flatMap((section) =>
    section.rows.map((row): PaletteEntry => {
      const entry: PaletteEntry = {
        id: `issue:${row.issueId}`,
        label: row.title,
        hint: `${row.identifier} · ${row.stateName}`,
        href: row.url,
        external: true,
      };
      if (section.status === null) return entry;
      return {
        ...entry,
        status: uiStatus(section.status),
        statusLabel: `Milestone ${statusLabel(section.status).toLowerCase()}`,
      };
    })
  );
  return { projects, milestones, issues };
}

function isEntry(value: unknown): value is PaletteEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.hint === 'string' &&
    typeof v.href === 'string' &&
    typeof v.external === 'boolean'
  );
}

/** Shape check for the palette response before the client maps it. */
export function isPaletteIndex(value: unknown): value is PaletteIndex {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['projects', 'milestones', 'issues'].every(
    (key) => Array.isArray(v[key]) && (v[key] as unknown[]).every(isEntry)
  );
}

/**
 * Palette rows from the index: internal targets navigate through the
 * provider (router.push); external ones (Linear issues) call `openExternal`
 * so they open in a new tab instead of leaving the app.
 */
export function paletteItemsFromIndex(
  index: PaletteIndex,
  options: {
    openExternal: (url: string) => void;
    externalIcon?: ShellIcon;
  }
): PaletteItem[] {
  const entries = [...index.projects, ...index.milestones, ...index.issues];
  return entries.map((entry): PaletteItem => {
    const item: PaletteItem = {
      id: entry.id,
      label: entry.label,
      hint: entry.hint,
      section: PALETTE_SECTIONS.jump,
    };
    if (entry.status !== undefined) {
      item.status = entry.status;
      item.statusLabel = entry.statusLabel;
    }
    if (entry.external) {
      item.onSelect = () => options.openExternal(entry.href);
      if (entry.status === undefined) item.icon = options.externalIcon;
    } else {
      item.href = entry.href;
    }
    return item;
  });
}

/**
 * The run id in a POST /api/runs response: `{ run: { id } }` or a bare
 * run `{ id }`. Null when neither is there.
 */
export function runIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const run = record.run;
  if (typeof run === 'object' && run !== null) {
    const id = (run as Record<string, unknown>).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return typeof record.id === 'string' && record.id !== '' ? record.id : null;
}

/**
 * Why a POST /api/sync that answered 200 still did not sync: a body with
 * `ok: false` (a SyncResult, bare or under `sync`) carries the reason.
 * Null when the sync went through.
 */
export function syncFailureMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const result =
    typeof record.sync === 'object' && record.sync !== null
      ? (record.sync as Record<string, unknown>)
      : record;
  if (result.ok !== false) return null;
  return typeof result.error === 'string' && result.error !== ''
    ? `Linear sync failed: ${result.error}`
    : 'Linear sync failed; the screens still show the previous data.';
}
