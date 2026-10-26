// The issue list (owner request 2026-10-22, "every issue in one list";
// architecture §2.14): every issue of the viewer's snapshot, filtered,
// ordered by the weight rule (§2.7) or by a field, grouped, divided into
// sections, cut to a row budget, with each group's drop patch, the preset
// tabs' counts and the names everything references. Plain data, ready to
// serialize. Each step is one pass; nothing is recomputed per comparison.

import { isValidIsoDate } from './dates';
import {
  foldedTitles,
  foldText,
  issueSearchScore,
  issueSearchTerms,
} from './issue-search';
import {
  compareInitiatives,
  compareMilestones,
  homeInitiativeIds,
  NO_INITIATIVE_ID,
  orderProjects,
} from './ordering';
import {
  isOpenState,
  issueStateType,
  milestoneTargetDate,
  priorityRank,
} from './snapshot';
import {
  type AllocationPlan,
  type EvalContext,
  type Issue,
  type IssueBulkPatch,
  type IssueListFilters,
  type IssueListGroup,
  type IssueListGroupBy,
  type IssueListGroupValue,
  type IssueListIdFacet,
  type IssueListOptions,
  type IssueListPresetId,
  type IssueListQuery,
  type IssueListQuick,
  type IssueListRefs,
  type IssueListRow,
  type IssueListSection,
  type IssueListSectionBy,
  type IssueListSectionValue,
  type IssueListSort,
  type IssueListView,
  LIST_ME,
  LIST_NONE,
  type Milestone,
  type MilestoneAssessment,
  type Priority,
  type Snapshot,
  type WorkflowStateType,
} from './types';

/** The open state types (§2.1), in Linear's column order. */
export const OPEN_STATE_TYPES: readonly WorkflowStateType[] = Object.freeze([
  'triage',
  'backlog',
  'unstarted',
  'started',
] as const);
/** Every state type, in Linear's column order (triage → canceled). */
export const ALL_STATE_TYPES: readonly WorkflowStateType[] = Object.freeze([
  ...OPEN_STATE_TYPES,
  'completed',
  'canceled',
] as const);

/** Rows returned by default. */
export const ISSUE_LIST_DEFAULT_LIMIT: number = 500;
/** "Show more" grows the row budget by this much. */
export const ISSUE_LIST_LIMIT_STEP: number = 500;
/** The largest row budget a URL may ask for. */
export const ISSUE_LIST_MAX_LIMIT: number = 2000;
/** Group headers returned at most; later groups are counted in moreGroups. */
export const ISSUE_LIST_MAX_GROUPS: number = 200;
/** Values kept per filter field. */
export const ISSUE_LIST_MAX_VALUES: number = 50;
/** Characters of the text search kept. */
export const ISSUE_LIST_QUERY_MAX: number = 200;
/** Longest id-like filter value kept, in characters (longer ones are dropped). */
export const ISSUE_LIST_VALUE_MAX_LENGTH: number = 200;
/**
 * With 1 to this many projects in the project filter (grouped by
 * milestone), their open milestones are listed even with no matches, as
 * drop targets.
 */
export const ISSUE_LIST_EMPTY_TARGET_PROJECTS: number = 5;

/** Each sort's default direction (the weight order has none). */
export const ISSUE_LIST_DEFAULT_DIR: Readonly<
  Record<IssueListSort, 'asc' | 'desc'>
> = Object.freeze({
  weight: 'asc',
  project_priority: 'asc',
  priority: 'asc',
  due: 'asc',
  updated: 'desc',
  created: 'desc',
  title: 'asc',
});

/**
 * Whether a sort can be reversed. The weight and project priority orders are
 * rules (overdue on top, paused projects last), not a field, so they have no
 * direction: the query keeps 'asc' and the Sort menu offers none.
 */
export function issueListSortHasDirection(sort: IssueListSort): boolean {
  return sort !== 'weight' && sort !== 'project_priority';
}

const GROUP_KINDS: readonly IssueListGroupBy[] = [
  'milestone',
  'project',
  'initiative',
  'assignee',
  'state',
  'priority',
  'none',
];
const SECTION_KINDS: readonly IssueListSectionBy[] = [
  'none',
  'initiative',
  'project',
];
const SORTS: readonly IssueListSort[] = [
  'weight',
  'project_priority',
  'priority',
  'due',
  'updated',
  'created',
  'title',
];
const QUICKS: readonly IssueListQuick[] = ['blocked', 'at_risk', 'next'];

// A fresh copy of the default filters (open issues, nothing else).
function defaultFilters(): IssueListFilters {
  return {
    q: '',
    initiativeIds: [],
    projectIds: [],
    milestoneIds: [],
    assigneeIds: [],
    teamIds: [],
    stateTypes: [...OPEN_STATE_TYPES],
    priorities: [],
    quick: [],
  };
}

// Freezes a query (or filters) and every array in it, so the shared
// constants below cannot be changed by a caller by accident.
function frozen<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (typeof item === 'object' && item !== null) frozen(item);
  }
  return Object.freeze(value);
}

/** The view /issues shows with no parameters: open issues by milestone, weight order. */
export const DEFAULT_ISSUE_LIST_QUERY: IssueListQuery = frozen({
  filters: defaultFilters(),
  group: 'milestone',
  sections: 'none',
  sort: 'weight',
  dir: 'asc',
  limit: ISSUE_LIST_DEFAULT_LIMIT,
});

/** The complete filters of each preset tab (all over open issues). */
export const ISSUE_LIST_PRESETS: Readonly<
  Record<IssueListPresetId, IssueListFilters>
> = frozen({
  all: defaultFilters(),
  mine: { ...defaultFilters(), assigneeIds: [LIST_ME] },
  unplanned: { ...defaultFilters(), milestoneIds: [LIST_NONE] },
  unassigned: { ...defaultFilters(), assigneeIds: [LIST_NONE] },
  blocked: { ...defaultFilters(), quick: ['blocked'] },
  at_risk: { ...defaultFilters(), quick: ['at_risk'] },
});

/**
 * Whether a sections level may divide a grouping: by initiative with every
 * group but initiative; by project with milestone, assignee, state,
 * priority and none (a project or initiative group already is one).
 */
