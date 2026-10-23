'use client';

import {
  AssigneePicker,
  BulkBar,
  type BulkBarConfirm,
  Button,
  type FilterChipData,
  FilterChips,
  Notice,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  SegmentedControl,
  StatePicker,
  Switch,
  type TaskColumnId,
  type TaskGroupData,
  TaskGroupTable,
  type TaskPriority,
  type TaskRowData,
  type TaskSectionData,
  ToolbarBadge,
  ViewToolbar,
} from '@better-tracker/ui';
import { type ReactNode, useState } from 'react';

import {
  FILTER_FIELDS,
  type IssueFixture,
  ISSUE_MILESTONES,
  ISSUE_PEOPLE,
  ISSUE_PROJECTS,
  ISSUE_STATES,
  ISSUES,
  ME_ID,
  PRIORITY_NAMES,
  QUICK_FILTERS,
  SORT_OPTIONS,
} from './issue-list-fixtures';
import css from './page.module.css';

/* The issue list's parts from @better-tracker/ui, composed the way the
   planner's Issues page composes them: ViewToolbar (search, Filter / Sort
   / Group menus as PickerPopover searchable={false}), FilterChips, the
   TaskGroupTable with selection, drag, cell pickers, row and group menus,
   and the BulkBar. The rows live in this component's state, so a move,
   a drop or a cell pick changes them (after a short pretend round trip
   that shows the pending rows). No engine, no Linear. */

type GroupBy = 'milestone' | 'state' | 'priority';

/** What a move sets on the rows: the planner's IssueBulkPatch, cut down. */
type Change =
  | { kind: 'move'; projectId: string; milestoneId: string | null }
  | { kind: 'assignee'; assigneeId: string | null }
  | { kind: 'state'; stateId: string }
  | { kind: 'priority'; priority: TaskPriority };

const PRIORITY_ORDER: TaskPriority[] = [1, 2, 3, 4, 0];
const ROUND_TRIP_MS = 900;
const CONFIRM_AT = 20;

/* Inline 14px icons (the gallery imports only from the UI package). */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* Open as graph: three linked boxes. */
const GraphIcon = () => (
  <Glyph>
    <rect x="5" y="1.5" width="4" height="3" rx="0.8" />
    <rect x="1.5" y="9.5" width="4" height="3" rx="0.8" />
    <rect x="8.5" y="9.5" width="4" height="3" rx="0.8" />
    <path d="M7 4.5v2.5M3.5 9.5V7h7v2.5" />
  </Glyph>
);

/* Copy link: two chain links. */
const LinkIcon = () => (
  <Glyph>
    <path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 8 2.5l-.7.7" />
    <path d="M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.7-.7" />
  </Glyph>
);

const MoreIcon = () => (
  <Glyph>
    <circle cx="3" cy="7" r="0.6" />
    <circle cx="7" cy="7" r="0.6" />
    <circle cx="11" cy="7" r="0.6" />
  </Glyph>
);
const FilterIcon = () => (
  <Glyph>
    <path d="M2 3.5h10M4 7h6M6 10.5h2" />
  </Glyph>
);
const SortIcon = () => (
  <Glyph>
    <path d="M4.5 2.5v9M2.5 9.5l2 2 2-2M9.5 11.5v-9M7.5 4.5l2-2 2 2" />
  </Glyph>
);
const GroupIcon = () => (
  <Glyph>
    <rect x="2" y="2.5" width="10" height="3" />
    <rect x="2" y="8.5" width="10" height="3" />
  </Glyph>
);
const PlusIcon = () => (
  <Glyph>
    <path d="M7 3v8M3 7h8" />
  </Glyph>
);
const MoveIcon = () => (
  <Glyph>
    <path d="M2 4.5h4l1.2 1.5H12v5.5H2Z" />
  </Glyph>
);
const PersonIcon = () => (
  <Glyph>
    <circle cx="7" cy="5" r="2.2" />
    <path d="M2.8 12c.6-2.1 2.2-3.2 4.2-3.2s3.6 1.1 4.2 3.2" />
  </Glyph>
);
const StatusIcon = () => (
  <Glyph>
    <circle cx="7" cy="7" r="4.5" />
    <circle cx="7" cy="7" r="1.2" />
  </Glyph>
);
const PriorityIcon = () => (
  <Glyph>
    <path d="M3 11.5v-2M7 11.5v-5M11 11.5v-8" />
  </Glyph>
);

const projectName = (id: string) =>
  ISSUE_PROJECTS.find((p) => p.id === id)?.name ?? id;
