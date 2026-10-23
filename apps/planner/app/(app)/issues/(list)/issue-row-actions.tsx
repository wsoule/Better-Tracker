'use client';

import type { IssuePatch, Priority } from '@better-tracker/core';
import {
  AssigneePicker,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  StatePicker,
  type TaskColumnId,
  type TaskRowData,
} from '@better-tracker/ui';
import {
  CircleDot,
  Ellipsis,
  FolderInput,
  SignalHigh,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { moreOption } from '../../../../lib/adapters/issue-list';
import {
  assignablePeople,
  assigneeChange,
  bulkAssigneeOptions,
  bulkPriorityOptions,
  bulkStateOptions,
  currentMoveChoice,
  type IssueChange,
  type IssueRowFacts,
  type MilestoneMenuData,
  milestoneChoice,
  milestoneMenuOptions,
  moveChange,
  movePatch,
  moveTargetOptions,
  priorityChange,
  type RowMenuAction,
  type RowMenuStage,
  rowMenuOptions,
  stateChange,
  teamStateChoices,
} from '../../../../lib/adapters/issue-moves';
import type { IssueListOptionsState } from './use-issue-list-options';

/* The Issues page's move controls (architecture §8.4 "Issues", moving),
   every one the ui package's PickerPopover: a row's "…" menu (also opened
   by right-click and the row keys m, a, s, p), which switches in place to
   the move, assignee, status or priority picker for the selection (when
   the row is in it) or the row; the cell pickers (milestone, assignee,
   status, priority: one issue, through the single edit's PATCH
   /api/issues/[id]); the bulk bar's four pickers; and a milestone group's
   "…" menu with its weight. Pickers that list workspace data fetch the
   options on first open (useIssueListOptions). */

const ICON = { size: 14, strokeWidth: 1.5, 'aria-hidden': true } as const;

/** The issues a row's menu or the bulk bar acts on. */
export interface MoveTargets {
  ids: readonly string[];
  facts: readonly IssueRowFacts[];
}

// The moving issues' projects and teams (the move picker lists their
// projects first and hints teams a project does not include).
function placesOf(targets: MoveTargets): {
  projectIds: string[];
  teamIds: string[];
} {
  return {
    projectIds: [
      ...new Set(
        targets.facts
          .map((f) => f.projectId)
          .filter((id): id is string => id !== null)
      ),
    ],
    teamIds: [...new Set(targets.facts.map((f) => f.teamId))],
  };
}

// "ENG-12" or "3 issues".
function targetName(targets: MoveTargets): string {
  if (targets.ids.length === 1) {
    return targets.facts[0]?.identifier ?? '1 issue';
  }
  return `${targets.ids.length} issues`;
}

// Fetches the options when a picker that needs them opens.
function useLoadWhen(open: boolean, state: IssueListOptionsState): void {
  const { load } = state;
  useEffect(() => {
    if (open) load();
  }, [open, load]);
}

// The picker with its option list cut to the limit ("Keep typing to
// narrow N more" at the end).
function withMore(list: { options: PickerOption[]; more: number }) {
  return list.more > 0
    ? [...list.options, moreOption(list.more)]
    : list.options;
}

/** One stage of a field picker for a set of issues (the row menu's stages
    and the bulk bar share it). */
function FieldPicker({
  field,
  targets,
  optionsState,
  today,
  viewerId,
  appearance,
  trigger,
  triggerLabel,
  align,
  anchorPoint,
  returnFocus,
  open,
  onOpenChange,
  onPick,
}: {
  field: Exclude<RowMenuStage, 'menu'>;
  targets: MoveTargets;
  optionsState: IssueListOptionsState;
  today: string;
  viewerId: string;
  appearance: 'quiet' | 'bar';
  trigger: ReactNode;
  triggerLabel: string;
  align: 'start' | 'end';
  /** Opens at this viewport point (a right-click on the row). */
  anchorPoint?: { x: number; y: number } | null;
  /** Where focus goes on Esc or a choice instead of the trigger. */
  returnFocus?: () => HTMLElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onPick: (change: IssueChange) => void;
}): ReactNode {
  const [search, setSearch] = useState('');
  const [openState, setOpenState] = useState(false);
  const isOpen = open ?? openState;
  const needsOptions = field !== 'priority';
  useLoadWhen(isOpen && needsOptions, optionsState);
  const { options } = optionsState;
  const waiting = needsOptions && options === null;
  const name = targetName(targets);
  let label: string;
  let list: PickerOption[];
  let filter = true;
  let toChange: (value: string) => IssueChange | null;
  switch (field) {
    case 'move': {
      const places = placesOf(targets);
      label = `Move ${name} to a milestone`;
      list = withMore(moveTargetOptions(options, { ...places, today, search }));
      filter = false;
      toChange = (value) => moveChange(value, options);
      break;
    }
    case 'assign':
      label = `Assign ${name}`;
      list = bulkAssigneeOptions(options, viewerId);
      toChange = (value) => assigneeChange(value, options);
      break;
    case 'status':
      label = `Set the status of ${name}`;
      list = bulkStateOptions(options, placesOf(targets).teamIds);
      toChange = stateChange;
      break;
    case 'priority':
      label = `Set the priority of ${name}`;
      list = bulkPriorityOptions();
      toChange = priorityChange;
      break;
  }
  return (
    <PickerPopover
      label={label}
      action
      appearance={appearance}
      align={align}
      anchorPoint={anchorPoint}
      returnFocus={returnFocus}
      value={null}
      options={list}
      filter={filter}
      query={filter ? undefined : search}
      onQueryChange={filter ? undefined : setSearch}
      searchable={field !== 'priority'}
      searchPlaceholder={
        field === 'move'
          ? 'Move to…'
          : field === 'assign'
            ? 'Assign to…'
            : 'Change status…'
      }
      loading={waiting && optionsState.error === null}
      error={needsOptions ? optionsState.error : null}
      onRetry={optionsState.retry}
      trigger={trigger}
      triggerLabel={triggerLabel}
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) setSearch('');
        if (open === undefined) setOpenState(next);
        onOpenChange?.(next);
      }}
      onChange={(value) => {
        if (value === null) return;
        const change = toChange(value);
        if (change !== null) onPick(change);
      }}
    />
  );
}