export function issueListSectionsAllowed(
  group: IssueListGroupBy,
  sections: IssueListSectionBy
): boolean {
  if (sections === 'none') return true;
  if (sections === 'initiative') return group !== 'initiative';
  return group !== 'project' && group !== 'initiative';
}

/**
 * How a workflow state name is compared across teams: trimmed and
 * case-insensitive ("In Review" in ENG and "in review " in OPS are one
 * status). The list's status groups and the bulk status change share it.
 */
export function stateNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The raw values of one filter field: an array, or a comma-separated
// string (the URL form). Each is trimmed; blanks, values over
// ISSUE_LIST_VALUE_MAX_LENGTH characters and repeats are dropped, and at
// most ISSUE_LIST_MAX_VALUES are kept.
function cleanValues(
  raw: unknown,
  accept: (value: string) => boolean = () => true
): string[] {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value === '' || value.length > ISSUE_LIST_VALUE_MAX_LENGTH) continue;
    if (seen.has(value) || !accept(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length === ISSUE_LIST_MAX_VALUES) break;
  }
  return out;
}

function enumValues<T extends string>(
  raw: unknown,
  allowed: readonly T[]
): T[] {
  return cleanValues(raw, (value) =>
    (allowed as readonly string[]).includes(value)
  ) as T[];
}

function isPriority(value: unknown): value is Priority {
  return (
    value === 0 || value === 1 || value === 2 || value === 3 || value === 4
  );
}

