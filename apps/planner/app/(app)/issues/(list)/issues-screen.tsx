'use client';

import type {
  IssueListPresetId,
  IssueListQuery,
  IssueListQuick,
} from '@better-tracker/core';
import {
  BulkBar,
  Button,
  EmptyState,
  type FilterChipData,
  FilterChips,
  NavTabs,
  Notice,
  type TaskColumnId,
  type TaskGroupData,
  TaskGroupTable,
  type TaskRowData,
  type TaskSectionData,
  useModKeyLabel,
  useOptionalCommandPalette,
  useToast,
  ViewToolbar,
} from '@better-tracker/ui';
import { CheckSquare, Link2, Network } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

import { graphHref } from '../../../../lib/adapters/graph';
import { issuePagePath } from '../../../../lib/adapters/issue';
import {
  FACET_LABEL,
  filterBadgeCount,
  type IssueListChipModel,
  type IssueListFacet,
  type IssueListFilterNames,
  type IssueListPageModel,
  type IssueListSectionModel,
  issueListChips,
  issueListGraphHref,
  issueListHref,
  issueListTabs,
  ISSUE_LIST_COLUMN_LABELS,
  hasDefaultFilters,
  mergeNames,
  milestoneProjectLookup,
  namesFromFilterNames,
  namesFromOptions,
  parseIssueListSearch,
  withDefaultFilters,
  withFilterValues,
  withGroupMenu,
  withoutInitiatives,
  withQuick,
  withSearch,
  withSortMenu,
} from '../../../../lib/adapters/issue-list';
import {
  dropPlan,
  ISSUE_MOVE_MAX,
  type IssueChange,
  type RowMenuAction,
  type RowMenuStage,
  weightAfter,
  weightToast,
} from '../../../../lib/adapters/issue-moves';
import { notSavedToast, sendJson } from '../../../../lib/api-client';
import {
  IssueDrawer,
  type IssueDrawerServer,
  useIssueDrawerState,
} from '../../components/issue-drawer';
import ReadOnlyNotice from '../../components/read-only-notice';
import {
  BulkActions,
  issueCell,
  MilestoneMenu,
  type MoveTargets,
  RowMenu,
} from './issue-row-actions';
import {
  FacetIcon,
  FacetPicker,
  FilterMenu,
  GroupMenu,
  SortMenu,
} from './issues-filters';
import css from './page.module.css';
import { useIssueListOptions } from './use-issue-list-options';
import { useIssueMoves, useMediaQuery } from './use-issue-moves';

/** How long the search waits for typing to pause before it applies. */
const SEARCH_DEBOUNCE_MS = 250;

export interface IssuesScreenProps {
  page: IssueListPageModel;
  /** The view the URL describes (normalized; before core's fallback). */
  urlQuery: IssueListQuery;
  /** Each preset tab's own count. */
  counts: Record<IssueListPresetId, number>;
  /** Names of the current filter values (chips, the cascade). */
  filterNames: IssueListFilterNames;
  today: string;
  viewerId: string;
  mirrorVersion: number;
  /** Which Filter menu fields apply: Initiative only with initiatives,
      Team only with two or more teams. */
  facts: { hasInitiatives: boolean; teamCount: number };
  /** ?issue=: the slide-over (architecture §8.5). */
  drawer: IssueDrawerServer;
  /** Who may change what here (architecture §8.4 "Issues", who sees
      what): `canMove` (a Linear write grant, not a guest) brings the
      checkboxes, grips, cell pickers, the edits of the row menu and the
      bulk bar; `canEditWeight` (anyone but a guest) the milestone group's
      weight items. */
  permissions: {
    canMove: boolean;
    canEditWeight: boolean;
    canWriteLinear: boolean;
    readOnly: boolean;
  };
  /** The milestone weight's bounds (the engine's WEIGHT_MIN / MAX). */
  weightBounds: { min: number; max: number };
}

/** Touch screens and phones select with the Select button first. */
const TOUCH_QUERY = '(pointer: coarse), (width <= 640px)';

/** A phone: the bulk bar puts Status and Priority under "More". */
const PHONE_QUERY = '(width <= 640px)';

/** The row keys that open a field's picker (m, a, s, p). */
const ROW_KEY_STAGE: Readonly<Record<string, RowMenuStage>> = {
  m: 'move',
  a: 'assign',
  s: 'status',
  p: 'priority',
};

