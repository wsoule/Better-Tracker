import {
  PriorityGlyph,
  type PropertyListItem,
  StatusMark,
  type TaskDetailProps,
  type TaskPriority,
  TaskPropertyValue,
  type TaskRelation,
  type TaskStateKind,
  type UiStatus,
} from '@better-tracker/ui';

// Fixture props for /ui-gallery/task: tasks from the demo workspace
// ("Northwind Labs") on Wednesday, October 21, 2026, as the planner would
// describe them. Shapes only, nothing computed: the gallery needs no
// engine. Every name, issue and date here is fictional.

const LINEAR = 'https://linear.app/northwind/issue';

/** The task's page in the (fictional) Linear workspace. */
export function linearUrl(key: string): string {
  return `${LINEAR}/${key}`;
}

/** Everything a gallery task carries except the host's header actions. */
export type GalleryTask = Omit<
  TaskDetailProps,
  'headerActions' | 'layout' | 'header' | 'headingLevel' | 'onOpenRelation'
>;

interface StateSpec {
  kind: TaskStateKind;
  label: string;
}

const TODO: StateSpec = { kind: 'unstarted', label: 'Todo' };
const BACKLOG: StateSpec = { kind: 'backlog', label: 'Backlog' };
const IN_PROGRESS: StateSpec = { kind: 'started', label: 'In Progress' };
const IN_REVIEW: StateSpec = { kind: 'started', label: 'In Review' };
const DONE: StateSpec = { kind: 'completed', label: 'Done' };

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

interface PropertySpec {
  state: StateSpec;
  /** How long it has sat in its state ("9 days"). */
  inState: string;
  /** The planner flagged it as stalled: the duration is the accent. */
  stalled?: boolean;
  assignee: string | null;
  /** Why it is this person's (the planner's allocation), or what is missing. */
  assigneeNote?: string;
  milestone: {
    name: string;
    status: UiStatus;
    statusLabel: string;
    note: string;
  } | null;
  project: string;
  projectNote?: string;
  priority: TaskPriority;
  estimate?: string;
}

/* The planner's property sheet for an issue: what Linear shows (assignee,
   priority, estimate) plus what it does not — why the planner gave it to
   this person, its milestone's status, and how long it has sat in its
   state. The state itself is in the view's status line. */
function properties(spec: PropertySpec): PropertyListItem[] {
  const items: PropertyListItem[] = [
    {
      id: 'assignee',
      label: 'Assignee',
      value: (
        <TaskPropertyValue
          tone={spec.assignee === null ? 'accent' : 'default'}
          note={spec.assigneeNote}
        >
          {spec.assignee ?? 'Unassigned'}
        </TaskPropertyValue>
      ),
    },
    {
      id: 'milestone',
      label: 'Milestone',
      value:
        spec.milestone === null ? (
          <TaskPropertyValue tone="muted" note="Not allocated by the planner">
            No milestone
          </TaskPropertyValue>
        ) : (
          <TaskPropertyValue note={spec.milestone.note}>
            <StatusMark
              status={spec.milestone.status}
              label={spec.milestone.statusLabel}
            />
            {spec.milestone.name}
          </TaskPropertyValue>
        ),
    },
    {
      id: 'in-state',
      label: 'Time in state',
      value: (
        <TaskPropertyValue
          mono
          tone={spec.stalled === true ? 'accent' : 'default'}
          note={
            spec.stalled === true
              ? `Stalled in ${spec.state.label}`
              : `Since moving to ${spec.state.label}`
          }
        >
          {spec.inState}
        </TaskPropertyValue>
      ),
    },
    {
      id: 'project',
      label: 'Project',
      value: (
        <TaskPropertyValue note={spec.projectNote}>
          {spec.project}
        </TaskPropertyValue>
      ),
    },
    {
      id: 'priority',
      label: 'Priority',
      value: (
        <TaskPropertyValue>
          <PriorityGlyph priority={spec.priority} size={13} />
          {PRIORITY_LABEL[spec.priority]}
        </TaskPropertyValue>
      ),
    },
  ];
  if (spec.estimate !== undefined) {
    items.push({
      id: 'estimate',
      label: 'Estimate',
      value: <TaskPropertyValue mono>{spec.estimate}</TaskPropertyValue>,
    });
  }
  return items;
}