// Priorities as numbers 0–4 (a digit string is read as its number).
function priorityValues(raw: unknown): Priority[] {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const out: Priority[] = [];
  for (const item of items) {
    const value =
      typeof item === 'string' && /^\s*\d\s*$/.test(item) ? Number(item) : item;
    if (isPriority(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

// The text search: trimmed, cut to ISSUE_LIST_QUERY_MAX characters (code
// points, so an emoji is never split), trimmed again.
function normalizeQ(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.trim()).slice(0, ISSUE_LIST_QUERY_MAX).join('').trim();
}

// The row budget: a multiple of the step (rounded up) in [default, max].
function normalizeLimit(raw: unknown): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return ISSUE_LIST_DEFAULT_LIMIT;
  const stepped =
    Math.ceil(value / ISSUE_LIST_LIMIT_STEP) * ISSUE_LIST_LIMIT_STEP;
  return Math.min(
    ISSUE_LIST_MAX_LIMIT,
    Math.max(ISSUE_LIST_DEFAULT_LIMIT, stepped)
  );
}

function oneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * Any value as a valid query, leniently, so old and shared links keep
 * working: unknown enum values, blank or over-long values, repeats and
 * values past ISSUE_LIST_MAX_VALUES per field are dropped; q is trimmed to
 * ISSUE_LIST_QUERY_MAX characters; the limit is stepped and clamped; an
 * invalid sections/group pair resets sections to 'none'; an empty status
 * list means the open types; the weight sort's direction is 'asc'. Values
 * keep the order given. Never throws.
 */
export function normalizeIssueListQuery(raw: unknown): IssueListQuery {
  const input = isRecord(raw) ? raw : {};
  const rawFilters = isRecord(input['filters']) ? input['filters'] : {};
  const stateTypes = enumValues(rawFilters['stateTypes'], ALL_STATE_TYPES);
  const filters: IssueListFilters = {
    q: normalizeQ(rawFilters['q']),
    initiativeIds: cleanValues(rawFilters['initiativeIds']),
    projectIds: cleanValues(rawFilters['projectIds']),
    milestoneIds: cleanValues(rawFilters['milestoneIds']),
    assigneeIds: cleanValues(rawFilters['assigneeIds']),
    teamIds: cleanValues(rawFilters['teamIds']),
    stateTypes: stateTypes.length === 0 ? [...OPEN_STATE_TYPES] : stateTypes,
    priorities: priorityValues(rawFilters['priorities']),
    quick: enumValues(rawFilters['quick'], QUICKS),
  };
  const group = oneOf(input['group'], GROUP_KINDS, 'milestone');
  const sectionsRaw = oneOf(input['sections'], SECTION_KINDS, 'none');
  const sections = issueListSectionsAllowed(group, sectionsRaw)
    ? sectionsRaw
    : 'none';
  const sort = oneOf(input['sort'], SORTS, 'weight');
  const dir = !issueListSortHasDirection(sort)
    ? 'asc'
    : oneOf(
        input['dir'],
        ['asc', 'desc'] as const,
        ISSUE_LIST_DEFAULT_DIR[sort]
      );
  return {
    filters,
    group,
    sections,
    sort,
    dir,
    limit: normalizeLimit(input['limit']),
  };
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/** Whether two filter sets mean the same view (each field compared as a set). */
export function sameIssueListFilters(
  a: IssueListFilters,
  b: IssueListFilters
): boolean {
  return (
    a.q === b.q &&
    sameSet(a.initiativeIds, b.initiativeIds) &&
    sameSet(a.projectIds, b.projectIds) &&
    sameSet(a.milestoneIds, b.milestoneIds) &&
    sameSet(a.assigneeIds, b.assigneeIds) &&
    sameSet(a.teamIds, b.teamIds) &&
    sameSet(a.stateTypes, b.stateTypes) &&
    sameSet(a.priorities, b.priorities) &&
    sameSet(a.quick, b.quick)
  );
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** A sort key compared element by element (numbers with numbers, strings with strings). */
type SortKey = readonly (number | string)[];

function compareKeys(a: SortKey, b: SortKey): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

// Plain code-unit comparison: deterministic on every host.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tiers of the weight order (architecture §2.7): A–E. */
const TIER_A = 0; // a milestone of an active project
const TIER_B = 1; // an active project, no milestone
const TIER_C = 2; // no project
const TIER_D = 3; // a milestone of an inactive project
const TIER_E = 4; // an inactive project, no milestone

/** One matching issue with everything its order and grouping need, computed once. */
interface Match {
  issue: Issue;
  stateType: WorkflowStateType;
  open: boolean;
  /** Mirrored project, else null. */
  projectId: string | null;
  /** Mirrored milestone of that project, else undefined. */
  milestone: Milestone | undefined;
  blockedBy: number;
  tier: number;
  tierRank: number;
  priorityRank: number;
  createdMs: number;
  identifierPrefix: string;
  identifierNumber: number;
  /** The project priority order's key after the tier ([0, 0] otherwise). */
  priorityFirst: SortKey;
  /** The field sort's key; null sorts last in both directions. */
  sortValue: number | string | null;
  /** The folded title (title sort only). */
  title: string;
}

interface GroupAcc {
  valueKey: string;
  value: IssueListGroupValue;
  order: SortKey;
  matches: Match[];
  emptyTarget: boolean;
  /** State groups: the lowest position seen and its name. */
  statePosition?: number;
}

interface SectionAcc {
  key: string;
  value: IssueListSectionValue;
  order: SortKey;
  groups: Map<string, GroupAcc>;
}

const IDENTIFIER = /^(.*?)(\d+)$/;

function msOrMax(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

// The weight key after the tier: open before closed, then compareIssues
// (priority rank, oldest first, ENG-2 before ENG-10, id).
function compareWeight(a: Match, b: Match): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (a.open !== b.open) return a.open ? -1 : 1;
  if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
  if (a.createdMs !== b.createdMs) return a.createdMs - b.createdMs;
  return compareIdentifierParts(a, b);
}

function compareIdentifierParts(a: Match, b: Match): number {
  const prefix = compareStrings(a.identifierPrefix, b.identifierPrefix);
  if (prefix !== 0) return prefix;
  if (a.identifierNumber !== b.identifierNumber)
    return a.identifierNumber - b.identifierNumber;
  const byIdentifier = compareStrings(a.issue.identifier, b.issue.identifier);
  return byIdentifier !== 0
    ? byIdentifier
    : compareStrings(a.issue.id, b.issue.id);
}

// The row order of one query: the field sort's key first (nulls last both
// ways; title ties then by identifier), then the weight key, so the order
// is total.
function rowComparator(
  sort: IssueListSort,
  dir: 'asc' | 'desc'
): (a: Match, b: Match) => number {
  if (sort === 'weight') return compareWeight;
  if (sort === 'project_priority') {
    return (a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const byProject = compareKeys(a.priorityFirst, b.priorityFirst);
      return byProject !== 0 ? byProject : compareWeight(a, b);
    };
  }
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const x = a.sortValue;
    const y = b.sortValue;
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      const by =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : compareStrings(String(x), String(y));
      if (by !== 0) return sign * by;
    }
    if (sort === 'title') {
      const byIdentifier = compareIdentifierParts(a, b);
      if (byIdentifier !== 0) return sign * byIdentifier;
    }
    return compareWeight(a, b);
  };
}

/** The value a field sort orders by; null for "none" (sorted last). */
function sortValueOf(
  sort: IssueListSort,
  issue: Issue,
  createdMs: number,
  title: string
): number | string | null {
  switch (sort) {
    case 'priority':
      return issue.priority === 0 ? null : issue.priority;
    case 'due': {
      const due = issue.dueDate ?? null;
      return due !== null && isValidIsoDate(due) ? due : null;
    }
    case 'updated': {
      const ms = Date.parse(issue.updatedAt);
      return Number.isNaN(ms) ? null : ms;
    }
    case 'created':
      return createdMs === Number.MAX_SAFE_INTEGER ? null : createdMs;
    case 'title':
      return title;
    case 'weight':
    case 'project_priority':
      return null;
  }
}

// The no-initiatives fallback (architecture §2.14): a snapshot without
// initiatives (a guest's, or a workspace without any) cannot filter,
// group or divide by them, so the query falls back to projects. Every
// initiative id gets the same answer, so nothing leaks.
function withFallback(
  snapshot: Snapshot,
  query: IssueListQuery
): { query: IssueListQuery; fallback: IssueListView['fallback'] } {
  const names =
    query.filters.initiativeIds.length > 0 ||
    query.group === 'initiative' ||
    query.sections === 'initiative';
  if (snapshot.initiatives.size > 0 || !names) return { query, fallback: null };
  return {
    query: {
      ...query,
      filters: { ...query.filters, initiativeIds: [] },
      group: query.group === 'initiative' ? 'project' : query.group,
      sections: query.sections === 'initiative' ? 'none' : query.sections,
    },
    fallback: { reason: 'no_initiatives' },
  };
}

const STATE_TYPE_RANK: ReadonlyMap<WorkflowStateType, number> = new Map(
  ALL_STATE_TYPES.map((type, index) => [type, index])
);

const TIER_SECTIONS: readonly Extract<
  IssueListSectionValue,
  { kind: 'tier' }
>['tier'][] = ['overdue', 'upcoming', 'unplanned', 'inactive'];

/**
 * The issue list (architecture §2.14) over the viewer's snapshot: filter,
 * weight key, groups and sections in order, empty milestones as drop
 * targets, the row and group budgets, refs for what is shown, unknown
 * filter ids, the "also in" notice and the preset counts. `viewerId`
 * resolves LIST_ME (null: LIST_ME matches nothing). The query is
 * normalized again here. O(issues + relations + milestones log milestones
 * + matches log matches).
 */
export function buildIssueList(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  query: IssueListQuery;
  viewerId: string | null;
}): IssueListView {
  const { snapshot, ctx, assessments, allocationPlan, viewerId } = input;
  const applied = withFallback(snapshot, normalizeIssueListQuery(input.query));
  const query = applied.query;
  const { filters } = query;

  // --- precomputed once ------------------------------------------------------
  const activeStatuses = new Set(ctx.tuning.activeProjectStatuses);
  const activeProjects = new Set<string>();
  for (const project of snapshot.data.projects) {
    if (activeStatuses.has(project.statusType)) activeProjects.add(project.id);
  }
  // Allocation and warnings apply (§2.8); an unmirrored project is not active.
  const isActive = (projectId: string | null): boolean =>
    projectId !== null && activeProjects.has(projectId);
  const home = homeInitiativeIds(snapshot);
  const orderedProjects = orderProjects(snapshot);
  const projectIndex = new Map<string, number>();
  orderedProjects.forEach((project, index) =>
    projectIndex.set(project.id, index)
  );
  const sortedInitiatives = [...snapshot.data.initiatives].sort(
    compareInitiatives
  );
  const initiativeIndex = new Map<string, number>();
  sortedInitiatives.forEach((initiative, index) =>
    initiativeIndex.set(initiative.id, index)
  );
  const sortedMilestones = [...snapshot.data.milestones].sort(
    compareMilestones(snapshot, ctx, assessments)
  );
  const milestoneIndex = new Map<string, number>();
  sortedMilestones.forEach((milestone, index) =>
    milestoneIndex.set(milestone.id, index)
  );
  const milestoneCount = sortedMilestones.length;
  // The project priority order's key, right after the tier: an active
  // project's overdue milestones first (as the Overdue divider shows them),
  // then the project's Linear priority, urgent first and none last. Every
  // other sort gets [0, 0], so its rows, groups and sections keep their order.
  const byProjectPriority = query.sort === 'project_priority';
  const priorityFirst = (
    projectId: string | null,
    milestone: Milestone | undefined
  ): SortKey => {
    if (!byProjectPriority || projectId === null) return [0, 0];
    const overdue =
      milestone !== undefined &&
      isActive(projectId) &&
      assessments.get(milestone.id)?.status === 'overdue';
    const project = snapshot.projects.get(projectId);
    return [
      overdue ? 0 : 1,
      project === undefined ? 0 : priorityRank(project.priority),
    ];
  };
  const nextByProject = new Map<string, string>();
  for (const assessment of assessments.values()) {
    if (assessment.isNext)
      nextByProject.set(assessment.projectId, assessment.milestoneId);
  }
  const isOpenIssue = (issue: Issue): boolean =>
    isOpenState(issueStateType(snapshot, issue));
  const openBlockersOf = (issueId: string): number => {
    let count = 0;
    for (const blockerId of snapshot.blockersOf.get(issueId) ?? []) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker !== undefined && isOpenIssue(blocker)) count += 1;
    }
    return count;
  };
  // Each open blocker of an open issue in an overdue or at-risk milestone
  // of an active project, mapped to the first such milestone in weight order.
  const holdsUp = new Map<string, string>();
  for (const milestone of sortedMilestones) {
    const status = assessments.get(milestone.id)?.status;
    if (
      (status !== 'overdue' && status !== 'at_risk') ||
      !isActive(milestone.projectId)
    )
      continue;
    for (const held of snapshot.issuesByMilestone.get(milestone.id) ?? []) {
      if (!isOpenIssue(held)) continue;
      for (const blockerId of snapshot.blockersOf.get(held.id) ?? []) {
        if (holdsUp.has(blockerId)) continue;
        const blocker = snapshot.issues.get(blockerId);
        if (blocker !== undefined && isOpenIssue(blocker))
          holdsUp.set(blockerId, milestone.id);
      }
    }
  }

  // --- filters as sets (null: the field adds no condition) ------------------------
  const setOf = <T>(values: readonly T[]): Set<T> | null =>
    values.length === 0 ? null : new Set(values);
  const stateSet = new Set(filters.stateTypes);
  const initiativeSet = setOf(filters.initiativeIds);
  const projectSet = setOf(filters.projectIds);
  const milestoneSet = setOf(filters.milestoneIds);
  const assigneeSet =
    filters.assigneeIds.length === 0
      ? null
      : new Set(
          filters.assigneeIds.flatMap((id) =>
            id === LIST_ME ? (viewerId === null ? [] : [viewerId]) : [id]
          )
        );
  const teamSet = setOf(filters.teamIds);
  const prioritySet = setOf(filters.priorities);
  const quick = new Set(filters.quick);
  const terms = filters.q === '' ? null : issueSearchTerms(filters.q);
  const titles = terms === null ? null : foldedTitles(snapshot);
  const searchIdentifier = /\d/.test(filters.q);
  const needsTitle = query.sort === 'title';

  // --- the filter pass, which also counts the presets over open issues --------------
  const counts: Record<IssueListPresetId, number> = {
    all: 0,
    mine: 0,
    unplanned: 0,
    unassigned: 0,
    blocked: 0,
    at_risk: 0,
  };
  const matches: Match[] = [];
  for (const issue of snapshot.data.issues) {
    const stateType = issueStateType(snapshot, issue);
    const open = isOpenState(stateType);
    const projectId =
      issue.projectId !== null && snapshot.projects.has(issue.projectId)
        ? issue.projectId
        : null;
    const candidate =
      issue.milestoneId === null
        ? undefined
        : snapshot.milestones.get(issue.milestoneId);
    const milestone =
      candidate !== undefined && candidate.projectId === projectId
        ? candidate
        : undefined;
    const assessment =
      milestone === undefined ? undefined : assessments.get(milestone.id);
    const active = isActive(projectId);
    // Closed issues need it only when they match (computed below).
    let blockedBy = open ? openBlockersOf(issue.id) : 0;
    const atRisk =
      open &&
      active &&
      (assessment?.status === 'overdue' || assessment?.status === 'at_risk');
    const inNext = open && active && assessment?.isNext === true;
    if (open) {
      counts.all += 1;
      if (viewerId !== null && issue.assigneeId === viewerId) counts.mine += 1;
      if (milestone === undefined) counts.unplanned += 1;
      if (issue.assigneeId === null) counts.unassigned += 1;
      if (blockedBy > 0) counts.blocked += 1;
      if (atRisk) counts.at_risk += 1;
    }

    if (!stateSet.has(stateType)) continue;
    if (initiativeSet !== null) {
      if (projectId === null) continue;
      if (!initiativeSet.has(home.get(projectId) ?? NO_INITIATIVE_ID)) continue;
    }
    if (projectSet !== null && !projectSet.has(projectId ?? LIST_NONE))
      continue;
    if (milestoneSet !== null && !milestoneSet.has(milestone?.id ?? LIST_NONE))
      continue;
    if (assigneeSet !== null && !assigneeSet.has(issue.assigneeId ?? LIST_NONE))
      continue;
    if (teamSet !== null && !teamSet.has(issue.teamId)) continue;
    if (prioritySet !== null && !prioritySet.has(issue.priority)) continue;
    if (quick.has('blocked') && !(open && blockedBy > 0)) continue;
    if (quick.has('at_risk') && !atRisk) continue;
    if (quick.has('next') && !inNext) continue;
    if (terms !== null && titles !== null) {
      const title = titles.get(issue.id) ?? foldText(issue.title);
      if (
        issueSearchScore(issue, terms, title, {
          identifier: searchIdentifier,
        }) === null
      )
        continue;
    }

    if (!open) blockedBy = openBlockersOf(issue.id);
    let tier: number;
    let tierRank: number;
    if (milestone !== undefined) {
      tier = active ? TIER_A : TIER_D;
      const complete = assessment?.status === 'complete' ? 1 : 0;
      tierRank =
        complete * milestoneCount + (milestoneIndex.get(milestone.id) ?? 0);
    } else if (projectId !== null) {
      tier = active ? TIER_B : TIER_E;
      tierRank = projectIndex.get(projectId) ?? 0;
    } else {
      tier = TIER_C;
      tierRank = 0;
    }
    const createdMs = msOrMax(issue.createdAt);
    const parts = IDENTIFIER.exec(issue.identifier);
    const title = needsTitle
      ? (titles?.get(issue.id) ?? foldText(issue.title))
      : '';
    matches.push({
      issue,
      stateType,
      open,
      projectId,
      milestone,
      blockedBy,
      tier,
      tierRank,
      priorityRank: priorityRank(issue.priority),
      priorityFirst: priorityFirst(projectId, milestone),
      createdMs,
      identifierPrefix: parts?.[1] ?? issue.identifier,
      identifierNumber: parts === null ? -1 : Number(parts[2]),
      sortValue: sortValueOf(query.sort, issue, createdMs, title),
      title,
    });
  }

  // --- sections and groups ---------------------------------------------------------------
  const sections = new Map<string, SectionAcc>();
  const projectSection = (
    projectId: string | null
  ): { key: string; value: IssueListSectionValue; order: SortKey } => {
    if (projectId === null)
      return { key: 'p:none', value: { kind: 'no_project' }, order: [1] };
    return {
      key: `p:${projectId}`,
      value: { kind: 'project', projectId },
      order: [
        isActive(projectId) ? 0 : 2,
        ...priorityFirst(projectId, undefined),
        projectIndex.get(projectId) ?? 0,
      ],
    };
  };
  const sectionOf = (
    projectId: string | null,
    tier: number,
    milestone: Milestone | undefined
  ): { key: string; value: IssueListSectionValue; order: SortKey } => {
    if (query.sections === 'initiative') {
      if (projectId === null)
        return { key: 'p:none', value: { kind: 'no_project' }, order: [2] };
      const initiativeId = home.get(projectId) ?? null;
      return initiativeId === null
        ? {
            key: `i:${NO_INITIATIVE_ID}`,
            value: { kind: 'initiative', initiativeId: NO_INITIATIVE_ID },
            order: [1],
          }
        : {
            key: `i:${initiativeId}`,
            value: { kind: 'initiative', initiativeId },
            order: [0, initiativeIndex.get(initiativeId) ?? 0],
          };
    }
    if (query.sections === 'project') return projectSection(projectId);
    if (query.group !== 'milestone')
      return { key: 'all', value: { kind: 'all' }, order: [0] };
    let tierName: (typeof TIER_SECTIONS)[number];
    if (tier === TIER_A) {
      tierName =
        milestone !== undefined &&
        assessments.get(milestone.id)?.status === 'overdue'
          ? 'overdue'
          : 'upcoming';
    } else if (tier === TIER_B || tier === TIER_C) {
      tierName = 'unplanned';
    } else {
      tierName = 'inactive';
    }
    return {
      key: `t:${tierName}`,
      value: { kind: 'tier', tier: tierName },
      order: [TIER_SECTIONS.indexOf(tierName)],
    };
  };

  const milestoneGroup = (
    milestone: Milestone,
    tier: number
  ): Omit<GroupAcc, 'matches' | 'emptyTarget'> => {
    const complete =
      assessments.get(milestone.id)?.status === 'complete' ? 1 : 0;
    return {
      valueKey: `m:${milestone.id}`,
      value: {
        kind: 'milestone',
        milestoneId: milestone.id,
        projectId: milestone.projectId,
      },
      order: [
        tier,
        ...priorityFirst(milestone.projectId, milestone),
        complete,
        milestoneIndex.get(milestone.id) ?? 0,
      ],
    };
  };
  const NO_PROJECT_GROUP = {
    valueKey: 'np',
    value: { kind: 'no_project' } as const,
  };
  const assigneeOrder = (userId: string | null): SortKey => {
    if (userId === null) return [3];
    if (userId === viewerId) return [0];
    const user = snapshot.users.get(userId);
    const name = foldText(user?.name ?? '');
    return [
      user !== undefined && user.active && !user.app ? 1 : 2,
      name,
      userId,
    ];
  };
  const groupOf = (match: Match): Omit<GroupAcc, 'matches' | 'emptyTarget'> => {
    const { issue, projectId, milestone, tier } = match;
    switch (query.group) {
      case 'milestone':
        if (milestone !== undefined) return milestoneGroup(milestone, tier);
        if (projectId !== null) {
          return {
            valueKey: `nm:${projectId}`,
            value: { kind: 'no_milestone', projectId },
            order: [
              tier,
              ...priorityFirst(projectId, undefined),
              projectIndex.get(projectId) ?? 0,
            ],
          };
        }
        return { ...NO_PROJECT_GROUP, order: [TIER_C] };
      case 'project':
        if (projectId === null) return { ...NO_PROJECT_GROUP, order: [1] };
        return {
          valueKey: `p:${projectId}`,
          value: { kind: 'project', projectId },
          order: [
            isActive(projectId) ? 0 : 2,
            ...priorityFirst(projectId, undefined),
            projectIndex.get(projectId) ?? 0,
          ],
        };
      case 'initiative': {
        if (projectId === null) return { ...NO_PROJECT_GROUP, order: [2] };
        const initiativeId = home.get(projectId) ?? null;
        return initiativeId === null
          ? {
              valueKey: `i:${NO_INITIATIVE_ID}`,
              value: { kind: 'initiative', initiativeId: NO_INITIATIVE_ID },
              order: [1],
            }
          : {
              valueKey: `i:${initiativeId}`,
              value: { kind: 'initiative', initiativeId },
              order: [0, initiativeIndex.get(initiativeId) ?? 0],
            };
      }
      case 'assignee':
        return {
          valueKey: `a:${issue.assigneeId ?? LIST_NONE}`,
          value: { kind: 'assignee', userId: issue.assigneeId },
          order: assigneeOrder(issue.assigneeId),
        };
      case 'state': {
        const name = snapshot.states.get(issue.stateId)?.name ?? '';
        const key = stateNameKey(name);
        return {
          valueKey: `s:${match.stateType}:${key}`,
          value: {
            kind: 'state',
            stateType: match.stateType,
            stateName: name.trim(),
          },
          order: [STATE_TYPE_RANK.get(match.stateType) ?? 0, 0, key],
        };
      }
      case 'priority':
        return {
          valueKey: `pr:${issue.priority}`,
          value: { kind: 'priority', priority: issue.priority },
          order: [priorityRank(issue.priority)],
        };
      case 'none':
        return { valueKey: 'all', value: { kind: 'all' }, order: [0] };
    }
  };

  const sectionAcc = (place: {
    key: string;
    value: IssueListSectionValue;
    order: SortKey;
  }): SectionAcc => {
    let section = sections.get(place.key);
    if (section === undefined) {
      section = { ...place, groups: new Map() };
      sections.set(place.key, section);
    }
    return section;
  };
  for (const match of matches) {
    const section = sectionAcc(
      sectionOf(match.projectId, match.tier, match.milestone)
    );
    const place = groupOf(match);
    let group = section.groups.get(place.valueKey);
    if (group === undefined) {
      group = { ...place, matches: [], emptyTarget: false };
      section.groups.set(place.valueKey, group);
    }
    group.matches.push(match);
    if (query.group === 'state') {
      // A status group sorts by the lowest position among its states and
      // is named after that state.
      const state = snapshot.states.get(match.issue.stateId);
      const position = state?.position ?? Number.MAX_SAFE_INTEGER;
      if (group.statePosition === undefined || position < group.statePosition) {
        group.statePosition = position;
        group.order = [group.order[0] ?? 0, position, group.order[2] ?? ''];
        if (group.value.kind === 'state' && state !== undefined) {
          group.value = { ...group.value, stateName: state.name.trim() };
        }
      }
    }
  }

  // Every priority is a group (a drop target) even when empty, when the
  // list has no sections (inside sections only the ones with matches).
  if (query.group === 'priority' && query.sections === 'none') {
    const section = sectionAcc({
      key: 'all',
      value: { kind: 'all' },
      order: [0],
    });
    for (const priority of [1, 2, 3, 4, 0] as const) {
      const valueKey = `pr:${priority}`;
      if (section.groups.has(valueKey)) continue;
      section.groups.set(valueKey, {
        valueKey,
        value: { kind: 'priority', priority },
        order: [priorityRank(priority)],
        matches: [],
        emptyTarget: true,
      });
    }
  }

  // Empty milestones as drop targets (§2.14): the open milestones of 1 to
  // ISSUE_LIST_EMPTY_TARGET_PROJECTS named projects, and every named
  // milestone the viewer's snapshot holds (an unknown or hidden id never
  // becomes a header).
  if (query.group === 'milestone') {
    const targets = new Map<string, Milestone>();
    const namedProjects = filters.projectIds.filter((id) => id !== LIST_NONE);
    if (
      namedProjects.length >= 1 &&
      namedProjects.length <= ISSUE_LIST_EMPTY_TARGET_PROJECTS
    ) {
      for (const projectId of namedProjects) {
        for (const milestone of snapshot.milestonesByProject.get(projectId) ??
          []) {
          if (assessments.get(milestone.id)?.status !== 'complete')
            targets.set(milestone.id, milestone);
        }
      }
    }
    for (const milestoneId of filters.milestoneIds) {
      const milestone = snapshot.milestones.get(milestoneId);
      if (
        milestone !== undefined &&
        snapshot.projects.has(milestone.projectId)
      ) {
        targets.set(milestone.id, milestone);
      }
    }
    for (const milestone of targets.values()) {
      const tier = isActive(milestone.projectId) ? TIER_A : TIER_D;
      const section = sectionAcc(
        sectionOf(milestone.projectId, tier, milestone)
      );
      const place = milestoneGroup(milestone, tier);
      if (section.groups.has(place.valueKey)) continue;
      section.groups.set(place.valueKey, {
        ...place,
        matches: [],
        emptyTarget: true,
      });
    }
  }

  // --- order and budgets ------------------------------------------------------------------
  const compareRows = rowComparator(query.sort, query.dir);
  const orderedSections = [...sections.values()].sort((a, b) =>
    compareKeys(a.order, b.order)
  );
  const planByProject = new Map(
    allocationPlan.projects.map((plan) => [plan.projectId, plan])
  );
  const refIds = {
    people: new Set<string>(),
    teams: new Set<string>(),
    initiatives: new Set<string>(),
    projects: new Set<string>(),
    milestones: new Set<string>(),
  };
  const toRow = (match: Match): IssueListRow => {
    const { issue } = match;
    const state = snapshot.states.get(issue.stateId);
    const due = issue.dueDate ?? null;
    const assessment =
      match.milestone === undefined
        ? undefined
        : assessments.get(match.milestone.id);
    const active = isActive(match.projectId);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      teamId: issue.teamId,
      stateId: issue.stateId,
      stateName: state?.name ?? '',
      stateType: match.stateType,
      priority: issue.priority,
      assigneeId: issue.assigneeId,
      projectId: match.projectId,
      milestoneId: match.milestone?.id ?? null,
      dueDate: due !== null && isValidIsoDate(due) ? due : null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      open: match.open,
      blockedBy: match.blockedBy,
      holdsUpMilestoneId: match.open ? (holdsUp.get(issue.id) ?? null) : null,
      unassignedInNext:
        match.open &&
        issue.assigneeId === null &&
        match.stateType !== 'triage' &&
        active &&
        assessment?.isNext === true,
      projectActive: match.projectId === null || active,
    };
  };

  let remaining = query.limit;
  let keptGroups = 0;
  let shown = 0;
  const moreGroups = { groups: 0, issues: 0 };
  const outSections: IssueListSection[] = [];
  for (const section of orderedSections) {
    const groups = [...section.groups.values()].sort((a, b) =>
      compareKeys(a.order, b.order)
    );
    const outGroups: IssueListGroup[] = [];
    let sectionCount = 0;
    for (const group of groups) {
      sectionCount += group.matches.length;
      if (keptGroups >= ISSUE_LIST_MAX_GROUPS) {
        moreGroups.groups += 1;
        moreGroups.issues += group.matches.length;
        continue;
      }
      keptGroups += 1;
      const take = Math.min(group.matches.length, remaining);
      const rows =
        take === 0
          ? []
          : group.matches.sort(compareRows).slice(0, take).map(toRow);
      remaining -= rows.length;
      shown += rows.length;
      for (const row of rows) {
        if (row.assigneeId !== null) refIds.people.add(row.assigneeId);
        refIds.teams.add(row.teamId);
        if (row.projectId !== null) refIds.projects.add(row.projectId);
        if (row.milestoneId !== null) refIds.milestones.add(row.milestoneId);
        if (row.holdsUpMilestoneId !== null)
          refIds.milestones.add(row.holdsUpMilestoneId);
      }
      referenceGroup(group.value, refIds);
      outGroups.push({
        key: `${section.key}/${group.valueKey}`,
        value: group.value,
        count: group.matches.length,
        rows,
        patch: dropPatch(snapshot, group.value),
        muted: isMuted(group.value, isActive),
        emptyTarget: group.emptyTarget || group.matches.length === 0,
      });
    }
    if (outGroups.length === 0) continue;
    if (
      section.value.kind === 'initiative' &&
      section.value.initiativeId !== NO_INITIATIVE_ID
    ) {
      refIds.initiatives.add(section.value.initiativeId);
    }
    if (section.value.kind === 'project')
      refIds.projects.add(section.value.projectId);
    outSections.push({
      key: section.key,
      value: section.value,
      count: sectionCount,
      groups: outGroups,
    });
  }

  // --- filter values: unknown ids, refs, "also in" ------------------------------------------
  const unknownIds: IssueListView['unknownIds'] = [];
  const checkIds = (
    facet: IssueListIdFacet,
    ids: readonly string[],
    known: (id: string) => boolean
  ): void => {
    for (const id of ids) {
      if (id === LIST_NONE || (facet === 'assignee' && id === LIST_ME))
        continue;
      if (known(id)) continue;
      unknownIds.push({ facet, id });
    }
  };
  checkIds('initiative', filters.initiativeIds, (id) =>
    snapshot.initiatives.has(id)
  );
  checkIds('project', filters.projectIds, (id) => snapshot.projects.has(id));
  checkIds('milestone', filters.milestoneIds, (id) =>
    snapshot.milestones.has(id)
  );
  checkIds('assignee', filters.assigneeIds, (id) => snapshot.users.has(id));
  checkIds('team', filters.teamIds, (id) => snapshot.teams.has(id));
  for (const id of filters.initiativeIds)
    if (snapshot.initiatives.has(id)) refIds.initiatives.add(id);
  for (const id of filters.projectIds)
    if (snapshot.projects.has(id)) refIds.projects.add(id);
  for (const id of filters.milestoneIds)
    if (snapshot.milestones.has(id)) refIds.milestones.add(id);
  for (const id of filters.assigneeIds) {
    const userId = id === LIST_ME ? viewerId : id;
    if (userId !== null && snapshot.users.has(userId))
      refIds.people.add(userId);
  }
  for (const id of filters.teamIds)
    if (snapshot.teams.has(id)) refIds.teams.add(id);

  const alsoIn: IssueListView['alsoIn'] = [];
  if (filters.initiativeIds.length > 0) {
    const chosen = new Set(filters.initiativeIds);
    for (const project of orderedProjects) {
      const homeId = home.get(project.id) ?? null;
      if (homeId === null || chosen.has(homeId)) continue;
      const chosenInitiative = sortedInitiatives.find(
        (initiative) =>
          chosen.has(initiative.id) &&
          project.initiativeIds.includes(initiative.id)
      );
      if (chosenInitiative === undefined) continue;
      alsoIn.push({
        projectId: project.id,
        projectName: project.name,
        homeInitiativeName: snapshot.initiatives.get(homeId)?.name ?? '',
        chosenInitiativeName: chosenInitiative.name,
      });
      refIds.projects.add(project.id);
    }
  }

  // --- refs ------------------------------------------------------------------------------
  const refs: IssueListRefs = {
    people: {},
    teams: {},
    initiatives: {},
    projects: {},
    milestones: {},
  };
  for (const milestoneId of refIds.milestones) {
    const milestone = snapshot.milestones.get(milestoneId);
    if (milestone !== undefined) refIds.projects.add(milestone.projectId);
  }
  for (const projectId of refIds.projects) {
    const project = snapshot.projects.get(projectId);
    if (project === undefined) continue;
    const plan = planByProject.get(projectId);
    const homeId = home.get(projectId) ?? null;
    const nextId = nextByProject.get(projectId) ?? null;
    if (homeId !== null) refIds.initiatives.add(homeId);
    if (project.leadId !== null) refIds.people.add(project.leadId);
    if (nextId !== null) refIds.milestones.add(nextId);
    refs.projects[projectId] = {
      name: project.name,
      url: project.url,
      active: isActive(projectId),
      statusName: project.statusName,
      leadId: project.leadId,
      homeInitiativeId: homeId,
      nextMilestoneId: nextId,
      allocation:
        plan === undefined
          ? null
          : {
              outcome: plan.outcome,
              blockReason: plan.blockReason,
              gaps: [...plan.gaps],
            },
    };
  }
  for (const milestoneId of refIds.milestones) {
    const milestone = snapshot.milestones.get(milestoneId);
    const assessment = assessments.get(milestoneId);
    if (milestone === undefined || assessment === undefined) continue;
    refs.milestones[milestoneId] = {
      name: milestone.name,
      projectId: milestone.projectId,
      targetDate: milestoneTargetDate(milestone),
      daysLeft: assessment.daysLeft,
      status: assessment.status,
      reasons: [...assessment.reasons],
      rubric: {
        valid: assessment.rubric.valid,
        gaps: [...assessment.rubric.gaps],
      },
      isNext: assessment.isNext,
      weight: ctx.meta.get(milestoneId)?.weight ?? null,
      progress: { ...assessment.progress },
    };
  }
  for (const userId of refIds.people) {
    const user = snapshot.users.get(userId);
    refs.people[userId] =
      user === undefined
        ? { name: 'Unknown user', active: false }
        : { name: user.name, active: user.active };
  }
  for (const teamId of refIds.teams) {
    const team = snapshot.teams.get(teamId);
    if (team !== undefined)
      refs.teams[teamId] = { key: team.key, name: team.name };
  }
  for (const initiativeId of refIds.initiatives) {
    const initiative = snapshot.initiatives.get(initiativeId);
    if (initiative !== undefined)
      refs.initiatives[initiativeId] = { name: initiative.name };
  }

  let projectCount = 0;
  for (const project of snapshot.data.projects) {
    if (project.statusType !== 'completed' && project.statusType !== 'canceled')
      projectCount += 1;
  }

  return {
    query,
    today: ctx.today,
    total: matches.length,
    shown,
    sections: outSections,
    moreGroups,
    counts,
    projectCount,
    refs,
    unknownIds,
    fallback: applied.fallback,
    includesClosed: filters.stateTypes.some((type) => !isOpenState(type)),
    alsoIn,
  };
}