/** Which row's "…" menu is open, at which stage, and where: under the
    "…" button (point null), or at the pointer of a right-click. */
interface MenuState {
  rowId: string;
  stage: RowMenuStage;
  open: boolean;
  point: { x: number; y: number } | null;
}

/** The columns that give way first when the list is narrow (the
    milestone, the reason for the page, never does). */
const DROP_COLUMNS: readonly TaskColumnId[] = [
  'due',
  'priority',
  'state',
  'assignee',
];

// A key typed into a field, or a control that takes keys itself.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/* The Issues page's client island (architecture §8.4 "Issues"): the
   preset tabs, the toolbar (search, Filter, Sort, Group, Open as graph,
   Copy link), the filter chips, the notices, the grouped list and the
   issue slide-over. The server filters, orders and groups (core's
   buildIssueList); this island keeps the view the person is asking for
   (`query`), applies each change to the URL at once (push; the search
   after a 250 ms pause, one history entry per search; Show more
   replaces), and shows the old list dimmed and busy until the server
   answers. Chips, tabs and toolbar labels follow `query` straight away.
   The island follows the address bar when it changes under it (Back,
   Forward, a sidebar or tab link), skipping the URLs it wrote itself and
   keeping a half-typed search while the URL still means the view shown;
   a non-canonical URL is rewritten in place. */