/**
 * A row's "…" menu: the actions (rowMenuOptions), and in place of them,
 * once an edit is chosen (or a row key pressed), that field's picker for
 * the targets. Each stage is its own popover on the "…" button: the
 * search box takes focus when a picker opens, and when it closes the
 * button stays (as that stage's closed trigger) with focus on it (or, for
 * a picker a row key opened, on `returnFocus`: the row's title, where the
 * key was pressed); a click on it opens the actions again.
 */
export function RowMenu({
  row,
  facts,
  targets,
  stage,
  open,
  anchorPoint = null,
  returnFocus,
  onOpen,
  onClose,
  onStage,
  onAction,
  onPick,
  readOnly,
  canWriteLinear,
  optionsState,
  today,
  viewerId,
}: {
  row: TaskRowData;
  facts: IssueRowFacts | undefined;
  targets: MoveTargets;
  stage: RowMenuStage;
  open: boolean;
  /** Where a right-click opened the menu (its stages open there too);
      null under the "…" button. */
  anchorPoint?: { x: number; y: number } | null;
  /** Where focus goes when a stage closes on Esc or a choice, instead of
      the "…" button (the row's title, for a picker a row key opened). */
  returnFocus?: () => HTMLElement | null;
  /** Opens the actions (a click on the "…" button). */
  onOpen: () => void;
  onClose: () => void;
  onStage: (stage: RowMenuStage) => void;
  onAction: (action: RowMenuAction) => void;
  onPick: (change: IssueChange) => void;
  readOnly: boolean;
  canWriteLinear: boolean;
  optionsState: IssueListOptionsState;
  today: string;
  viewerId: string;
}): ReactNode {
  const trigger = <Ellipsis {...ICON} />;
  const triggerLabel = `Actions for ${row.key}`;
  if (stage !== 'menu') {
    return (
      <FieldPicker
        key={stage}
        field={stage}
        targets={targets}
        optionsState={optionsState}
        today={today}
        viewerId={viewerId}
        appearance="quiet"
        align={anchorPoint === null ? 'end' : 'start'}
        anchorPoint={anchorPoint}
        returnFocus={returnFocus}
        trigger={trigger}
        triggerLabel={triggerLabel}
        open={open}
        onOpenChange={(next) => (next ? onOpen() : onClose())}
        onPick={onPick}
      />
    );
  }
  return (
    <PickerPopover
      key="menu"
      label={triggerLabel}
      searchable={false}
      action
      appearance="quiet"
      align={anchorPoint === null ? 'end' : 'start'}
      anchorPoint={anchorPoint}
      returnFocus={returnFocus}
      value={null}
      options={rowMenuOptions({
        facts,
        readOnly,
        canWriteLinear,
        targets: targets.ids.length,
      })}
      trigger={trigger}
      triggerLabel={triggerLabel}
      open={open}
      onOpenChange={(next) => (next ? onOpen() : onClose())}
      onChange={(value) => {
        if (value === null) return;
        if (
          value === 'move' ||
          value === 'assign' ||
          value === 'status' ||
          value === 'priority'
        ) {
          onStage(value);
        } else {
          onAction(value as RowMenuAction);
        }
      }}
    />
  );
}

