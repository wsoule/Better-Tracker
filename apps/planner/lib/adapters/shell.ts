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
import type { ReadOnlyReasonCopy } from '../read-only';
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

/** What a palette suggestion does when chosen (PlannerShell wires each). */
export type PaletteSuggestionAction = 'dry-run' | 'resync' | 'theme';

export interface PaletteSuggestion {
  id: string;
  label: string;
  hint: string;
  action: PaletteSuggestionAction;
}

/**
 * The palette's Suggestions, the same for everyone signed in but a guest:
 * there are no roles (owner decision 2026-10-22), so the dry run and the
 * resync are offered to every person the routes behind them accept. A
 * Linear guest is read-only (owner decision 2026-10-22, "Guests limited to
 * read only") and gets only the theme switch (paletteSuggestions).
 */
export const PALETTE_SUGGESTIONS: readonly PaletteSuggestion[] = [
  {
    id: 'suggest-dry-run',
    label: 'Preview allocation (dry run)',
    hint: 'Assigns nothing',
    action: 'dry-run',
  },
  {
    id: 'suggest-resync',
    label: 'Resync from Linear',
    hint: 'Full sync',
    action: 'resync',
  },
  {
    id: 'suggest-theme',
    label: 'Switch theme',
    hint: 'Light / dark',
    action: 'theme',
  },
];

/** Suggestions that change something (a run, a resync): none for a guest. */
const ACTION_SUGGESTIONS: ReadonlySet<PaletteSuggestionAction> = new Set([
  'dry-run',
  'resync',
]);

/**
 * The Suggestions a person is offered: all of them, or for a read-only
 * person (a Linear guest) only those that change nothing (the theme).
 */
export function paletteSuggestions(readOnly: boolean): PaletteSuggestion[] {
  return PALETTE_SUGGESTIONS.filter(
    (suggestion) => !readOnly || !ACTION_SUGGESTIONS.has(suggestion.action)
  );
}

/** The sidebar's chip beside a guest's name. */
export const GUEST_BADGE = 'Guest';

/** The chip for someone read-only for another reason (not yet synced). */
export const READ_ONLY_BADGE = 'Read only';

/**
 * The sidebar user line's chip: "Guest" for a Linear guest, "Read only"
 * for someone read-only for another reason (the mirror does not know them
 * yet, or the first sync has not landed), none otherwise.
 */
export function userBadge(frame: {
  readOnly: boolean;
  readOnlyReason: ReadOnlyReasonCopy | undefined;
}): string | undefined {
  if (!frame.readOnly) return undefined;
  return frame.readOnlyReason === 'guest' || frame.readOnlyReason === undefined
    ? GUEST_BADGE
    : READ_ONLY_BADGE;
}

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
const EXTRA_CRUMBS: Record<string, string> = {
  setup: 'Setup',
  issues: 'Issues',
};

/** Roots with no index page of their own: their crumb is not a link
    (/issues/ENG-24 exists, /issues does not). */
const UNLINKED_ROOTS: ReadonlySet<string> = new Set(['issues']);

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
  const rootCrumb: ShellCrumb = UNLINKED_ROOTS.has(first)
    ? { label: rootLabel }
    : { label: rootLabel, href: root };
  if (pageCrumb !== null && pageCrumb !== '') {
    return [rootCrumb, { label: pageCrumb }];
  }
  if (rest.length > 0) return [rootCrumb];
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
  /**
   * The person is read-only in the planner: the palette offers no runs or
   * resyncs, and the user line says "Guest" for a Linear guest.
   */
  readOnly: boolean;
  /** Why, when `readOnly` (Actor.readOnlyReason); the notices say it. */
  readOnlyReason: ReadOnlyReasonCopy | undefined;
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
  /** Actor.readOnly. */
  readOnly: boolean;
  /** Actor.readOnlyReason. */
  readOnlyReason?: ReadOnlyReasonCopy | undefined;
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
    readOnly: input.readOnly,
    readOnlyReason: input.readOnly
      ? (input.readOnlyReason ?? 'guest')
      : undefined,
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
  /** Opens outside the app, in a new tab (none do today: issues open the
      planner's page, which links to Linear). */
  external: boolean;
  status?: UiStatus;
  statusLabel?: string;
  /** An inactive project's target (§2.8): the mark is drawn in greys and
      its label ends "· inactive project". Absent when active. */
  muted?: boolean;
}

/** The GET /api/palette body. */
export interface PaletteIndex {
  projects: PaletteEntry[];
  milestones: PaletteEntry[];
  issues: PaletteEntry[];
}

/** "Atlas · due Oct 18"; a complete milestone is not "due" any more, so
    it reads "Atlas · complete · Oct 1". */
function milestoneHint(
  lane: TimelineLane,
  bar: TimelineBar,
  today: string
): string {
  const when =
    bar.end === null
      ? 'no target date'
      : bar.status === 'complete'
        ? `complete · ${formatDate(bar.end, today)}`
        : `due ${formatDate(bar.end, today)}`;
  return `${lane.name} · ${when}`;
}

/**
 * The palette's status fields for a mark. In an inactive project (§2.8:
 * never loud) the mark is muted and its label says why, as on the
 * projects register.
 */
function paletteMark(
  mark: Mark,
  active: boolean
): Pick<PaletteEntry, 'status' | 'statusLabel' | 'muted'> {
  return active
    ? { status: mark.status, statusLabel: mark.label }
    : {
        status: mark.status,
        statusLabel: `${mark.label} · inactive project`,
        muted: true,
      };
}

/**
 * The palette's jump targets: every project lane and milestone on the
 * timeline (marked like the sidebar), and the person's open issues from
 * My week (opening the planner's issue page, where Linear is one click
 * away; marked with their milestone's status).
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
      ...paletteMark(mark, lane.active),
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
        ...paletteMark(mark, lane.active),
      };
    })
  );
  const inactiveMilestones = new Set(
    lanes
      .filter((lane) => !lane.active)
      .flatMap((lane) =>
        [...lane.bars, ...lane.undated].map((bar) => bar.milestoneId)
      )
  );
  const issues = week.sections.flatMap((section) =>
    section.rows.map((row): PaletteEntry => {
      const entry: PaletteEntry = {
        id: `issue:${row.issueId}`,
        label: row.title,
        hint: `${row.identifier} · ${row.stateName}`,
        href: `/issues/${encodeURIComponent(row.identifier)}`,
        external: false,
      };
      if (section.status === null) return entry;
      return {
        ...entry,
        ...paletteMark(
          {
            status: uiStatus(section.status),
            label: `Milestone ${statusLabel(section.status).toLowerCase()}`,
          },
          section.milestoneId === null ||
            !inactiveMilestones.has(section.milestoneId)
        ),
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
      if (entry.muted === true) item.statusMuted = true;
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
