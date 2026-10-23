import {
  ALL_STATE_TYPES,
  DEFAULT_ISSUE_LIST_QUERY,
  diffDays,
  foldText,
  ISSUE_LIST_DEFAULT_DIR,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_GROUP_LABEL,
  ISSUE_LIST_LIMIT_STEP,
  ISSUE_LIST_MAX_GROUPS,
  ISSUE_LIST_MAX_LIMIT,
  ISSUE_LIST_PRESET_LABEL,
  ISSUE_LIST_PRESETS,
  ISSUE_LIST_QUICK_LABEL,
  ISSUE_LIST_SECTION_LABEL,
  ISSUE_LIST_SORT_HINT,
  ISSUE_LIST_SORT_LABEL,
  ISSUE_LIST_TIER_LABEL,
  type IssueListFilters,
  type IssueListGroup,
  type IssueListGroupBy,
  type IssueListOptions,
  type IssueListPresetId,
  type IssueListQuery,
  type IssueListQuick,
  type IssueListRefs,
  type IssueListRow,
  type IssueListSection,
  type IssueListSectionBy,
  type IssueListSort,
  type IssueListView,
  LIST_ME,
  LIST_NONE,
  normalizeIssueListQuery,
  OPEN_STATE_TYPES,
  type Priority,
  PRIORITY_LABEL,
  sameIssueListFilters,
  STATE_TYPE_LABEL,
  type WorkflowStateType,
} from '@better-tracker/core';
import type {
  NavTabItem,
  PickerOption,
  TaskColumnId,
  TaskGroupData,
  TaskRowData,
  TaskSectionData,
} from '@better-tracker/ui';

import { formatDate, plural } from '../format';
import type { ReadOnlyReasonCopy } from '../read-only';
import { readOnlyNotice } from '../read-only';
import { GRAPH_PATH, graphHref } from './graph';
import type {
  IssueGroupTarget,
  IssueRowFacts,
  MilestoneMenuData,
} from './issue-moves';
import { dueTone, progressTone } from './projects';
import {
  assessmentMark,
  blockedReasonLine,
  statusLabel,
  uiStatus,
} from './status';
import { missingLabel, timelineGrantWriteHref, weightTag } from './timeline';

// The Issues page (architecture §8.4 "Issues", §2.14; owner request
// 2026-10-22, "every issue in one list"): the URL grammar of /issues
// (parse, canonical href, filter changes with their cascade) and the
// core IssueListView mapped onto the ui package's TaskGroupTable,
// NavTabs and FilterChips shapes, plus everything the page says around
// it (heading, receipts, notices, the empty state). Pure functions; the
// server page builds the model once, and the client island recomputes
// only what follows its own, not yet answered, query (chips, tabs,
// toolbar labels) with the same functions.

/** The page's path. */
export const ISSUES_PATH = '/issues';

/** The id filter fields, in URL order, with their URL parameter. */
const ID_PARAMS = [
  ['initiative', 'initiativeIds'],
  ['project', 'projectIds'],
  ['milestone', 'milestoneIds'],
  ['assignee', 'assigneeIds'],
  ['team', 'teamIds'],
] as const;

/** A filter field the chips and pickers edit (every field but the text). */
export type IssueListFacet = Exclude<keyof IssueListFilters, 'q'>;

/** Priorities as the URL spells them (Linear's 0–4 scale). */
const PRIORITY_ORDER_ALL: readonly Priority[] = [0, 1, 2, 3, 4];

const PRIORITY_TOKEN: Record<Priority, string> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};

const PRIORITY_BY_TOKEN: ReadonlyMap<string, Priority> = new Map(
  PRIORITY_ORDER_ALL.map((priority) => [PRIORITY_TOKEN[priority], priority])
);

/** The priorities in the order the pickers and groups list them. */
export const PRIORITY_ORDER: readonly Priority[] = [1, 2, 3, 4, 0];

/** The preset tabs, left to right. */
export const ISSUE_LIST_PRESET_IDS: readonly IssueListPresetId[] = [
  'all',
  'mine',
  'unplanned',
  'unassigned',
  'blocked',
  'at_risk',
];

type SearchParams = Record<string, string | string[] | undefined>;