export default function IssuesScreen({
  page,
  urlQuery,
  counts,
  filterNames,
  today,
  viewerId,
  mirrorVersion,
  facts,
  drawer,
  permissions,
  weightBounds,
}: IssuesScreenProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlSearch = searchParams.toString();
  const { toast } = useToast();
  const palette = useOptionalCommandPalette();
  const [busy, startTransition] = useTransition();

  // A viewer without initiatives (a guest) gets core's fallback here too,
  // so the toolbar and chips name what the list shows.
  const hasInitiatives = facts.hasInitiatives;
  const shown = useCallback(
    (raw: IssueListQuery) => (hasInitiatives ? raw : withoutInitiatives(raw)),
    [hasInitiatives]
  );
  const [query, setQuery] = useState(() => shown(urlQuery));
  const [searchText, setSearchText] = useState(urlQuery.filters.q);
  // The query the callbacks below read (navigate sets it at once; this
  // keeps it in step with renders that come from the URL).
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // The canonical hrefs (without ?issue=) this island navigated to, so
  // their echo through useSearchParams is not taken for a change from
  // outside; cleared as soon as an outside change arrives.
  const written = useRef<string[]>([]);

  // A search being typed has one history entry. Its first change pushes
  // ('pushed'); only once that entry is in the address bar ('shown') do
  // the later changes replace it: a replace sent while the push is still
  // pending would cancel the push, and Back would skip the unfiltered
  // list. Enter or leaving the field ends the search ('off').
  const typing = useRef<'off' | 'pushed' | 'shown'>('off');

  const drawerState = useIssueDrawerState(drawer);
  const openIssue = drawerState.requested;

  // Follow the address bar (Back, Forward, a tab or sidebar link).
  useEffect(() => {
    // A search's first push is in the address bar now: its later changes
    // replace that entry.
    if (typing.current === 'pushed') typing.current = 'shown';
    const next = shown(parseIssueListSearch(urlSearch));
    const key = issueListHref(next);
    const own = written.current.indexOf(key);
    if (own !== -1) {
      written.current.splice(0, own + 1);
      return;
    }
    written.current = [];
    if (issueListHref(queryRef.current) === key) return;
    queryRef.current = next;
    setQuery(next);
    setSearchText(next.filters.q);
  }, [urlSearch, shown]);

  // A non-canonical URL (another parameter order, a default spelled out,
  // a value dropped as unknown) is rewritten in place, as the timeline's
  // toolbar does; nothing is fetched again.
  useEffect(() => {
    const canonical = issueListHref(parseIssueListSearch(urlSearch), {
      issue: searchParams.get('issue'),
    });
    const here = `${window.location.pathname}${window.location.search}`;
    if (pathname === '/issues' && here !== canonical) {
      window.history.replaceState(window.history.state, '', canonical);
    }
  }, [urlSearch, searchParams, pathname]);

  /** Shows `next` at once and asks the server for it. */
  const navigate = useCallback(
    (next: IssueListQuery, mode: 'push' | 'replace' = 'push') => {
      const key = issueListHref(next);
      if (key === issueListHref(queryRef.current) && mode === 'push') return;
      queryRef.current = next;
      setQuery(next);
      written.current.push(key);
      const href = issueListHref(next, { issue: openIssue });
      startTransition(() => {
        if (mode === 'push') router.push(href, { scroll: false });
        else router.replace(href, { scroll: false });
      });
    },
    [router, openIssue]
  );

  // ---- search ---------------------------------------------------------------

  const searchInput = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<number | null>(null);
  const applySearch = useCallback(
    (text: string) => {
      const next = withSearch(queryRef.current, text);
      if (issueListHref(next) === issueListHref(queryRef.current)) return;
      navigate(next, typing.current === 'shown' ? 'replace' : 'push');
      if (typing.current === 'off') typing.current = 'pushed';
    },
    [navigate]
  );
  useEffect(
    () => () => {
      if (searchTimer.current !== null)
        window.clearTimeout(searchTimer.current);
    },
    []
  );

  // ---- pickers --------------------------------------------------------------

  const optionsState = useIssueListOptions(mirrorVersion);
  const names = useMemo(
    () =>
      mergeNames(
        namesFromFilterNames(filterNames),
        namesFromOptions(optionsState.options)
      ),
    [filterNames, optionsState.options]
  );
  const lookup = useMemo(
    () => milestoneProjectLookup(filterNames, optionsState.options),
    [filterNames, optionsState.options]
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openFacet, setOpenFacet] = useState<IssueListFacet | null>(null);
  // A field chosen in the Filter menu that has no value yet: its chip
  // shows "… is …" with its picker open until a value is chosen or the
  // picker closes.
  const [pendingFacet, setPendingFacet] = useState<IssueListFacet | null>(null);

  const chips = issueListChips(query, names);
  const shownChips: IssueListChipModel[] =
    pendingFacet !== null && !chips.some((chip) => chip.facet === pendingFacet)
      ? [
          ...chips,
          {
            id: pendingFacet,
            facet: pendingFacet,
            field: FACET_LABEL[pendingFacet],
            summary: '…',
            unknown: false,
            removeLabel: `Remove ${FACET_LABEL[pendingFacet].toLowerCase()} filter`,
            removed: query,
            isDefault: false,
          },
        ]
      : chips;

  function chooseField(facet: IssueListFacet) {
    setFilterOpen(false);
    setAddOpen(false);
    if (!chips.some((chip) => chip.facet === facet)) setPendingFacet(facet);
    setOpenFacet(facet);
  }

  function toggleQuick(quick: IssueListQuick) {
    navigate(withQuick(query, quick, !query.filters.quick.includes(quick)));
  }

  const chipData: FilterChipData[] = shownChips.map((chip) => {
    const facet = chip.facet;
    const data: FilterChipData = {
      id: chip.id,
      icon: <FacetIcon facet={facet ?? 'quick'} size={12} />,
      field: chip.field,
      summary: chip.summary,
      unknown: chip.unknown,
      removeLabel: chip.removeLabel,
      onRemove: () => {
        if (facet !== null && facet === pendingFacet) setPendingFacet(null);
        navigate(chip.removed);
      },
    };
    if (facet !== null && facet !== 'quick') {
      const values = query.filters[facet].map(String);
      data.renderEditor = (face) => (
        <FacetPicker
          facet={facet}
          query={query}
          values={values}
          face={face}
          faceLabel={`${chip.field} filter: ${chip.summary}`}
          open={openFacet === facet}
          onOpenChange={(open) => {
            setOpenFacet(open ? facet : null);
            if (!open && pendingFacet === facet) setPendingFacet(null);
          }}
          onChange={(next) =>
            navigate(withFilterValues(query, facet, next, lookup))
          }
          optionsState={optionsState}
          today={today}
          viewerId={viewerId}
        />
      );
    }
    return data;
  });

  // ---- moving issues ----------------------------------------------------------

  const canEdit = permissions.canMove;
  const touch = useMediaQuery(TOUCH_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const [selectMode, setSelectMode] = useState(false);
  const moves = useIssueMoves({
    page,
    query,
    viewerId,
    options: optionsState.options,
  });
  const { selected, clearSelection, send } = moves;
  const [menu, setMenu] = useState<MenuState | null>(null);

  // The row that last had focus in the list: Esc on the bulk bar (or the
  // page) clears the selection and puts focus back there.
  const lastRow = useRef<string | null>(null);
  const clearAndRefocus = useCallback(() => {
    clearSelection();
    const id = lastRow.current;
    if (id === null) return;
    const link = document.querySelector<HTMLElement>(
      `[data-nav-item="row"][data-row-id="${CSS.escape(id)}"] [data-nav-target] > a, [data-nav-item="row"][data-row-id="${CSS.escape(id)}"] [data-nav-target] > button`
    );
    link?.focus();
  }, [clearSelection]);
  // The page's Esc listener reads these (it is registered once).
  const openIssueRef = useRef(openIssue);
  const selectionSizeRef = useRef(selected.size);
  const clearAndRefocusRef = useRef(clearAndRefocus);
  useEffect(() => {
    openIssueRef.current = openIssue;
    selectionSizeRef.current = selected.size;
    clearAndRefocusRef.current = clearAndRefocus;
  }, [openIssue, selected, clearAndRefocus]);

  /** The issues a row's menu or keys act on: the selection when the row
      is in it, else the row. */
  const targetsFor = useCallback(
    (rowId: string): MoveTargets => {
      const ids =
        selected.has(rowId) && selected.size > 1 ? [...selected] : [rowId];
      return {
        ids,
        facts: ids
          .map((id) => page.rowFacts[id])
          .filter((f) => f !== undefined),
      };
    },
    [selected, page.rowFacts]
  );

  const selectedTargets: MoveTargets = useMemo(() => {
    const ids = [...selected];
    return {
      ids,
      facts: ids.map((id) => page.rowFacts[id]).filter((f) => f !== undefined),
    };
  }, [selected, page.rowFacts]);

  function onRowAction(action: RowMenuAction, row: TaskRowData) {
    const facts = page.rowFacts[row.id];
    switch (action) {
      case 'open':
        drawerState.open(row.key);
        break;
      case 'page':
        router.push(issuePagePath(row.key));
        break;
      case 'linear':
        if (row.externalHref !== undefined) {
          window.open(row.externalHref, '_blank', 'noopener,noreferrer');
        }
        break;
      case 'copy': {
        const url = `${window.location.origin}${issueListHref(query, { issue: row.key })}`;
        void navigator.clipboard.writeText(url).then(
          () =>
            toast({ kind: 'info', label: 'Copied', message: 'Link copied.' }),
          () =>
            toast({
              kind: 'error',
              label: 'Copy',
              message: `Could not copy the link. It is ${url}`,
            })
        );
        break;
      }
      case 'chain':
        if (facts?.milestoneId !== null && facts?.milestoneId !== undefined) {
          router.push(
            graphHref({ level: 'issue', milestoneId: facts.milestoneId })
          );
        } else if (
          facts?.projectId !== null &&
          facts?.projectId !== undefined
        ) {
          router.push(
            graphHref({ level: 'issue', projectId: facts.projectId })
          );
        }
        break;
      default:
        break;
    }
  }

  // The group whose weight just changed: its toggle gets focus back once
  // the refreshed list (where the group may have moved) renders.
  const refocusGroup = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusGroup.current;
    if (id === null) return;
    refocusGroup.current = null;
    document
      .querySelector<HTMLElement>(
        `[data-group-id="${CSS.escape(id)}"] [data-nav-item="group"] button[data-nav-target]`
      )
      ?.focus();
  }, [page]);

  async function saveWeight(
    group: TaskGroupData,
    choice: 'raise' | 'lower' | 'clear'
  ) {
    const menuData = page.milestoneMenus[group.id];
    if (menuData === undefined) return;
    const next = weightAfter(choice, menuData.weight);
    if (next === undefined) return;
    const answer = await sendJson(
      'PATCH',
      `/api/milestones/${encodeURIComponent(menuData.milestoneId)}`,
      { weight: next }
    );
    if (!answer.ok) {
      toast(notSavedToast(answer, (href) => window.location.assign(href)));
      return;
    }
    toast({
      kind: 'info',
      label: 'Saved',
      message: weightToast(menuData.name, next),
    });
    refocusGroup.current = group.id;
    startTransition(() => router.refresh());
  }

  function onRowKeyDown(
    event: ReactKeyboardEvent<HTMLElement>,
    row: TaskRowData
  ) {
    if (!canEdit) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const stage = ROW_KEY_STAGE[event.key.toLowerCase()];
    if (stage === undefined) return;
    // A pending G chord (G S, G P) belongs to the palette.
    if (palette?.isSequencePending() === true) return;
    event.preventDefault();
    setMenu({ rowId: row.id, stage, open: true, point: null });
  }

  const pick = (ids: readonly string[], change: IssueChange) => {
    send(ids, change);
  };

  function canDrop(rowIds: readonly string[], groupId: string): true | string {
    if (rowIds.length > ISSUE_MOVE_MAX) {
      return `At most ${ISSUE_MOVE_MAX} issues at a time.`;
    }
    const plan = dropPlan(page.targets[groupId], rowIds, page.rowFacts);
    return plan.ok ? true : plan.reason;
  }

  function onDrop(rowIds: readonly string[], groupId: string) {
    const plan = dropPlan(page.targets[groupId], rowIds, page.rowFacts);
    if (plan.ok) send(plan.issueIds, plan.change, { drag: true });
  }

  function renderCell(
    column: TaskColumnId,
    row: TaskRowData
  ): ReactNode | undefined {
    if (!canEdit || moves.pending.has(row.id) || row.pending === true) {
      return undefined;
    }
    const rowFacts = page.rowFacts[row.id];
    if (rowFacts === undefined) return undefined;
    return issueCell({
      column,
      row,
      facts: rowFacts,
      optionsState,
      today,
      viewerId,
      onSave: moves.saveIssue,
    });
  }

  function rowActions(row: TaskRowData): ReactNode {
    const mine = menu !== null && menu.rowId === row.id;
    return (
      <RowMenu
        row={row}
        facts={page.rowFacts[row.id]}
        targets={mine ? targetsFor(row.id) : { ids: [row.id], facts: [] }}
        stage={mine ? menu.stage : 'menu'}
        open={mine && menu.open}
        anchorPoint={mine ? menu.point : null}
        onOpen={() =>
          setMenu({ rowId: row.id, stage: 'menu', open: true, point: null })
        }
        onClose={() =>
          setMenu((current) =>
            current === null || current.rowId !== row.id
              ? current
              : { ...current, open: false }
          )
        }
        onStage={(stage) =>
          setMenu((current) => ({
            rowId: row.id,
            stage,
            open: true,
            point: current?.rowId === row.id ? current.point : null,
          }))
        }
        onAction={(action) => onRowAction(action, row)}
        onPick={(change) => pick(targetsFor(row.id).ids, change)}
        readOnly={permissions.readOnly}
        canWriteLinear={permissions.canWriteLinear}
        optionsState={optionsState}
        today={today}
        viewerId={viewerId}
      />
    );
  }

  function groupActions(group: TaskGroupData): ReactNode {
    if (!permissions.canEditWeight) return null;
    const menuData = page.milestoneMenus[group.id];
    if (menuData === undefined) return null;
    return (
      <MilestoneMenu
        title={group.title}
        menu={menuData}
        bounds={weightBounds}
        onWeight={(choice) => void saveWeight(group, choice)}
        onOpen={() =>
          router.push(
            `/timeline?milestone=${encodeURIComponent(menuData.milestoneId)}`
          )
        }
      />
    );
  }

  // ---- page keys and the shortcuts sheet ------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"]') != null) return;
      // Esc: a popover and the slide-over close themselves first; then
      // it clears the selection and puts focus back on the last row.
      if (event.key === 'Escape') {
        if (openIssueRef.current !== null) return;
        if (selectionSizeRef.current === 0) return;
        event.preventDefault();
        clearAndRefocusRef.current();
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      } else if (event.key === 'f' || event.key === 'F') {
        if (palette?.isSequencePending() === true) return;
        event.preventDefault();
        setFilterOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [palette]);

  const registerShortcutGroup = palette?.registerShortcutGroup;
  const canMove = permissions.canMove;
  // ⌘ on Apple platforms, Ctrl elsewhere (the palette's own row says the same).
  const mod = useModKeyLabel();
  useEffect(
    () =>
      registerShortcutGroup?.({
        title: 'Issues',
        rows: [
          { label: 'Search issues', keys: ['/'] },
          { label: 'Open the filter menu', keys: ['F'] },
          ...(canMove
            ? [
                { label: 'Select the focused issue', keys: ['X'] },
                { label: 'Extend the selection', keys: ['Shift', '↑ ↓'] },
                { label: 'Select every shown issue', keys: [mod, 'A'] },
                { label: 'Move to milestone', keys: ['M'] },
                { label: 'Assign', keys: ['A'] },
                { label: 'Change status', keys: ['S'] },
                { label: 'Change priority', keys: ['P'] },
                { label: 'Clear the selection', keys: ['Esc'] },
              ]
            : []),
          { label: 'Go to Issues', keys: ['G', 'I'] },
        ],
      }),
    [registerShortcutGroup, canMove, mod]
  );

  // ---- the list ---------------------------------------------------------------

  const baseSections = useMemo(
    () =>
      page.sections.map((section: IssueListSectionModel): TaskSectionData => ({
        ...section,
        groups: section.groups.map((group): TaskGroupData => ({
          ...group,
          footer:
            group.footer === undefined
              ? undefined
              : {
                  text: group.footer.text,
                  actions: group.footer.actions.map((action) => ({
                    label: action.label,
                    disabled: action.disabled,
                    onActivate: () =>
                      navigate(
                        action.query,
                        action.replace ? 'replace' : 'push'
                      ),
                  })),
                },
        })),
      })),
    [page.sections, navigate]
  );
  const { decorate } = moves;
  const sections = useMemo(
    () => decorate(baseSections),
    [decorate, baseSections]
  );

  const wanted = openIssue?.toUpperCase() ?? null;
  const activeRow =
    wanted === null
      ? undefined
      : page.sections
          .flatMap((section) => section.groups.flatMap((group) => group.rows))
          .find(
            (row) =>
              row.key.toUpperCase() === wanted ||
              row.id.toUpperCase() === wanted
          );

  async function copyLink() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast({ kind: 'info', label: 'Copied', message: 'Link copied.' });
    } catch {
      toast({
        kind: 'error',
        label: 'Copy',
        message: `Could not copy the link. It is ${url}`,
      });
    }
  }

  const badge = filterBadgeCount(chips);
  // A tab click shows its view at once (tabs, chips, the busy list) like
  // any other view change; its href still opens in a new tab.
  const tabs = issueListTabs(query, counts).map((tab) => {
    const href = tab.href;
    if (href === undefined) return tab;
    const at = href.indexOf('?');
    return {
      ...tab,
      onFollow: () =>
        navigate(shown(parseIssueListSearch(at < 0 ? '' : href.slice(at + 1)))),
    };
  });

  return (
    <>
      <div className={css.tabs}>
        <NavTabs items={tabs} label="Issue presets" />
      </div>
      {page.notices.length > 0 ? (
        <div className={css.notices}>
          {page.notices.map((notice) =>
            notice.id === 'read_only' ? (
              <ReadOnlyNotice key={notice.id} />
            ) : (
              <Notice
                key={notice.id}
                tone="default"
                label={notice.label}
                action={
                  notice.action === undefined ? undefined : (
                    // A plain anchor: the OAuth start must never be prefetched.
                    <Button size="sm" href={notice.action.href}>
                      {notice.action.label}
                    </Button>
                  )
                }
              >
                {notice.text}
              </Notice>
            )
          )}
        </div>
      ) : null}

      <div className={css.toolbarWrap}>
        <ViewToolbar
          label="Issue list options"
          busy={busy}
          search={{
            value: searchText,
            placeholder: 'Search issues',
            label: 'Search issues',
            inputRef: searchInput,
            onChange: (value) => {
              setSearchText(value);
              if (searchTimer.current !== null) {
                window.clearTimeout(searchTimer.current);
              }
              searchTimer.current = window.setTimeout(() => {
                searchTimer.current = null;
                applySearch(value);
              }, SEARCH_DEBOUNCE_MS);
            },
            onCommit: (value) => {
              if (searchTimer.current !== null) {
                window.clearTimeout(searchTimer.current);
                searchTimer.current = null;
              }
              applySearch(value);
              typing.current = 'off';
            },
          }}
          controls={
            <>
              <FilterMenu
                query={query}
                badge={badge}
                facts={facts}
                open={filterOpen}
                onOpenChange={setFilterOpen}
                onField={chooseField}
                onQuick={toggleQuick}
              />
              <SortMenu
                query={query}
                onChange={(values) => navigate(withSortMenu(query, values))}
              />
              <GroupMenu
                query={query}
                hasInitiatives={hasInitiatives}
                onChange={(values) => navigate(withGroupMenu(query, values))}
              />
              {canEdit ? (
                // Always rendered (server and client agree); shown only on
                // touch screens and phones, where the checkboxes wait for it.
                <span className={css.selectWrap}>
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-pressed={selectMode}
                    onClick={() => {
                      if (selectMode) clearSelection();
                      setSelectMode(!selectMode);
                    }}
                    icon={
                      <CheckSquare
                        size={14}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    }
                  >
                    {selectMode ? 'Done' : 'Select'}
                  </Button>
                </span>
              ) : null}
            </>
          }
          end={
            <>
              <Button
                variant="quiet"
                size="sm"
                href={issueListGraphHref(query)}
                icon={
                  <Network size={14} strokeWidth={1.8} aria-hidden="true" />
                }
              >
                Open as graph
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void copyLink()}
                icon={<Link2 size={14} strokeWidth={1.8} aria-hidden="true" />}
              >
                Copy link
              </Button>
            </>
          }
        />
        <FilterChips
          chips={chipData}
          label="Issue filters"
          add={
            <FilterMenu
              variant="add"
              query={query}
              badge={badge}
              facts={facts}
              open={addOpen}
              onOpenChange={setAddOpen}
              onField={chooseField}
              onQuick={toggleQuick}
            />
          }
          onClearAll={() => {
            setPendingFacet(null);
            navigate(withDefaultFilters(query));
          }}
          clearDisabled={hasDefaultFilters(query)}
        />
      </div>

      <div
        className={css.list}
        aria-busy={busy ? 'true' : undefined}
        data-busy={busy ? 'true' : undefined}
        data-selecting={selected.size > 0 ? 'true' : undefined}
        onFocusCapture={(event) => {
          const item = (event.target as Element).closest('[data-row-id]');
          const id = item?.getAttribute('data-row-id');
          if (id !== null && id !== undefined) lastRow.current = id;
        }}
      >
        {page.empty !== null ? (
          <EmptyState
            label="No issues"
            action={
              page.empty.clearable ? (
                <Button
                  size="sm"
                  onClick={() => navigate(withDefaultFilters(query))}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {page.empty.message}
          </EmptyState>
        ) : (
          <TaskGroupTable
            key={page.storageKey}
            sections={sections}
            columns={page.columns}
            columnLabels={ISSUE_LIST_COLUMN_LABELS}
            label="Issues"
            headingLevel={2}
            storageKey={page.storageKey}
            defaultCollapsed={page.defaultCollapsed}
            onOpenRow={(row) => drawerState.open(row.key)}
            activeRowId={activeRow?.id}
            onRowKeyDown={onRowKeyDown}
            // The checkboxes are in the markup whenever the person can move
            // issues; on a touch screen or a phone CSS hides them until the
            // Select button turns selection mode on (no flash after
            // hydration).
            selection={
              canEdit
                ? {
                    selected,
                    onChange: moves.onSelectionChange,
                    toggleOnClick: touch && selectMode,
                    hideOnTouch: !selectMode,
                  }
                : undefined
            }
            dropColumns={DROP_COLUMNS}
            renderCell={renderCell}
            rowActions={rowActions}
            onRowContextMenu={(event, row) => {
              if (touch) return;
              event.preventDefault();
              // At the pointer, as a desktop context menu opens.
              setMenu({
                rowId: row.id,
                stage: 'menu',
                open: true,
                point: { x: event.clientX, y: event.clientY },
              });
            }}
            groupActions={permissions.canEditWeight ? groupActions : undefined}
            drag={
              canEdit
                ? {
                    canDrop,
                    onDrop,
                    label: (n) => (n === 1 ? '1 issue' : `${n} issues`),
                  }
                : undefined
            }
          />
        )}
      </div>
      {canEdit ? (
        <BulkBar
          count={selected.size}
          busy={moves.bar.busy}
          note={moves.bar.note}
          confirm={moves.bar.confirm}
          onClear={clearAndRefocus}
        >
          <BulkActions
            targets={selectedTargets}
            optionsState={optionsState}
            today={today}
            viewerId={viewerId}
            compact={phone}
            onPick={(change) => pick([...selected], change)}
          />
        </BulkBar>
      ) : null}
      <IssueDrawer state={drawerState} fallbackTitle={activeRow?.title} />
    </>
  );
}