const personName = (id: string | null) =>
  id === null ? null : (ISSUE_PEOPLE.find((p) => p.id === id)?.name ?? id);
const stateOf = (id: string) =>
  ISSUE_STATES.find((s) => s.id === id) ?? ISSUE_STATES[0];

/** The move picker's choices: each project's milestones, then "{Project} ›
    No milestone"; inactive projects last. Values: m:<id> / p:<id>. */
const MOVE_OPTIONS: PickerOption[] = [...ISSUE_PROJECTS]
  .sort((a, b) => Number(b.active) - Number(a.active))
  .flatMap((project) => [
    ...ISSUE_MILESTONES.filter((m) => m.projectId === project.id).map(
      (m): PickerOption => ({
        value: `m:${m.id}`,
        label: m.name,
        hint: m.next === true ? `${m.dueLabel} · next` : m.dueLabel,
        group: project.active ? project.name : `${project.name} · inactive`,
        mark: {
          kind: 'status',
          status: m.status,
          label: m.statusLabel,
          muted: !project.active,
        },
      })
    ),
    {
      value: `p:${project.id}`,
      label: 'No milestone',
      hint: 'stays in the project',
      keywords: [project.name],
      group: project.active ? project.name : `${project.name} · inactive`,
    },
  ]);

function moveChange(value: string | null): Change | null {
  if (value === null) return null;
  if (value.startsWith('m:')) {
    const milestone = ISSUE_MILESTONES.find((m) => m.id === value.slice(2));
    return milestone === undefined
      ? null
      : {
          kind: 'move',
          projectId: milestone.projectId,
          milestoneId: milestone.id,
        };
  }
  if (value.startsWith('p:')) {
    return { kind: 'move', projectId: value.slice(2), milestoneId: null };
  }
  return null;
}

function describeChange(change: Change): string {
  switch (change.kind) {
    case 'move': {
      const milestone = ISSUE_MILESTONES.find(
        (m) => m.id === change.milestoneId
      );
      return `${projectName(change.projectId)} › ${milestone?.name ?? 'No milestone'}`;
    }
    case 'assignee':
      return personName(change.assigneeId) ?? 'Unassigned';
    case 'state':
      return stateOf(change.stateId).name;
    case 'priority':
      return `${PRIORITY_NAMES[change.priority]} priority`;
  }
}

function applyChange(issue: IssueFixture, change: Change): IssueFixture {
  switch (change.kind) {
    case 'move':
      return {
        ...issue,
        projectId: change.projectId,
        milestoneId: change.milestoneId,
        note: undefined,
      };
    case 'assignee':
      return { ...issue, assigneeId: change.assigneeId, note: undefined };
    case 'state':
      return { ...issue, stateId: change.stateId, note: undefined };
    case 'priority':
      return { ...issue, priority: change.priority, note: undefined };
  }
}

/** The change a drop on `groupId` makes, for the current grouping. */
function dropChange(groupBy: GroupBy, groupId: string): Change | null {
  if (groupBy === 'milestone') {
    if (groupId.startsWith('nm:')) {
      return { kind: 'move', projectId: groupId.slice(3), milestoneId: null };
    }
    return moveChange(`m:${groupId}`);
  }
  if (groupBy === 'state') return { kind: 'state', stateId: groupId };
  const priority = Number(groupId.slice(3));
  return PRIORITY_ORDER.includes(priority as TaskPriority)
    ? { kind: 'priority', priority: priority as TaskPriority }
    : null;
}

/** Whether `change` would leave `issue` as it is. */
function sameAs(issue: IssueFixture, change: Change): boolean {
  switch (change.kind) {
    case 'move':
      return (
        issue.projectId === change.projectId &&
        issue.milestoneId === change.milestoneId
      );
    case 'assignee':
      return issue.assigneeId === change.assigneeId;
    case 'state':
      return issue.stateId === change.stateId;
    case 'priority':
      return issue.priority === change.priority;
  }
}

