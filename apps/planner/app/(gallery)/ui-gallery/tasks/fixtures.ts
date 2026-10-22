import type {
  ChecklistItem,
  ChipTone,
  DeadlineGroup,
  SegmentedOption,
  StatCell,
  TaskSectionData,
  UiTone,
} from '@better-tracker/ui';

// Fixture props for /ui-gallery/tasks: a fictional workspace on Wednesday,
// October 21, 2026, seen by Pat (who leads Atlas). Shapes only; nothing
// here is computed, so the gallery needs no engine. Tones follow
// architecture §8.2: overdue danger, at risk / blocked / due soon warning,
// allocating and in progress info, new to you the accent.

export const WEEK_STATS: StatCell[] = [
  {
    id: 'open',
    label: 'Open issues · this week',
    value: 7,
    note: 'of 12 assigned to you',
    href: '/week#this-week',
  },
  {
    id: 'overdue',
    label: 'Overdue milestones',
    value: 1,
    note: 'Atlas · cutover rehearsal',
    tone: 'danger',
    href: '/timeline?milestone=m-atlas-cutover',
  },
  {
    id: 'new',
    label: 'New to you',
    value: 2,
    note: 'given because you lead Atlas',
    tone: 'accent',
  },
  {
    id: 'risk',
    label: 'At risk in your projects',
    value: 1,
    note: 'Beacon · public beta',
    tone: 'warning',
  },
];

const NEW_CHIP = {
  label: 'New — given to you because you lead Atlas',
  tone: 'accent' as const,
};

