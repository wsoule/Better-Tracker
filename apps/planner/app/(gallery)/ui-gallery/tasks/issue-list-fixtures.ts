import type {
  TaskChipData,
  TaskGroupProgress,
  TaskPriority,
  TaskStateKind,
  UiStatus,
  UiTone,
} from '@better-tracker/ui';

// Fixture data for the gallery's issue list (/ui-gallery/tasks): a small
// fictional workspace seen by Chloe on Thursday, October 22, 2026. The
// gallery keeps these in state and turns them into TaskGroupTable data
// itself, so selection, drag, the bulk bar and the cell pickers can be
// tried for real. Nothing is computed from an engine; the order is the
// order written here (the planner's weight order comes from core).

export interface ProjectFixture {
  id: string;
  name: string;
  active: boolean;
}

export interface MilestoneFixture {
  id: string;
  projectId: string;
  name: string;
  /** The tier divider it is listed under. */
  tier: 'overdue' | 'upcoming' | 'inactive';
  status: UiStatus;
  statusLabel: string;
  dueLabel: string;
  daysLeftLabel: string;
  /** The due date's status tone (architecture §8.2, as My week draws
      it): danger overdue, warning undated or due today or tomorrow; none
      otherwise. */
  dueTone?: UiTone;
  progress: TaskGroupProgress;
  weight: number;
  next?: boolean;
  missingLabel?: string;
  /** Matching issues past the row budget (shown as a footer). */
  notLoaded?: number;
}

export interface StateFixture {
  id: string;
  name: string;
  kind: TaskStateKind;
}

export interface PersonFixture {
  id: string;
  name: string;
}

export interface IssueFixture {
  id: string;
  key: string;
  title: string;
  projectId: string;
  milestoneId: string | null;
  assigneeId: string | null;
  stateId: string;
  priority: TaskPriority;
  due?: string;
  dueTone?: UiTone;
  /** The toned date's word under it ("Overdue", "Tomorrow"), as the
      planner's. */
  dueNote?: string;
  /** Row chips, as the planner's (Blocked: the filled amber chip). */
  chips?: TaskChipData[];
  note?: { text: string; tone?: UiTone };
}

export const ISSUE_PROJECTS: ProjectFixture[] = [
  { id: 'p-atlas', name: 'Atlas billing migration', active: true },
  { id: 'p-garnet', name: 'Garnet mobile app', active: true },
  { id: 'p-fjord', name: 'Fjord analytics', active: false },
];

export const ISSUE_MILESTONES: MilestoneFixture[] = [
  {
    id: 'ms-atlas-2',
    projectId: 'p-atlas',
    name: 'Dual-write',
    tier: 'overdue',
    status: 'overdue',
    statusLabel: 'Overdue',
    dueLabel: 'Oct 20',
    daysLeftLabel: '2 days overdue',
    dueTone: 'danger',
    progress: { done: 4, total: 9, tone: 'danger' },
    weight: 2,
    next: true,
    notLoaded: 209,
  },
  {
    id: 'ms-garnet-1',
    projectId: 'p-garnet',
    name: 'Offline mode',
    tier: 'upcoming',
    status: 'on_track',
    statusLabel: 'On track',
    dueLabel: 'Oct 28',
    daysLeftLabel: '6 days left',
    progress: { done: 1, total: 4 },
    weight: 0,
    next: true,
  },
  {
    id: 'ms-garnet-2',
    projectId: 'p-garnet',
    name: 'Push notifications',
    tier: 'upcoming',
    status: 'missing',
    statusLabel: 'Missing: issues',
    dueLabel: 'Nov 12',
    daysLeftLabel: '21 days left',
    progress: { done: 0, total: 0 },
    weight: 0,
    missingLabel: 'Missing: done means…',
  },
  {
    id: 'ms-fjord-1',
    projectId: 'p-fjord',
    name: 'Dashboards',
    tier: 'inactive',
    status: 'overdue',
    statusLabel: 'Overdue · inactive project',
    dueLabel: 'Oct 16',
    daysLeftLabel: 'Inactive project',
    progress: { done: 0, total: 2 },
    weight: 0,
  },
];

export const ISSUE_STATES: StateFixture[] = [
  { id: 'st-triage', name: 'Triage', kind: 'triage' },
  { id: 'st-todo', name: 'Todo', kind: 'unstarted' },
  { id: 'st-progress', name: 'In Progress', kind: 'started' },
  { id: 'st-review', name: 'In Review', kind: 'started' },
  { id: 'st-done', name: 'Done', kind: 'completed' },
];

