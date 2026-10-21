import type {
  EstimateChoice,
  LabelChoice,
  PersonChoice,
  PlanChoice,
  StateChoice,
  TaskComment,
  TaskSearchResult,
} from '@better-tracker/ui';

// Fixture choices for the editable task on /ui-gallery/task: the demo
// workspace ("Northwind Labs") as an editable host would load it. Every
// name and issue is fictional; label colours are data, drawn only as the
// label's small square.

/** The person signed in to the gallery. */
export const ME = { id: 'u-ana', name: 'Ana Moreno' };

export const STATES: StateChoice[] = [
  { id: 's-backlog', name: 'Backlog', kind: 'backlog' },
  { id: 's-todo', name: 'Todo', kind: 'unstarted' },
  { id: 's-progress', name: 'In Progress', kind: 'started' },
  { id: 's-review', name: 'In Review', kind: 'started' },
  { id: 's-done', name: 'Done', kind: 'completed' },
  { id: 's-canceled', name: 'Canceled', kind: 'canceled' },
];

export const PEOPLE: PersonChoice[] = [
  { id: 'u-ana', name: 'Ana Moreno', keywords: ['ana@northwind.test'] },
  { id: 'u-ben', name: 'Ben Carter', keywords: ['ben@northwind.test'] },
  { id: 'u-chloe', name: 'Chloé Laurent', keywords: ['chloe@northwind.test'] },
  { id: 'u-dev', name: 'Dev Patel', keywords: ['dev@northwind.test'] },
  { id: 'u-eli', name: 'Eli Brandt', keywords: ['eli@northwind.test'] },
  { id: 'u-farah', name: 'Farah Haddad', keywords: ['farah@northwind.test'] },
];

export const LABELS: LabelChoice[] = [
  { id: 'l-bug', name: 'Bug', color: '#eb5757' },
  { id: 'l-feature', name: 'Feature', color: '#bb87fc' },
  { id: 'l-improvement', name: 'Improvement', color: '#4ea7fc' },
  {
    id: 'l-search',
    name: 'search',
    color: '#26b5ce',
    group: { id: 'g-area', name: 'Area' },
  },
  {
    id: 'l-backend',
    name: 'backend',
    color: '#f2c94c',
    group: { id: 'g-area', name: 'Area' },
  },
  {
    id: 'l-frontend',
    name: 'frontend',
    color: '#f2994a',
    group: { id: 'g-area', name: 'Area' },
  },
  {
    id: 'l-s',
    name: 'Size S',
    color: '#95a2b3',
    group: { id: 'g-size', name: 'Size (one)', singleSelect: true },
  },
  {
    id: 'l-m',
    name: 'Size M',
    color: '#95a2b3',
    group: { id: 'g-size', name: 'Size (one)', singleSelect: true },
  },
  {
    id: 'l-l',
    name: 'Size L',
    color: '#95a2b3',
    group: { id: 'g-size', name: 'Size (one)', singleSelect: true },
  },
];

export const PROJECTS: PlanChoice[] = [
  {
    id: 'p-beacon',
    name: 'Beacon search',
    hint: 'In progress',
    group: 'Active',
    status: { status: 'at_risk', label: 'Next milestone at risk' },
  },
  {
    id: 'p-atlas',
    name: 'Atlas billing migration',
    hint: 'In progress',
    group: 'Active',
    status: { status: 'overdue', label: 'Next milestone overdue' },
  },
  {
    id: 'p-compass',
    name: 'Compass onboarding',
    hint: 'Planned',
    group: 'Active',
    status: { status: 'on_track', label: 'Next milestone on track' },
  },
  {
    id: 'p-portal',
    name: 'Partner portal',
    hint: 'Paused',
    group: 'Other',
    status: { status: 'on_track', label: 'Inactive project', muted: true },
  },
];

