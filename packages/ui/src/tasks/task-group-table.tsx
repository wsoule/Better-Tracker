'use client';

import { ArrowUpRight, ChevronRight } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import StatusMark from '../components/status-mark';
import { Link } from '../lib/link';
import { Chip } from './chip';
import { cx } from './class-names';
import {
  parseCollapsed,
  readCollapsedRaw,
  subscribeCollapsed,
  writeCollapsed,
} from './collapsed-groups';
import { EmptyState } from './notice';
import { ProgressRule } from './progress-rule';
import { PriorityGlyph, StateGlyph } from './task-glyphs';
import styles from './task-group-table.module.css';
import type {
  TaskColumnId,
  TaskGroupData,
  TaskGroupTableProps,
  TaskRowData,
  TaskSectionData,
} from './types';

const DEFAULT_COLUMNS: TaskColumnId[] = ['project', 'state', 'priority', 'due'];

const DEFAULT_LABELS: Record<TaskColumnId | 'title', string> = {
  title: 'Issue',
  project: 'Project',
  state: 'State',
  priority: 'Priority',
  due: 'Due',
};

const COLUMN_WIDTHS: Record<TaskColumnId, string> = {
  project: '156px',
  state: '136px',
  priority: '128px',
  due: '88px',
};

type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// A plain primary-button click (no modifier, no middle button): the only
// click a row callback may take over; cmd/ctrl/shift-click and middle
// click keep the browser's open-in-new-tab behaviour.
function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

// Decorative hues for project dots (tokens.css keeps --violet, --teal,
// --rose and --orange for dots and swatches only), so a project's colour
// never reads as a status. The same name always gets the same hue.
const PROJECT_HUES = ['--violet', '--teal', '--rose', '--orange'] as const;

function projectHue(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = PROJECT_HUES[Math.abs(hash) % PROJECT_HUES.length];
  return `var(${hue ?? '--gray'})`;
}

// The element a nav item hands focus to: a group's toggle button, or the
// row's primary link/button (rendered by the host <Link>, so it is found
// in the DOM rather than through a ref).
function focusTargetOf(item: Element): HTMLElement | null {
  return item.querySelector<HTMLElement>(
    '[data-nav-target] > a, [data-nav-target] > button, button[data-nav-target]'
  );
}

/* Gr8r's My Tasks grouped list, as one rounded panel. Structure: a column
   header, then sections (This week / Later / No milestone) as recessed
   bands, each holding collapsible groups (Gr8r's group header: chevron,
   status mark, Project / Milestone, count, then due, days left and
   completed/scope) of flat rows split by soft dividers.

   Semantics are plain on purpose: section and group titles are headings,
   each group's toggle is a disclosure button (aria-expanded/controls) and
   its rows are a list of links, so screen readers, cmd-click and the host
   router all work natively. The keyboard model (Gr8r/Dispatch) is layered
   on top: ↑/↓ (or j/k) move between group toggles and rows, Home/End jump,
   ← on a row goes to its group and on a group collapses it, → expands or
   enters it, ↵ opens; any other key on a row goes to onRowKeyDown, so a
   host can add its own single-key commands. Collapsed groups persist under
   storageKey. The column header is sticky at var(--task-sticky-top, 0):
   hosts with a sticky topbar set that custom property to its height. */