export const ISSUE_PEOPLE: PersonFixture[] = [
  { id: 'u-chloe', name: 'Chloe Park' },
  { id: 'u-ana', name: 'Ana Moreno' },
  { id: 'u-ben', name: 'Ben Okafor' },
  { id: 'u-dev', name: 'Dev Patel' },
];

export const ME_ID = 'u-chloe';

export const ISSUES: IssueFixture[] = [
  {
    id: 'eng-12',
    key: 'ENG-12',
    title: 'Backfill ledger rows from the old billing tables',
    projectId: 'p-atlas',
    milestoneId: 'ms-atlas-2',
    assigneeId: 'u-ana',
    stateId: 'st-progress',
    priority: 2,
    due: 'Oct 20',
    dueTone: 'danger',
    dueNote: 'Overdue',
  },
  {
    id: 'eng-14',
    key: 'ENG-14',
    title: 'Shadow-write invoices to the new store',
    projectId: 'p-atlas',
    milestoneId: 'ms-atlas-2',
    assigneeId: null,
    stateId: 'st-todo',
    priority: 1,
    due: 'Oct 23',
    dueTone: 'warning',
    dueNote: 'Tomorrow',
    chips: [{ label: 'Blocked', tone: 'warning', filled: true }],
  },
  {
    id: 'eng-15',
    key: 'ENG-15',
    title: 'Reconcile nightly totals',
    projectId: 'p-atlas',
    milestoneId: 'ms-atlas-2',
    assigneeId: 'u-dev',
    stateId: 'st-review',
    priority: 3,
    note: {
      text: 'Not moved · Linear refused: Garnet mobile app does not include OPS',
      tone: 'danger',
    },
  },
  {
    id: 'eng-50',
    key: 'ENG-50',
    title: 'Cache the last 50 screens',
    projectId: 'p-garnet',
    milestoneId: 'ms-garnet-1',
    assigneeId: 'u-ben',
    stateId: 'st-progress',
    priority: 2,
    due: 'Oct 27',
  },
  {
    id: 'eng-51',
    key: 'ENG-51',
    title: 'Queue writes while offline',
    projectId: 'p-garnet',
    milestoneId: 'ms-garnet-1',
    assigneeId: 'u-chloe',
    stateId: 'st-todo',
    priority: 3,
  },
  {
    id: 'eng-53',
    key: 'ENG-53',
    title: 'Conflict banner after reconnecting',
    projectId: 'p-garnet',
    milestoneId: 'ms-garnet-1',
    assigneeId: null,
    stateId: 'st-review',
    priority: 4,
  },
  {
    id: 'eng-54',
    key: 'ENG-54',
    title: 'Crash on cold start with no network',
    projectId: 'p-garnet',
    milestoneId: null,
    assigneeId: null,
    stateId: 'st-triage',
    priority: 1,
  },
  {
    id: 'eng-55',
    key: 'ENG-55',
    title: 'Settings sync between devices',
    projectId: 'p-garnet',
    milestoneId: null,
    assigneeId: 'u-ben',
    stateId: 'st-todo',
    priority: 0,
  },
  {
    id: 'ops-7',
    key: 'OPS-7',
    title: 'Weekly revenue chart',
    projectId: 'p-fjord',
    milestoneId: 'ms-fjord-1',
    assigneeId: 'u-ana',
    stateId: 'st-todo',
    priority: 3,
    due: 'Oct 16',
  },
];

export const PRIORITY_NAMES: Record<TaskPriority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export const SORT_OPTIONS = [
  {
    value: 'weight',
    label: 'Weight',
    hint: 'Overdue first, then weight, due date and project priority',
  },
  { value: 'priority', label: 'Priority', hint: 'Urgent first' },
  { value: 'due', label: 'Due date', hint: 'Soonest first' },
  { value: 'updated', label: 'Last updated', hint: 'Newest first' },
  { value: 'created', label: 'Created', hint: 'Newest first' },
  { value: 'title', label: 'Title', hint: 'A to Z' },
];

export const FILTER_FIELDS = [
  'Initiative',
  'Project',
  'Milestone',
  'Assignee',
  'Team',
  'Status',
  'Priority',
];

export const QUICK_FILTERS = ['Blocked', 'At risk', 'In next milestones'];
