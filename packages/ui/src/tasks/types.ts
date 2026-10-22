import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import type { UiStatus, UiTone } from '../types';

// Prop vocabulary of the "tasks" family: primitives, the grouped task table,
// deadlines, stats and registers. Plain data + callbacks only, so the
// planner (Next) and Dispatch (Vite + Tauri) can map their own models onto
// these shapes in a thin adapter.

/* ---- primitives -------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonCommonProps {
  /** primary = ink slab, secondary = 2px outline, quiet = bare mono label,
   * danger = accent outline (the system has no red: danger is the accent). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon, e.g. a 14px lucide icon (strokeWidth 1.5). */
  icon?: ReactNode;
  /** Trailing icon. */
  iconAfter?: ReactNode;
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
  title?: string;
}

export interface ButtonAsButtonProps extends ButtonCommonProps {
  href?: undefined;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

export interface ButtonAsLinkProps extends ButtonCommonProps {
  /** Renders through the host's <Link>. */
  href: string;
  /** Opens in a new tab with a screen-reader note. */
  external?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

/** default = ink outline, muted = grey idle chip, accent = filled with the accent
 * ("needs action"), inverse = ink fill (the stronger claim). */
export type ChipTone = 'default' | 'muted' | 'accent' | 'inverse';

export interface ChipProps {
  tone?: ChipTone;
  /** Optional leading status mark; needs statusLabel for assistive tech. */
  status?: UiStatus;
  statusLabel?: string;
  title?: string;
  children: ReactNode;
}

export interface SegmentedOption {
  id: string;
  label: string;
  /** Mono count after the label, e.g. "UPCOMING 6". */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  /** Controlled selection. Omit (and pass defaultValue) for uncontrolled. */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Accessible name of the radio group, e.g. "Zoom". */
  label: string;
  size?: 'sm' | 'md';
  /** Stretch the cells across the container (tab-strip form). */
  fill?: boolean;
}

export interface SwitchProps {
  /** Controlled state. Omit (and pass defaultChecked) for uncontrolled. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  /** Sans note after the label (muted). */
  note?: string;
  disabled?: boolean;
  id?: string;
}

export interface CheckboxProps {
  /** Controlled state. Omit (and pass defaultChecked) for uncontrolled. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** Mono label beside the glyph (and the accessible name). */
  label: string;
  /** Sans note after the label (muted). */
  note?: string;
  disabled?: boolean;
  id?: string;
  /** Form field name and value, for hosts that submit a native form. */
  name?: string;
  value?: string;
  /** Keep the label for assistive tech only (a register column names it). */
  hideLabel?: boolean;
  /** Overrides the accessible name; keep the visible label inside it
      ("Ana Moreno: Watcher"). */
  'aria-label'?: string;
}

/** One cell of a NavTabs strip: a destination, not a state. */
export interface NavTabItem {
  id: string;
  label: string;
  /** Where the cell goes. Omit for a cell that cannot be followed yet
      (drawn hatched; say why in `note`). */
  href?: string;
  /** The page being shown: ink fill and aria-current="page". */
  current?: boolean;
  /** Mono count after the label. */
  count?: number;
  /** Short muted note after the label ("select a milestone"). */
  note?: string;
}

export interface NavTabsProps {
  items: NavTabItem[];
  /** Accessible name of the <nav> ("Graph level", "Settings sections"). */
  label: string;
  /** horizontal = a tab strip; vertical = a sub-nav column that becomes a
      wrapping strip at 900px and below. */
  orientation?: 'horizontal' | 'vertical';
  size?: 'sm' | 'md';
  /** Horizontal only: stretch the cells across the container. */
  fill?: boolean;
  className?: string;
}

export interface ProgressRuleProps {
  done: number;
  total: number;
  /** accent when the progress itself needs action (behind pace, overdue). */
  tone?: 'default' | 'accent';
  /** Visible label; defaults to "done/total". Pass null to hide it. */
  label?: string | null;
  /** Accessible name, e.g. "Cutover rehearsal progress". */
  'aria-label'?: string;
}

export interface NoticeProps {
  /** Mono key before the copy, e.g. "BLOCKED", "DEMO DATA". */
  label?: string;
  children: ReactNode;
  /** accent = 2px accent rule (default); default = 1px ink hairline. */
  tone?: 'accent' | 'default';
  /** status (polite) for updates, alert for errors. Omit for static copy. */
  role?: 'status' | 'alert';
  /** Trailing control, e.g. a quiet Button. */
  action?: ReactNode;
}

export interface EmptyStateProps {
  /** The explanation, in the body face: "Nothing due this week." */
  children: ReactNode;
  /** A short mono key above it ("No runs"), when the sentence is long. */
  label?: string;
  action?: ReactNode;
  /** Hatch the box (an input is missing rather than nothing to show). */
  hatched?: boolean;
}

export interface ChecklistItem {
  id?: string;
  label: string;
  met: boolean;
  /** Sans note under the label, e.g. "Add a target date in Linear". */
  note?: string;
}

export interface ChecklistProps {
  items: ChecklistItem[];
  /** Accessible name of the list, e.g. "Rubric". */
  label?: string;
  /** Right-aligned state words; defaults to MET / MISSING. */
  metLabel?: string;
  missingLabel?: string;
}

/* ---- stats ------------------------------------------------------------- */

export interface StatCell {
  id: string;
  label: string;
  /** Rendered in mono numerals. */
  value: ReactNode;
  note?: string;
  /** accent = needs action (value + note in the accent); muted = quiet. */
  tone?: UiTone;
  /** Makes the cell a link (Gr8r stat cards navigate to the filtered list). */
  href?: string;
}

export interface StatsStripProps {
  cells: StatCell[];
  /** Accessible name of the strip. */
  label?: string;
}

/* ---- the grouped task table -------------------------------------------- */

/** Linear's state types. */
export type TaskStateKind =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

/** Linear's priority scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/** Optional meta columns; the key + title column is always shown. */
export type TaskColumnId = 'project' | 'state' | 'priority' | 'due';

export interface TaskChipData {
  label: string;
  tone?: ChipTone;
}

export interface TaskRowData {
  id: string;
  /** Issue identifier, e.g. "ATL-142" (mono). */
  key: string;
  title: string;
  /** Where the row opens. Omit and pass onOpenRow for a callback-only row. */
  href?: string;
  /** Opens in a new tab (e.g. straight to Linear). */
  external?: boolean;
  /** A second, separate link after the title, drawn as a small ↗ icon
   * that opens in a new tab (the issue in the tracker, while the title
   * opens the host's own view). */
  externalHref?: string;
  /** Accessible name of that icon link ("Open ATL-142 in Linear").
   * Default "Open {key} in a new tab". */
  externalLabel?: string;
  project?: string;
  /** Human state name, e.g. "In Progress". */
  state: string;
  stateKind: TaskStateKind;
  priority: TaskPriority;
  /** e.g. "Urgent", "No priority". */
  priorityLabel: string;
  /** Short due label, e.g. "Oct 23". */
  due?: string;
  dueTone?: UiTone;
  chips?: TaskChipData[];
}

export interface TaskGroupProgress {
  done: number;
  total: number;
  tone?: 'default' | 'accent';
}

export interface TaskGroupData {
  id: string;
  /** Mono eyebrow, typically the PROJECT. */
  eyebrow?: string;
  /** The group's name, typically the MILESTONE. */
  title: string;
  /** Opens the milestone (drawer, timeline). */
  href?: string;
  status?: UiStatus;
  statusLabel?: string;
  /** e.g. "Oct 19". */
  dueLabel?: string;
  /** e.g. "2 days overdue", "5 days left". */
  daysLeftLabel?: string;
  dueTone?: UiTone;
  progress?: TaskGroupProgress;
  /** Drawn quietly (e.g. a paused project's milestone): the status mark in
   * greys, and the due date and progress never in the accent, whatever
   * dueTone and progress.tone say. */
  muted?: boolean;
  rows: TaskRowData[];
}

export interface TaskSectionData {
  id: string;
  /** Divider label, e.g. "This week", "Later", "No milestone". */
  label: string;
  /** Mono note after the label; defaults to the issue count. */
  note?: string;
  /** Said when the section has no groups; defaults to "Nothing in this
   * section". */
  emptyLabel?: string;
  groups: TaskGroupData[];
}

export interface TaskGroupTableProps {
  sections: TaskSectionData[];
  /** Visible meta columns in order. Default: project, state, priority, due. */
  columns?: TaskColumnId[];
  /** Header wording; defaults: Issue / Project / State / Priority / Due. */
  columnLabels?: Partial<Record<TaskColumnId | 'title', string>>;
  /** Accessible name of the table. */
  label?: string;
  /** Heading level of the section dividers; group titles sit one below.
   * Default 3 (under a page h1 and a block h2). */
  headingLevel?: 2 | 3 | 4 | 5;
  /** Persist collapsed group ids under this storage key. */
  storageKey?: string;
  /** localStorage (default) survives restarts; session suits a desktop app. */
  storage?: 'local' | 'session';
  /** Groups collapsed when nothing is stored. */
  defaultCollapsed?: string[];
  /** Shown when there are no groups at all. */
  emptyMessage?: ReactNode;
  /** Plain click / ↵ on a row. Without it the row's link navigates. */
  onOpenRow?: (row: TaskRowData, group: TaskGroupData) => void;
  /** ↵ / click on a group title. Without it the group's link navigates. */
  onOpenGroup?: (group: TaskGroupData) => void;
  onToggleGroup?: (groupId: string, collapsed: boolean) => void;
  /** The row the host has open (in a drawer, a detail pane): it keeps the
   * ink fill and is marked aria-current. */
  activeRowId?: string;
  /** Keys on a focused row that the table's own model (arrows, j/k,
   * Home/End) leaves alone, modified keys included: lets a host layer
   * single-key commands (Dispatch's x / s / p, ⌘C) without owning focus.
   * Call event.preventDefault() for keys it handles. */
  onRowKeyDown?: (
    event: KeyboardEvent<HTMLElement>,
    row: TaskRowData,
    group: TaskGroupData
  ) => void;
}

/* ---- deadlines --------------------------------------------------------- */

export interface DeadlineItem {
  id: string;
  label: string;
  /** Mono line under the label, e.g. "ATLAS · 3 OPEN". */
  sublabel?: string;
  href: string;
  status: UiStatus;
  statusLabel: string;
  dueLabel: string;
}

export interface DeadlineGroup {
  id: string;
  /** Today / Tomorrow / This week / Overdue. */
  label: string;
  /** accent for the group that needs action (Overdue). */
  tone?: UiTone;
  items: DeadlineItem[];
}

export interface DeadlineListProps {
  groups: DeadlineGroup[];
  /** Items shown per group before "+N more". Default 4. */
  limit?: number;
  /** Shown under a group with no items. */
  emptyLabel?: string;
  /** Accessible name. */
  label?: string;
  /** Heading level of the group labels. Default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
}

/* ---- registers --------------------------------------------------------- */

export interface RegisterColumn {
  id: string;
  label: string;
  align?: 'start' | 'end';
}

export interface RegisterProps {
  /** CSS grid-template-columns shared by the header and every row. */
  columns: string;
  /** Optional header row; cells then hide their own labels on desktop. */
  header?: RegisterColumn[];
  /** Accessible name of the list. */
  label: string;
  children: ReactNode;
  /** Rows stack into cards below this viewport width (px). Default 900. */
  stackBelow?: 700 | 900;
  /** Stack by the register's own width instead of the viewport's: rows
   * become cards while the register is narrower than this (px). Use it
   * inside a sidebar shell, where the content column is far narrower than
   * the window, or for a wide (many-column) register. Overrides
   * stackBelow. */
  stackWithin?: 700 | 900 | 1000;
  /** grid-template-columns of a stacked card; the first cell (the row's
   * subject) spans the full width. Default two equal columns. */
  stackedColumns?: string;
}

interface RegisterRowCommonProps {
  /** accent = 2px accent left rule (the row needs action). */
  tone?: 'default' | 'accent' | 'muted';
  /** Ink fill, like a selected tab. */
  selected?: boolean;
  children: ReactNode;
}

/** The whole row is a link (stretched) and keyboard-focusable. */
export interface RegisterLinkRowProps extends RegisterRowCommonProps {
  href: string;
  external?: boolean;
  onActivate?: undefined;
  /** Accessible name of the row's link: the stretched target has no text
   * of its own, so it is required. */
  rowLabel: string;
}

/** Callback row: the whole row is a button. */
export interface RegisterButtonRowProps extends RegisterRowCommonProps {
  href?: undefined;
  external?: undefined;
  onActivate: () => void;
  /** Accessible name of the row's button (required, as for links). */
  rowLabel: string;
}

/** A plain row (settings): its controls live in the cells. */
export interface RegisterPlainRowProps extends RegisterRowCommonProps {
  href?: undefined;
  external?: undefined;
  onActivate?: undefined;
  rowLabel?: undefined;
}

export type RegisterRowProps =
  | RegisterLinkRowProps
  | RegisterButtonRowProps
  | RegisterPlainRowProps;

export interface RegisterCellProps {
  /** Mono micro-label above the value (hidden on desktop under a header). */
  label?: string;
  /** name = sans 15/600 (row subject), value = body copy, mono = machine
   * furniture (states, counts, dates). */
  variant?: 'name' | 'value' | 'mono';
  /** Mono line under the value. */
  sub?: ReactNode;
  tone?: UiTone;
  align?: 'start' | 'end';
  children?: ReactNode;
}