export function TaskGroupTable({
  sections,
  columns = DEFAULT_COLUMNS,
  columnLabels,
  label = 'Issues',
  headingLevel = 3,
  storageKey,
  storage = 'local',
  defaultCollapsed,
  emptyMessage = 'Nothing assigned to you',
  onOpenRow,
  onOpenGroup,
  onToggleGroup,
  activeRowId,
  onRowKeyDown,
}: TaskGroupTableProps) {
  // Folds live in component state, mirrored to storage when storageKey is
  // set. The stored value is read through useSyncExternalStore: the server
  // and hydration renders see null (defaults), the client then switches to
  // the stored set without a mismatch, and other tabs stay in step.
  const [local, setLocal] = useState<ReadonlySet<string>>(
    () => new Set(defaultCollapsed)
  );
  const stored = useSyncExternalStore(
    subscribeCollapsed,
    () =>
      storageKey === undefined ? null : readCollapsedRaw(storageKey, storage),
    () => null
  );
  const collapsed = useMemo<ReadonlySet<string>>(
    () => (stored === null ? local : parseCollapsed(stored)),
    [stored, local]
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const baseId = useId();

  const labels = { ...DEFAULT_LABELS, ...columnLabels };
  const template = [
    'minmax(0, 1fr)',
    ...columns.map((c) => COLUMN_WIDTHS[c]),
  ].join(' ');
  const SectionHeading = `h${headingLevel}` as HeadingTag;
  const GroupHeading = `h${headingLevel + 1}` as HeadingTag;

  function setGroupCollapsed(group: TaskGroupData, shut: boolean) {
    if (collapsed.has(group.id) === shut) return;
    // Focus must not vanish with the rows: if it sits in this group's rows,
    // hand it to the group's toggle before they unmount.
    if (shut) {
      const active = document.activeElement;
      const groupEl = rootRef.current?.querySelector(
        `[data-group-id="${CSS.escape(group.id)}"]`
      );
      const header = groupEl?.querySelector('[data-nav-item="group"]') ?? null;
      if (
        active !== null &&
        header !== null &&
        groupEl?.contains(active) === true &&
        !header.contains(active)
      ) {
        focusTargetOf(header)?.focus();
      }
    }
    const next = new Set(collapsed);
    if (shut) next.add(group.id);
    else next.delete(group.id);
    setLocal(next);
    if (storageKey !== undefined) writeCollapsed(storageKey, storage, next);
    onToggleGroup?.(group.id, shut);
  }

  const groupById = new Map<string, TaskGroupData>();
  for (const section of sections) {
    for (const group of section.groups) groupById.set(group.id, group);
  }

  // The table's own navigation; returns false for keys it leaves alone.
  function navigate(
    key: string,
    items: HTMLElement[],
    index: number,
    group: TaskGroupData | undefined,
    isGroup: boolean
  ): boolean {
    const root = rootRef.current;
    const focusAt = (i: number) => {
      const next = items[Math.min(Math.max(i, 0), items.length - 1)];
      if (next !== undefined) focusTargetOf(next)?.focus();
    };
    switch (key) {
      case 'ArrowDown':
      case 'j':
        focusAt(index + 1);
        return true;
      case 'ArrowUp':
      case 'k':
        focusAt(index - 1);
        return true;
      case 'Home':
        focusAt(0);
        return true;
      case 'End':
        focusAt(items.length - 1);
        return true;
      case 'ArrowRight': {
        if (!isGroup || group === undefined) return false;
        if (collapsed.has(group.id)) setGroupCollapsed(group, false);
        else if (group.rows.length > 0) focusAt(index + 1);
        return true;
      }
      case 'ArrowLeft': {
        if (group === undefined) return false;
        if (isGroup) {
          setGroupCollapsed(group, true);
        } else {
          const header = root?.querySelector(
            `[data-group-id="${CSS.escape(group.id)}"] [data-nav-item="group"]`
          );
          if (header !== null && header !== undefined) {
            focusTargetOf(header)?.focus();
          }
        }
        return true;
      }
      default:
        return false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const root = rootRef.current;
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-nav-item]');
    if (root === null || item === null || !root.contains(item)) return;
    const isGroup = item.dataset.navItem === 'group';
    const group = groupById.get(item.dataset.groupId ?? '');
    // A held modifier means someone else's shortcut (the palette, the
    // browser): never navigation, but a host row command may want it.
    const modified = event.altKey || event.ctrlKey || event.metaKey;
    if (!modified) {
      // Rendered items only, in reading order: collapsed groups' rows are
      // not in the DOM, so they are skipped for free.
      const items = Array.from(
        root.querySelectorAll<HTMLElement>('[data-nav-item]')
      );
      if (navigate(event.key, items, items.indexOf(item), group, isGroup)) {
        event.preventDefault();
        return;
      }
    }
    if (isGroup || group === undefined || onRowKeyDown === undefined) return;
    const row = group.rows.find((r) => r.id === item.dataset.rowId);
    if (row !== undefined) onRowKeyDown(event, row, group);
  }

  const hasGroups = sections.some((s) => s.groups.length > 0);
  if (!hasGroups) {
    return <EmptyState>{emptyMessage}</EmptyState>;
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      style={{ '--task-cols': template } as CSSProperties}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={label}
      aria-describedby={hintId}
    >
      <p id={hintId} className="srOnly">
        Up and down arrows move between groups and issues. Left and right
        collapse and expand a group. Enter opens.
      </p>
      <div className={styles.head} aria-hidden="true">
        <span className={cx(styles.headCell, styles.headTitle)}>
          {labels.title}
        </span>
        {columns.map((c) => (
          <span key={c} className={styles.headCell}>
            {labels[c]}
          </span>
        ))}
      </div>
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          Heading={SectionHeading}
          GroupHeading={GroupHeading}
          baseId={baseId}
          columns={columns}
          labels={labels}
          collapsed={collapsed}
          onToggle={setGroupCollapsed}
          onOpenRow={onOpenRow}
          onOpenGroup={onOpenGroup}
          activeRowId={activeRowId}
        />
      ))}
    </div>
  );
}