function relation(
  key: string,
  title: string,
  state: StateSpec,
  assignee: string | null,
  context: string,
  extra: Partial<TaskRelation> = {}
): TaskRelation {
  return {
    id: key,
    taskKey: key,
    title,
    href: linearUrl(key),
    state,
    assignee,
    context,
    ...extra,
  };
}

const BEACON_BETA = 'Beacon search / Search v2 beta';

// ---- ENG-24: blocked and stalled, the long description ------------------

const ENG_24_DESCRIPTION = `Send search analytics events so we can tell whether Search v2 beats v1 before the beta opens.

Events
- search_performed: query length, filters, result count, latency_ms
- result_clicked: position, result type, time since the search
- search_abandoned: no click within 30 s, or the query was refined

Rules
- Never log the raw query text; hash it with the workspace salt.
- Sample at 100% during the beta, 10% after GA.
- Events go through the existing analytics queue, not a new pipeline.

Done when
1. All three events show up in the Search v2 dashboard for the beta workspaces.
2. Latency percentiles match the API's own metrics within 5%.
3. A <script> tag or **markdown** typed into a query shows up as text in the payload viewer, never as markup.

Open questions
- Do we need consent copy for the EU workspaces? Probably not for hashed queries; confirm with Ana.
- Should typo-corrected queries log both the original and the corrected form? Depends on ENG-23.

Notes from the kickoff (Oct 9)
The beta cohort is 40 workspaces. Dev wants a daily export to the warehouse so the ranking work (ENG-22) can be tuned against real clicks.`;

export const ENG_24: GalleryTask = {
  taskKey: 'ENG-24',
  title: 'Search analytics events',
  href: linearUrl('ENG-24'),
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
    { label: 'Search v2 beta', href: '/timeline?milestone=ms-beacon-1' },
    { label: 'ENG-24' },
  ],
  status: TODO,
  alerts: [
    {
      id: 'blocked',
      label: 'Blocked',
      message:
        'Waiting on ENG-23 (in progress) and ENG-12 (backlog, unassigned).',
      action: { label: 'Graph', href: '/graph?chain=ENG-24' },
    },
    {
      id: 'stalled',
      label: 'Stalled',
      message: 'In Todo for 9 days; Search v2 beta is due in 2 days.',
    },
  ],
  properties: properties({
    state: TODO,
    inState: '9 days',
    stalled: true,
    assignee: 'Ana Moreno',
    assigneeNote:
      'Given by the planner on Oct 12: she leads Beacon search and had the most room in Search v2 beta.',
    milestone: {
      name: 'Search v2 beta',
      status: 'at_risk',
      statusLabel: 'At risk',
      note: 'At risk · due Oct 23, in 2 days · 3 of 7 done',
    },
    project: 'Beacon search',
    projectNote: 'Lead Dev Patel',
    priority: 3,
    estimate: '2 points',
  }),
  description: {
    text: ENG_24_DESCRIPTION,
    sourceLabel: 'From Linear · edited Oct 14',
  },
  relations: {
    blockedBy: [
      relation(
        'ENG-23',
        'Typo tolerance',
        IN_PROGRESS,
        'Dev Patel',
        BEACON_BETA
      ),
      relation(
        'ENG-12',
        'Reconcile dual-write drift',
        BACKLOG,
        null,
        'Atlas billing migration / Dual-write',
        { external: true }
      ),
    ],
    blocks: [
      relation(
        'ENG-25',
        'Beta feedback widget',
        IN_REVIEW,
        'Ben Carter',
        BEACON_BETA
      ),
    ],
  },
  activity: [
    {
      id: 'stalled',
      at: 'Oct 21',
      dateTime: '2026-10-21',
      label: 'Flagged as stalled',
      detail: 'In Todo for 9 days while Search v2 beta is due in 2 days.',
      tone: 'accent',
    },
    {
      id: 'blocked',
      at: 'Oct 14',
      dateTime: '2026-10-14',
      label: 'Blocked by ENG-23 in Linear',
      detail: 'Typo tolerance changes which form of the query gets logged.',
    },
    {
      id: 'assigned',
      at: 'Oct 12',
      dateTime: '2026-10-12',
      label: 'Assigned to Ana Moreno by the planner',
      detail: 'Daily run: she leads Beacon search and had the most room.',
      href: '/runs/run-2026-10-12',
    },
    {
      id: 'todo',
      at: 'Oct 12',
      dateTime: '2026-10-12',
      label: 'Moved from Backlog to Todo by the planner',
      tone: 'muted',
    },
    {
      id: 'created',
      at: 'Oct 9',
      dateTime: '2026-10-09',
      label: 'Created in Linear by Dev Patel',
      tone: 'muted',
    },
  ],
};