function toRow(issue: IssueFixture, pending: Map<string, string>): TaskRowData {
  const state = stateOf(issue.stateId);
  const project = ISSUE_PROJECTS.find((p) => p.id === issue.projectId);
  const milestone = ISSUE_MILESTONES.find((m) => m.id === issue.milestoneId);
  const assignee = personName(issue.assigneeId);
  // An open issue of an active project needs a person (as the planner's).
  const live =
    project?.active === true &&
    state.kind !== 'completed' &&
    state.kind !== 'canceled';
  const note = pending.get(issue.id);
  return {
    id: issue.id,
    key: issue.key,
    title: issue.title,
    href: `/issues?issue=${issue.key}`,
    externalHref: `https://linear.app/northwind/issue/${issue.key}`,
    externalLabel: `Open ${issue.key} in Linear`,
    state: state.name,
    stateKind: state.kind,
    priority: issue.priority,
    priorityLabel: PRIORITY_NAMES[issue.priority],
    due: issue.due,
    // An inactive project's rows carry no tone at all (as the planner's).
    dueTone: project?.active === true ? issue.dueTone : undefined,
    dueNote: project?.active === true ? issue.dueNote : undefined,
    assignee,
    assigneeTone: assignee === null && live ? 'warning' : undefined,
    unassignedLabel: assignee === null && live ? 'Needs assignee' : undefined,
    milestone:
      milestone === undefined
        ? null
        : `${projectName(milestone.projectId)} › ${milestone.name}`,
    done: state.kind === 'completed' || state.kind === 'canceled',
    // Only an active project's open issue is loud (as the planner's).
    chips: project?.active === true ? issue.chips : undefined,
    pending: note !== undefined,
    note: note !== undefined ? { text: note } : issue.note,
  };
}

/** The list grouped by milestone under tier dividers (the default view). */
function milestoneSections(
  issues: IssueFixture[],
  pending: Map<string, string>,
  footerActions: (milestoneId: string) => NonNullable<TaskGroupData['footer']>
): TaskSectionData[] {
  const tiers: { id: string; label: string; groups: TaskGroupData[] }[] = [
    { id: 't:overdue', label: 'Overdue', groups: [] },
    { id: 't:upcoming', label: 'Upcoming', groups: [] },
    { id: 't:unplanned', label: 'No milestone', groups: [] },
    { id: 't:inactive', label: 'Inactive projects', groups: [] },
  ];
  const tier = (id: string) => tiers.find((t) => t.id === id)?.groups ?? [];
  for (const m of ISSUE_MILESTONES) {
    const rows = issues
      .filter((i) => i.milestoneId === m.id)
      .map((i) => toRow(i, pending));
    const project = ISSUE_PROJECTS.find((p) => p.id === m.projectId);
    const muted = project?.active !== true;
    const count = rows.length + (m.notLoaded ?? 0);
    tier(`t:${m.tier}`).push({
      id: m.id,
      eyebrow: projectName(m.projectId),
      title: m.name,
      href: `/timeline?milestone=${m.id}`,
      status: m.status,
      statusLabel: m.statusLabel,
      dueLabel: m.dueLabel,
      daysLeftLabel: m.daysLeftLabel,
      dueTone: m.dueTone,
      progress: m.progress,
      muted,
      tags: [
        ...(m.next === true ? ['Next'] : []),
        ...(m.weight > 0 ? [`↑${m.weight}`] : []),
        ...(m.weight < 0 ? [`↓${-m.weight}`] : []),
      ],
      missingLabel: m.missingLabel,
      count,
      rows,
      emptyLabel:
        m.progress.total - m.progress.done === 0
          ? 'No open issues here yet. Drag issues here, or use Move to milestone.'
          : undefined,
      footer: count > rows.length ? footerActions(m.id) : undefined,
    });
  }
  for (const project of ISSUE_PROJECTS) {
    const rows = issues
      .filter((i) => i.projectId === project.id && i.milestoneId === null)
      .map((i) => toRow(i, pending));
    if (rows.length === 0) continue;
    tier(project.active ? 't:unplanned' : 't:inactive').push({
      id: `nm:${project.id}`,
      eyebrow: project.name,
      title: 'No milestone',
      href: `/timeline?project=${project.id}`,
      muted: !project.active,
      rows,
    });
  }
  return tiers
    .filter((t) => t.groups.length > 0)
    .map((t) => ({ id: t.id, label: t.label, groups: t.groups }));
}

/** One unnamed section of state (or priority) groups, each with its glyph:
    a list without dividers. */
function flatSections(
  groupBy: 'state' | 'priority',
  issues: IssueFixture[],
  pending: Map<string, string>
): TaskSectionData[] {
  const groups: TaskGroupData[] =
    groupBy === 'state'
      ? ISSUE_STATES.map((state) => ({
          id: state.id,
          title: state.name,
          mark: { kind: 'state' as const, state: state.kind },
          rows: issues
            .filter((i) => i.stateId === state.id)
            .map((i) => toRow(i, pending)),
          emptyLabel: 'No issues in this status.',
        }))
      : PRIORITY_ORDER.map((priority) => ({
          id: `pr:${priority}`,
          title: PRIORITY_NAMES[priority],
          mark: { kind: 'priority' as const, priority },
          rows: issues
            .filter((i) => i.priority === priority)
            .map((i) => toRow(i, pending)),
          emptyLabel: 'No issues at this priority.',
        }));
  return [{ id: 'all', groups }];
}

