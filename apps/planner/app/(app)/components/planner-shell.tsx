'use client';

import {
  AppShell,
  CommandPaletteProvider,
  type PaletteItem,
  type ShellIcon,
  type ShellNavItem,
  type ShellSection,
  type ShellTab,
  useToast,
} from '@better-tracker/ui';
import {
  CalendarCheck,
  ChartGantt,
  Contrast,
  ExternalLink,
  FolderKanban,
  History,
  Network,
  Play,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useMemo } from 'react';

import {
  crumbsFor,
  isCurrentPath,
  isPaletteIndex,
  NAV_TARGETS,
  type NavTargetId,
  PALETTE_SECTION_ORDER,
  PALETTE_SECTIONS,
  paletteItemsFromIndex,
  paletteSuggestions,
  type PaletteSuggestionAction,
  runIdFrom,
  type ShellFrame,
  SIDEBAR_STORAGE_KEY,
  syncFailureMessage,
  userBadge,
} from '../../../lib/adapters/shell';
import { getJson, sendJson } from '../../../lib/api-client';
import { CrumbProvider, usePageCrumb } from './page-crumb';
import { ReadOnlyReasonProvider } from './read-only-notice';

const NAV_ICONS: Record<NavTargetId, ShellIcon> = {
  week: CalendarCheck,
  timeline: ChartGantt,
  projects: FolderKanban,
  graph: Network,
  runs: History,
  settings: SlidersHorizontal,
};

const SUGGESTION_ICONS: Record<PaletteSuggestionAction, ShellIcon> = {
  'dry-run': Play,
  resync: RefreshCw,
  theme: Contrast,
};

/** Destinations on the phone tab bar; "More" (the drawer) is appended. */
const TAB_IDS: readonly NavTargetId[] = [
  'week',
  'timeline',
  'projects',
  'graph',
];