/**
 * A meta cell as a picker (one issue, PATCH /api/issues/[id]): the
 * milestone (the move picker), the assignee, the status (the issue's own
 * team's) and the priority. The ui save contract applies: the new value
 * shows pending, then stays or rolls back with "Not saved · …". Undefined
 * for a column that keeps its plain value (TaskGroupTable's renderCell
 * contract), so this is called as a function, not rendered.
 */
export function issueCell({
  column,
  row,
  facts,
  optionsState,
  today,
  viewerId,
  onSave,
}: {
  column: TaskColumnId;
  row: TaskRowData;
  facts: IssueRowFacts;
  optionsState: IssueListOptionsState;
  today: string;
  viewerId: string;
  onSave: (issueId: string, patch: IssuePatch) => Promise<void>;
}): ReactNode | undefined {
  switch (column) {
    case 'milestone':
      return (
        <MoveCell
          row={row}
          facts={facts}
          optionsState={optionsState}
          today={today}
          onSave={onSave}
        />
      );
    case 'assignee':
      return (
        <AssigneeCell
          row={row}
          facts={facts}
          optionsState={optionsState}
          viewerId={viewerId}
          onSave={onSave}
        />
      );
    case 'state':
      return (
        <StateCell
          row={row}
          facts={facts}
          optionsState={optionsState}
          onSave={onSave}
        />
      );
    case 'priority':
      return (
        <PriorityPicker
          label={`${row.key} priority`}
          appearance="cell"
          value={row.priority}
          onChange={(priority: Priority) => onSave(facts.id, { priority })}
        />
      );
    default:
      return undefined;
  }
}

function MoveCell({
  row,
  facts,
  optionsState,
  today,
  onSave,
}: {
  row: TaskRowData;
  facts: IssueRowFacts;
  optionsState: IssueListOptionsState;
  today: string;
  onSave: (issueId: string, patch: IssuePatch) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  useLoadWhen(open, optionsState);
  const { options } = optionsState;
  const value =
    facts.milestoneId === null ? null : milestoneChoice(facts.milestoneId);
  // The face reads like the plain cell: the milestone first, then its
  // project (cut first by the ellipsis).
  const face =
    row.milestone === null || row.milestone === undefined
      ? undefined
      : row.milestoneProject === undefined
        ? row.milestone
        : `${row.milestone} · ${row.milestoneProject}`;
  const list =
    options === null
      ? value === null
        ? []
        : [{ value, label: face ?? value }]
      : withMore(
          moveTargetOptions(options, {
            projectIds: facts.projectId === null ? [] : [facts.projectId],
            teamIds: [facts.teamId],
            today,
            search,
          })
        );
  return (
    <PickerPopover
      label={`${row.key} milestone`}
      appearance="cell"
      value={value}
      valueLabel={face}
      placeholder="No milestone"
      options={list}
      filter={false}
      query={search}
      onQueryChange={setSearch}
      searchPlaceholder="Move to…"
      loading={options === null && optionsState.error === null}
      error={optionsState.error}
      onRetry={optionsState.retry}
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch('');
        setOpen(next);
      }}
      onChange={(choice) => {
        const patch = movePatch(choice ?? currentMoveChoice(facts), options);
        if (patch === null) {
          return Promise.reject(
            new Error('That milestone is not in the planner.')
          );
        }
        return onSave(facts.id, patch);
      }}
    />
  );
}

