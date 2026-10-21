import type { ReactNode } from 'react';

import type {
  AlertStripAction,
  PropertyListItem,
  ShellCrumb,
  SlideOverProps,
} from '../shell/types';
import type { TaskStateKind } from '../tasks/types';
import type { UiTone } from '../types';

// Prop vocabulary of the "task" family: the detail view of one task (issue)
// and the parts it is built from. Plain data, ReactNode slots and callbacks
// only. The planner fills it read-only (Linear stays the source of truth);
// Dispatch passes its own editors (PropertyControls) as property values and
// slots, so nothing here assumes the task is read-only or editable.

/** A task's workflow state: the kind picks the glyph, the label is printed. */
export interface TaskDetailStatus {
  kind: TaskStateKind;
  /** The state's name, e.g. "In Review". */
  label: string;
  /** Replaces the printed glyph + label in the status line, e.g. Dispatch's
      inline status picker. `kind` and `label` still describe the task. */
  control?: ReactNode;
}

/** One row of the alert stack above the properties. */
export interface TaskDetailAlert {
  id?: string;
  /** Mono key in the accent ("BLOCKED", "STALLED", "UNASSIGNED"). */
  label: string;
  /** One sentence ("Waiting on ENG-12 (in progress)."). */
  message: ReactNode;
  /** Follow-up: a link when it has an href, a button when it acts in place. */
  action?: AlertStripAction;
}

/** Another task this one waits on, or that waits on it. */
export interface TaskRelation {
  id: string;
  /** Identifier, e.g. "ENG-12" (mono). */
  taskKey: string;
  title: string;
  /** Where the row goes: a host route or the tracker's URL (http(s) URLs
      open in a new tab). */
  href?: string;
  /** Opens the task in place (a drawer, a peek). With an href, plain clicks
      call this and modified clicks still follow the link. */
  onOpen?: () => void;
  state: { kind: TaskStateKind; label: string };
  /** The assignee's name, or null when nobody is assigned. Leave undefined
      to print nothing. */
  assignee?: string | null;
  /** Where it lives, e.g. "Atlas billing migration / Dual-write" (the
      facts around it are already separated by middots). */
  context?: string;
  /** Outside the scope the viewer is looking at (another project, a team
      they cannot see): tagged so it is not mistaken for a local task. */
  external?: boolean;
  /** No longer blocking (done or canceled): drawn struck through and
      muted. */
  resolved?: boolean;
  /** Adds a remove button beside the row (an editable host's "unlink");
      it is a sibling of the row's link or button, never inside it. */
  onRemove?: () => void;
}

export interface TaskRelations {
  /** Tasks this one waits on. */
  blockedBy: TaskRelation[];
  /** Tasks that wait on this one. */
  blocks: TaskRelation[];
}

/** One event in the task's history, already worded and dated by the host. */
export interface TaskActivityItem {
  id: string;
  /** Display text for when it happened ("Oct 14", "2 days ago"). */
  at: string;
  /** Machine-readable instant for <time dateTime>, e.g. an ISO string. */
  dateTime?: string;
  /** What happened ("Assigned to Ana Moreno by the planner"). A node,
      so a host can mark up the actor; plain strings print as text. */
  label: ReactNode;
  /** A sentence of context under the label. */
  detail?: ReactNode;
  /** accent = needs action; muted = background noise. */
  tone?: UiTone;
  /** Makes the label a link (a run, a comment in the tracker). */
  href?: string;
}

/** The description as the tracker stores it: plain text, never HTML. */
export interface TaskDescriptionData {
  /** null or blank shows the empty state. */
  text: string | null;
  /** A body the host renders itself (its markdown renderer, or an
      editor) in place of `text`. No clamp applies, and the package never
      parses anything: whatever is safe here is the host's call. */
  content?: ReactNode;
  /** Shows a skeleton instead of the text. */
  loading?: boolean;
  /** Shows an error line instead of the text. */
  error?: string | null;
  /** Mono note under the text, right-aligned ("From Linear · edited
      Oct 18"). */
  sourceLabel?: string;
  /** Adds a retry button to the error line. */
  onRetry?: () => void;
}

export interface TaskDescriptionProps extends TaskDescriptionData {
  /** Lines shown before "Show more". Default 12. */
  clampLines?: number;
  /** Starts expanded (e.g. a host that remembers the choice). */
  defaultExpanded?: boolean;
  emptyLabel?: string;
  loadingLabel?: string;
  /** Mono key of the error line. Default "Error". */
  errorLabel?: string;
  retryLabel?: string;
  showMoreLabel?: string;
  showLessLabel?: string;
}

export interface TaskRelationListProps {
  items: TaskRelation[];
  /** Accessible name of the list ("Blocked by"). */
  label: string;
  /** Said when there are no items. */
  emptyLabel?: string;
  /** Opens a row in place when the row has no onOpen of its own. */
  onOpen?: (relation: TaskRelation) => void;
  /** Tag on external rows. Default "Outside view". */
  externalLabel?: string;
  /** Tag on resolved rows. Default "Resolved". */
  resolvedLabel?: string;
  /** Printed when assignee is null. Default "Unassigned". */
  unassignedLabel?: string;
  /** Screen-reader note on rows that open a new tab. */
  newTabLabel?: string;
  /** Name of a row's remove button; the task key is appended ("Remove
      ENG-23"). Default "Remove". */
  removeLabel?: string;
}