/** Flips html[data-theme] and remembers it, as the ThemeToggle does. */
function switchTheme(storageKey: string): void {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

/** Opens a Linear URL in a new tab, keeping the planner where it is. */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

interface PlannerShellProps {
  frame: ShellFrame;
  /** The demo-mode strip, when there is one. */
  banner?: ReactNode;
  themeStorageKey: string;
  children: ReactNode;
}

/**
 * The signed-in frame: AppShell fed with the server-built ShellFrame, plus
 * what only the browser knows (the current URL for nav state and the
 * breadcrumb) and the command palette with its actions. Every command is
 * offered to everyone signed in (there are no roles) except a Linear
 * guest, who is read-only (owner decision 2026-10-22): their palette keeps
 * navigation, Jump to and the theme switch, and their user line says
 * "Guest". The routes behind the commands refuse a guest too.
 */
export default function PlannerShell(props: PlannerShellProps) {
  return (
    <CrumbProvider>
      <ReadOnlyReasonProvider reason={props.frame.readOnlyReason}>
        <PaletteFrame {...props} />
      </ReadOnlyReasonProvider>
    </CrumbProvider>
  );
}

function PaletteFrame({
  frame,
  banner,
  themeStorageKey,
  children,
}: PlannerShellProps) {
  const router = useRouter();
  const { toast } = useToast();

  const previewAllocation = useCallback(async () => {
    toast({
      kind: 'info',
      label: 'Dry run',
      message: 'Previewing allocation: syncing from Linear, then planning.',
    });
    const result = await sendJson('POST', '/api/runs', { mode: 'dry_run' });
    if (!result.ok) {
      toast({ kind: 'error', label: 'Dry run', message: result.message });
      return;
    }
    const id = runIdFrom(result.data);
    router.push(id === null ? '/runs' : `/runs/${encodeURIComponent(id)}`);
  }, [router, toast]);

  const resync = useCallback(async () => {
    toast({ kind: 'info', label: 'Sync', message: 'Resyncing from Linear.' });
    const result = await sendJson('POST', '/api/sync', {});
    if (!result.ok) {
      toast({ kind: 'error', label: 'Sync', message: result.message });
      return;
    }
    const failure = syncFailureMessage(result.data);
    toast(
      failure === null
        ? {
            kind: 'info',
            label: 'Synced',
            message: 'Resynced from Linear; these screens now show it.',
          }
        : { kind: 'error', label: 'Sync', message: failure }
    );
    router.refresh();
  }, [router, toast]);

  const items = useMemo<PaletteItem[]>(() => {
    const run: Record<PaletteSuggestionAction, () => void> = {
      'dry-run': () => void previewAllocation(),
      resync: () => void resync(),
      theme: () => switchTheme(themeStorageKey),
    };
    const suggestions = paletteSuggestions(frame.readOnly).map(
      (suggestion): PaletteItem => ({
        id: suggestion.id,
        label: suggestion.label,
        hint: suggestion.hint,
        section: PALETTE_SECTIONS.suggestions,
        icon: SUGGESTION_ICONS[suggestion.action],
        onSelect: run[suggestion.action],
      })
    );
    const navigation = NAV_TARGETS.map((target): PaletteItem => ({
      id: `nav-${target.id}`,
      label: `Go to ${target.label}`,
      section: PALETTE_SECTIONS.navigation,
      href: target.href,
      shortcut: target.shortcut,
      icon: NAV_ICONS[target.id],
    }));
    return [...suggestions, ...navigation];
  }, [frame.readOnly, previewAllocation, resync, themeStorageKey]);

  const loadItems = useCallback(async () => {
    const body = await getJson('/api/palette');
    if (!isPaletteIndex(body)) {
      throw new Error('The search index came back in an unexpected shape.');
    }
    return paletteItemsFromIndex(body, {
      openExternal,
      externalIcon: ExternalLink,
    });
  }, []);

  const navigate = useCallback((href: string) => router.push(href), [router]);

  return (
    <CommandPaletteProvider
      items={items}
      loadItems={loadItems}
      sectionOrder={PALETTE_SECTION_ORDER}
      navigate={navigate}
      placeholder="Search projects, milestones and your issues…"
    >
      <Frame frame={frame} banner={banner} themeStorageKey={themeStorageKey}>
        {children}
      </Frame>
    </CommandPaletteProvider>
  );
}

function Frame({
  frame,
  banner,
  themeStorageKey,
  children,
}: PlannerShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pageCrumb = usePageCrumb();

  const nav = NAV_TARGETS.filter((target) => target.id !== 'settings').map(
    (target): ShellNavItem => {
      const item: ShellNavItem = {
        id: target.id,
        label: target.label,
        href: target.href,
        icon: NAV_ICONS[target.id],
        current: isCurrentPath(pathname, target.href),
        shortcut: target.shortcut,
      };
      if (target.id === 'week' && frame.weekCount !== null) {
        item.count = frame.weekCount;
        item.countLabel = frame.weekCountLabel ?? undefined;
      }
      return item;
    }
  );

  // A project is "current" while the timeline is focused on its lane.
  const focusedProject =
    pathname === '/timeline' ? searchParams.get('project') : null;
  const sections: ShellSection[] = [
    {
      id: 'projects',
      title: 'Projects',
      action: { label: 'All', href: '/projects' },
      emptyLabel: frame.projectsEmptyLabel,
      items: frame.projects.map((item) => ({
        ...item,
        current: item.id === focusedProject,
      })),
    },
  ];

  const tabs = TAB_IDS.map((id): ShellTab => {
    const target = NAV_TARGETS.find((t) => t.id === id) ?? NAV_TARGETS[0];
    return {
      id,
      label: target.label,
      href: target.href,
      icon: NAV_ICONS[id],
      current: isCurrentPath(pathname, target.href),
    };
  });

  return (
    <AppShell
      appName={frame.appName}
      workspaceName={frame.workspaceName ?? undefined}
      brandHref="/week"
      nav={nav}
      sections={sections}
      settings={{
        href: '/settings',
        current: isCurrentPath(pathname, '/settings'),
      }}
      user={{
        name: frame.userName,
        badge: userBadge(frame),
      }}
      signOut={{ action: '/api/auth/logout', method: 'post' }}
      themeStorageKey={themeStorageKey}
      crumbs={crumbsFor(pathname, pageCrumb)}
      banner={banner}
      tabs={tabs}
      storageKey={SIDEBAR_STORAGE_KEY}
      mainId="main"
    >
      {children}
    </AppShell>
  );
}