interface SectionProps {
  section: TaskSectionData;
  Heading: HeadingTag;
  GroupHeading: HeadingTag;
  baseId: string;
  columns: TaskColumnId[];
  labels: Record<TaskColumnId | 'title', string>;
  collapsed: ReadonlySet<string>;
  onToggle: (group: TaskGroupData, shut: boolean) => void;
  onOpenRow: TaskGroupTableProps['onOpenRow'];
  onOpenGroup: TaskGroupTableProps['onOpenGroup'];
  activeRowId: string | undefined;
}

function Section({
  section,
  Heading,
  GroupHeading,
  baseId,
  columns,
  labels,
  collapsed,
  onToggle,
  onOpenRow,
  onOpenGroup,
  activeRowId,
}: SectionProps) {
  let count = 0;
  for (const group of section.groups) count += group.rows.length;
  const note = section.note ?? plural(count, 'issue', 'issues');
  return (
    <div className={styles.section} data-section-id={section.id}>
      <Heading className={styles.sectionRow}>
        <span className={styles.sectionLabel}>{section.label}</span>
        <span className={styles.sectionNote}>{note}</span>
      </Heading>
      {section.groups.length === 0 ? (
        <p className={styles.emptyLine}>
          {section.emptyLabel ?? 'Nothing in this section'}
        </p>
      ) : null}
      {section.groups.map((group) => (
        <Group
          key={group.id}
          group={group}
          Heading={GroupHeading}
          listId={`${baseId}-${section.id}-${group.id}`}
          columns={columns}
          labels={labels}
          collapsed={collapsed.has(group.id)}
          onToggle={onToggle}
          onOpenRow={onOpenRow}
          onOpenGroup={onOpenGroup}
          activeRowId={activeRowId}
        />
      ))}
    </div>
  );
}

interface GroupProps {
  group: TaskGroupData;
  Heading: HeadingTag;
  listId: string;
  columns: TaskColumnId[];
  labels: Record<TaskColumnId | 'title', string>;
  collapsed: boolean;
  onToggle: (group: TaskGroupData, shut: boolean) => void;
  onOpenRow: TaskGroupTableProps['onOpenRow'];
  onOpenGroup: TaskGroupTableProps['onOpenGroup'];
  activeRowId: string | undefined;
}

function Group({
  group,
  Heading,
  listId,
  columns,
  labels,
  collapsed,
  onToggle,
  onOpenRow,
  onOpenGroup,
  activeRowId,
}: GroupProps) {
  // The spoken name: a comma, not the visible "/" between project and
  // milestone, which screen readers read out as "slash".
  const name =
    group.eyebrow !== undefined && group.eyebrow !== ''
      ? `${group.eyebrow}, ${group.title}`
      : group.title;
  const countId = `${listId}-count`;
  // A muted group is never loud: its date and progress are drawn in
  // greys, whatever dueTone and progress.tone say.
  const muted = group.muted === true;

  function onTitleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (onOpenGroup === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onOpenGroup(group);
  }

  const title =
    group.href !== undefined ? (
      <Link
        href={group.href}
        className={styles.groupLink}
        onClick={onTitleClick}
      >
        {group.title}
      </Link>
    ) : onOpenGroup !== undefined ? (
      <button
        type="button"
        className={styles.groupLink}
        onClick={() => onOpenGroup(group)}
      >
        {group.title}
      </button>
    ) : (
      <span className={styles.groupTitle}>{group.title}</span>
    );

  return (
    <div
      className={styles.group}
      data-group-id={group.id}
      data-collapsed={collapsed}
    >
      <div
        className={styles.groupRow}
        data-nav-item="group"
        data-group-id={group.id}
      >
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={name}
          aria-describedby={countId}
          data-nav-target=""
          onClick={() => onToggle(group, !collapsed)}
        >
          <ChevronRight
            className={styles.chevron}
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
        <Heading className={styles.groupHeading}>
          {group.status !== undefined ? (
            <StatusMark
              status={group.status}
              label={group.statusLabel ?? group.status}
              muted={muted}
            />
          ) : null}
          {group.eyebrow !== undefined && group.eyebrow !== '' ? (
            <>
              <span className={styles.eyebrow}>{group.eyebrow}</span>
              <span className={styles.crumb} aria-hidden="true">
                /
              </span>
            </>
          ) : null}
          {title}
          <span id={countId} className={styles.count}>
            {plural(group.rows.length, 'issue', 'issues')}
          </span>
        </Heading>
        <div className={styles.groupMeta}>
          {group.dueLabel !== undefined ? (
            <span
              className={styles.groupDue}
              data-tone={muted ? 'muted' : (group.dueTone ?? 'default')}
            >
              <span className="srOnly">Due </span>
              {group.dueLabel}
              {group.daysLeftLabel !== undefined ? (
                <span className={styles.daysLeft}>{group.daysLeftLabel}</span>
              ) : null}
            </span>
          ) : null}
          {group.progress !== undefined ? (
            <span className={styles.groupProgress}>
              <ProgressRule
                done={group.progress.done}
                total={group.progress.total}
                tone={muted ? 'muted' : group.progress.tone}
                aria-label={`${group.title} progress`}
              />
            </span>
          ) : null}
        </div>
      </div>
      <ul
        id={listId}
        className={styles.rows}
        hidden={collapsed}
        aria-label={name}
      >
        {collapsed
          ? null
          : group.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                group={group}
                columns={columns}
                labels={labels}
                onOpenRow={onOpenRow}
                active={row.id === activeRowId}
              />
            ))}
        {!collapsed && group.rows.length === 0 ? (
          <li className={styles.emptyLine}>No open issues</li>
        ) : null}
      </ul>
    </div>
  );
}