export const WEEK_SECTIONS: TaskSectionData[] = [
  {
    id: 'this-week',
    label: 'This week',
    groups: [
      {
        id: 'm-atlas-cutover',
        eyebrow: 'Atlas migration',
        title: 'Cutover rehearsal',
        href: '/timeline?milestone=m-atlas-cutover',
        status: 'overdue',
        statusLabel: 'Overdue',
        dueLabel: 'Oct 19',
        daysLeftLabel: '2 days overdue',
        dueTone: 'danger',
        progress: { done: 4, total: 7, tone: 'danger' },
        rows: [
          {
            id: 'atl-142',
            key: 'ATL-142',
            title: 'Freeze writes on the legacy ledger',
            href: '/issues/ATL-142',
            project: 'Atlas migration',
            state: 'In Progress',
            stateKind: 'started',
            priority: 1,
            priorityLabel: 'Urgent',
            due: 'Oct 19',
            dueTone: 'danger',
          },
          {
            id: 'atl-151',
            key: 'ATL-151',
            title: 'Dry-run the cutover script against staging',
            href: '/issues/ATL-151',
            project: 'Atlas migration',
            state: 'Todo',
            stateKind: 'unstarted',
            priority: 2,
            priorityLabel: 'High',
            due: 'Oct 19',
            dueTone: 'danger',
            chips: [NEW_CHIP],
          },
          {
            id: 'atl-157',
            key: 'ATL-157',
            title: 'Write the rollback runbook',
            href: '/issues/ATL-157',
            project: 'Atlas migration',
            state: 'Todo',
            stateKind: 'unstarted',
            priority: 3,
            priorityLabel: 'Medium',
            due: 'Oct 19',
            dueTone: 'danger',
            chips: [NEW_CHIP],
          },
        ],
      },
      {
        id: 'm-beacon-beta',
        eyebrow: 'Beacon',
        title: 'Public beta',
        href: '/timeline?milestone=m-beacon-beta',
        status: 'at_risk',
        statusLabel: 'At risk',
        dueLabel: 'Oct 23',
        daysLeftLabel: '2 days left',
        progress: { done: 3, total: 7, tone: 'warning' },
        rows: [
          {
            id: 'bea-88',
            key: 'BEA-88',
            title: 'Import the invite list from the waitlist export',
            href: '/issues/BEA-88',
            project: 'Beacon',
            state: 'In Review',
            stateKind: 'started',
            priority: 2,
            priorityLabel: 'High',
            due: 'Oct 23',
          },
          {
            id: 'bea-91',
            key: 'BEA-91',
            title: 'Rate-limit the public sign-up endpoint',
            href: '/issues/BEA-91',
            project: 'Beacon',
            state: 'Triage',
            stateKind: 'triage',
            priority: 0,
            priorityLabel: 'No priority',
            due: 'Oct 23',
          },
          {
            id: 'bea-95',
            key: 'BEA-95',
            title: 'Beta feedback form in the help menu',
            href: 'https://linear.app/example/issue/BEA-95',
            external: true,
            project: 'Beacon',
            state: 'Backlog',
            stateKind: 'backlog',
            priority: 4,
            priorityLabel: 'Low',
            due: 'Oct 23',
          },
        ],
      },
      {
        id: 'm-cobalt-invoices',
        eyebrow: 'Cobalt',
        title: 'Invoices v2',
        href: '/timeline?milestone=m-cobalt-invoices',
        status: 'on_track',
        statusLabel: 'On track',
        dueLabel: 'Oct 26',
        daysLeftLabel: '5 days left',
        progress: { done: 6, total: 9 },
        rows: [
          {
            id: 'cob-310',
            key: 'COB-310',
            title: 'Proration for mid-cycle plan changes',
            href: '/issues/COB-310',
            project: 'Cobalt',
            state: 'In Progress',
            stateKind: 'started',
            priority: 3,
            priorityLabel: 'Medium',
            due: 'Oct 26',
          },
        ],
      },
    ],
  },
  {
    id: 'later',
    label: 'Later',
    groups: [
      {
        id: 'm-atlas-decom',
        eyebrow: 'Atlas migration',
        title: 'Decommission the legacy ledger',
        href: '/timeline?milestone=m-atlas-decom',
        status: 'on_track',
        statusLabel: 'On track',
        dueLabel: 'Nov 13',
        daysLeftLabel: '23 days left',
        progress: { done: 0, total: 5 },
        rows: [
          {
            id: 'atl-170',
            key: 'ATL-170',
            title: 'Archive ledger snapshots to cold storage',
            href: '/issues/ATL-170',
            project: 'Atlas migration',
            state: 'Backlog',
            stateKind: 'backlog',
            priority: 4,
            priorityLabel: 'Low',
            due: 'Nov 13',
          },
          {
            id: 'atl-171',
            key: 'ATL-171',
            title: 'Remove the dual-write shim',
            href: '/issues/ATL-171',
            project: 'Atlas migration',
            state: 'Todo',
            stateKind: 'unstarted',
            priority: 3,
            priorityLabel: 'Medium',
            due: 'Nov 13',
          },
        ],
      },
      {
        id: 'm-delta-search',
        eyebrow: 'Delta',
        title: 'Search relevance',
        href: '/timeline?milestone=m-delta-search',
        status: 'missing',
        statusLabel: 'Missing input',
        dueLabel: 'No target date',
        dueTone: 'warning',
        progress: { done: 1, total: 4 },
        rows: [
          {
            id: 'del-42',
            key: 'DEL-42',
            title: 'Tune synonyms for product names',
            href: '/issues/DEL-42',
            project: 'Delta',
            state: 'In Progress',
            stateKind: 'started',
            priority: 2,
            priorityLabel: 'High',
          },
        ],
      },
    ],
  },
  {
    id: 'no-milestone',
    label: 'No milestone',
    groups: [
      {
        id: 'none',
        title: 'Issues without a milestone',
        rows: [
          {
            id: 'bea-102',
            key: 'BEA-102',
            title: 'Typo in the onboarding email footer',
            href: '/issues/BEA-102',
            project: 'Beacon',
            state: 'Todo',
            stateKind: 'unstarted',
            priority: 4,
            priorityLabel: 'Low',
          },
          {
            id: 'cob-322',
            key: 'COB-322',
            title: 'Flaky snapshot test for invoice PDFs',
            href: '/issues/COB-322',
            project: 'Cobalt',
            state: 'Backlog',
            stateKind: 'backlog',
            priority: 0,
            priorityLabel: 'No priority',
          },
        ],
      },
    ],
  },
];

