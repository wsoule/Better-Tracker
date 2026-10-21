import type {
  PaletteItem,
  PropertyListItem,
  ShellNavItem,
  ShellSection,
  ShellTab,
  UiStatus,
} from '@better-tracker/ui';
import type { ReactNode } from 'react';

// Fixture props for /ui-gallery/shell: a fictional workspace ("Northwind")
// shaped like the planner's real shell. The gallery may import only from
// @better-tracker/ui, so the nav glyphs are small inline SVGs drawn on the
// lucide grid (16px, 1.5 stroke) instead of lucide components.

/** localStorage key for the collapsed rail (AppShell + pre-paint script). */
export const SIDEBAR_STORAGE_KEY = 'milestone-planner-sidebar';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const icons = {
  week: (
    <Glyph>
      <rect x="2.5" y="3.5" width="11" height="10" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3M5.5 10l1.75 1.5L10.5 8.75" />
    </Glyph>
  ),
  timeline: (
    <Glyph>
      <path d="M2 2v12M4.5 4.5h5M6.5 8h7M4.5 11.5h4" />
    </Glyph>
  ),
  projects: (
    <Glyph>
      <path d="M2 4V13h12V5.5H8L6.5 4Z" />
      <path d="M5 8.5h6M5 11h3.5" />
    </Glyph>
  ),
  graph: (
    <Glyph>
      <rect x="1.75" y="2.75" width="3.5" height="3.5" />
      <rect x="10.75" y="6.25" width="3.5" height="3.5" />
      <rect x="1.75" y="9.75" width="3.5" height="3.5" />
      <path d="M5.25 4.5h2.5v6.75h-2.5M7.75 8h3" />
    </Glyph>
  ),
  runs: (
    <Glyph>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2 2.75v2.5h2.5M8 5v3.25l2.25 1.5" />
    </Glyph>
  ),
  // Settings as two sliders (a gear at 16px reads as a sun).
  settings: (
    <Glyph>
      <path d="M2 5h2.5M7.5 5H14M2 11h6.5M11.5 11H14" />
      <rect x="4.5" y="3.5" width="3" height="3" />
      <rect x="8.5" y="9.5" width="3" height="3" />
    </Glyph>
  ),
  // Palette suggestions: a dry run (play), a resync (two arrows), the
  // theme (half-filled disc) — the commands Gr8r's palette leads with.
  dryRun: (
    <Glyph>
      <path d="M4.5 3v10l8-5Z" />
    </Glyph>
  ),
  resync: (
    <Glyph>
      <path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11" />
      <path d="M3.25 2.5V5h2.5M12.75 13.5V11h-2.5" />
    </Glyph>
  ),
  theme: (
    <Glyph>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
    </Glyph>
  ),
} as const;

export const nav: ShellNavItem[] = [
  {
    id: 'week',
    label: 'My week',
    href: '/week',
    icon: icons.week,
    count: 4,
    countLabel: '4 issues due this week',
    shortcut: ['G', 'W'],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    href: '/timeline',
    icon: icons.timeline,
    current: true,
    shortcut: ['G', 'T'],
  },
  {
    id: 'projects',
    label: 'Projects',
    href: '/projects',
    icon: icons.projects,
    count: 2,
    countLabel: '2 projects blocked',
    countTone: 'accent',
    shortcut: ['G', 'P'],
  },
  {
    id: 'graph',
    label: 'Graph',
    href: '/graph',
    icon: icons.graph,
    shortcut: ['G', 'G'],
  },
  {
    id: 'runs',
    label: 'Runs',
    href: '/runs',
    icon: icons.runs,
    shortcut: ['G', 'R'],
  },
];

const project = (
  id: string,
  label: string,
  status: UiStatus,
  statusLabel: string,
  current = false
) => ({
  id,
  label,
  href: `/timeline?project=${id}`,
  status,
  statusLabel,
  current,
});

export const sections: ShellSection[] = [
  {
    id: 'projects',
    title: 'Projects',
    action: { label: 'All', href: '/projects' },
    items: [
      project('atlas', 'Atlas migration', 'overdue', 'Overdue', true),
      project('billing', 'Billing v2', 'at_risk', 'At risk'),
      project('search', 'Search relevance', 'on_track', 'On track'),
      project('onboard', 'Onboarding revamp', 'missing', 'Missing input'),
      project('mobile', 'Mobile offline sync', 'on_track', 'On track'),
      project('sso', 'SSO for enterprise', 'done', 'Complete'),
    ],
  },
];

export const tabs: ShellTab[] = [
  { id: 'week', label: 'My week', href: '/week', icon: icons.week },
  {
    id: 'timeline',
    label: 'Timeline',
    href: '/timeline',
    icon: icons.timeline,
    current: true,
  },
  {
    id: 'projects',
    label: 'Projects',
    href: '/projects',
    icon: icons.projects,
  },
  { id: 'graph', label: 'Graph', href: '/graph', icon: icons.graph },
];