// Adds the ids a group header names to the refs.
function referenceGroup(
  value: IssueListGroupValue,
  refIds: {
    people: Set<string>;
    initiatives: Set<string>;
    projects: Set<string>;
    milestones: Set<string>;
  }
): void {
  switch (value.kind) {
    case 'milestone':
      refIds.milestones.add(value.milestoneId);
      refIds.projects.add(value.projectId);
      break;
    case 'no_milestone':
    case 'project':
      refIds.projects.add(value.projectId);
      break;
    case 'initiative':
      if (value.initiativeId !== NO_INITIATIVE_ID)
        refIds.initiatives.add(value.initiativeId);
      break;
    case 'assignee':
      if (value.userId !== null) refIds.people.add(value.userId);
      break;
    default:
      break;
  }
}

/**
 * What dropping issues on a group sets (§2.14): the group's own value, or
 * null where a drop cannot mean one change (an initiative comes from the
 * project; "all issues" is no value), or where it could only fail (a
 * deactivated person, an app user or an unknown person as assignee; a
 * state the mirror does not know).
 */
function dropPatch(
  snapshot: Snapshot,
  value: IssueListGroupValue
): IssueBulkPatch | null {
  switch (value.kind) {
    case 'milestone':
      return {
        move: { projectId: value.projectId, milestoneId: value.milestoneId },
      };
    case 'no_milestone':
    case 'project':
      return { move: { projectId: value.projectId, milestoneId: null } };
    case 'no_project':
      return { move: { projectId: null, milestoneId: null } };
    case 'assignee': {
      if (value.userId === null) return { assigneeId: null };
      const user = snapshot.users.get(value.userId);
      return user !== undefined && user.active && !user.app
        ? { assigneeId: value.userId }
        : null;
    }
    case 'state':
      return value.stateName === ''
        ? null
        : { state: { type: value.stateType, name: value.stateName } };
    case 'priority':
      return { priority: value.priority };
    case 'initiative':
    case 'all':
      return null;
  }
}