// ---- ENG-32: blocked, stalled and unassigned -----------------------------

export const ENG_32: GalleryTask = {
  taskKey: 'ENG-32',
  title: 'Workspace templates',
  href: linearUrl('ENG-32'),
  breadcrumb: [
    { label: 'Compass onboarding', href: '/timeline?project=proj-compass' },
    { label: 'Guided setup', href: '/timeline?milestone=ms-compass-1' },
    { label: 'ENG-32' },
  ],
  status: TODO,
  alerts: [
    {
      id: 'blocked',
      label: 'Blocked',
      message: 'Waiting on ENG-31 (backlog, unassigned).',
    },
    {
      id: 'stalled',
      label: 'Stalled',
      message: 'In Todo for 10 days with nobody on it.',
    },
    {
      id: 'unassigned',
      label: 'Unassigned',
      message: 'Next milestone, due Oct 26.',
      action: { label: 'Preview allocation', href: '/runs?preview=1' },
    },
  ],
  properties: properties({
    state: TODO,
    inState: '10 days',
    stalled: true,
    assignee: null,
    assigneeNote:
      'The next run gives it out: Compass has no member with room before Oct 26.',
    milestone: {
      name: 'Guided setup',
      status: 'at_risk',
      statusLabel: 'At risk',
      note: 'At risk · due Oct 26, in 5 days · 2 of 7 done',
    },
    project: 'Compass onboarding',
    projectNote: 'Lead Ana Moreno',
    priority: 3,
  }),
  description: {
    text: 'Offer three starter templates (Engineering, Design, Support) on the last setup step, so a new workspace starts with projects instead of an empty list.',
    sourceLabel: 'From Linear',
  },
  relations: {
    blockedBy: [
      relation(
        'ENG-31',
        'Sample data import',
        BACKLOG,
        null,
        'Compass onboarding / Guided setup'
      ),
    ],
    blocks: [],
  },
  activity: [
    {
      id: 'unassigned',
      at: 'Oct 21',
      label: 'Left unassigned by the planner',
      detail: 'Nobody in Compass onboarding has room before Oct 26.',
      tone: 'accent',
    },
    {
      id: 'created',
      at: 'Oct 11',
      label: 'Created in Linear by Ana Moreno',
      tone: 'muted',
    },
  ],
};

// ---- ENG-23: the cross-project chain (external relations) ---------------

export const ENG_23: GalleryTask = {
  taskKey: 'ENG-23',
  title: 'Typo tolerance',
  href: linearUrl('ENG-23'),
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
    { label: 'Search v2 beta', href: '/timeline?milestone=ms-beacon-1' },
    { label: 'ENG-23' },
  ],
  status: IN_PROGRESS,
  alerts: [
    {
      id: 'blocked',
      label: 'Blocked',
      message:
        'Waiting on ENG-12 in Atlas billing migration, which nobody is on.',
    },
  ],
  properties: properties({
    state: IN_PROGRESS,
    inState: '1 day',
    assignee: 'Dev Patel',
    assigneeNote: 'Assigned in Linear by Dev Patel; the planner kept it.',
    milestone: {
      name: 'Search v2 beta',
      status: 'at_risk',
      statusLabel: 'At risk',
      note: 'At risk · due Oct 23, in 2 days · 3 of 7 done',
    },
    project: 'Beacon search',
    projectNote: 'Lead Dev Patel',
    priority: 1,
    estimate: '3 points',
  }),
  description: {
    text: 'Match queries with one or two typos against product names and SKUs.\n\nUses the corrected spelling only when the original returns nothing; both forms reach the analytics events (ENG-24).',
  },
  relations: {
    blockedBy: [
      relation(
        'ENG-12',
        'Reconcile dual-write drift',
        BACKLOG,
        null,
        'Atlas billing migration / Dual-write',
        { external: true }
      ),
    ],
    blocks: [
      relation(
        'ENG-24',
        'Search analytics events',
        TODO,
        'Ana Moreno',
        BEACON_BETA
      ),
      relation(
        'OPS-20',
        'Brand review sign-off',
        TODO,
        'Femi Adeyemi',
        'Juniper design system / Tokens and type',
        { external: true }
      ),
    ],
  },
  activity: [
    {
      id: 'started',
      at: 'Oct 20',
      label: 'Moved from Todo to In Progress by Dev Patel',
    },
  ],
};