export const crumbs = [
  { label: 'Timeline', href: '/timeline' },
  { label: 'Atlas migration' },
];

const NAV_TARGETS: {
  id: keyof typeof icons;
  label: string;
  keys: string[];
}[] = [
  { id: 'week', label: 'My week', keys: ['G', 'W'] },
  { id: 'timeline', label: 'Timeline', keys: ['G', 'T'] },
  { id: 'projects', label: 'Projects', keys: ['G', 'P'] },
  { id: 'graph', label: 'Graph', keys: ['G', 'G'] },
  { id: 'runs', label: 'Runs', keys: ['G', 'R'] },
  { id: 'settings', label: 'Settings', keys: ['G', 'S'] },
];

/** Navigation items: the planner's two-key shortcuts (G W, G T, …). */
export const navigationItems: PaletteItem[] = NAV_TARGETS.map((target) => ({
  id: `nav-${target.id}`,
  label: `Go to ${target.label}`,
  section: 'Navigation',
  href: `/${target.id}`,
  shortcut: target.keys,
  icon: icons[target.id],
}));

/** What GET /api/palette would return: projects, milestones, open issues. */
export const jumpItems: PaletteItem[] = [
  {
    id: 'p-atlas',
    label: 'Atlas migration',
    hint: 'Project · Pat Lee',
    section: 'Jump to',
    href: '/timeline?project=atlas',
    status: 'overdue',
    statusLabel: 'Overdue',
  },
  {
    id: 'p-billing',
    label: 'Billing v2',
    hint: 'Project · Sam Ortiz',
    section: 'Jump to',
    href: '/timeline?project=billing',
    status: 'at_risk',
    statusLabel: 'At risk',
  },
  {
    id: 'm-atlas-3',
    label: 'M3 Cutover',
    hint: 'Atlas migration · due Oct 18',
    section: 'Jump to',
    href: '/timeline?milestone=atlas-3',
    status: 'overdue',
    statusLabel: 'Overdue',
  },
  {
    id: 'm-billing-2',
    label: 'M2 Proration',
    hint: 'Billing v2 · due Oct 27',
    section: 'Jump to',
    href: '/timeline?milestone=billing-2',
    status: 'at_risk',
    statusLabel: 'At risk',
  },
  {
    id: 'i-atl-142',
    label: 'Cut over the billing writes',
    hint: 'ATL-142',
    section: 'Jump to',
    href: '/week#ATL-142',
    status: 'on_track',
    statusLabel: 'In progress',
  },
  {
    id: 'i-atl-147',
    label: 'Backfill historical invoices',
    hint: 'ATL-147',
    section: 'Jump to',
    href: '/week#ATL-147',
    status: 'on_track',
    statusLabel: 'Todo',
  },
  {
    id: 'i-bil-88',
    label: 'Prorate mid-cycle plan changes',
    hint: 'BIL-88',
    section: 'Jump to',
    href: '/week#BIL-88',
    status: 'at_risk',
    statusLabel: 'Todo, unassigned',
  },
];

export interface FixtureMilestone {
  id: string;
  name: string;
  due: string;
  daysLabel: string;
  status: UiStatus;
  statusLabel: string;
  completed: number;
  scope: number;
}

export const milestones: FixtureMilestone[] = [
  {
    id: 'atlas-2',
    name: 'M2 Dual writes',
    due: 'Oct 04',
    daysLabel: 'Done',
    status: 'done',
    statusLabel: 'Complete',
    completed: 9,
    scope: 9,
  },
  {
    id: 'atlas-3',
    name: 'M3 Cutover',
    due: 'Oct 18',
    daysLabel: '3 days overdue',
    status: 'overdue',
    statusLabel: 'Overdue',
    completed: 3,
    scope: 7,
  },
  {
    id: 'atlas-4',
    name: 'M4 Backfill',
    due: 'Nov 08',
    daysLabel: '18 days left',
    status: 'on_track',
    statusLabel: 'On track',
    completed: 1,
    scope: 6,
  },
  {
    id: 'atlas-5',
    name: 'M5 Decommission',
    due: '—',
    daysLabel: 'No date',
    status: 'missing',
    statusLabel: 'Missing: target date',
    completed: 0,
    scope: 4,
  },
];

/** The slide-over property sheet for M3 Cutover (values filled in by the
    gallery, which owns the date field's ref). */
export const milestoneFacts: Omit<PropertyListItem, 'value'>[] = [
  { id: 'status', label: 'Status' },
  { id: 'due', label: 'Due date' },
  { id: 'lead', label: 'Lead' },
  { id: 'progress', label: 'Progress' },
  { id: 'weight', label: 'Weight' },
  { id: 'next', label: 'Next milestone' },
  { id: 'done', label: 'Done means…' },
];