const COLUMNS: Record<GroupBy, TaskColumnId[]> = {
  milestone: ['assignee', 'state', 'priority', 'due'],
  state: ['milestone', 'assignee', 'priority', 'due'],
  priority: ['milestone', 'assignee', 'state', 'due'],
};

const DEFAULT_CHIPS = ['state'];

export function IssueListGallery({
  record,
}: {
  record: (href: string) => void;
}): ReactNode {
  const [issues, setIssues] = useState<IssueFixture[]>(ISSUES);
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(ISSUE_MILESTONES.map((m) => [m.id, m.weight]))
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [pending, setPending] = useState<Map<string, string>>(() => new Map());
  const [groupBy, setGroupBy] = useState<GroupBy>('milestone');
  const [sort, setSort] = useState('weight');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<string[]>(['state', 'project', 'ghost']);
  const [projects, setProjects] = useState<string[]>(['p-garnet']);
  const [quick, setQuick] = useState<string[]>([]);
  const [confirmAll, setConfirmAll] = useState(false);
  const [tapMode, setTapMode] = useState(false);
  const [tooMany, setTooMany] = useState(false);
  const [confirm, setConfirm] = useState<BulkBarConfirm | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [result, setResult] = useState<{
    message: string;
    undo: IssueFixture[];
  } | null>(null);
  // The pretend round trips (a state update after unmount is harmless).
  function later(run: () => void, ms: number) {
    window.setTimeout(run, ms);
  }

  // A view change "loads": the toolbar's progress rule for a moment.
  function changeView(run: () => void) {
    run();
    setBusy(true);
    later(() => setBusy(false), 700);
  }

  /** Sends `change` for `ids` the way the page does: the rows show pending
      with a note at once, stay where they are, then land where the "server" puts
      them, with a result line that can undo it. */
  function send(ids: readonly string[], change: Change) {
    const targets = issues.filter(
      (i) => ids.includes(i.id) && !sameAs(i, change)
    );
    const label = describeChange(change);
    if (targets.length === 0) {
      setResult({
        message: `Nothing to change: the ${ids.length} issues already had that.`,
        undo: [],
      });
      return;
    }
    const note = change.kind === 'move' ? `Moving to ${label}…` : 'Saving…';
    setPending(new Map(targets.map((i) => [i.id, note])));
    setSending(
      `${change.kind === 'move' ? 'Moving' : 'Changing'} ${targets.length} ${targets.length === 1 ? 'issue' : 'issues'}…`
    );
    const before = issues;
    later(() => {
      setIssues((list) =>
        list.map((i) =>
          targets.some((t) => t.id === i.id) ? applyChange(i, change) : i
        )
      );
      setPending(new Map());
      setSending(null);
      const n = targets.length;
      const what = n === 1 ? (targets[0]?.key ?? '1 issue') : `${n} issues`;
      setResult({
        message:
          change.kind === 'move'
            ? `Moved ${what} to ${label}.`
            : change.kind === 'assignee'
              ? change.assigneeId === null
                ? `Unassigned ${what}.`
                : `Assigned ${what} to ${label}.`
              : `Set ${what} to ${label}.`,
        undo: before,
      });
    }, ROUND_TRIP_MS);
  }

  /** Sends at once, or through the bulk bar's confirm strip: at 20 or
      more issues, for a move that changes a project, or (in the gallery)
      whenever "Confirm first" is chosen. */
  function confirmOrSend(ids: readonly string[], change: Change) {
    const moving = issues.filter((i) => ids.includes(i.id));
    const crossProject =
      change.kind === 'move' &&
      moving.some((i) => i.projectId !== change.projectId);
    const total = tooMany ? 312 : ids.length;
    if (!confirmAll && !crossProject && total < CONFIRM_AT) {
      send(ids, change);
      return;
    }
    const label = describeChange(change);
    const what = `${total} ${total === 1 ? 'issue' : 'issues'}`;
    const others =
      change.kind === 'move'
        ? moving.filter((i) => i.projectId !== change.projectId)
        : [];
    const fromProjects = [
      ...new Set(others.map((i) => projectName(i.projectId))),
    ];
    setSelected(new Set(ids));
    setConfirm({
      message:
        change.kind === 'move'
          ? `Move ${what} to ${label}?${
              others.length > 0
                ? ` ${others.length} of them move from ${fromProjects.join(', ')} to ${projectName(change.projectId)}.`
                : ''
            } This changes them in Linear, as you.`
          : `Set ${what} to ${label}? This changes them in Linear, as you.`,
      confirmLabel: change.kind === 'move' ? `Move ${what}` : `Set ${what}`,
      onConfirm: () => {
        setConfirm(null);
        send(ids, change);
      },
      onCancel: () => setConfirm(null),
    });
  }

  function bulk(change: Change) {
    confirmOrSend([...selected], change);
  }

  const sections =
    groupBy === 'milestone'
      ? milestoneSections(issues, pending, (id) => ({
          text: `Showing ${issues.filter((i) => i.milestoneId === id).length} of ${
            issues.filter((i) => i.milestoneId === id).length +
            (ISSUE_MILESTONES.find((m) => m.id === id)?.notLoaded ?? 0)
          }`,
          actions: [
            {
              label: 'Show more',
              onActivate: () => record('/issues?limit=1000'),
            },
            {
              label: 'Only this milestone',
              onActivate: () => record(`/issues?milestone=${id}`),
            },
          ],
        })).map((section) => ({
          ...section,
          groups: section.groups.map((group) => {
            const weight = weights[group.id];
            if (weight === undefined) return group;
            const tags = (group.tags ?? []).filter(
              (t) => !t.startsWith('↑') && !t.startsWith('↓')
            );
            if (weight > 0) tags.push(`↑${weight}`);
            if (weight < 0) tags.push(`↓${-weight}`);
            return { ...group, tags };
          }),
        }))
      : flatSections(groupBy, issues, pending);

  const words = query.trim().toLowerCase();
  const shownSections =
    words === ''
      ? sections
      : sections.map((section) => ({
          ...section,
          groups: section.groups.map((group) => ({
            ...group,
            rows: group.rows.filter(
              (r) =>
                r.title.toLowerCase().includes(words) ||
                r.key.toLowerCase().includes(words)
            ),
          })),
        }));

  // ---- toolbar ------------------------------------------------------------

  const filterCount = chips.filter((c) => c !== 'state').length + quick.length;
  const filterMenu = (
    <PickerPopover
      label="Filter"
      searchable={false}
      action
      appearance="quiet"
      value={null}
      trigger={
        <>
          <FilterIcon />
          Filter
          {filterCount > 0 ? <ToolbarBadge count={filterCount} /> : null}
        </>
      }
      triggerLabel={filterCount > 0 ? `Filter, ${filterCount} set` : 'Filter'}
      options={[
        ...FILTER_FIELDS.map((field) => ({
          value: `field:${field}`,
          label: field,
          group: 'Filter by',
        })),
        ...QUICK_FILTERS.map((name) => ({
          value: `quick:${name}`,
          label: name,
          hint: quick.includes(name) ? 'On' : undefined,
          group: 'Quick filters',
        })),
      ]}
      onChange={(value) => {
        if (value === null) return;
        if (value.startsWith('quick:')) {
          const name = value.slice(6);
          changeView(() =>
            setQuick((list) =>
              list.includes(name)
                ? list.filter((q) => q !== name)
                : [...list, name]
            )
          );
        } else {
          record(`/issues (add a ${value.slice(6).toLowerCase()} chip)`);
        }
      }}
    />
  );

  const sortMenu = (
    <PickerPopover
      label="Sort"
      searchable={false}
      appearance="quiet"
      value={sort}
      trigger={
        <>
          <SortIcon />
          Sort: {SORT_OPTIONS.find((o) => o.value === sort)?.label}
        </>
      }
      triggerLabel={`Sort: ${SORT_OPTIONS.find((o) => o.value === sort)?.label}`}
      options={SORT_OPTIONS}
      onChange={(value) => {
        if (value !== null) changeView(() => setSort(value));
      }}
    />
  );

  const groupMenu = (
    <PickerPopover
      label="Group"
      searchable={false}
      appearance="quiet"
      value={groupBy}
      trigger={
        <>
          <GroupIcon />
          Group:{' '}
          {groupBy === 'milestone'
            ? 'Milestone'
            : groupBy === 'state'
              ? 'Status'
              : 'Priority'}
        </>
      }
      triggerLabel={`Group: ${groupBy}`}
      options={[
        { value: 'milestone', label: 'Milestone' },
        { value: 'state', label: 'Status' },
        { value: 'priority', label: 'Priority' },
        {
          value: 'initiative',
          label: 'Initiative',
          hint: 'On the Issues page',
          disabled: true,
        },
      ]}
      onChange={(value) => {
        if (
          value === 'milestone' ||
          value === 'state' ||
          value === 'priority'
        ) {
          changeView(() => setGroupBy(value));
        }
      }}
    />
  );

  // ---- chips ----------------------------------------------------------------

  const chipData: FilterChipData[] = chips.map((id) => {
    if (id === 'state') {
      return {
        id,
        icon: <StatusIcon />,
        field: 'Status',
        summary: 'open',
        onRemove: () =>
          changeView(() => setChips((c) => c.filter((x) => x !== id))),
        removeLabel: 'Remove status filter',
      };
    }
    if (id === 'ghost') {
      return {
        id,
        icon: <MoveIcon />,
        field: 'Milestone',
        summary: 'Not found',
        unknown: true,
        onRemove: () =>
          changeView(() => setChips((c) => c.filter((x) => x !== id))),
        removeLabel: 'Remove milestone filter',
      };
    }
    const names = projects.map(projectName);
    return {
      id,
      icon: <FilterIcon />,
      field: 'Project',
      summary:
        names.length >= 3
          ? `${names.length} projects`
          : names.length === 0
            ? 'any'
            : names.join(', '),
      renderEditor: (face) => (
        <PickerPopover
          label="Project"
          multiple
          appearance="quiet"
          value={projects}
          trigger={face}
          triggerLabel={`Project filter: ${names.join(', ')}`}
          options={ISSUE_PROJECTS.map((p) => ({
            value: p.id,
            label: p.name,
            group: p.active ? 'Active projects' : 'Other projects',
          }))}
          onChange={(next) => changeView(() => setProjects(next))}
        />
      ),
      onRemove: () =>
        changeView(() => setChips((c) => c.filter((x) => x !== id))),
      removeLabel: 'Remove project filter',
    };
  });
  for (const name of quick) {
    chipData.push({
      id: `quick:${name}`,
      field: name,
      summary: 'on',
      onRemove: () =>
        changeView(() => setQuick((list) => list.filter((q) => q !== name))),
      removeLabel: `Remove ${name.toLowerCase()} filter`,
    });
  }

  // ---- row and group menus ----------------------------------------------------

  function rowMenu(row: TaskRowData): ReactNode {
    return (
      <PickerPopover
        label={`Actions for ${row.key}`}
        searchable={false}
        action
        appearance="quiet"
        align="end"
        value={null}
        open={menuFor === row.id}
        onOpenChange={(open) => setMenuFor(open ? row.id : null)}
        trigger={<MoreIcon />}
        triggerLabel={`Actions for ${row.key}`}
        options={[
          { value: 'open', label: 'Open', hint: '↵' },
          { value: 'move', label: 'Move to milestone…', hint: 'M' },
          { value: 'assign', label: 'Assign to…', hint: 'A' },
          { value: 'status', label: 'Status…', hint: 'S' },
          { value: 'priority', label: 'Priority…', hint: 'P' },
          { value: 'page', label: 'Open issue page', group: 'Go to' },
          { value: 'linear', label: 'Open in Linear ↗', group: 'Go to' },
          { value: 'copy', label: 'Copy link', group: 'Go to' },
        ]}
        onChange={(value) => {
          if (value === 'page') record(`/issues/${row.key}`);
          else if (value === 'linear') record(row.externalHref ?? row.key);
          else if (value !== null) record(`${row.key}: ${value}`);
        }}
      />
    );
  }

  function groupMenu_(group: TaskGroupData): ReactNode {
    const weight = weights[group.id];
    if (weight === undefined) return null;
    return (
      <PickerPopover
        label={`Actions for ${group.title}`}
        searchable={false}
        action
        appearance="quiet"
        align="end"
        value={null}
        trigger={<MoreIcon />}
        triggerLabel={`Actions for ${group.title}`}
        options={[
          { value: 'raise', label: 'Raise weight', hint: `${weight + 1}` },
          { value: 'lower', label: 'Lower weight', hint: `${weight - 1}` },
          ...(weight !== 0 ? [{ value: 'clear', label: 'Clear weight' }] : []),
          { value: 'open', label: 'Open milestone' },
        ]}
        onChange={(value) => {
          if (value === 'open') {
            record(`/timeline?milestone=${group.id}`);
            return;
          }
          const next =
            value === 'raise' ? weight + 1 : value === 'lower' ? weight - 1 : 0;
          setWeights((w) => ({ ...w, [group.id]: next }));
          setResult({
            message:
              next === 0
                ? `${group.title} has no weight now.`
                : `${group.title} has weight ${next} now.`,
            undo: [],
          });
        }}
      />
    );
  }

  // ---- cells --------------------------------------------------------------------

  function renderCell(
    column: TaskColumnId,
    row: TaskRowData
  ): ReactNode | undefined {
    const issue = issues.find((i) => i.id === row.id);
    if (issue === undefined || row.pending === true) return undefined;
    if (column === 'state') {
      return (
        <StatePicker
          appearance="cell"
          states={ISSUE_STATES}
          value={issue.stateId}
          onChange={(stateId) => send([issue.id], { kind: 'state', stateId })}
        />
      );
    }
    if (column === 'assignee') {
      return (
        <AssigneePicker
          appearance="cell"
          people={ISSUE_PEOPLE}
          meId={ME_ID}
          value={issue.assigneeId}
          placeholder={row.unassignedLabel}
          placeholderTone={row.assigneeTone === 'warning' ? 'warning' : 'muted'}
          onChange={(assigneeId) =>
            send([issue.id], { kind: 'assignee', assigneeId })
          }
        />
      );
    }
    if (column === 'priority') {
      return (
        <PriorityPicker
          appearance="cell"
          priorityTones={{ 1: 'danger' }}
          value={issue.priority}
          onChange={(priority) =>
            send([issue.id], { kind: 'priority', priority })
          }
        />
      );
    }
    return undefined;
  }

  // ---- drag -------------------------------------------------------------------

  function canDrop(ids: readonly string[], groupId: string): true | string {
    const change = dropChange(groupBy, groupId);
    if (change === null) return 'Nothing to change here.';
    const moving = issues.filter((i) => ids.includes(i.id));
    if (moving.every((i) => sameAs(i, change))) {
      return ids.length === 1
        ? 'Order inside a group comes from the weight. Change the milestone’s weight instead.'
        : 'Already there.';
    }
    return true;
  }

  const count = tooMany ? 312 : selected.size;
  const n = selected.size;
  const plural = n === 1 ? 'issue' : 'issues';

  return (
    <div className={css.issueList}>
      <div className={css.issueControls}>
        <SegmentedControl
          label="Bulk bar state"
          size="sm"
          value={tooMany ? 'many' : confirmAll ? 'confirm' : 'plain'}
          onChange={(id) => {
            setTooMany(id === 'many');
            setConfirmAll(id === 'confirm');
          }}
          options={[
            { id: 'plain', label: 'Send at once' },
            { id: 'confirm', label: 'Confirm first' },
            { id: 'many', label: '312 selected' },
          ]}
        />
        <Switch
          label="Phone selection mode"
          note="a click toggles a row"
          checked={tapMode}
          onChange={setTapMode}
        />
      </div>
      <div className={css.issueFrame}>
        <ViewToolbar
          busy={busy}
          label="Issue list options"
          search={{
            value: query,
            onChange: setQuery,
            onCommit: (value) => {
              if (value.trim() !== '') record(`/issues?q=${value.trim()}`);
            },
            placeholder: 'Search issues',
            label: 'Search issues',
          }}
          controls={
            <>
              {filterMenu}
              {sortMenu}
              {groupMenu}
            </>
          }
          end={
            <>
              {/* As on the page: Gr8r's ghost toolbar buttons with a
                  leading icon. */}
              <Button
                variant="quiet"
                size="sm"
                href="/graph?project=p-garnet"
                icon={<GraphIcon />}
              >
                Open as graph
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => record('Link copied')}
                icon={<LinkIcon />}
              >
                Copy link
              </Button>
            </>
          }
        />
        <FilterChips
          chips={chipData}
          add={
            <PickerPopover
              label="Add a filter"
              searchable={false}
              action
              appearance="quiet"
              value={null}
              trigger={
                <>
                  <PlusIcon />
                  Filter
                </>
              }
              triggerLabel="Add a filter"
              options={FILTER_FIELDS.map((field) => ({
                value: field,
                label: field,
              }))}
              onChange={(value) =>
                record(`/issues (add a ${String(value).toLowerCase()} chip)`)
              }
            />
          }
          onClearAll={() =>
            changeView(() => {
              setChips(DEFAULT_CHIPS);
              setQuick([]);
              setProjects([]);
            })
          }
          clearDisabled={
            chips.length === DEFAULT_CHIPS.length &&
            chips[0] === DEFAULT_CHIPS[0] &&
            quick.length === 0
          }
        />
      </div>
      {result !== null ? (
        <Notice
          tone="default"
          label="Done"
          role="status"
          action={
            result.undo.length > 0 ? (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setIssues(result.undo);
                  setResult({
                    message: 'Undone: the issues are back where they were.',
                    undo: [],
                  });
                }}
              >
                Undo
              </Button>
            ) : undefined
          }
        >
          {result.message}
        </Notice>
      ) : null}
      <div aria-busy={busy ? 'true' : undefined} className={css.issueTable}>
        <TaskGroupTable
          sections={shownSections}
          columns={COLUMNS[groupBy]}
          columnLabels={{ state: 'Status' }}
          label="Issues"
          storageKey={`gallery:tasks:issues:${groupBy}`}
          headingLevel={3}
          emptyMessage="No open issues match these filters."
          onOpenRow={(row) => record(row.href ?? row.key)}
          selection={{
            selected,
            onChange: setSelected,
            toggleOnClick: tapMode,
          }}
          renderCell={renderCell}
          rowActions={rowMenu}
          onRowContextMenu={(event, row) => {
            event.preventDefault();
            setMenuFor(row.id);
          }}
          groupActions={groupBy === 'milestone' ? groupMenu_ : undefined}
          drag={{
            canDrop,
            onDrop: (ids, groupId) => {
              const change = dropChange(groupBy, groupId);
              if (change !== null) confirmOrSend(ids, change);
            },
            label: (dragged) =>
              `${dragged} ${dragged === 1 ? 'issue' : 'issues'}`,
          }}
        />
      </div>
      <BulkBar
        count={count}
        onClear={() => {
          setSelected(new Set());
          setConfirm(null);
          setTooMany(false);
        }}
        busy={sending}
        note={tooMany ? `At most 100 at a time (${count} selected).` : null}
        confirm={confirm}
        label={`Actions for ${count} selected ${count === 1 ? 'issue' : 'issues'}`}
      >
        <PickerPopover
          label="Move to milestone"
          action
          appearance="bar"
          value={null}
          trigger={
            <>
              <MoveIcon />
              <span data-bulk-label="">Move to milestone</span>
            </>
          }
          triggerLabel={`Move ${n} ${plural} to a milestone`}
          searchPlaceholder="Move to…"
          options={MOVE_OPTIONS}
          onChange={(value) => {
            const change = moveChange(value);
            if (change !== null) bulk(change);
          }}
        />
        <PickerPopover
          label="Assignee"
          action
          appearance="bar"
          value={null}
          trigger={
            <>
              <PersonIcon />
              <span data-bulk-label="">Assignee</span>
            </>
          }
          triggerLabel={`Assign ${n} ${plural}`}
          searchPlaceholder="Assign to…"
          noneLabel="Unassign"
          noneMark={{ kind: 'avatar', name: '' }}
          options={ISSUE_PEOPLE.map((p) => ({
            value: p.id,
            label: p.name,
            hint: p.id === ME_ID ? 'You' : undefined,
            mark: { kind: 'avatar', name: p.name },
          }))}
          onChange={(value) => bulk({ kind: 'assignee', assigneeId: value })}
        />
        <PickerPopover
          label="Status"
          action
          appearance="bar"
          value={null}
          trigger={
            <>
              <StatusIcon />
              <span data-bulk-label="">Status</span>
            </>
          }
          triggerLabel={`Set the status of ${n} ${plural}`}
          options={ISSUE_STATES.map((s) => ({
            value: s.id,
            label: s.name,
            mark: { kind: 'state', state: s.kind },
          }))}
          onChange={(value) => {
            if (value !== null) bulk({ kind: 'state', stateId: value });
          }}
        />
        <PickerPopover
          label="Priority"
          action
          appearance="bar"
          value={null}
          trigger={
            <>
              <PriorityIcon />
              <span data-bulk-label="">Priority</span>
            </>
          }
          triggerLabel={`Set the priority of ${n} ${plural}`}
          options={PRIORITY_ORDER.map((p) => ({
            value: String(p),
            label: PRIORITY_NAMES[p],
            mark: { kind: 'priority', priority: p },
          }))}
          onChange={(value) => {
            const priority = Number(value);
            if (PRIORITY_ORDER.includes(priority as TaskPriority)) {
              bulk({ kind: 'priority', priority: priority as TaskPriority });
            }
          }}
        />
      </BulkBar>
    </div>
  );
}
