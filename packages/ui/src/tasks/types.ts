import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import type { UiStatus, UiTone } from '../types';

// Prop vocabulary of the "tasks" family: primitives, the grouped task table,
// deadlines, stats and registers. Plain data + callbacks only, so the
// planner (Next) and Dispatch (Vite + Tauri) can map their own models onto
// these shapes in a thin adapter.

/* ---- primitives -------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonCommonProps {
  /** primary = purple fill (one per view), secondary = white with a strong
   * border, quiet = Gr8r's ghost (no box until hover), danger = red fill
   * (a destructive or irreversible write, e.g. "Assign in Linear now"). */
  variant?: ButtonVariant;
  /** sm 26px (toolbars), md 30px (the default), lg 36px (the one call to
   * action of a card, e.g. "Sign in with Linear"). */
  size?: ButtonSize;
  /** Stretch across the container (a sign-in card's button). */
  block?: boolean;
  /** Leading icon, e.g. a 14px lucide icon (strokeWidth 1.8). */
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

/** Gr8r's badge: default = neutral (grey fill, soft border), muted = quieter
 * neutral, accent / info / success / warning / danger = the tone's text on
 * its soft tint (no border), inverse = dark fill (kept for old callers;
 * prefer a semantic tone). */
export type ChipTone = UiTone | 'inverse';

export interface ChipProps {
  tone?: ChipTone;
  /** Gr8r's status pill: a neutral bordered chip with a 6px dot in the
   * tone's hue, for a lifecycle status (a Linear project status, a run's
   * mode) rather than a call to action. */
  dot?: boolean;
  /** Optional leading status mark; needs statusLabel for assistive tech. */
  status?: UiStatus;
  statusLabel?: string;
  title?: string;
  children: ReactNode;
}

export interface SegmentedOption {
  id: string;
  label: string;
  /** Count after the label, e.g. "Upcoming 6". */
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
  /** Quiet note after the label. */
  note?: string;
  disabled?: boolean;
  id?: string;
  /** Overrides the accessible name when the visible label alone is not
      enough (two "Live" switches in a settings list); keep the visible
      label inside it ("Allocation live"). */
  'aria-label'?: string;
  /** Names the switch by other elements' text (a setting row's title). */
  'aria-labelledby'?: string;
}

export interface CheckboxProps {
  /** Controlled state. Omit (and pass defaultChecked) for uncontrolled. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** Label beside the box (and the accessible name). */
  label: string;
  /** Quiet note after the label. */
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
      (drawn dimmed; say why in `note`). */
  href?: string;
  /** The page being shown: raised / underlined, aria-current="page". */
  current?: boolean;
  /** Count after the label. */
  count?: number;
  /** Short muted note after the label ("select a milestone"). */
  note?: string;
  /** A leading icon (a 16px Lucide element; 14px at size sm), decorative:
      the label names the cell. Gr8r's settings sub-nav has one per item. */
  icon?: ReactNode;
}

export interface NavTabsProps {
  items: NavTabItem[];
  /** Accessible name of the <nav> ("Graph level", "Settings sections"). */
  label: string;
  /** horizontal = a tab strip; vertical = a sub-nav column that becomes a
      sideways-scrolling strip at 900px and below. */
  orientation?: 'horizontal' | 'vertical';
  size?: 'sm' | 'md';
  /** Horizontal only: stretch the cells across the container. */
  fill?: boolean;
  className?: string;
}

export interface ProgressRuleProps {
  done: number;
  total: number;
  /** The fill: default = the accent (Gr8r's progress), danger when the
   * milestone is overdue, warning when it is behind pace, success when
   * done, muted when inactive. */
  tone?: UiTone;
  /** Visible label; defaults to "done/total". Pass null to hide it. */
  label?: string | null;
  /** Accessible name, e.g. "Cutover rehearsal progress". */
  'aria-label'?: string;
}