// Every value of a parameter as one comma-separated string (a repeated
// parameter, ?project=a&project=b, reads like ?project=a,b).
function joined(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

// The first value of a single-valued parameter.
function single(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The view a /issues URL describes (architecture §8.4 "Issues", the URL
 * grammar): every parameter is lenient, so old and shared links keep
 * working; unknown parameters and values are ignored and the rest goes
 * through core's normalizeIssueListQuery (caps, clamps, invalid pairs).
 * `state=all` means every status; no `state` means the open ones.
 */
export function parseIssueListParams(params: SearchParams): IssueListQuery {
  const state = joined(params, 'state');
  const stateTypes =
    state === undefined
      ? []
      : state
            .split(',')
            .map((value) => value.trim())
            .includes('all')
        ? [...ALL_STATE_TYPES]
        : state.split(',');
  const priorities: Priority[] = [];
  for (const token of (joined(params, 'priority') ?? '').split(',')) {
    const priority = PRIORITY_BY_TOKEN.get(token.trim().toLowerCase());
    if (priority !== undefined) priorities.push(priority);
  }
  const filters: Record<string, unknown> = {
    q: single(params, 'q') ?? '',
    stateTypes,
    priorities,
    quick: joined(params, 'quick') ?? '',
  };
  for (const [param, field] of ID_PARAMS) {
    filters[field] = joined(params, param) ?? '';
  }
  return normalizeIssueListQuery({
    filters,
    group: single(params, 'group'),
    sections: single(params, 'sections'),
    sort: single(params, 'sort'),
    dir: single(params, 'dir'),
    limit: single(params, 'limit'),
  });
}

/** The same, from a query string or URLSearchParams (the client island). */
export function parseIssueListSearch(
  search: URLSearchParams | string
): IssueListQuery {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  const record: Record<string, string[]> = {};
  for (const [name, value] of params) (record[name] ??= []).push(value);
  return parseIssueListParams(record);
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every((value) => right.has(value));
}

/** The status filter is the default one (the four open types). */
export function isOpenStatusFilter(
  types: readonly WorkflowStateType[]
): boolean {
  return sameSet(types, OPEN_STATE_TYPES);
}

/** The status filter names every type (no status condition). */
export function isAnyStatusFilter(
  types: readonly WorkflowStateType[]
): boolean {
  return sameSet(types, ALL_STATE_TYPES);
}

/**
 * The canonical /issues URL of a view: parameters in a fixed order
 * (q, initiative, project, milestone, assignee, team, state, priority,
 * quick, group, sections, sort, dir, limit, issue), defaults left out,
 * values of a field comma-separated in the order given. `issue` opens
 * that issue in the slide-over.
 */
export function issueListHref(
  query: IssueListQuery,
  options: { issue?: string | null } = {}
): string {
  const parts: string[] = [];
  const add = (name: string, values: readonly string[]) => {
    parts.push(`${name}=${values.map(encodeURIComponent).join(',')}`);
  };
  const { filters } = query;
  if (filters.q !== '') add('q', [filters.q]);
  for (const [param, field] of ID_PARAMS) {
    if (filters[field].length > 0) add(param, filters[field]);
  }
  if (!isOpenStatusFilter(filters.stateTypes)) {
    add(
      'state',
      isAnyStatusFilter(filters.stateTypes) ? ['all'] : filters.stateTypes
    );
  }
  if (filters.priorities.length > 0) {
    add(
      'priority',
      filters.priorities.map((p) => PRIORITY_TOKEN[p])
    );
  }
  if (filters.quick.length > 0) add('quick', filters.quick);
  if (query.group !== DEFAULT_ISSUE_LIST_QUERY.group)
    add('group', [query.group]);
  if (query.sections !== DEFAULT_ISSUE_LIST_QUERY.sections) {
    add('sections', [query.sections]);
  }
  if (query.sort !== DEFAULT_ISSUE_LIST_QUERY.sort) add('sort', [query.sort]);
  if (
    query.sort !== 'weight' &&
    query.dir !== ISSUE_LIST_DEFAULT_DIR[query.sort]
  ) {
    add('dir', [query.dir]);
  }
  if (query.limit > ISSUE_LIST_DEFAULT_LIMIT)
    add('limit', [String(query.limit)]);
  if (
    options.issue !== undefined &&
    options.issue !== null &&
    options.issue !== ''
  ) {
    add('issue', [options.issue]);
  }
  return parts.length === 0 ? ISSUES_PATH : `${ISSUES_PATH}?${parts.join('&')}`;
}

/** Looks up which project a milestone belongs to (the cascade needs it). */
export type MilestoneProjectLookup = (
  milestoneId: string
) => string | null | undefined;

/**
 * The view with one filter field set to `values` (the row budget starts
 * over: a new filter is a new view). Applies the cascade: removing a
 * project from the project filter also drops that project's milestones
 * from the milestone filter, when `milestoneProjectId` can say which
 * project a milestone is in. Initiative and project stay independent.
 */
export function withFilterValues(
  query: IssueListQuery,
  facet: IssueListFacet,
  values: readonly (string | number)[],
  milestoneProjectId?: MilestoneProjectLookup
): IssueListQuery {
  const filters: Record<string, unknown> = {
    ...query.filters,
    [facet]: [...values],
  };
  if (facet === 'projectIds' && milestoneProjectId !== undefined) {
    const kept = new Set(values.map(String));
    const removed = new Set(
      query.filters.projectIds.filter((id) => !kept.has(id))
    );
    filters['milestoneIds'] = query.filters.milestoneIds.filter((id) => {
      if (id === LIST_NONE) return true;
      const projectId = milestoneProjectId(id);
      return (
        projectId === null || projectId === undefined || !removed.has(projectId)
      );
    });
  }
  return normalizeIssueListQuery({
    ...query,
    filters,
    limit: ISSUE_LIST_DEFAULT_LIMIT,
  });
}

/** The view with another text search (the row budget starts over). */
export function withSearch(query: IssueListQuery, q: string): IssueListQuery {
  return normalizeIssueListQuery({
    ...query,
    filters: { ...query.filters, q },
    limit: ISSUE_LIST_DEFAULT_LIMIT,
  });
}

/** The view with a quick filter turned on or off. */
export function withQuick(
  query: IssueListQuery,
  quick: IssueListQuick,
  on: boolean
): IssueListQuery {
  const rest = query.filters.quick.filter((value) => value !== quick);
  return withFilterValues(query, 'quick', on ? [...rest, quick] : rest);
}

/**
 * The view with another grouping, sections, sort or direction. A new
 * sort starts at its own default direction; a sections level that no
 * longer fits the grouping is dropped (core's rule).
 */
export function withLayout(
  query: IssueListQuery,
  patch: Partial<Pick<IssueListQuery, 'group' | 'sections' | 'sort' | 'dir'>>
): IssueListQuery {
  const sort = patch.sort ?? query.sort;
  const dir =
    patch.dir ??
    (patch.sort !== undefined && patch.sort !== query.sort
      ? ISSUE_LIST_DEFAULT_DIR[sort]
      : query.dir);
  return normalizeIssueListQuery({
    ...query,
    group: patch.group ?? query.group,
    sections: patch.sections ?? query.sections,
    sort,
    dir,
  });
}

/** The view with the default filters (open issues), layout kept. */
export function withDefaultFilters(query: IssueListQuery): IssueListQuery {
  return normalizeIssueListQuery({
    ...query,
    filters: DEFAULT_ISSUE_LIST_QUERY.filters,
    limit: ISSUE_LIST_DEFAULT_LIMIT,
  });
}

/** "Show more": the row budget grows by one step, up to the maximum. */
export function withMoreRows(query: IssueListQuery): IssueListQuery {
  return normalizeIssueListQuery({
    ...query,
    limit: Math.min(ISSUE_LIST_MAX_LIMIT, query.limit + ISSUE_LIST_LIMIT_STEP),
  });
}

/**
 * The view for a viewer who sees no initiatives (a Linear guest, or a
 * workspace without any): core's fallback (§2.14) applied on the client
 * too, so the toolbar names what the list shows: no initiative values,
 * grouped by project instead of initiative, no initiative sections.
 */
export function withoutInitiatives(query: IssueListQuery): IssueListQuery {
  if (
    query.filters.initiativeIds.length === 0 &&
    query.group !== 'initiative' &&
    query.sections !== 'initiative'
  ) {
    return query;
  }
  return normalizeIssueListQuery({
    ...query,
    filters: { ...query.filters, initiativeIds: [] },
    group: query.group === 'initiative' ? 'project' : query.group,
    sections: query.sections === 'initiative' ? 'none' : query.sections,
  });
}

/** The filters are the default ones (Clear all has nothing to do). */
export function hasDefaultFilters(query: IssueListQuery): boolean {
  return sameIssueListFilters(query.filters, DEFAULT_ISSUE_LIST_QUERY.filters);
}

// ---------------------------------------------------------------------------
// Names: what the chips and headers call ids
// ---------------------------------------------------------------------------

/**
 * Names for filter values: the view's refs (what the server answered)
 * and, on the client, the picker options fetched since (values chosen
 * before the server has answered). Undefined = the planner does not know
 * the id ("Not found").
 */
export interface IssueListNames {
  initiative(id: string): string | undefined;
  project(id: string): string | undefined;
  milestone(id: string): string | undefined;
  person(id: string): string | undefined;
  team(id: string): string | undefined;
}

/** Names from a view's refs. */
export function namesFromRefs(refs: IssueListRefs): IssueListNames {
  return {
    initiative: (id) => refs.initiatives[id]?.name,
    project: (id) => refs.projects[id]?.name,
    milestone: (id) => refs.milestones[id]?.name,
    person: (id) => refs.people[id]?.name,
    team: (id) => refs.teams[id]?.name,
  };
}

/**
 * The names of the current filter values only (plain data for the client
 * island, which needs them for the chips and the project → milestone
 * cascade but not the whole refs): ids the view's refs hold, by field.
 */
export interface IssueListFilterNames {
  initiatives: Record<string, string>;
  projects: Record<string, string>;
  milestones: Record<string, { name: string; projectId: string }>;
  people: Record<string, string>;
  teams: Record<string, string>;
}

/** The filter values' names from a view (what its refs hold of them). */
export function filterValueNames(view: IssueListView): IssueListFilterNames {
  const { filters } = view.query;
  const { refs } = view;
  const pick = <T, U>(
    ids: readonly string[],
    table: Record<string, T>,
    map: (value: T) => U
  ): Record<string, U> => {
    const out: Record<string, U> = {};
    for (const id of ids) {
      const value = table[id];
      if (value !== undefined) out[id] = map(value);
    }
    return out;
  };
  return {
    initiatives: pick(filters.initiativeIds, refs.initiatives, (i) => i.name),
    projects: pick(filters.projectIds, refs.projects, (p) => p.name),
    milestones: pick(filters.milestoneIds, refs.milestones, (m) => ({
      name: m.name,
      projectId: m.projectId,
    })),
    people: pick(filters.assigneeIds, refs.people, (p) => p.name),
    teams: pick(filters.teamIds, refs.teams, (t) => t.name),
  };
}

/** Names from filterValueNames' tables. */
export function namesFromFilterNames(
  names: IssueListFilterNames
): IssueListNames {
  return {
    initiative: (id) => names.initiatives[id],
    project: (id) => names.projects[id],
    milestone: (id) => names.milestones[id]?.name,
    person: (id) => names.people[id],
    team: (id) => names.teams[id],
  };
}

/** Each lookup tries `first`, then `second`. */
export function mergeNames(
  first: IssueListNames,
  second: IssueListNames
): IssueListNames {
  return {
    initiative: (id) => first.initiative(id) ?? second.initiative(id),
    project: (id) => first.project(id) ?? second.project(id),
    milestone: (id) => first.milestone(id) ?? second.milestone(id),
    person: (id) => first.person(id) ?? second.person(id),
    team: (id) => first.team(id) ?? second.team(id),
  };
}

// ---------------------------------------------------------------------------
// Chips, tabs, toolbar labels (built from the query the island shows)
// ---------------------------------------------------------------------------

/** What a chip is about: a filter field, or one quick filter. */
export type IssueListChipId = IssueListFacet | `quick:${IssueListQuick}`;

/** One filter chip ("Project is Atlas billing migration"), plain data. */
export interface IssueListChipModel {
  id: IssueListChipId;
  /** The field the chip's picker edits (null for a quick filter). */
  facet: IssueListFacet | null;
  field: string;
  summary: string;
  /** A value the planner does not hold ("Not found"). */
  unknown: boolean;
  removeLabel: string;
  /** The view without this chip. */
  removed: IssueListQuery;
  /** The default "Status is open" chip (not counted on the Filter badge). */
  isDefault: boolean;
}

/** The chip's field name per facet. */
export const FACET_LABEL: Record<IssueListFacet, string> = {
  initiativeIds: 'Initiative',
  projectIds: 'Project',
  milestoneIds: 'Milestone',
  assigneeIds: 'Assignee',
  teamIds: 'Team',
  stateTypes: 'Status',
  priorities: 'Priority',
  quick: 'Issue',
};

/** "3 projects", "3 people", … for a chip with three or more values. */
const FACET_PLURAL: Record<IssueListFacet, [string, string]> = {
  initiativeIds: ['initiative', 'initiatives'],
  projectIds: ['project', 'projects'],
  milestoneIds: ['milestone', 'milestones'],
  assigneeIds: ['person', 'people'],
  teamIds: ['team', 'teams'],
  stateTypes: ['status', 'statuses'],
  priorities: ['priority', 'priorities'],
  quick: ['filter', 'filters'],
};

/** A quick filter's chip reads "Issue is blocked". */
const QUICK_SUMMARY: Record<IssueListQuick, string> = {
  blocked: 'blocked',
  at_risk: 'at risk',
  next: 'in a next milestone',
};

/** The words a "Not found" value reads as. */
export const NOT_FOUND = 'Not found';

// One id filter value's name, or undefined when the planner lacks it.
function valueName(
  facet: IssueListFacet,
  id: string,
  names: IssueListNames
): string | undefined {
  switch (facet) {
    case 'initiativeIds':
      return id === LIST_NONE ? 'No initiative' : names.initiative(id);
    case 'projectIds':
      return id === LIST_NONE ? 'No project' : names.project(id);
    case 'milestoneIds':
      return id === LIST_NONE ? 'No milestone' : names.milestone(id);
    case 'assigneeIds':
      return id === LIST_ME
        ? 'Me'
        : id === LIST_NONE
          ? 'Unassigned'
          : names.person(id);
    case 'teamIds':
      return names.team(id);
    default:
      return undefined;
  }
}

// "A, B" for one or two values, "3 projects" from three on.
function summarize(facet: IssueListFacet, values: readonly string[]): string {
  if (values.length >= 3) {
    const [one, many] = FACET_PLURAL[facet];
    return plural(values.length, one, many);
  }
  return values.join(', ');
}

/**
 * The filter chips, one per set field in URL order and one per quick
 * filter: "Project is Atlas billing migration, Beacon search", "3
 * milestones" from three values on, "Not found" for an id the planner
 * does not hold (flagged). The open-status default shows as "Status is
 * open"; removing it means every status (state=all). With every status
 * there is no status chip.
 */
export function issueListChips(
  query: IssueListQuery,
  names: IssueListNames
): IssueListChipModel[] {
  const chips: IssueListChipModel[] = [];
  const { filters } = query;
  for (const [, facet] of ID_PARAMS) {
    const ids = filters[facet];
    if (ids.length === 0) continue;
    let unknown = false;
    const labels = ids.map((id) => {
      const name = valueName(facet, id, names);
      if (name === undefined) unknown = true;
      return name ?? NOT_FOUND;
    });
    chips.push({
      id: facet,
      facet,
      field: FACET_LABEL[facet],
      summary: summarize(facet, labels),
      unknown,
      removeLabel: `Remove ${FACET_LABEL[facet].toLowerCase()} filter`,
      removed: withFilterValues(query, facet, []),
      isDefault: false,
    });
  }
  if (isAnyStatusFilter(filters.stateTypes)) {
    // Every status (the open chip removed): said, counted, and undone by
    // its ×, so closed issues never come in silently.
    chips.push({
      id: 'stateTypes',
      facet: 'stateTypes',
      field: FACET_LABEL.stateTypes,
      summary: 'any',
      unknown: false,
      removeLabel: 'Back to open issues only',
      removed: withFilterValues(query, 'stateTypes', OPEN_STATE_TYPES),
      isDefault: false,
    });
  } else {
    const isDefault = isOpenStatusFilter(filters.stateTypes);
    chips.push({
      id: 'stateTypes',
      facet: 'stateTypes',
      field: FACET_LABEL.stateTypes,
      summary: isDefault
        ? 'open'
        : summarize(
            'stateTypes',
            filters.stateTypes.map((type) => STATE_TYPE_LABEL[type])
          ),
      unknown: false,
      removeLabel: 'Remove status filter',
      removed: withFilterValues(query, 'stateTypes', ALL_STATE_TYPES),
      isDefault,
    });
  }
  if (filters.priorities.length > 0) {
    chips.push({
      id: 'priorities',
      facet: 'priorities',
      field: FACET_LABEL.priorities,
      summary: summarize(
        'priorities',
        filters.priorities.map((p) => PRIORITY_LABEL[p])
      ),
      unknown: false,
      removeLabel: 'Remove priority filter',
      removed: withFilterValues(query, 'priorities', []),
      isDefault: false,
    });
  }
  for (const quick of filters.quick) {
    chips.push({
      id: `quick:${quick}`,
      facet: null,
      field: FACET_LABEL.quick,
      summary: QUICK_SUMMARY[quick],
      unknown: false,
      removeLabel: `Remove the ${QUICK_SUMMARY[quick]} filter`,
      removed: withQuick(query, quick, false),
      isDefault: false,
    });
  }
  return chips;
}

/** The Filter button's badge: the set fields, the default status not counted. */
export function filterBadgeCount(chips: readonly IssueListChipModel[]): number {
  return chips.filter((chip) => !chip.isDefault).length;
}

/**
 * The preset tabs (All · Mine · Unplanned · Unassigned · Blocked · At
 * risk) with each preset's own count; each keeps the current grouping,
 * sections and sort. A tab is current when the filters are exactly its
 * preset's, otherwise none is.
 */
export function issueListTabs(
  query: IssueListQuery,
  counts: Record<IssueListPresetId, number>
): NavTabItem[] {
  return ISSUE_LIST_PRESET_IDS.map((id) => {
    const preset = ISSUE_LIST_PRESETS[id];
    const href = issueListHref(
      normalizeIssueListQuery({
        ...query,
        filters: preset,
        limit: ISSUE_LIST_DEFAULT_LIMIT,
      })
    );
    return {
      id,
      label: ISSUE_LIST_PRESET_LABEL[id],
      href,
      count: counts[id],
      current: sameIssueListFilters(query.filters, preset),
    };
  });
}

/** "Sort: Weight", "Sort: Due date ↓" (the trigger's face). */
export function sortLabel(query: IssueListQuery): string {
  const name = ISSUE_LIST_SORT_LABEL[query.sort];
  if (query.sort === 'weight') return name;
  return query.dir === ISSUE_LIST_DEFAULT_DIR[query.sort]
    ? name
    : `${name}, reversed`;
}

/** "Milestone", "Milestone · by initiative" (the Group trigger's face). */
export function groupLabel(query: IssueListQuery): string {
  const name = ISSUE_LIST_GROUP_LABEL[query.group];
  return query.sections === 'none'
    ? name
    : `${name} · by ${ISSUE_LIST_SECTION_LABEL[query.sections].toLowerCase()}`;
}

/**
 * "Open as graph": the graph of the narrowest single container the
 * filters name: one milestone's or one project's issues (a `none` value
 * of either is not a container and is skipped), else one initiative's
 * projects (`initiative=none` is one: the projects in no initiative),
 * else the whole graph. A guest's query carries no initiative filter
 * (the no-initiatives fallback), so a guest never gets an initiative link.
 */
export function issueListGraphHref(query: IssueListQuery): string {
  const real = (ids: readonly string[]) => ids.filter((id) => id !== LIST_NONE);
  const milestones = real(query.filters.milestoneIds);
  if (milestones.length === 1 && milestones[0] !== undefined) {
    return graphHref({ level: 'issue', milestoneId: milestones[0] });
  }
  const projects = real(query.filters.projectIds);
  if (projects.length === 1 && projects[0] !== undefined) {
    return graphHref({ level: 'issue', projectId: projects[0] });
  }
  const [initiative, ...otherInitiatives] = query.filters.initiativeIds;
  if (initiative !== undefined && otherInitiatives.length === 0) {
    return graphHref({ level: 'project', initiativeId: initiative });
  }
  return GRAPH_PATH;
}

/** The meta columns per grouping: the one the group heading names is dropped. */
export function issueListColumns(group: IssueListGroupBy): TaskColumnId[] {
  const base: TaskColumnId[] = [
    'milestone',
    'assignee',
    'state',
    'priority',
    'due',
  ];
  const dropped: Partial<Record<IssueListGroupBy, TaskColumnId>> = {
    milestone: 'milestone',
    assignee: 'assignee',
    state: 'state',
    priority: 'priority',
  };
  return base.filter((column) => column !== dropped[group]);
}

/** The column headers ("Status", as the filter calls it, not "State"). */
export const ISSUE_LIST_COLUMN_LABELS: Partial<
  Record<TaskColumnId | 'title', string>
> = { state: 'Status' };

/** Where each grouping's collapsed groups are remembered (per viewer). */
export function collapsedStorageKey(group: IssueListGroupBy): string {
  return `milestone-planner:issues:collapsed:${group}`;
}

// ---------------------------------------------------------------------------
// The page model (server)
// ---------------------------------------------------------------------------

/** A footer action of a group: a view to go to (pushed, or replaced). */
export interface IssueListFooterAction {
  label: string;
  /** The view the action shows. */
  query: IssueListQuery;
  /** Replace the URL (Show more) rather than push it (Only this …). */
  replace: boolean;
  disabled?: boolean;
}

/** A TaskGroupData whose footer actions are views, not callbacks. */
export type IssueListGroupModel = Omit<TaskGroupData, 'footer'> & {
  footer?: { text: string; actions: IssueListFooterAction[] };
};

export interface IssueListSectionModel extends Omit<TaskSectionData, 'groups'> {
  groups: IssueListGroupModel[];
}

/** One quiet notice under the tabs. */
export interface IssueListNotice {
  id:
    | 'read_only'
    | 'grant'
    | 'fallback'
    | 'unknown'
    | `also_in:${string}`
    | 'closed'
    | 'more_groups';
  /** Lead-in word ("Linear read only"); none for most. */
  label?: string;
  text: string;
  action?: { label: string; href: string };
}

export interface IssueListPageModel {
  heading: string;
  subtitle: string;
  receipts: string;
  notices: IssueListNotice[];
  columns: TaskColumnId[];
  sections: IssueListSectionModel[];
  /** Folded when nothing is stored: complete milestones, unloaded groups. */
  defaultCollapsed: string[];
  storageKey: string;
  /** Shown instead of the list when no group is listed at all. */
  empty: { message: string; clearable: boolean } | null;
  /** Each shown row's current values (moves compare against them), by
      issue id. */
  rowFacts: Record<string, IssueRowFacts>;
  /** What dropping on each group does, by group key. */
  targets: Record<string, IssueGroupTarget>;
  /** Each milestone group's milestone and weight (its "…" menu), by
      group key. */
  milestoneMenus: Record<string, MilestoneMenuData>;
  /** Names of the projects the rows and groups reference (a move's
      confirmation names the projects issues leave). */
  projectNames: Record<string, string>;
}

export interface IssueListPageInput {
  view: IssueListView;
  /** The URL's own query (before the no-initiatives fallback): row links
      and footer views keep it. */
  query: IssueListQuery;
  viewerId: string;
  readOnly: boolean;
  readOnlyReason?: ReadOnlyReasonCopy | undefined;
  canWriteLinear: boolean;
  /** Moving issues is offered here (the empty target's wording). */
  canMove: boolean;
  /** Whether an issue blocks or waits on another (the row menu's
      Blocking chain); none when omitted. */
  related?: (issueId: string) => boolean;
}

/** "{n} open issues · …" or "{total} match these filters · …". */
export function issueListReceipts(view: IssueListView): string {
  const { counts } = view;
  const parts = hasDefaultFilters(view.query)
    ? [
        plural(counts.all, 'open issue'),
        `${counts.unplanned} without a milestone`,
        `${counts.blocked} blocked`,
        `${counts.at_risk} at risk`,
      ]
    : [
        `${view.total} ${view.total === 1 ? 'matches' : 'match'} these filters`,
        `${counts.all} open in all`,
      ];
  if (view.shown < view.total) parts.push(`showing ${view.shown}`);
  return parts.join(' · ');
}

// The page's notices, in the order of architecture §8.4 "Issues".
function notices(input: IssueListPageInput): IssueListNotice[] {
  const { view } = input;
  const out: IssueListNotice[] = [];
  if (input.readOnly) {
    out.push({ id: 'read_only', text: readOnlyNotice(input.readOnlyReason) });
  } else if (!input.canWriteLinear) {
    out.push({
      id: 'grant',
      label: 'Linear read only',
      text: 'Allow edits in Linear to change issues here.',
      action: {
        label: 'Allow edits in Linear',
        href: timelineGrantWriteHref(issueListHref(input.query)),
      },
    });
  }
  if (view.fallback !== null) {
    const reason = input.readOnly ? (input.readOnlyReason ?? 'guest') : null;
    out.push({
      id: 'fallback',
      text:
        reason === 'guest'
          ? 'Linear shows guests no initiatives, so this list covers every project you can see.'
          : reason === 'unknown'
            ? 'The planner has not seen your Linear account yet, so it shows you no initiatives; this list covers every project you can see.'
            : 'This workspace has no initiatives in Linear, so the list is grouped by project.',
    });
  }
  if (view.unknownIds.length > 0) {
    out.push({
      id: 'unknown',
      text: 'A filter names something that is not in the planner (closed, deleted, or in a team you cannot see), so nothing matches it.',
    });
  }
  for (const also of view.alsoIn) {
    out.push({
      id: `also_in:${also.projectId}`,
      text: `${also.projectName} is also in ${also.chosenInitiativeName} and counts under ${also.homeInitiativeName}, its first initiative, as on the timeline.`,
    });
  }
  if (view.includesClosed) {
    out.push({
      id: 'closed',
      text: 'Closed issues are listed only for projects that are still open: the planner does not keep closed projects, or closed issues without a project.',
    });
  }
  if (view.moreGroups.groups > 0) {
    out.push({
      id: 'more_groups',
      text: `Showing the first ${ISSUE_LIST_MAX_GROUPS} groups. ${plural(view.moreGroups.groups, 'more group')} hold ${plural(view.moreGroups.issues, 'issue')}. Narrow the filter to see them.`,
    });
  }
  return out;
}

/**
 * An issue's own due date, coloured the way the issue page colours it
 * (architecture §8.2 "due date"): danger (red) overdue, warning (amber)
 * due today or tomorrow, otherwise plain. A closed issue, or one of an
 * inactive project, is never coloured.
 */
export function issueDueTone(
  dueDate: string,
  today: string,
  quiet: boolean
): 'default' | 'danger' | 'warning' {
  if (quiet) return 'default';
  const left = diffDays(dueDate, today);
  if (left < 0) return 'danger';
  return left <= 1 ? 'warning' : 'default';
}

/**
 * The word printed under a toned due date ("Overdue", "Today",
 * "Tomorrow"), so the row's red or amber repeats a word instead of
 * carrying the state by colour alone (architecture §8.2 "due date"; the
 * issue page's note under the date says the same). Short enough for the
 * 88px due column; undefined wherever issueDueTone gives no tone.
 */
export function issueDueNote(
  dueDate: string,
  today: string,
  quiet: boolean
): string | undefined {
  if (quiet) return undefined;
  const left = diffDays(dueDate, today);
  if (left < 0) return 'Overdue';
  if (left === 0) return 'Today';
  return left === 1 ? 'Tomorrow' : undefined;
}

/** The assignee cell's words for nobody where the issue needs a person
    (the amber case): the hue then repeats a word, not only "Unassigned". */
export const ISSUE_LIST_NEEDS_ASSIGNEE = 'Needs assignee';

// One list row, toned the way the other screens tone the same states
// (architecture §8.2): Blocked and Holds up as filled amber chips (the
// projects register's filled BLOCKED); an open unassigned issue of an
// active project (or of none) with an amber "Needs assignee", the same
// rule as the drawer, the graph register and the issue page (the words
// differ from the grey "Unassigned" so the hue is never alone); its own
// due date red when overdue and amber when due today or tomorrow, with
// "Overdue" / "Today" / "Tomorrow" under it (the issue page). A closed
// issue's or an inactive project's row has no status tone: no chips, a
// grey "Unassigned", an ink date; its state and priority glyphs keep
// their hues, as in the drawer and on the issue page. The milestone cell
// names the milestone, then its project (muted, cut first), unless the
// grouping or the sections already name the project.
function toRow(
  row: IssueListRow,
  refs: IssueListRefs,
  today: string,
  query: IssueListQuery,
  projectNamed: boolean
): TaskRowData {
  const live = row.open && row.projectActive;
  const milestone =
    row.milestoneId === null ? undefined : refs.milestones[row.milestoneId];
  const project =
    row.projectId === null ? undefined : refs.projects[row.projectId];
  const chips: TaskRowData['chips'] = [];
  if (live && row.blockedBy > 0)
    chips.push({ label: 'Blocked', tone: 'warning', filled: true });
  if (live && row.holdsUpMilestoneId !== null) {
    const held = refs.milestones[row.holdsUpMilestoneId];
    chips.push({
      label:
        held === undefined ? 'Holds up a milestone' : `Holds up ${held.name}`,
      tone: 'warning',
      filled: true,
    });
  }
  const assignee =
    row.assigneeId === null
      ? null
      : (refs.people[row.assigneeId]?.name ?? null);
  const dueQuiet = !live;
  const dueToneValue =
    row.dueDate === null
      ? undefined
      : issueDueTone(row.dueDate, today, dueQuiet);
  const needsAssignee = live && row.assigneeId === null;
  return {
    id: row.id,
    key: row.identifier,
    title: row.title,
    href: issueListHref(query, { issue: row.identifier }),
    externalHref: row.url,
    externalLabel: `Open ${row.identifier} in Linear`,
    state:
      row.stateName === '' ? STATE_TYPE_LABEL[row.stateType] : row.stateName,
    stateKind: row.stateType,
    priority: row.priority,
    priorityLabel: PRIORITY_LABEL[row.priority],
    due: row.dueDate === null ? undefined : formatDate(row.dueDate, today),
    dueTone: dueToneValue === 'default' ? undefined : dueToneValue,
    dueNote:
      row.dueDate === null
        ? undefined
        : issueDueNote(row.dueDate, today, dueQuiet),
    assignee:
      row.assigneeId !== null && assignee === null
        ? 'Unknown person'
        : assignee,
    assigneeTone: needsAssignee ? 'warning' : undefined,
    unassignedLabel: needsAssignee ? ISSUE_LIST_NEEDS_ASSIGNEE : undefined,
    milestone: milestone === undefined ? null : milestone.name,
    milestoneProject:
      milestone === undefined || projectNamed
        ? undefined
        : (project?.name ?? refs.projects[milestone.projectId]?.name),
    done: !row.open,
    chips: chips.length === 0 ? undefined : chips,
  };
}

// The "Only this …" view of a group: the group's own filter in place of
// that field's current value (architecture §8.4 "Issues", budgets).
function onlyThis(
  group: IssueListGroup,
  query: IssueListQuery
): IssueListFooterAction | null {
  const value = group.value;
  const set = (facet: IssueListFacet, values: (string | number)[]) =>
    withFilterValues(query, facet, values);
  switch (value.kind) {
    case 'milestone':
      return {
        label: 'Only this milestone',
        query: set('milestoneIds', [value.milestoneId]),
        replace: false,
      };
    case 'no_milestone':
      return {
        label: 'Only this project’s unplanned issues',
        query: withFilterValues(
          set('projectIds', [value.projectId]),
          'milestoneIds',
          [LIST_NONE]
        ),
        replace: false,
      };
    case 'project':
      return {
        label: 'Only this project',
        query: set('projectIds', [value.projectId]),
        replace: false,
      };
    case 'no_project':
      return {
        label: 'Only issues with no project',
        query: set('projectIds', [LIST_NONE]),
        replace: false,
      };
    case 'initiative':
      return {
        label:
          value.initiativeId === LIST_NONE
            ? 'Only issues with no initiative'
            : 'Only this initiative',
        query: set('initiativeIds', [value.initiativeId]),
        replace: false,
      };
    case 'assignee':
      return {
        label:
          value.userId === null ? 'Only unassigned issues' : 'Only this person',
        query: set('assigneeIds', [value.userId ?? LIST_NONE]),
        replace: false,
      };
    case 'state':
      return {
        label: `Only ${STATE_TYPE_LABEL[value.stateType]} issues`,
        query: set('stateTypes', [value.stateType]),
        replace: false,
      };
    case 'priority':
      return {
        label: 'Only this priority',
        query: set('priorities', [value.priority]),
        replace: false,
      };
    case 'all':
      return null;
  }
}

// The footer of a group that shows fewer rows than it holds: "Showing 12
// of 212" (or "212 issues not shown" when none were loaded), Show more
// and Only this ….
function budgetFooter(
  group: IssueListGroup,
  query: IssueListQuery
): IssueListGroupModel['footer'] {
  const atMax = query.limit >= ISSUE_LIST_MAX_LIMIT;
  const shown = group.rows.length;
  const base =
    shown === 0
      ? `${plural(group.count, 'issue')} not shown`
      : `Showing ${shown} of ${group.count}`;
  const actions: IssueListFooterAction[] = [
    {
      label: 'Show more',
      query: withMoreRows(query),
      replace: true,
      disabled: atMax,
    },
  ];
  const only = onlyThis(group, query);
  if (only !== null) actions.push(only);
  return {
    text: atMax ? `${base}. Narrow the filter to see the rest.` : base,
    actions,
  };
}

// The heading data of a milestone group (or an empty milestone target),
// toned as My week's milestone groups with the shared rules (architecture
// §8.2): the date by dueTone (red overdue, amber undated or due today or
// tomorrow), the progress by progressTone (red overdue, amber behind pace,
// green complete); an inactive project's group is muted and carries
// neither (the table draws its progress in the inactive grey).
function milestoneHeading(
  milestoneId: string,
  refs: IssueListRefs,
  today: string,
  muted: boolean
): Partial<IssueListGroupModel> & { title: string } {
  const milestone = refs.milestones[milestoneId];
  if (milestone === undefined) return { title: 'Untitled milestone' };
  const project = refs.projects[milestone.projectId];
  const mark = assessmentMark(milestone);
  const complete = milestone.status === 'complete';
  const tags: string[] = [];
  if (milestone.isNext && !muted) tags.push('Next');
  const weight = weightTag(milestone.weight);
  if (weight !== null) tags.push(weight);
  const due = muted
    ? 'default'
    : dueTone(
        milestone.status,
        milestone.daysLeft,
        milestone.targetDate === null
      );
  const progress = progressTone(milestone, muted);
  return {
    eyebrow: project?.name,
    title: milestone.name,
    href: `/timeline?milestone=${encodeURIComponent(milestoneId)}`,
    status: mark.status,
    statusLabel: muted ? `${mark.label} · inactive project` : mark.label,
    dueLabel:
      milestone.targetDate === null
        ? 'No target date'
        : formatDate(milestone.targetDate, today),
    daysLeftLabel: muted
      ? 'Inactive project'
      : complete
        ? 'Complete'
        : milestone.daysLeft === null
          ? undefined
          : daysLeftText(milestone.daysLeft),
    dueTone: due === 'default' ? undefined : due,
    progress: {
      done: milestone.progress.completed,
      total: milestone.progress.scope,
      tone: progress === 'default' ? undefined : progress,
    },
    tags: tags.length === 0 ? undefined : tags,
    missingLabel:
      !complete && !milestone.rubric.valid && !muted
        ? missingLabel(milestone.rubric.gaps)
        : undefined,
  };
}

// "in 6 days", "2 days overdue", "due today".
function daysLeftText(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft === 1) return 'due tomorrow';
  if (daysLeft > 1) return `${daysLeft} days left`;
  return `${plural(-daysLeft, 'day')} overdue`;
}

// A group's heading, by kind.
function groupHeading(
  group: IssueListGroup,
  refs: IssueListRefs,
  today: string,
  viewerId: string
): Partial<IssueListGroupModel> & { title: string } {
  const value = group.value;
  switch (value.kind) {
    case 'milestone':
      return milestoneHeading(value.milestoneId, refs, today, group.muted);
    case 'no_milestone': {
      const project = refs.projects[value.projectId];
      return {
        eyebrow: project?.name,
        title: 'No milestone',
        href: `/timeline?project=${encodeURIComponent(value.projectId)}`,
      };
    }
    case 'no_project':
      return { title: 'No project' };
    case 'project': {
      const project = refs.projects[value.projectId];
      if (project === undefined) return { title: 'Untitled project' };
      const next =
        project.nextMilestoneId === null
          ? undefined
          : refs.milestones[project.nextMilestoneId];
      const mark =
        next === undefined
          ? { status: 'missing' as const, label: 'No open milestone' }
          : assessmentMark(next);
      const lead =
        project.leadId === null ? undefined : refs.people[project.leadId]?.name;
      const blocked =
        project.active && project.allocation?.outcome === 'blocked'
          ? project.allocation
          : null;
      return {
        eyebrow:
          project.homeInitiativeId === null
            ? undefined
            : refs.initiatives[project.homeInitiativeId]?.name,
        title: project.name,
        href: `/timeline?project=${encodeURIComponent(value.projectId)}`,
        status: mark.status,
        statusLabel: group.muted
          ? `${mark.label} · inactive project`
          : mark.label,
        tags: lead === undefined ? undefined : [`Lead: ${lead}`],
        missingLabel: !project.active
          ? undefined
          : blocked !== null && blocked.blockReason !== null
            ? `Allocation stopped: ${blockedReasonLine(blocked.blockReason, blocked.gaps)}`
            : lead === undefined
              ? 'No lead'
              : undefined,
      };
    }
    case 'initiative': {
      const projects = Object.values(refs.projects).filter(
        (project) =>
          (project.homeInitiativeId ?? LIST_NONE) === value.initiativeId
      ).length;
      return {
        title:
          value.initiativeId === LIST_NONE
            ? 'No initiative'
            : (refs.initiatives[value.initiativeId]?.name ?? NOT_FOUND),
        // The timeline filtered to the initiative ("none": projects in
        // no initiative), as its own filter reads it.
        href: `/timeline?initiative=${encodeURIComponent(value.initiativeId)}`,
        tags: projects === 0 ? undefined : [plural(projects, 'project')],
      };
    }
    case 'assignee': {
      if (value.userId === null) {
        return { title: 'Unassigned', mark: { kind: 'avatar', name: '' } };
      }
      const person = refs.people[value.userId];
      const name = person?.name ?? 'Unknown person';
      return {
        title:
          value.userId === viewerId
            ? `${name} (you)`
            : person?.active === false
              ? `${name} · deactivated`
              : name,
        mark: { kind: 'avatar', name },
      };
    }
    case 'state':
      return {
        title:
          value.stateName === ''
            ? STATE_TYPE_LABEL[value.stateType]
            : value.stateName,
        mark: { kind: 'state', state: value.stateType },
      };
    case 'priority':
      return {
        title: PRIORITY_LABEL[value.priority],
        mark: { kind: 'priority', priority: value.priority },
      };
    case 'all':
      return { title: 'All issues' };
  }
}

// What an empty group says, and its footer (empty drop targets, groups
// not loaded under the row budget).
function groupBody(
  group: IssueListGroup,
  input: IssueListPageInput
): Pick<IssueListGroupModel, 'emptyLabel' | 'footer'> {
  if (group.emptyTarget && group.value.kind === 'milestone') {
    const milestone = input.view.refs.milestones[group.value.milestoneId];
    const open = milestone?.progress.open ?? 0;
    if (open === 0) {
      return {
        emptyLabel: input.canMove
          ? 'No open issues here yet. Drag issues here, or use Move to milestone.'
          : 'No open issues here yet.',
      };
    }
    const only = onlyThis(group, input.query);
    return {
      footer: {
        text: `None of its ${plural(open, 'open issue')} match${open === 1 ? 'es' : ''} these filters.`,
        actions: only === null ? [] : [only],
      },
    };
  }
  if (group.rows.length < group.count) {
    return { footer: budgetFooter(group, input.query) };
  }
  return {
    emptyLabel:
      group.value.kind === 'priority' || group.value.kind === 'state'
        ? 'No issues here.'
        : undefined,
  };
}

// A section's divider label (none for the one unnamed section).
function sectionLabel(
  section: IssueListSection,
  refs: IssueListRefs
): string | undefined {
  const value = section.value;
  switch (value.kind) {
    case 'tier':
      return ISSUE_LIST_TIER_LABEL[value.tier];
    case 'initiative':
      return value.initiativeId === LIST_NONE
        ? 'No initiative'
        : (refs.initiatives[value.initiativeId]?.name ?? NOT_FOUND);
    case 'project':
      return refs.projects[value.projectId]?.name ?? NOT_FOUND;
    case 'no_project':
      return 'No project';
    case 'all':
      return undefined;
  }
}

// One row's values for the move logic (plain data for the island).
function rowFacts(
  row: IssueListRow,
  related: ((issueId: string) => boolean) | undefined
): IssueRowFacts {
  return {
    id: row.id,
    identifier: row.identifier,
    teamId: row.teamId,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    assigneeId: row.assigneeId,
    priority: row.priority,
    stateId: row.stateId,
    stateType: row.stateType,
    stateName: row.stateName,
    open: row.open,
    related: related?.(row.id) ?? false,
  };
}

/** Why dropping on an initiative group does nothing. */
export const INITIATIVE_DROP_REASON =
  'Initiatives come from the project. Drop on a project or a milestone.';

// What dropping on a group does: core's drop patch, its words, and the
// reason a group takes nothing (an initiative; a deactivated person or an
// app, whom the engine would refuse for the whole request).
function groupTarget(
  group: IssueListGroup,
  refs: IssueListRefs
): IssueGroupTarget {
  const value = group.value;
  const projectName = (id: string) => refs.projects[id]?.name ?? NOT_FOUND;
  const target = (
    label: string,
    reason: string | null = null,
    short?: string
  ): IssueGroupTarget => ({
    patch: group.patch,
    projectOnly: value.kind === 'project',
    reason: group.patch === null ? reason : null,
    label,
    ...(short === undefined ? {} : { short }),
  });
  switch (value.kind) {
    case 'milestone': {
      const name = refs.milestones[value.milestoneId]?.name ?? NOT_FOUND;
      return target(`${projectName(value.projectId)} › ${name}`, null, name);
    }
    case 'no_milestone':
    case 'project':
      return target(
        `${projectName(value.projectId)} › No milestone`,
        null,
        'No milestone'
      );
    case 'no_project':
      return target('No project', null, 'No project');
    case 'initiative':
      return target('', INITIATIVE_DROP_REASON);
    case 'assignee': {
      if (value.userId === null) return target('Unassigned');
      const person = refs.people[value.userId];
      const name = person?.name ?? 'Unknown person';
      return target(
        name,
        person === undefined
          ? `${name} is not in the planner.`
          : person.active
            ? `${name} is an app, not a person.`
            : `${name} is deactivated in Linear.`
      );
    }
    case 'state':
      return target(
        value.stateName === ''
          ? STATE_TYPE_LABEL[value.stateType]
          : value.stateName,
        'The planner does not know this status’s name.'
      );
    case 'priority':
      return target(PRIORITY_LABEL[value.priority]);
    case 'all':
      return target('');
  }
}

/**
 * The /issues page model: heading, receipts, notices, columns and the
 * grouped list in TaskGroupTable's shapes (group footers carry views, not
 * callbacks, so the model stays plain data), the folded groups, and the
 * empty state. Chips, tabs and toolbar labels follow the island's own
 * query (issueListChips, issueListTabs, …).
 */
export function buildIssueListPage(
  input: IssueListPageInput
): IssueListPageModel {
  const { view } = input;
  const { refs, today } = view;
  const defaultCollapsed: string[] = [];
  const facts: Record<string, IssueRowFacts> = {};
  const targets: Record<string, IssueGroupTarget> = {};
  const milestoneMenus: Record<string, MilestoneMenuData> = {};
  // Project groups or sections already name each row's project.
  const projectNamed =
    view.query.group === 'project' || view.query.sections === 'project';
  const sections: IssueListSectionModel[] = view.sections.map((section) => ({
    id: section.key,
    label: sectionLabel(section, refs),
    groups: section.groups.map((group): IssueListGroupModel => {
      const heading = groupHeading(group, refs, today, input.viewerId);
      targets[group.key] = groupTarget(group, refs);
      for (const row of group.rows)
        facts[row.id] = rowFacts(row, input.related);
      if (group.value.kind === 'milestone') {
        const milestone = refs.milestones[group.value.milestoneId];
        if (milestone !== undefined) {
          milestoneMenus[group.key] = {
            milestoneId: group.value.milestoneId,
            name: milestone.name,
            weight: milestone.weight,
          };
        }
      }
      const complete =
        group.value.kind === 'milestone' &&
        refs.milestones[group.value.milestoneId]?.status === 'complete';
      if (
        !group.emptyTarget &&
        (complete || (group.count > 0 && group.rows.length === 0))
      ) {
        defaultCollapsed.push(group.key);
      }
      return {
        ...heading,
        id: group.key,
        muted: group.muted,
        count: group.count,
        rows: group.rows.map((row) =>
          toRow(row, refs, today, input.query, projectNamed)
        ),
        // A group with no patch is still asked while a row is dragged
        // over it when it can say why it takes nothing (an initiative, a
        // deactivated person); "All issues" stays silent.
        droppable: group.patch !== null || targets[group.key]?.reason !== null,
        ...groupBody(group, input),
      };
    }),
  }));
  const explicitStatus = !isOpenStatusFilter(view.query.filters.stateTypes);
  return {
    heading: 'Issues',
    subtitle: `Every issue across ${plural(view.projectCount, 'project')}.`,
    receipts: issueListReceipts(view),
    notices: notices(input),
    columns: issueListColumns(view.query.group),
    sections,
    defaultCollapsed,
    storageKey: collapsedStorageKey(view.query.group),
    empty:
      sections.length === 0
        ? {
            message: explicitStatus
              ? 'No issues match these filters.'
              : 'No open issues match these filters.',
            clearable: !hasDefaultFilters(view.query),
          }
        : null,
    rowFacts: facts,
    targets,
    milestoneMenus,
    projectNames: Object.fromEntries(
      Object.entries(refs.projects).map(([id, project]) => [id, project.name])
    ),
  };
}

// ---------------------------------------------------------------------------
// Menus (the Sort and Group popovers' options)
// ---------------------------------------------------------------------------

/** The Group menu's groupings, in order. */
export const GROUP_CHOICES: readonly IssueListGroupBy[] = [
  'milestone',
  'project',
  'initiative',
  'assignee',
  'state',
  'priority',
  'none',
];

/** The Group menu's section levels, in order. */
export const SECTION_CHOICES: readonly IssueListSectionBy[] = [
  'none',
  'initiative',
  'project',
];

/** The Sort menu's sorts, in order. */
export const SORT_CHOICES: readonly IssueListSort[] = [
  'weight',
  'priority',
  'due',
  'updated',
  'created',
  'title',
];

// ---------------------------------------------------------------------------
// The filter pickers' options (from GET /api/issues/options)
// ---------------------------------------------------------------------------

/** At most this many options of a long list (milestones) are drawn. */
export const PICKER_OPTION_LIMIT = 200;

/** The Filter menu's field choices, in order. */
export const FILTER_FIELDS: readonly Exclude<IssueListFacet, 'quick'>[] = [
  'initiativeIds',
  'projectIds',
  'milestoneIds',
  'assigneeIds',
  'teamIds',
  'stateTypes',
  'priorities',
];

/** The quick filters, in the Filter menu's order. */
export const QUICK_CHOICES: readonly IssueListQuick[] = [
  'blocked',
  'at_risk',
  'next',
];

/**
 * The Filter menu: the fields (Initiative only when the viewer sees
 * initiatives, Team only when they see two or more teams), then the
 * quick filters, each hinted "On" while set. Values: `field:<facet>` and
 * `quick:<id>`.
 */
export function filterMenuOptions(
  query: IssueListQuery,
  facts: { hasInitiatives: boolean; teamCount: number }
): PickerOption[] {
  const fields = FILTER_FIELDS.filter(
    (facet) =>
      (facet !== 'initiativeIds' || facts.hasInitiatives) &&
      (facet !== 'teamIds' || facts.teamCount >= 2)
  ).map((facet): PickerOption => ({
    value: `field:${facet}`,
    label: FACET_LABEL[facet],
    group: 'Filter by',
  }));
  const quick = QUICK_CHOICES.map((id): PickerOption => ({
    value: `quick:${id}`,
    label: ISSUE_LIST_QUICK_LABEL[id],
    hint: query.filters.quick.includes(id) ? 'On' : undefined,
    group: 'Quick filters',
  }));
  return [...fields, ...quick];
}

/** A host-filtered option list, cut to PICKER_OPTION_LIMIT. */
export interface PickerOptionList {
  options: PickerOption[];
  /** Matching options left out ("Keep typing to narrow 1,800 more"). */
  more: number;
}

// Every word of the search in the option's label, hint or keywords.
function optionMatches(
  option: PickerOption,
  words: readonly string[]
): boolean {
  if (words.length === 0) return true;
  const text = foldText(
    [
      option.label,
      option.hint ?? '',
      option.group ?? '',
      ...(option.keywords ?? []),
    ].join(' ')
  );
  return words.every((word) => text.includes(word));
}

// The search's folded words.
function searchWords(search: string): string[] {
  return foldText(search)
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** "Keep typing to narrow 1,800 more" (a disabled option at the end). */
export function moreOption(more: number): PickerOption {
  return {
    value: 'more',
    label: `Keep typing to narrow ${more.toLocaleString('en-US')} more`,
    disabled: true,
  };
}

/**
 * One filter field's picker options, filtered by `search` here (the
 * pickers pass filter={false}) and cut to PICKER_OPTION_LIMIT:
 * initiatives in their order then "No initiative"; projects as Active
 * projects, Other projects, then "No project"; milestones grouped by
 * project in timeline order (only the filtered projects' when a project
 * filter is set), each with its status mark and due line, then "No
 * milestone"; people as "Me (name)", "Unassigned", active people, then
 * deactivated ones; teams; the six status types; the five priorities.
 */
export function facetPickerOptions(
  facet: Exclude<IssueListFacet, 'quick'>,
  options: IssueListOptions | null,
  context: {
    query: IssueListQuery;
    today: string;
    viewerId: string;
    search: string;
  }
): PickerOptionList {
  const list: PickerOption[] = [];
  switch (facet) {
    case 'initiativeIds':
      for (const initiative of options?.initiatives ?? []) {
        list.push({ value: initiative.id, label: initiative.name });
      }
      list.push({ value: LIST_NONE, label: 'No initiative' });
      break;
    case 'projectIds':
      for (const project of options?.projects ?? []) {
        list.push({
          value: project.id,
          label: project.name,
          hint: project.active ? undefined : project.statusName,
          group: project.active ? 'Active projects' : 'Other projects',
        });
      }
      list.push({ value: LIST_NONE, label: 'No project', group: 'None' });
      break;
    case 'milestoneIds': {
      const chosen = context.query.filters.projectIds.filter(
        (id) => id !== LIST_NONE
      );
      const only = chosen.length === 0 ? null : new Set(chosen);
      const noProjectOnly =
        only === null && context.query.filters.projectIds.includes(LIST_NONE);
      for (const project of options?.projects ?? []) {
        if (noProjectOnly) break;
        if (only !== null && !only.has(project.id)) continue;
        for (const milestone of project.milestones) {
          list.push({
            value: milestone.id,
            label: milestone.name,
            // Short, so the name keeps the room in a 240px popover; the
            // mark carries the status.
            hint:
              milestone.status === 'complete'
                ? 'complete'
                : milestone.targetDate === null
                  ? 'no date'
                  : formatDate(milestone.targetDate, context.today),
            keywords: [project.name],
            group: project.active ? project.name : `${project.name} · inactive`,
            mark: {
              kind: 'status',
              status: uiStatus(milestone.status),
              label: statusLabel(milestone.status),
              muted: !project.active,
            },
          });
        }
      }
      list.push({ value: LIST_NONE, label: 'No milestone', group: 'None' });
      break;
    }
    case 'assigneeIds': {
      const me = options?.people.find(
        (person) => person.id === context.viewerId
      );
      list.push({
        value: LIST_ME,
        label: me === undefined ? 'Me' : `Me (${me.name})`,
        mark: { kind: 'avatar', name: me?.name ?? '' },
      });
      list.push({
        value: LIST_NONE,
        label: 'Unassigned',
        mark: { kind: 'avatar', name: '' },
      });
      for (const person of options?.people ?? []) {
        if (person.id === context.viewerId) continue;
        list.push({
          value: person.id,
          label: person.name,
          hint: person.active ? undefined : 'deactivated',
          keywords: [person.displayName],
          mark: { kind: 'avatar', name: person.name },
        });
      }
      break;
    }
    case 'teamIds':
      for (const team of options?.teams ?? []) {
        list.push({ value: team.id, label: team.name, hint: team.key });
      }
      break;
    case 'stateTypes':
      for (const type of ALL_STATE_TYPES) {
        list.push({
          value: type,
          label: STATE_TYPE_LABEL[type],
          mark: { kind: 'state', state: type },
        });
      }
      break;
    case 'priorities':
      for (const priority of PRIORITY_ORDER) {
        list.push({
          value: String(priority),
          label: PRIORITY_LABEL[priority],
          mark: { kind: 'priority', priority },
        });
      }
      break;
  }
  return cutPickerOptions(list, context.search);
}

/**
 * The options of a host-filtered picker (filter={false}) that match
 * `search` (every folded word in the label, hint, group or keywords), cut
 * to PICKER_OPTION_LIMIT with the number left out.
 */
export function cutPickerOptions(
  list: readonly PickerOption[],
  search: string
): PickerOptionList {
  const words = searchWords(search);
  const matching = list.filter((option) => optionMatches(option, words));
  if (matching.length <= PICKER_OPTION_LIMIT) {
    return { options: matching, more: 0 };
  }
  return {
    options: matching.slice(0, PICKER_OPTION_LIMIT),
    more: matching.length - PICKER_OPTION_LIMIT,
  };
}

/** A filter field's picker needs the fetched options (the rest are fixed). */
export function facetNeedsOptions(facet: IssueListFacet): boolean {
  return (
    facet === 'initiativeIds' ||
    facet === 'projectIds' ||
    facet === 'milestoneIds' ||
    facet === 'assigneeIds' ||
    facet === 'teamIds'
  );
}

/** Names from the fetched picker options (values chosen before the
    server answered). */
export function namesFromOptions(
  options: IssueListOptions | null
): IssueListNames {
  const initiatives = new Map(options?.initiatives.map((i) => [i.id, i.name]));
  const projects = new Map(options?.projects.map((p) => [p.id, p.name]));
  const milestones = new Map(
    options?.projects.flatMap((p) =>
      p.milestones.map((m) => [m.id, m.name] as const)
    )
  );
  const people = new Map(options?.people.map((p) => [p.id, p.name]));
  const teams = new Map(options?.teams.map((t) => [t.id, t.name]));
  return {
    initiative: (id) => initiatives.get(id),
    project: (id) => projects.get(id),
    milestone: (id) => milestones.get(id),
    person: (id) => people.get(id),
    team: (id) => teams.get(id),
  };
}

/** Which project a milestone is in, from the filter values' names and
    the fetched options. */
export function milestoneProjectLookup(
  names: IssueListFilterNames,
  options: IssueListOptions | null
): MilestoneProjectLookup {
  const fromOptions = new Map(
    options?.projects.flatMap((p) =>
      p.milestones.map((m) => [m.id, p.id] as const)
    )
  );
  return (id) => names.milestones[id]?.projectId ?? fromOptions.get(id);
}

/** The Group menu (one multi-select list with one choice per part):
    `group:<kind>` and `sections:<kind>`; sections that cannot divide the
    grouping are disabled with the reason, and so are the initiative
    choices for a viewer who sees no initiatives. */
export function groupMenuOptions(
  query: IssueListQuery,
  hasInitiatives = true
): PickerOption[] {
  const noInitiatives = 'No initiatives to show';
  const groups = GROUP_CHOICES.map((group): PickerOption => {
    const disabled = group === 'initiative' && !hasInitiatives;
    return {
      value: `group:${group}`,
      label: ISSUE_LIST_GROUP_LABEL[group],
      hint: disabled ? noInitiatives : undefined,
      disabled,
      group: 'Group by',
    };
  });
  const sections = SECTION_CHOICES.map((sections): PickerOption => {
    const grouped =
      sections !== 'none' &&
      (query.group === 'initiative' ||
        (sections === 'project' && query.group === 'project'));
    const hidden = sections === 'initiative' && !hasInitiatives;
    return {
      value: `sections:${sections}`,
      label:
        sections === 'none'
          ? 'No sections'
          : `By ${ISSUE_LIST_SECTION_LABEL[sections].toLowerCase()}`,
      hint: grouped
        ? `Already grouped by ${ISSUE_LIST_GROUP_LABEL[query.group].toLowerCase()}`
        : hidden
          ? noInitiatives
          : undefined,
      disabled: grouped || hidden,
      group: 'Sections',
    };
  });
  return [...groups, ...sections];
}

/** The Sort menu's hints, short enough for the menu's width (core's
    ISSUE_LIST_SORT_HINT says the same at length). */
const SORT_MENU_HINT: Record<IssueListSort, string> = {
  weight: 'Overdue first',
  priority: 'Urgent first',
  due: 'Soonest first',
  updated: 'Newest first',
  created: 'Newest first',
  title: 'A to Z',
};

/** The Sort menu: `sort:<kind>` with each sort's hint, then the direction
    (`dir:asc` / `dir:desc`) for a field sort. */
export function sortMenuOptions(query: IssueListQuery): PickerOption[] {
  const sorts = SORT_CHOICES.map((sort): PickerOption => ({
    value: `sort:${sort}`,
    label: ISSUE_LIST_SORT_LABEL[sort],
    hint: SORT_MENU_HINT[sort],
    keywords: [ISSUE_LIST_SORT_HINT[sort]],
    group: 'Sort by',
  }));
  if (query.sort === 'weight') return sorts;
  return [
    ...sorts,
    { value: 'dir:asc', label: 'Ascending', group: 'Direction' },
    { value: 'dir:desc', label: 'Descending', group: 'Direction' },
  ];
}

/** The chosen values of the Group menu. */
export function groupMenuValue(query: IssueListQuery): string[] {
  return [`group:${query.group}`, `sections:${query.sections}`];
}

/** The chosen values of the Sort menu. */
export function sortMenuValue(query: IssueListQuery): string[] {
  return query.sort === 'weight'
    ? ['sort:weight']
    : [`sort:${query.sort}`, `dir:${query.dir}`];
}

/**
 * A menu toggle as the new value list: one choice per part (the value's
 * prefix before ':'), so choosing `group:project` replaces `group:…` and
 * choosing the current one keeps it (a part can never be emptied).
 */
export function oneChoicePerPart(
  current: readonly string[],
  toggled: string
): string[] {
  const part = toggled.slice(0, toggled.indexOf(':') + 1);
  return [...current.filter((value) => !value.startsWith(part)), toggled];
}

/** The view a Group menu value list describes. */
export function withGroupMenu(
  query: IssueListQuery,
  values: readonly string[]
): IssueListQuery {
  const group = values.find((v) => v.startsWith('group:'))?.slice(6);
  const sections = values.find((v) => v.startsWith('sections:'))?.slice(9);
  return withLayout(query, {
    group: (GROUP_CHOICES as readonly string[]).includes(group ?? '')
      ? (group as IssueListGroupBy)
      : query.group,
    sections: (SECTION_CHOICES as readonly string[]).includes(sections ?? '')
      ? (sections as IssueListSectionBy)
      : query.sections,
  });
}

/** The view a Sort menu value list describes. */
export function withSortMenu(
  query: IssueListQuery,
  values: readonly string[]
): IssueListQuery {
  const sort = values.find((v) => v.startsWith('sort:'))?.slice(5);
  const dir = values.find((v) => v.startsWith('dir:'))?.slice(4);
  const nextSort = (SORT_CHOICES as readonly string[]).includes(sort ?? '')
    ? (sort as IssueListSort)
    : query.sort;
  return withLayout(query, {
    sort: nextSort,
    dir:
      nextSort !== query.sort
        ? undefined
        : dir === 'asc' || dir === 'desc'
          ? dir
          : undefined,
  });
}