export const DEADLINES: DeadlineGroup[] = [
  {
    id: 'overdue',
    label: 'Overdue',
    tone: 'danger',
    items: [
      {
        id: 'm-atlas-cutover',
        label: 'Cutover rehearsal',
        sublabel: 'Atlas migration · 3 open',
        href: '/timeline?milestone=m-atlas-cutover',
        status: 'overdue',
        statusLabel: 'Overdue',
        dueLabel: 'Oct 19',
      },
    ],
  },
  { id: 'today', label: 'Today', items: [] },
  {
    id: 'tomorrow',
    label: 'Tomorrow',
    tone: 'warning',
    items: [
      {
        id: 'm-cobalt-export',
        label: 'CSV export',
        sublabel: 'Cobalt · 2 open',
        href: '/timeline?milestone=m-cobalt-export',
        status: 'on_track',
        statusLabel: 'On track',
        dueLabel: 'Oct 22',
      },
    ],
  },
  {
    id: 'week',
    label: 'This week',
    items: [
      {
        id: 'm-beacon-beta',
        label: 'Public beta',
        sublabel: 'Beacon · 4 open · 1 unassigned',
        href: '/timeline?milestone=m-beacon-beta',
        status: 'at_risk',
        statusLabel: 'At risk',
        dueLabel: 'Oct 23',
      },
      {
        id: 'm-echo-pilot',
        label: 'Pilot customer handover',
        sublabel: 'Echo · 5 open',
        href: '/timeline?milestone=m-echo-pilot',
        status: 'on_track',
        statusLabel: 'On track',
        dueLabel: 'Oct 24',
      },
      {
        id: 'm-cobalt-invoices',
        label: 'Invoices v2',
        sublabel: 'Cobalt · 3 open',
        href: '/timeline?milestone=m-cobalt-invoices',
        status: 'on_track',
        statusLabel: 'On track',
        dueLabel: 'Oct 26',
      },
      {
        id: 'm-fern-audit',
        label: 'Access audit',
        sublabel: 'Fern · 2 open',
        href: '/timeline?milestone=m-fern-audit',
        status: 'missing',
        statusLabel: 'Missing: done means…',
        dueLabel: 'Oct 27',
      },
      {
        id: 'm-atlas-dashboards',
        label: 'Ledger dashboards',
        sublabel: 'Atlas migration · 1 open',
        href: '/timeline?milestone=m-atlas-dashboards',
        status: 'on_track',
        statusLabel: 'On track',
        dueLabel: 'Oct 28',
      },
      {
        id: 'm-beacon-docs',
        label: 'Public docs',
        sublabel: 'Beacon · 2 open',
        href: '/timeline?milestone=m-beacon-docs',
        status: 'done',
        statusLabel: 'Complete',
        dueLabel: 'Oct 28',
      },
    ],
  },
];

export interface ProjectFixture {
  id: string;
  name: string;
  initiative: string;
  linearStatus: string;
  /** The Linear status's dot: info started, muted backlog / planned. */
  linearTone: ChipTone;
  milestone: string;
  milestoneDue: string;
  /** danger overdue, warning undated or due soon, default later. */
  milestoneDueTone: UiTone;
  /** The progress fill: danger overdue, warning behind pace. */
  progressTone: UiTone;
  status: 'done' | 'on_track' | 'at_risk' | 'overdue' | 'missing';
  statusLabel: string;
  done: number;
  total: number;
  lead: string | null;
  allocation: string;
  /** Under the allocation chip: why it is blocked. */
  allocationDetail?: string;
  allocationTone: 'default' | 'muted' | 'info' | 'warning';
  active: boolean;
}