export interface NoticeProps {
  /** Semibold lead-in before the copy, e.g. "Blocked", "Demo data". */
  label?: string;
  children: ReactNode;
  /** default / muted = a bordered neutral box; any other tone fills the
   * box with its soft tint and prints the label in the tone's ink. Defaults
   * to accent (Gr8r's info alert); pass a semantic tone for status. */
  tone?: UiTone;
  /** status (polite) for updates, alert for errors. Omit for static copy. */
  role?: 'status' | 'alert';
  /** Trailing control, e.g. a quiet Button. */
  action?: ReactNode;
}

export interface EmptyStateProps {
  /** The explanation, in the body face: "Nothing due this week." */
  children: ReactNode;
  /** A short title above it ("No runs"), when the sentence is long. */
  label?: string;
  action?: ReactNode;
  /** Dash the box's edge (an input is missing rather than nothing to
   * show). */
  hatched?: boolean;
  /** The 22px decorative icon above the title (a Lucide element). Defaults
   * to an empty tray, or a dashed circle when hatched; null for none. */
  icon?: ReactNode;
}

export interface ChecklistItem {
  id?: string;
  label: string;
  met: boolean;
  /** Quiet note under the label, e.g. "Add a target date in Linear". */
  note?: string;
}

export interface ChecklistProps {
  items: ChecklistItem[];
  /** Accessible name of the list, e.g. "Rubric". */
  label?: string;
  /** Right-aligned state words; defaults to Met / Missing. */
  metLabel?: string;
  missingLabel?: string;
}

/* ---- stats ------------------------------------------------------------- */

export interface StatCell {
  id: string;
  label: string;
  /** 22px semibold, tabular figures. */
  value: ReactNode;
  note?: string;
  /** The value's colour: a semantic tone for a status count (overdue =
   * danger), accent for new / unread, muted = quiet. */
  tone?: UiTone;
  /** Makes the cell a link (Gr8r stat cards navigate to the filtered list). */
  href?: string;
  /** Gr8r's key icon: a 14px glyph in --text-4 before the label (drawing
   * only, hidden from assistive tech; the label says it). */
  icon?: ReactNode;
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
  tone?: UiTone;
}

export interface TaskGroupData {
  id: string;
  /** The project before the title (Project / Milestone), in secondary
   * text. */
  eyebrow?: string;
  /** The group's name, typically the milestone. */
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
   * greys, and the due date and progress grey, whatever dueTone and
   * progress.tone say. */
  muted?: boolean;
  rows: TaskRowData[];
}

export interface TaskSectionData {
  id: string;
  /** Divider label, e.g. "This week", "Later", "No milestone". */
  label: string;
  /** Quiet note after the label; defaults to the issue count. */
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
  /** The row the host has open (in a drawer, a detail pane): it takes the
   * accent tint (Gr8r's selected row) and is marked aria-current. */
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
  /** Quiet line under the label, e.g. "3 open · Atlas". */
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
  /** danger for Overdue, warning for Today or Tomorrow when they hold
   * something; colours the label and the dates. */
  tone?: UiTone;
  items: DeadlineItem[];
}

export interface DeadlineListProps {
  groups: DeadlineGroup[];
  /** Items shown per group before "+N more". Default 4. */
  limit?: number;
  /** Shown when every group is empty (empty groups are not drawn); one
   * EmptyState stands for the whole list. */
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
  /** A row that needs action (a semantic tone) or is quiet (muted): data
   * only; muted steps the subject back. */
  tone?: UiTone;
  /** The accent tint (Gr8r's selected row). */
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
  /** Label above the value (hidden on desktop under a header). */
  label?: string;
  /** name = the row's subject (medium), value = body copy, mono = short
   * facts in tabular figures (Geist; the name is historical). */
  variant?: 'name' | 'value' | 'mono';
  /** Secondary line under the value. */
  sub?: ReactNode;
  tone?: UiTone;
  align?: 'start' | 'end';
  children?: ReactNode;
}