// Groups of an inactive project (its milestones, its "No milestone", the
// project itself) are drawn quietly.
function isMuted(
  value: IssueListGroupValue,
  isActive: (projectId: string | null) => boolean
): boolean {
  switch (value.kind) {
    case 'milestone':
    case 'no_milestone':
    case 'project':
      return !isActive(value.projectId);
    default:
      return false;
  }
}

/**
 * The data of the list's filter, move and bulk pickers, from the viewer's
 * snapshot: initiatives in compareInitiatives order; projects active first
 * (timeline order) with their milestones in §2.6 order, and each project's
 * teams narrowed to the teams the viewer sees (the narrowed snapshot keeps
 * a shared project's full team list, and this goes to the browser);
 * non-app people, active first, each part by folded name; teams by name
 * with their states (type group, then position).
 */
export function buildIssueListOptions(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): IssueListOptions {
  const activeStatuses = new Set(ctx.tuning.activeProjectStatuses);
  const home = homeInitiativeIds(snapshot);
  const projects = orderProjects(snapshot).map((project) => ({
    id: project.id,
    name: project.name,
    active: activeStatuses.has(project.statusType),
    statusName: project.statusName,
    homeInitiativeId: home.get(project.id) ?? null,
    teamIds: project.teamIds.filter((teamId) => snapshot.teams.has(teamId)),
    leadId: project.leadId,
    milestones: (snapshot.milestonesByProject.get(project.id) ?? []).map(
      (milestone) => {
        const assessment = assessments.get(milestone.id);
        return {
          id: milestone.id,
          name: milestone.name,
          targetDate: milestoneTargetDate(milestone),
          daysLeft: assessment?.daysLeft ?? null,
          status: assessment?.status ?? 'empty',
          isNext: assessment?.isNext ?? false,
          weight: ctx.meta.get(milestone.id)?.weight ?? null,
        };
      }
    ),
  }));
  const byFoldedName = <T extends { id: string; name: string }>(
    a: T,
    b: T
  ): number => {
    const byName = compareStrings(foldText(a.name), foldText(b.name));
    return byName !== 0 ? byName : compareStrings(a.id, b.id);
  };
  const people = snapshot.data.users
    .filter((user) => !user.app)
    .sort((a, b) =>
      a.active !== b.active ? (a.active ? -1 : 1) : byFoldedName(a, b)
    )
    .map((user) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      active: user.active,
    }));
  const statesByTeam = new Map<
    string,
    IssueListOptions['teams'][number]['states']
  >();
  for (const state of snapshot.data.states) {
    const list = statesByTeam.get(state.teamId) ?? [];
    list.push({
      id: state.id,
      name: state.name,
      type: state.type,
      position: state.position,
    });
    statesByTeam.set(state.teamId, list);
  }
  const teams = [...snapshot.data.teams].sort(byFoldedName).map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
    states: (statesByTeam.get(team.id) ?? []).sort((a, b) => {
      const byType =
        (STATE_TYPE_RANK.get(a.type) ?? 0) - (STATE_TYPE_RANK.get(b.type) ?? 0);
      if (byType !== 0) return byType;
      if (a.position !== b.position) return a.position - b.position;
      return byFoldedName(a, b);
    }),
  }));
  return {
    initiatives: [...snapshot.data.initiatives]
      .sort(compareInitiatives)
      .map((initiative) => ({ id: initiative.id, name: initiative.name })),
    projects: [
      ...projects.filter((project) => project.active),
      ...projects.filter((project) => !project.active),
    ],
    people,
    teams,
  };
}