export const MILESTONES: Record<string, PlanChoice[]> = {
  'p-beacon': [
    {
      id: 'm-beta',
      name: 'Search v2 beta',
      hint: 'Oct 23',
      status: { status: 'at_risk', label: 'At risk' },
    },
    {
      id: 'm-ga',
      name: 'Search v2 GA',
      hint: 'Nov 20',
      status: { status: 'on_track', label: 'On track' },
    },
  ],
  'p-atlas': [
    {
      id: 'm-dual',
      name: 'Dual-write',
      hint: 'Oct 19',
      status: { status: 'overdue', label: 'Overdue' },
    },
    {
      id: 'm-cutover',
      name: 'Cutover',
      hint: 'Nov 13',
      status: { status: 'on_track', label: 'On track' },
    },
  ],
  'p-compass': [
    {
      id: 'm-guided',
      name: 'Guided setup',
      hint: 'Nov 6',
      status: { status: 'on_track', label: 'On track' },
    },
  ],
  'p-portal': [],
};

/** Linear's Fibonacci scale. */
export const ESTIMATES: EstimateChoice[] = [
  { value: 0, label: '0 points' },
  { value: 1, label: '1 point' },
  { value: 2, label: '2 points' },
  { value: 3, label: '3 points' },
  { value: 5, label: '5 points' },
  { value: 8, label: '8 points' },
];

/** Tasks the relation pickers can find. */
export const SEARCHABLE: TaskSearchResult[] = [
  {
    id: 'i-12',
    taskKey: 'ENG-12',
    title: 'Reconcile dual-write drift',
    state: { kind: 'backlog', label: 'Backlog' },
    group: 'Atlas billing migration',
  },
  {
    id: 'i-22',
    taskKey: 'ENG-22',
    title: 'Ranking v2',
    state: { kind: 'completed', label: 'Done' },
    group: 'Beacon search',
  },
  {
    id: 'i-23',
    taskKey: 'ENG-23',
    title: 'Typo tolerance',
    state: { kind: 'started', label: 'In Progress' },
    group: 'Beacon search',
  },
  {
    id: 'i-24',
    taskKey: 'ENG-24',
    title: 'Search analytics events',
    state: { kind: 'unstarted', label: 'Todo' },
    group: 'Beacon search',
  },
  {
    id: 'i-25',
    taskKey: 'ENG-25',
    title: 'Beta feedback widget',
    state: { kind: 'started', label: 'In Review' },
    group: 'Beacon search',
  },
  {
    id: 'i-27',
    taskKey: 'ENG-27',
    title: 'Synonyms admin',
    state: { kind: 'unstarted', label: 'Todo' },
    group: 'Beacon search',
  },
  {
    id: 'i-32',
    taskKey: 'ENG-32',
    title: 'Workspace templates',
    state: { kind: 'unstarted', label: 'Todo' },
    group: 'Compass onboarding',
  },
  {
    id: 'i-35',
    taskKey: 'ENG-35',
    title: 'Invite flow',
    state: { kind: 'backlog', label: 'Backlog' },
    group: 'Compass onboarding',
  },
  {
    id: 'i-1042',
    taskKey: 'PLATFORM-1042',
    title: 'Log oversized query tokens without breaking the dashboard',
    state: { kind: 'triage', label: 'Triage' },
    group: 'Platform',
  },
];

export const COMMENTS: TaskComment[] = [
  {
    id: 'c-1',
    author: 'Dev Patel',
    at: 'Oct 14',
    dateTime: '2026-10-14T15:20:00Z',
    body: 'Blocked on ENG-23 until we know which form of the query gets logged.\nIf typo tolerance lands first we log both.',
    href: 'https://linear.app/northwind/issue/ENG-24#comment-c-1',
  },
  {
    id: 'c-2',
    author: 'GitHub',
    at: 'Oct 18',
    dateTime: '2026-10-18T09:02:00Z',
    body: 'Ana Moreno linked PR #412 "search: emit analytics events".',
    tone: 'muted',
  },
  {
    id: 'c-3',
    author: 'Ana Moreno',
    at: 'Oct 20',
    dateTime: '2026-10-20T11:45:00Z',
    body: 'Hashing is in. **Sampling** still to do — <b>not</b> markup, just text.',
    href: 'https://linear.app/northwind/issue/ENG-24#comment-c-3',
  },
];

/** Searches the fixture tasks by key or title, after a little latency. */
export function searchTasks(
  query: string,
  signal: AbortSignal
): Promise<TaskSearchResult[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      resolve(
        SEARCHABLE.filter((task) => {
          const hay = `${task.taskKey} ${task.title}`.toLowerCase();
          return words.every((word) => hay.includes(word));
        })
      );
    }, 300);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}