export const PROJECTS: ProjectFixture[] = [
  {
    id: 'p-atlas',
    name: 'Atlas migration',
    initiative: 'Platform',
    linearStatus: 'In Progress',
    linearTone: 'info',
    milestone: 'Cutover rehearsal',
    milestoneDue: 'Oct 19 · 2 days overdue',
    milestoneDueTone: 'danger',
    progressTone: 'danger',
    status: 'overdue',
    statusLabel: 'Overdue',
    done: 4,
    total: 7,
    lead: 'Pat Okafor',
    allocation: 'Allocating 2',
    allocationTone: 'info',
    active: true,
  },
  {
    id: 'p-delta',
    name: 'Delta',
    initiative: 'Growth',
    linearStatus: 'Planned',
    linearTone: 'muted',
    milestone: 'Search relevance',
    milestoneDue: 'No target date',
    milestoneDueTone: 'warning',
    progressTone: 'default',
    status: 'missing',
    statusLabel: 'Missing input',
    done: 1,
    total: 4,
    lead: null,
    allocation: 'Blocked',
    allocationDetail: 'Project has no lead',
    allocationTone: 'warning',
    active: true,
  },
  {
    id: 'p-beacon',
    name: 'Beacon',
    initiative: 'Growth',
    linearStatus: 'In Progress',
    linearTone: 'info',
    milestone: 'Public beta',
    milestoneDue: 'Oct 23 · 2 days left',
    milestoneDueTone: 'default',
    progressTone: 'warning',
    status: 'at_risk',
    statusLabel: 'At risk',
    done: 3,
    total: 7,
    lead: 'Ren Ito',
    allocation: 'Nothing to do',
    allocationTone: 'default',
    active: true,
  },
  {
    id: 'p-cobalt',
    name: 'Cobalt',
    initiative: 'Revenue',
    linearStatus: 'In Progress',
    linearTone: 'info',
    milestone: 'Invoices v2',
    milestoneDue: 'Oct 26 · 5 days left',
    milestoneDueTone: 'default',
    progressTone: 'default',
    status: 'on_track',
    statusLabel: 'On track',
    done: 6,
    total: 9,
    lead: 'Sam Reyes',
    allocation: 'Allocating 1',
    allocationTone: 'info',
    active: true,
  },
  {
    id: 'p-glass',
    name: 'Glass',
    initiative: 'Revenue',
    linearStatus: 'Backlog',
    linearTone: 'muted',
    milestone: 'Pricing page refresh',
    milestoneDue: 'Dec 4 · 44 days left',
    milestoneDueTone: 'muted',
    progressTone: 'muted',
    status: 'on_track',
    statusLabel: 'On track',
    done: 0,
    total: 3,
    lead: 'Ines Duarte',
    allocation: 'Inactive',
    allocationTone: 'muted',
    active: false,
  },
];

export const PROJECT_FILTERS: SegmentedOption[] = [
  { id: 'all', label: 'All', count: 5 },
  { id: 'blocked', label: 'Blocked', count: 1 },
  { id: 'allocating', label: 'Allocating', count: 2 },
  { id: 'inactive', label: 'Inactive', count: 1 },
];

export interface RunFixture {
  id: string;
  when: string;
  mode: 'Dry run' | 'Live';
  trigger: string;
  assigned: number;
  skipped: number;
  blocked: number;
  failed: number;
}

export const RUNS: RunFixture[] = [
  {
    id: 'run-0412',
    when: 'Oct 21 · 08:00',
    mode: 'Live',
    trigger: 'Schedule',
    assigned: 3,
    skipped: 9,
    blocked: 1,
    failed: 0,
  },
  {
    id: 'run-0411',
    when: 'Oct 20 · 16:42',
    mode: 'Dry run',
    trigger: 'Pat Okafor',
    assigned: 3,
    skipped: 9,
    blocked: 1,
    failed: 0,
  },
  {
    id: 'run-0410',
    when: 'Oct 20 · 08:00',
    mode: 'Live',
    trigger: 'Schedule',
    assigned: 0,
    skipped: 11,
    blocked: 1,
    failed: 1,
  },
];

export const RUBRIC: ChecklistItem[] = [
  { id: 'date', label: 'Target date', met: true, note: 'Oct 19' },
  {
    id: 'done-means',
    label: 'Done means…',
    met: false,
    note: 'Add a "Done means:" line to the milestone description in Linear.',
  },
  { id: 'lead', label: 'Project lead', met: true, note: 'Pat Okafor' },
  { id: 'issues', label: 'At least one issue', met: true, note: '7 issues' },
];

export const ZOOM_OPTIONS: SegmentedOption[] = [
  { id: 'weeks', label: 'Weeks' },
  { id: 'months', label: 'Months' },
];

export const HOME_TABS: SegmentedOption[] = [
  { id: 'upcoming', label: 'Upcoming', count: 6 },
  { id: 'overdue', label: 'Overdue', count: 1 },
  { id: 'completed', label: 'Completed', count: 1 },
  { id: 'archived', label: 'Archived', count: 0, disabled: true },
];