function AssigneeCell({
  row,
  facts,
  optionsState,
  viewerId,
  onSave,
}: {
  row: TaskRowData;
  facts: IssueRowFacts;
  optionsState: IssueListOptionsState;
  viewerId: string;
  onSave: (issueId: string, patch: IssuePatch) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  useLoadWhen(open, optionsState);
  const { options } = optionsState;
  return (
    <AssigneePicker
      label={`${row.key} assignee`}
      appearance="cell"
      people={assignablePeople(options)}
      value={facts.assigneeId}
      valueLabel={row.assignee ?? undefined}
      meId={viewerId}
      placeholderTone={row.assigneeTone === 'accent' ? 'accent' : 'muted'}
      loading={options === null && optionsState.error === null}
      error={optionsState.error}
      onRetry={optionsState.retry}
      open={open}
      onOpenChange={setOpen}
      onChange={(assigneeId) => onSave(facts.id, { assigneeId })}
    />
  );
}

function StateCell({
  row,
  facts,
  optionsState,
  onSave,
}: {
  row: TaskRowData;
  facts: IssueRowFacts;
  optionsState: IssueListOptionsState;
  onSave: (issueId: string, patch: IssuePatch) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  useLoadWhen(open, optionsState);
  const { options } = optionsState;
  const states =
    options === null
      ? [{ id: facts.stateId, name: row.state, kind: row.stateKind }]
      : teamStateChoices(options, facts.teamId);
  return (
    <StatePicker
      label={`${row.key} status`}
      appearance="cell"
      states={states}
      value={facts.stateId}
      loading={options === null && optionsState.error === null}
      error={optionsState.error}
      onRetry={optionsState.retry}
      open={open}
      onOpenChange={setOpen}
      onChange={(stateId) => onSave(facts.id, { stateId })}
    />
  );
}

/**
 * The bulk bar's actions: Move to milestone, Assignee, Status, Priority,
 * each a picker for the selected issues (appearance 'bar'). On a phone
 * the last two share one "More" picker, grouped Status then Priority.
 */
export function BulkActions({
  targets,
  optionsState,
  today,
  viewerId,
  compact,
  onPick,
}: {
  targets: MoveTargets;
  optionsState: IssueListOptionsState;
  today: string;
  viewerId: string;
  /** A phone: Status and Priority go into "More". */
  compact: boolean;
  onPick: (change: IssueChange) => void;
}): ReactNode {
  const common = { targets, optionsState, today, viewerId, onPick } as const;
  const face = (icon: ReactNode, text: string) => (
    <>
      {icon}
      <span data-bulk-label="">{text}</span>
    </>
  );
  return (
    <>
      <FieldPicker
        {...common}
        field="move"
        appearance="bar"
        align="start"
        trigger={face(<FolderInput {...ICON} />, 'Move to milestone')}
        triggerLabel="Move to milestone"
      />
      <FieldPicker
        {...common}
        field="assign"
        appearance="bar"
        align="start"
        trigger={face(<UserRound {...ICON} />, 'Assignee')}
        triggerLabel="Assignee"
      />
      {compact ? (
        <MorePicker {...common} />
      ) : (
        <>
          <FieldPicker
            {...common}
            field="status"
            appearance="bar"
            align="start"
            trigger={face(<CircleDot {...ICON} />, 'Status')}
            triggerLabel="Status"
          />
          <FieldPicker
            {...common}
            field="priority"
            appearance="bar"
            align="end"
            trigger={face(<SignalHigh {...ICON} />, 'Priority')}
            triggerLabel="Priority"
          />
        </>
      )}
    </>
  );
}

// The phone bar's "More": the statuses and priorities in one list.
function MorePicker({
  targets,
  optionsState,
  onPick,
}: {
  targets: MoveTargets;
  optionsState: IssueListOptionsState;
  onPick: (change: IssueChange) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  useLoadWhen(open, optionsState);
  const states = bulkStateOptions(
    optionsState.options,
    placesOf(targets).teamIds
  ).map((option) => ({ ...option, group: 'Status' }));
  const priorities = bulkPriorityOptions().map((option) => ({
    ...option,
    value: `priority:${option.value}`,
    group: 'Priority',
  }));
  return (
    <PickerPopover
      label={`Status or priority of ${targetName(targets)}`}
      action
      appearance="bar"
      align="end"
      value={null}
      options={[...states, ...priorities]}
      loading={optionsState.options === null && optionsState.error === null}
      error={optionsState.error}
      onRetry={optionsState.retry}
      trigger={
        <>
          <SlidersHorizontal {...ICON} />
          <span data-bulk-label="">More</span>
        </>
      }
      triggerLabel="More: status or priority"
      open={open}
      onOpenChange={setOpen}
      onChange={(value) => {
        if (value === null) return;
        const change = value.startsWith('priority:')
          ? priorityChange(value.slice(9))
          : stateChange(value);
        if (change !== null) onPick(change);
      }}
    />
  );
}

/**
 * A milestone group's "…" menu: Raise weight, Lower weight, Clear weight
 * and Open milestone, then the line saying the weight changes only the
 * order on screen. Everyone signed in but a guest (the weight is the
 * planner's own; no Linear grant needed).
 */
export function MilestoneMenu({
  title,
  menu,
  bounds,
  onWeight,
  onOpen,
}: {
  title: string;
  menu: MilestoneMenuData;
  bounds: { min: number; max: number };
  onWeight: (choice: 'raise' | 'lower' | 'clear') => void;
  onOpen: () => void;
}): ReactNode {
  return (
    <PickerPopover
      label={`Actions for ${title}`}
      searchable={false}
      action
      appearance="quiet"
      align="end"
      value={null}
      options={milestoneMenuOptions(menu, bounds)}
      trigger={<Ellipsis {...ICON} />}
      triggerLabel={`Actions for ${title}`}
      onChange={(value) => {
        if (value === 'raise' || value === 'lower' || value === 'clear') {
          onWeight(value);
        } else if (value === 'open') {
          onOpen();
        }
      }}
    />
  );
}