export interface TaskActivityListProps {
  items: TaskActivityItem[];
  /** Accessible name of the list. Default "Activity". */
  label?: string;
  emptyLabel?: string;
  /** Items shown before "Show all N". Omit to show every item. */
  limit?: number;
  /** Button wording; the total is appended ("Show all 9"). */
  showAllLabel?: string;
  showFewerLabel?: string;
  /** Screen-reader note on links to http(s) URLs. */
  newTabLabel?: string;
}

export interface TaskDetailSectionProps {
  title: ReactNode;
  /** Level of the section's heading. Default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Mono count after the title. */
  count?: number;
  /** Right-aligned mono note or control ("From Linear"). */
  meta?: ReactNode;
  /** Keep the heading for assistive tech only. */
  hideTitle?: boolean;
  id?: string;
  className?: string;
  children?: ReactNode;
}

/** Wording of every built-in label, for hosts in another language. */
export interface TaskDetailLabels {
  properties: string;
  propertiesList: string;
  description: string;
  noDescription: string;
  loadingDescription: string;
  error: string;
  retry: string;
  showMore: string;
  showLess: string;
  blockedBy: string;
  blocks: string;
  nothingBlocks: string;
  blocksNothing: string;
  activity: string;
  noActivity: string;
  showAll: string;
  showFewer: string;
  external: string;
  resolved: string;
  unassigned: string;
  breadcrumb: string;
  opensInNewTab: string;
  remove: string;
}

/** drawer = one column for a slide-over or split pane; page = main column
    beside a properties rail when there is room (both stack when narrow). */
export type TaskDetailLayout = 'drawer' | 'page';

export interface TaskDetailProps {
  /** Identifier, e.g. "ENG-24". */
  taskKey: string;
  /** The task's name: printed as the heading and naming the view (or the
      SlideOver) for assistive tech. */
  title: string;
  /** Replaces the printed title, e.g. Dispatch's inline title editor.
      `title` still names the view. */
  titleControl?: ReactNode;
  /** The task in its tracker (Linear); the key links there, new tab. */
  href?: string;
  /** Mono trail in the header bar ("BEACON SEARCH / ENG-24"): crumbs like
      the shell's, or a ready node. Defaults to the key. */
  breadcrumb?: ReactNode | readonly ShellCrumb[];
  /** Header bar controls, e.g. Open in Linear and Copy link. */
  headerActions?: ReactNode;
  status: TaskDetailStatus;
  /** Extra content in the status line (a priority glyph, "Updated 2h"). */
  statusMeta?: ReactNode;
  alerts?: TaskDetailAlert[];
  /** The host's property sheet, in the host's order. Values are nodes, so
      they may be plain text or editors. */
  properties: PropertyListItem[];
  /** Host sections that belong with the properties (labels, hierarchy,
      links, an editable relations list): in the rail under the property
      sheet in page layout, right after it in drawer layout. Build them
      with TaskDetailSection. */
  rail?: ReactNode;
  /** Omit to leave out the section; pass empty lists to say there are
      none. */
  relations?: TaskRelations;
  /** Opens a relation in place when it has no onOpen of its own. */
  onOpenRelation?: (relation: TaskRelation) => void;
  /** Omit to leave out the section. */
  description?: TaskDescriptionData;
  /** Omit to leave out the section; newest first, or as given. */
  activity?: TaskActivityItem[];
  /** Items shown before "Show all N". */
  activityLimit?: number;
  /** Extra host sections, after the built-in ones in the main column. */
  children?: ReactNode;
  /** Default 'drawer'. */
  layout?: TaskDetailLayout;
  /**
   * Draw the header (breadcrumb bar, actions and title). Default true.
   * Pass false when a container already draws them, e.g. inside SlideOver
   * (TaskSlideOver does this for you).
   */
  header?: boolean;
  /** Level of the title's heading, drawn here or by the container;
      sections sit one below. Default 2. */
  headingLevel?: 1 | 2 | 3 | 4 | 5;
  labels?: Partial<TaskDetailLabels>;
  id?: string;
  className?: string;
}

export interface TaskCrumbsProps {
  /** Crumbs, a ready node, or nothing (the key stands alone). */
  breadcrumb: TaskDetailProps['breadcrumb'];
  taskKey: string;
  /** Accessible name of the crumb nav ("Breadcrumb"). */
  label: string;
}

/** TaskDetail inside the shell's SlideOver: the drawer's bar carries the
    breadcrumb and actions, its heading the title. */
export interface TaskSlideOverProps extends Omit<
  TaskDetailProps,
  'layout' | 'header' | 'headingLevel'
> {
  open: boolean;
  onClose: () => void;
  closeLabel?: string;
  /** Receives focus on open instead of the panel itself. */
  initialFocusRef?: SlideOverProps['initialFocusRef'];
}

export interface TaskPropertyValueProps {
  children: ReactNode;
  /** A sentence under the value ("Given by the planner: …"). */
  note?: ReactNode;
  /** accent = needs action ("Unassigned"); muted = quiet. */
  tone?: UiTone;
  noteTone?: UiTone;
  /** Print the value in the mono voice (dates, durations). */
  mono?: boolean;
}