// ---- ENG-25: description still loading ------------------------------------

export const ENG_25: GalleryTask = {
  taskKey: 'ENG-25',
  title: 'Beta feedback widget',
  href: linearUrl('ENG-25'),
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
    { label: 'Search v2 beta', href: '/timeline?milestone=ms-beacon-1' },
    { label: 'ENG-25' },
  ],
  status: IN_REVIEW,
  properties: properties({
    state: IN_REVIEW,
    inState: '1 day',
    assignee: 'Ben Carter',
    assigneeNote: 'Given by the planner on Oct 12.',
    milestone: {
      name: 'Search v2 beta',
      status: 'at_risk',
      statusLabel: 'At risk',
      note: 'At risk · due Oct 23, in 2 days · 3 of 7 done',
    },
    project: 'Beacon search',
    priority: 3,
  }),
  description: { text: null, loading: true },
  relations: {
    blockedBy: [
      relation(
        'ENG-24',
        'Search analytics events',
        TODO,
        'Ana Moreno',
        BEACON_BETA
      ),
    ],
    blocks: [],
  },
};

// ---- ENG-27: the description failed to load --------------------------------

export const ENG_27_TEXT =
  'Let workspace admins add synonym pairs ("tee" = "t-shirt") that the query parser expands before ranking.';

export const ENG_27: GalleryTask = {
  taskKey: 'ENG-27',
  title: 'Synonyms admin',
  href: linearUrl('ENG-27'),
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
    { label: 'Search v2 GA', href: '/timeline?milestone=ms-beacon-2' },
    { label: 'ENG-27' },
  ],
  status: BACKLOG,
  properties: properties({
    state: BACKLOG,
    inState: '12 days',
    assignee: 'Dev Patel',
    assigneeNote: 'Assigned in Linear; not in the next milestone.',
    milestone: {
      name: 'Search v2 GA',
      status: 'on_track',
      statusLabel: 'On track',
      note: 'On track · due Nov 20',
    },
    project: 'Beacon search',
    priority: 3,
    estimate: '5 points',
  }),
  description: {
    text: null,
    error: 'Linear did not answer in time.',
  },
  relations: { blockedBy: [], blocks: [] },
};

// ---- ENG-35: nothing related, nothing written ------------------------------

export const ENG_35: GalleryTask = {
  taskKey: 'ENG-35',
  title: 'Invite flow',
  href: linearUrl('ENG-35'),
  breadcrumb: [
    { label: 'Compass onboarding', href: '/timeline?project=proj-compass' },
    { label: 'Team invites', href: '/timeline?milestone=ms-compass-2' },
    { label: 'ENG-35' },
  ],
  status: BACKLOG,
  properties: properties({
    state: BACKLOG,
    inState: '9 days',
    assignee: 'Ana Moreno',
    assigneeNote: 'Assigned in Linear; Team invites is not next yet.',
    milestone: {
      name: 'Team invites',
      status: 'on_track',
      statusLabel: 'On track',
      note: 'On track · due Nov 30',
    },
    project: 'Compass onboarding',
    priority: 2,
  }),
  description: { text: null },
  relations: { blockedBy: [], blocks: [] },
  activity: [],
};

// ---- ENG-22: done ------------------------------------------------------------

export const ENG_22: GalleryTask = {
  taskKey: 'ENG-22',
  title: 'Ranking v2',
  href: linearUrl('ENG-22'),
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
    { label: 'Search v2 beta', href: '/timeline?milestone=ms-beacon-1' },
    { label: 'ENG-22' },
  ],
  status: DONE,
  properties: properties({
    state: DONE,
    inState: '3 days',
    assignee: 'Ana Moreno',
    assigneeNote: 'Given by the planner on Oct 5.',
    milestone: {
      name: 'Search v2 beta',
      status: 'at_risk',
      statusLabel: 'At risk',
      note: 'At risk · due Oct 23, in 2 days · 3 of 7 done',
    },
    project: 'Beacon search',
    priority: 1,
    estimate: '3 points',
  }),
  description: {
    text: 'Blend text relevance with click-through from the last 30 days. Ship behind the search_v2 flag.',
    sourceLabel: 'From Linear',
  },
  relations: {
    blockedBy: [
      relation('ENG-21', 'Query parser', DONE, 'Dev Patel', BEACON_BETA, {
        resolved: true,
      }),
    ],
    blocks: [
      relation(
        'ENG-26',
        'Search results page polish',
        TODO,
        'Grace Lin',
        BEACON_BETA
      ),
    ],
  },
  activity: [
    {
      id: 'done',
      at: 'Oct 18',
      label: 'Moved from In Review to Done by Ana Moreno',
    },
    {
      id: 'assigned',
      at: 'Oct 5',
      label: 'Assigned to Ana Moreno by the planner',
      tone: 'muted',
    },
  ],
};