interface RowProps {
  row: TaskRowData;
  group: TaskGroupData;
  columns: TaskColumnId[];
  labels: Record<TaskColumnId | 'title', string>;
  onOpenRow: TaskGroupTableProps['onOpenRow'];
  active: boolean;
}

function Row({ row, group, columns, labels, onOpenRow, active }: RowProps) {
  const external = row.external === true;
  // Under a "Project / Milestone" heading the project cell repeats the
  // heading; phones drop it so the meta fits one line.
  const projectRepeatsHeading =
    row.project !== undefined && row.project === group.eyebrow;

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (onOpenRow === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onOpenRow(row, group);
  }

  const primary =
    row.href !== undefined ? (
      <Link
        href={row.href}
        className={styles.titleLink}
        onClick={onClick}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {row.title}
        {external ? (
          <>
            <ArrowUpRight
              className={styles.externalGlyph}
              size={12}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="srOnly"> (opens in a new tab)</span>
          </>
        ) : null}
      </Link>
    ) : (
      <button
        type="button"
        className={styles.titleLink}
        onClick={() => onOpenRow?.(row, group)}
      >
        {row.title}
      </button>
    );

  return (
    <li
      className={styles.row}
      data-nav-item="row"
      data-group-id={group.id}
      data-row-id={row.id}
      aria-current={active ? 'true' : undefined}
    >
      <div className={styles.titleCell}>
        <span className={styles.key}>{row.key}</span>
        <span className={styles.titleWrap}>
          <span className={styles.titleText} data-nav-target="">
            {primary}
          </span>
          {row.externalHref !== undefined ? (
            // U+2060 WORD JOINER: no line break between the title's last
            // word and the ↗.
            <>{'\u2060'}</>
          ) : null}
          {row.externalHref !== undefined ? (
            <Link
              href={row.externalHref}
              className={styles.linkOut}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={row.externalLabel ?? `Open ${row.key} in a new tab`}
              title={row.externalLabel ?? `Open ${row.key} in a new tab`}
            >
              <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden="true" />
            </Link>
          ) : null}
          {row.chips !== undefined && row.chips.length > 0 ? (
            <span className={styles.chips}>
              {row.chips.map((chip) => (
                <Chip key={chip.label} tone={chip.tone ?? 'default'}>
                  {chip.label}
                </Chip>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      {columns.map((column) => (
        <div
          key={column}
          className={styles.cell}
          data-column={column}
          data-repeats-heading={
            column === 'project' && projectRepeatsHeading ? '' : undefined
          }
        >
          <span className="srOnly">{labels[column]}: </span>
          <CellValue row={row} column={column} />
        </div>
      ))}
    </li>
  );
}

function CellValue({
  row,
  column,
}: {
  row: TaskRowData;
  column: TaskColumnId;
}) {
  switch (column) {
    case 'project':
      return row.project === undefined || row.project === '' ? (
        <span className={styles.project}>—</span>
      ) : (
        <span className={styles.project}>
          <span
            className={styles.projectDot}
            style={
              { '--project-hue': projectHue(row.project) } as CSSProperties
            }
            aria-hidden="true"
          />
          <span className={styles.projectName}>{row.project}</span>
        </span>
      );
    case 'state':
      return (
        <span className={styles.glyphValue} data-state={row.stateKind}>
          <StateGlyph kind={row.stateKind} />
          <span className={styles.metaText}>{row.state}</span>
        </span>
      );
    case 'priority':
      return (
        <span className={styles.glyphValue} data-priority={row.priority}>
          <PriorityGlyph priority={row.priority} />
          <span className={styles.metaText}>{row.priorityLabel}</span>
        </span>
      );
    case 'due':
      return (
        <span
          className={styles.due}
          data-tone={
            row.due === undefined ? 'muted' : (row.dueTone ?? 'default')
          }
        >
          {row.due ?? '—'}
        </span>
      );
  }
}
