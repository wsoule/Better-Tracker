'use client';

import type { IssueListQuery, IssueListQuick } from '@better-tracker/core';
import { PickerPopover, ToolbarBadge } from '@better-tracker/ui';
import {
  ArrowUpDown,
  CircleDot,
  FolderKanban,
  ListFilter,
  Milestone,
  Plus,
  Rows3,
  SignalHigh,
  Target,
  User,
  Users,
  Zap,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import {
  FACET_LABEL,
  facetNeedsOptions,
  facetPickerOptions,
  filterMenuOptions,
  groupLabel,
  groupMenuOptions,
  groupMenuValue,
  type IssueListFacet,
  moreOption,
  oneChoicePerPart,
  sortLabel,
  sortMenuOptions,
  sortMenuValue,
} from '../../../../lib/adapters/issue-list';
import type { IssueListOptionsState } from './use-issue-list-options';

/* The Issues page's Filter, Sort and Group menus and the filter chips'
   value pickers (architecture §8.4 "Issues"): every one is the ui
   package's PickerPopover. The menus have no search row
   (searchable={false}); Sort and Group are one list with one choice per
   part (sort and direction; grouping and sections), so both choices show
   their check: the single picker's trailing accent tick (marks="tick"),
   never checkbox squares, since each part takes one choice. Value pickers are multi-select and stay open while values
   are toggled; the page applies each change to the URL at once. The
   pickers that list workspace data (initiatives, projects, milestones,
   people, teams) fetch it on first open (useIssueListOptions) and are
   filtered here, at most 200 options at a time. */

const ICON_SIZE = 14;

/** A filter field's 12–14px icon (chips and the Filter menu). */
export function FacetIcon({
  facet,
  size = ICON_SIZE,
}: {
  facet: IssueListFacet;
  size?: number;
}): ReactNode {
  const props = { size, strokeWidth: 1.8, 'aria-hidden': true } as const;
  switch (facet) {
    case 'initiativeIds':
      return <Target {...props} />;
    case 'projectIds':
      return <FolderKanban {...props} />;
    case 'milestoneIds':
      return <Milestone {...props} />;
    case 'assigneeIds':
      return <User {...props} />;
    case 'teamIds':
      return <Users {...props} />;
    case 'stateTypes':
      return <CircleDot {...props} />;
    case 'priorities':
      return <SignalHigh {...props} />;
    case 'quick':
      return <Zap {...props} />;
  }
}

/**
 * The toolbar's Filter menu: the fields (choosing one adds its chip and
 * opens the chip's picker) and the quick filters (choosing one turns it on
 * or off). `open` is controlled so the page's `f` key can open it.
 */
export function FilterMenu({
  query,
  badge,
  facts,
  open,
  onOpenChange,
  onField,
  onQuick,
  variant = 'toolbar',
}: {
  query: IssueListQuery;
  /** The set fields, the default status not counted. */
  badge: number;
  facts: { hasInitiatives: boolean; teamCount: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onField: (facet: IssueListFacet) => void;
  onQuick: (quick: IssueListQuick) => void;
  /** toolbar: "Filter" with the count badge; add: the chips bar's
      "+ Filter". */
  variant?: 'toolbar' | 'add';
}): ReactNode {
  const add = variant === 'add';
  return (
    <PickerPopover
      label="Filter"
      searchable={false}
      action
      appearance="quiet"
      value={null}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        add ? (
          <>
            <Plus size={12} strokeWidth={1.8} aria-hidden="true" />
            Filter
          </>
        ) : (
          <>
            <ListFilter size={ICON_SIZE} strokeWidth={1.8} aria-hidden="true" />
            Filter
            {badge > 0 ? <ToolbarBadge count={badge} /> : null}
          </>
        )
      }
      triggerLabel={
        add ? 'Add a filter' : badge > 0 ? `Filter, ${badge} set` : 'Filter'
      }
      options={filterMenuOptions(query, facts)}
      onChange={(value) => {
        if (value === null) return;
        if (value.startsWith('quick:')) {
          onQuick(value.slice(6) as IssueListQuick);
        } else if (value.startsWith('field:')) {
          onField(value.slice(6) as IssueListFacet);
        }
      }}
    />
  );
}

/** The toolbar's Sort menu: the sort, then (for a field sort) its direction. */
export function SortMenu({
  query,
  onChange,
}: {
  query: IssueListQuery;
  onChange: (values: string[]) => void;
}): ReactNode {
  const label = sortLabel(query);
  return (
    <PickerPopover
      label="Sort"
      multiple
      marks="tick"
      searchable={false}
      appearance="quiet"
      value={sortMenuValue(query)}
      resolveToggle={oneChoicePerPart}
      trigger={
        <>
          <ArrowUpDown size={ICON_SIZE} strokeWidth={1.8} aria-hidden="true" />
          <span data-toolbar-word="">Sort:</span> {label}
        </>
      }
      triggerLabel={`Sort: ${label}`}
      options={sortMenuOptions(query)}
      onChange={onChange}
    />
  );
}

/** The toolbar's Group menu: the grouping, then the sections level. */
export function GroupMenu({
  query,
  hasInitiatives,
  onChange,
}: {
  query: IssueListQuery;
  /** The viewer sees initiatives (else their choices are disabled). */
  hasInitiatives: boolean;
  onChange: (values: string[]) => void;
}): ReactNode {
  const label = groupLabel(query);
  return (
    <PickerPopover
      label="Group"
      multiple
      marks="tick"
      searchable={false}
      appearance="quiet"
      value={groupMenuValue(query)}
      resolveToggle={oneChoicePerPart}
      trigger={
        <>
          <Rows3 size={ICON_SIZE} strokeWidth={1.8} aria-hidden="true" />
          <span data-toolbar-word="">Group:</span> {label}
        </>
      }
      triggerLabel={`Group: ${label}`}
      options={groupMenuOptions(query, hasInitiatives)}
      onChange={onChange}
    />
  );
}

/**
 * A filter chip's value picker, wrapped around the chip's face: a
 * multi-select list of that field's values (search filtered here), each
 * toggle applied at once. Opening it fetches the workspace options the
 * first time.
 */
export function FacetPicker({
  facet,
  query,
  values,
  face,
  faceLabel,
  open,
  onOpenChange,
  onChange,
  optionsState,
  today,
  viewerId,
}: {
  facet: Exclude<IssueListFacet, 'quick'>;
  query: IssueListQuery;
  values: readonly string[];
  face: ReactNode;
  faceLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (values: string[]) => void;
  optionsState: IssueListOptionsState;
  today: string;
  viewerId: string;
}): ReactNode {
  const [search, setSearch] = useState('');
  const needsOptions = facetNeedsOptions(facet);
  const list = facetPickerOptions(facet, optionsState.options, {
    query,
    today,
    viewerId,
    search,
  });
  const waiting = needsOptions && optionsState.options === null;
  // Opened by the page (a field chosen in the Filter menu) as well as by
  // a click: either way the workspace options are fetched once.
  const { load } = optionsState;
  useEffect(() => {
    if (open && needsOptions) load();
  }, [open, needsOptions, load]);
  return (
    <PickerPopover
      label={FACET_LABEL[facet]}
      multiple
      appearance="quiet"
      value={values}
      trigger={face}
      triggerLabel={faceLabel}
      searchPlaceholder={`Filter by ${FACET_LABEL[facet].toLowerCase()}…`}
      options={
        list.more > 0 ? [...list.options, moreOption(list.more)] : list.options
      }
      filter={false}
      query={search}
      onQueryChange={setSearch}
      loading={waiting && optionsState.error === null}
      error={needsOptions ? optionsState.error : null}
      onRetry={optionsState.retry}
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch('');
        onOpenChange(next);
      }}
      onChange={onChange}
    />
  );
}