// ---- PLATFORM-1042: hostile input -----------------------------------------
// What a tracker can hand the view: markup and markdown typed as text, links
// with a javascript: scheme, tokens with no break opportunity, right-to-left
// paragraphs and a key longer than the usual three letters. All of it must
// print as typed, wrap inside its column and never scroll the page sideways.

const LONG_TOKEN = `search_v2_ranking_${'feature_flag_rollout_'.repeat(6)}override`;

export const HOSTILE_DESCRIPTION = `<script>alert('description')</script>
<img src=x onerror="alert(1)"> <a href="javascript:alert(1)">click me</a>
# Not a heading
**not bold** _not italic_ [not a link](javascript:alert(1)) \`not code\`

https://linear.app/northwind/issue/PLATFORM-1042/${'a-very-long-slug-'.repeat(12)}end

${LONG_TOKEN}

مرحبا، هذا وصف باللغة العربية يذكر ENG-24 في المنتصف.
שלום, זה תיאור בעברית עם מספר 42.
Mixed: the key ENG-24, then עברית, then English again.`;

export const PLATFORM_1042: GalleryTask = {
  taskKey: 'PLATFORM-1042',
  title: `Log ${LONG_TOKEN} without breaking the dashboard`,
  href: linearUrl('PLATFORM-1042'),
  breadcrumb: [
    {
      label: 'Platform reliability and observability programme',
      href: '/timeline?project=proj-platform',
    },
    {
      label: 'Quarterly hardening milestone with a long name',
      href: '/timeline?milestone=ms-platform-3',
    },
    { label: 'PLATFORM-1042' },
  ],
  status: IN_PROGRESS,
  alerts: [
    {
      id: 'blocked',
      label: 'Blocked',
      message: `Waiting on PLATFORM-10417 (${LONG_TOKEN}).`,
    },
  ],
  properties: properties({
    state: IN_PROGRESS,
    inState: '2 days',
    assignee: 'Nadia Al-Hassan',
    assigneeNote: 'مُسند من المخطط: لديها أكبر قدر من الوقت.',
    milestone: {
      name: 'Quarterly hardening milestone with a long name',
      status: 'on_track',
      statusLabel: 'On track',
      note: `On track · due Nov 14 · ${LONG_TOKEN}`,
    },
    project: 'Platform reliability and observability programme',
    priority: 2,
    estimate: '13 points',
  }),
  description: { text: HOSTILE_DESCRIPTION, sourceLabel: 'From Linear' },
  relations: {
    blockedBy: [
      relation(
        'PLATFORM-10417',
        LONG_TOKEN,
        IN_PROGRESS,
        null,
        'Platform reliability and observability programme / Quarterly hardening milestone with a long name'
      ),
      relation('ENG-24', 'تتبع أحداث البحث', TODO, 'Ana Moreno', BEACON_BETA, {
        external: true,
      }),
    ],
    blocks: [],
  },
  activity: [
    {
      id: 'long',
      at: 'Oct 20',
      label: `Renamed to ${LONG_TOKEN}`,
      detail: '<b>not bold</b> and **not markdown** either.',
    },
  ],
};

/** Tasks the drawer can open from a relation row (by key). */
export const DRAWER_TASKS: Record<string, GalleryTask> = {
  'ENG-24': ENG_24,
  'ENG-32': ENG_32,
  'ENG-23': ENG_23,
  'ENG-25': ENG_25,
  'ENG-27': ENG_27,
  'ENG-35': ENG_35,
  'ENG-22': ENG_22,
  'PLATFORM-1042': PLATFORM_1042,
};
