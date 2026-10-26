import {
  ALL_STATE_TYPES,
  type IssueBulkPatch,
  type IssueListOptions,
  type IssueListQuery,
  type IssuePatch,
  LIST_ME,
  LIST_NONE,
  type Priority,
  PRIORITY_LABEL,
  stateNameKey,
  type WorkflowStateType,
} from '@better-tracker/core';
import type { IssueBulkResult } from '@better-tracker/engine';
import type { PickerOption, TaskRowData } from '@better-tracker/ui';

import { formatDate } from '../format';
import { cutPickerOptions, type PickerOptionList } from './issue-list';
import { blockedReasonLine, statusLabel, uiStatus } from './status';
import { weightTag } from './timeline';

// Moving issues on the Issues page (architecture §8.4 "Issues", moving;
// §7.3 for the engine; owner request 2026-10-22, "… and move them to
// milestones and stuff"): the pure half of the page's moves. What a pick,
// a drop or a key sends (an IssueBulkPatch for PATCH /api/issues, or an
// IssuePatch for a cell's PATCH /api/issues/[id]), the move, status,
// assignee and priority pickers' options, whether a drop target takes the
// dragged rows, the inline confirmation, the rows' pending values, every
// toast a bulk change ends with, and the Undo requests. The client island
// (use-issue-moves.ts, issue-row-actions.tsx) only wires these to the
// browser.

/** At most this many issues per change: the engine's ISSUE_BULK_MAX
    (kept here so the browser bundle never imports the engine; a test
    holds the two equal). */
export const ISSUE_MOVE_MAX = 100;

/** At this many issues a bulk change asks first (and for a drag that
    changes any issue's project). */
export const BULK_CONFIRM_AT = 20;

/** How long a toast with Undo stays up. */
export const UNDO_TOAST_MS = 8000;

/** One shown row's current values: what a move compares against. Plain
    data in the page model, keyed by issue id. */
export interface IssueRowFacts {
  id: string;
  identifier: string;
  teamId: string;
  projectId: string | null;
  milestoneId: string | null;
  assigneeId: string | null;
  priority: Priority;
  stateId: string;
  stateType: WorkflowStateType;
  stateName: string;
  open: boolean;
  /** It blocks or waits on another issue (the row menu's Blocking chain). */
  related: boolean;
}

/** What dropping rows on one group does (core's IssueListGroup.patch). */
export interface IssueGroupTarget {
  /** The group's drop patch; null = not a target. */
  patch: IssueBulkPatch | null;
  /** A project group: only the dragged issues from other projects are
      sent, so an issue already in the project keeps its milestone. */
  projectOnly: boolean;
  /** Why the group takes nothing (shown while a row is dragged over it). */
  reason: string | null;
  /** The target in words ("Garnet mobile app › Push notifications"). */
  label: string;
  /** A move's short name for the rows' note ("Push notifications", "No
      milestone", "No project"). */
  short?: string;
}

/** A change the page sends, with the words its toast and note use. */
export interface IssueChange {
  patch: IssueBulkPatch;
  /** "Garnet mobile app › Push notifications", "Ana Moreno",
      "Unassigned", "In Review", "High". */
  label: string;
  /** A move's short name for the rows' note ("Moving to Push
      notifications…"); the label when absent. */
  short?: string;
}

/** Which field a change sets (its toast's verb). */
export type IssueChangeKind = 'move' | 'assignee' | 'state' | 'priority';

/** The field a patch sets first: move, then assignee, status, priority. */
export function changeKind(patch: IssueBulkPatch): IssueChangeKind {
  if (patch.move !== undefined) return 'move';
  if (patch.assigneeId !== undefined) return 'assignee';
  if (patch.state !== undefined) return 'state';
  return 'priority';
}

// ---------------------------------------------------------------------------
// The move picker (cells, the row menu, `m`, the bulk bar)
// ---------------------------------------------------------------------------

/** The move picker's value for a milestone ("m:<id>"). */
export function milestoneChoice(milestoneId: string): string {
  return `m:${milestoneId}`;
}

/** The move picker's value for "No milestone in P" ("p:<id>"), or "No
    project" ("p:none"). */
export function projectChoice(projectId: string | null): string {
  return `p:${projectId ?? LIST_NONE}`;
}

/** A row's current place as the move picker's value. */
export function currentMoveChoice(facts: IssueRowFacts): string {
  return facts.milestoneId !== null
    ? milestoneChoice(facts.milestoneId)
    : projectChoice(facts.projectId);
}

// "not ENG's", "not ENG's or OPS's": the moving issues' teams a project
// does not include (Linear decides; the hint only warns).
function notTeamsHint(
  projectTeamIds: readonly string[],
  issueTeamIds: readonly string[],
  teamKey: (teamId: string) => string | undefined
): string | null {
  const missing = issueTeamIds
    .filter((id) => !projectTeamIds.includes(id))
    .map((id) => teamKey(id))
    .filter((key): key is string => key !== undefined);
  if (missing.length === 0) return null;
  return `not ${missing.map((key) => `${key}’s`).join(' or ')}`;
}

/**
 * The move picker's options: one group per project (the moving issues'
 * own projects first, then other active projects in timeline order, then
 * inactive ones headed "{name} · inactive"), each listing its milestones
 * in the planner's order with their status mark and a hint ("Oct 28 ·
 * next · ↑2", "complete" for complete ones, which come last, "not ENG's"
 * when the project does not include the issues' team), then "No milestone
 * in {Project}"; then "Other" with "No project". Values: `m:<milestone>`,
 * `p:<project>`, `p:none`. Filtered by `search` here (the picker passes
 * filter={false}) and cut to 200 options.
 */
export function moveTargetOptions(
  options: IssueListOptions | null,
  context: {
    /** The moving issues' projects, listed first. */
    projectIds: readonly string[];
    /** The moving issues' teams (the "not ENG's" hint). */
    teamIds: readonly string[];
    today: string;
    search: string;
  }
): PickerOptionList {
  const projects = options?.projects ?? [];
  const teamKeys = new Map(options?.teams.map((t) => [t.id, t.key]));
  const first = new Set(context.projectIds);
  const ordered = [
    ...projects.filter((p) => first.has(p.id)),
    ...projects.filter((p) => !first.has(p.id) && p.active),
    ...projects.filter((p) => !first.has(p.id) && !p.active),
  ];
  const teams = [...new Set(context.teamIds)];
  const list: PickerOption[] = [];
  for (const project of ordered) {
    const group = project.active ? project.name : `${project.name} · inactive`;
    const notOurs = notTeamsHint(project.teamIds, teams, (id) =>
      teamKeys.get(id)
    );
    const milestones = [
      ...project.milestones.filter((m) => m.status !== 'complete'),
      ...project.milestones.filter((m) => m.status === 'complete'),
    ];
    for (const milestone of milestones) {
      const hint: string[] = [];
      if (milestone.status === 'complete') {
        hint.push('complete');
      } else {
        hint.push(
          milestone.targetDate === null
            ? 'no date'
            : formatDate(milestone.targetDate, context.today)
        );
        if (milestone.isNext && project.active) hint.push('next');
        const weight = weightTag(milestone.weight);
        if (weight !== null) hint.push(weight);
      }
      if (notOurs !== null) hint.push(notOurs);
      list.push({
        value: milestoneChoice(milestone.id),
        label: milestone.name,
        hint: hint.join(' · '),
        keywords: [project.name],
        group,
        mark: {
          kind: 'status',
          status: uiStatus(milestone.status),
          label: statusLabel(milestone.status),
          muted: !project.active,
        },
      });
    }
    // Under the project's heading: "No milestone" (in that project).
    list.push({
      value: projectChoice(project.id),
      label: 'No milestone',
      hint: notOurs ?? undefined,
      keywords: [project.name],
      group,
    });
  }
  list.push({
    value: projectChoice(null),
    label: 'No project',
    group: 'Other',
  });
  return cutPickerOptions(list, context.search);
}

// The project and milestone a move picker value names, from the options.
function placeOf(
  choice: string,
  options: IssueListOptions | null
): {
  projectId: string | null;
  milestoneId: string | null;
  projectName: string | null;
  milestoneName: string | null;
} | null {
  if (choice === projectChoice(null)) {
    return {
      projectId: null,
      milestoneId: null,
      projectName: null,
      milestoneName: null,
    };
  }
  if (choice.startsWith('p:')) {
    const id = choice.slice(2);
    const project = options?.projects.find((p) => p.id === id);
    if (project === undefined) return null;
    return {
      projectId: id,
      milestoneId: null,
      projectName: project.name,
      milestoneName: null,
    };
  }
  if (choice.startsWith('m:')) {
    const id = choice.slice(2);
    for (const project of options?.projects ?? []) {
      const milestone = project.milestones.find((m) => m.id === id);
      if (milestone !== undefined) {
        return {
          projectId: project.id,
          milestoneId: id,
          projectName: project.name,
          milestoneName: milestone.name,
        };
      }
    }
  }
  return null;
}

/** "Atlas billing migration › Dual-write", "Atlas billing migration › No
    milestone", "No project". */
export function placeLabel(
  projectName: string | null,
  milestoneName: string | null
): string {
  if (projectName === null) return 'No project';
  return `${projectName} › ${milestoneName ?? 'No milestone'}`;
}

/**
 * A cell's move as the single edit's IssuePatch (PATCH /api/issues/[id]):
 * a milestone brings its project; "No milestone in P" sets the project and
 * clears the milestone; "No project" clears the project (the engine then
 * clears the milestone). Null for a value the options do not hold.
 */
export function movePatch(
  choice: string,
  options: IssueListOptions | null
): IssuePatch | null {
  const place = placeOf(choice, options);
  if (place === null) return null;
  if (place.projectId === null) return { projectId: null };
  return { projectId: place.projectId, projectMilestoneId: place.milestoneId };
}

/** A move picker value as a bulk change (PATCH /api/issues), or null. */
export function moveChange(
  choice: string,
  options: IssueListOptions | null
): IssueChange | null {
  const place = placeOf(choice, options);
  if (place === null) return null;
  return {
    patch: {
      move: { projectId: place.projectId, milestoneId: place.milestoneId },
    },
    label: placeLabel(place.projectName, place.milestoneName),
    short:
      place.milestoneName ??
      (place.projectId === null ? 'No project' : 'No milestone'),
  };
}

// ---------------------------------------------------------------------------
// The bulk bar's other pickers
// ---------------------------------------------------------------------------

/** The assignee picker's value for "Unassign". */
export const UNASSIGN_CHOICE = 'none';

/**
 * The bulk Assignee picker: "Unassign", then you ("You" as its hint),
 * then the other active people by name (a deactivated person cannot be
 * assigned). Values: a user id, or `none`.
 */
export function bulkAssigneeOptions(
  options: IssueListOptions | null,
  viewerId: string
): PickerOption[] {
  const people = (options?.people ?? []).filter((p) => p.active);
  const me = people.find((p) => p.id === viewerId);
  const list: PickerOption[] = [
    {
      value: UNASSIGN_CHOICE,
      label: 'Unassign',
      mark: { kind: 'avatar', name: '' },
    },
  ];
  if (me !== undefined) {
    list.push({
      value: me.id,
      label: me.name,
      hint: 'You',
      keywords: [me.displayName],
      mark: { kind: 'avatar', name: me.name },
    });
  }
  for (const person of people) {
    if (person.id === viewerId) continue;
    list.push({
      value: person.id,
      label: person.name,
      keywords: [person.displayName],
      mark: { kind: 'avatar', name: person.name },
    });
  }
  return list;
}

/** An assignee picker value as a bulk change, or null. */
export function assigneeChange(
  choice: string,
  options: IssueListOptions | null
): IssueChange | null {
  if (choice === UNASSIGN_CHOICE) {
    return { patch: { assigneeId: null }, label: 'Unassigned' };
  }
  const person = options?.people.find((p) => p.id === choice);
  if (person === undefined) return null;
  return { patch: { assigneeId: person.id }, label: person.name };
}

/** The priorities in the order the pickers list them. */
const PRIORITY_ORDER: readonly Priority[] = [1, 2, 3, 4, 0];

/** The bulk Priority picker: the five levels with their glyphs. */
export function bulkPriorityOptions(): PickerOption[] {
  return PRIORITY_ORDER.map((priority) => ({
    value: String(priority),
    label: PRIORITY_LABEL[priority],
    mark: { kind: 'priority', priority },
  }));
}

/** A priority picker value as a bulk change, or null. */
export function priorityChange(choice: string): IssueChange | null {
  const priority = Number(choice);
  if (!PRIORITY_ORDER.includes(priority as Priority)) return null;
  return {
    patch: { priority: priority as Priority },
    label: PRIORITY_LABEL[priority as Priority],
  };
}

// A status picker value: "s:<type>:<name>" (the name as first listed).
function stateChoice(type: WorkflowStateType, name: string): string {
  return `s:${type}:${name}`;
}

/**
 * The bulk Status picker: the selected issues' teams' statuses joined by
 * type and name (trimmed, case-insensitive, so ENG's and OPS's "In Review"
 * are one choice), ordered by type (triage → canceled) then the lowest
 * position among the teams, each hinted "not in {Team}" when one of the
 * teams lacks it (those issues are then left as they are). Values:
 * `s:<type>:<name>`.
 */
export function bulkStateOptions(
  options: IssueListOptions | null,
  teamIds: readonly string[]
): PickerOption[] {
  const wanted = [...new Set(teamIds)];
  const teams = (options?.teams ?? []).filter((t) => wanted.includes(t.id));
  const byKey = new Map<
    string,
    {
      type: WorkflowStateType;
      name: string;
      position: number;
      teamIds: Set<string>;
    }
  >();
  for (const team of teams) {
    for (const state of team.states) {
      const key = `${state.type}\0${stateNameKey(state.name)}`;
      const found = byKey.get(key);
      if (found === undefined) {
        byKey.set(key, {
          type: state.type,
          name: state.name.trim(),
          position: state.position,
          teamIds: new Set([team.id]),
        });
      } else {
        found.position = Math.min(found.position, state.position);
        found.teamIds.add(team.id);
      }
    }
  }
  const typeIndex = (type: WorkflowStateType) => ALL_STATE_TYPES.indexOf(type);
  return [...byKey.values()]
    .sort((a, b) => {
      const byType = typeIndex(a.type) - typeIndex(b.type);
      if (byType !== 0) return byType;
      const byPosition = a.position - b.position;
      return byPosition !== 0 ? byPosition : a.name.localeCompare(b.name);
    })
    .map((state) => {
      const missing = teams.filter((t) => !state.teamIds.has(t.id));
      return {
        value: stateChoice(state.type, state.name),
        label: state.name,
        hint:
          missing.length === 0
            ? undefined
            : `not in ${missing.map((t) => t.name).join(', ')}`,
        mark: { kind: 'state', state: state.type },
      };
    });
}

/** A status picker value as a bulk change, or null. */
export function stateChange(choice: string): IssueChange | null {
  const match = /^s:([a-z]+):(.+)$/s.exec(choice);
  if (match === null) return null;
  const type = match[1] as WorkflowStateType;
  const name = match[2] ?? '';
  if (!ALL_STATE_TYPES.includes(type) || name.trim() === '') return null;
  return { patch: { state: { type, name } }, label: name };
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

/** Dropping on a group whose order the weight decides (one row on its own
    milestone). */
export const ORDER_FROM_WEIGHT =
  'Order inside a group comes from the weight. Change the milestone’s weight instead.';

/** Dropping where every dragged issue already is. */
export const ALREADY_THERE = 'Already there.';

/** Whether `patch` would change anything about the issue `facts` holds. */
export function wouldChange(
  facts: IssueRowFacts,
  patch: IssueBulkPatch
): boolean {
  if (
    patch.move !== undefined &&
    (facts.projectId !== patch.move.projectId ||
      facts.milestoneId !== patch.move.milestoneId)
  ) {
    return true;
  }
  if (patch.assigneeId !== undefined && facts.assigneeId !== patch.assigneeId) {
    return true;
  }
  if (patch.priority !== undefined && facts.priority !== patch.priority) {
    return true;
  }
  if (
    patch.state !== undefined &&
    (facts.stateType !== patch.state.type ||
      stateNameKey(facts.stateName) !== stateNameKey(patch.state.name))
  ) {
    return true;
  }
  return false;
}

/** What a drop sends: the issues and the change, or why it does nothing. */
export type DropPlan =
  | { ok: true; issueIds: string[]; change: IssueChange }
  | { ok: false; reason: string };

/**
 * Dropping `ids` on a group: its drop patch for every dragged issue (the
 * engine reports the ones that already had it as unchanged), except on a
 * project group, which takes only the issues from other projects (a row
 * released on its own project would otherwise lose its milestone in
 * Linear). Refused, with the reason shown while dragging, when the group
 * is not a target or nothing would change: one row on its own milestone
 * is told that order comes from the weight.
 */
export function dropPlan(
  target: IssueGroupTarget | undefined,
  ids: readonly string[],
  facts: Readonly<Record<string, IssueRowFacts>>
): DropPlan {
  if (target === undefined || target.patch === null) {
    return { ok: false, reason: target?.reason ?? 'Nothing to change here.' };
  }
  const patch = target.patch;
  const known = ids.filter((id) => facts[id] !== undefined);
  const candidates =
    target.projectOnly && patch.move !== undefined
      ? known.filter((id) => facts[id]?.projectId !== patch.move?.projectId)
      : known;
  const changing = candidates.filter((id) => {
    const row = facts[id];
    return row !== undefined && wouldChange(row, patch);
  });
  if (changing.length === 0) {
    const ownMilestone =
      known.length === 1 &&
      patch.move !== undefined &&
      patch.move.milestoneId !== null;
    return {
      ok: false,
      reason: ownMilestone ? ORDER_FROM_WEIGHT : ALREADY_THERE,
    };
  }
  return {
    ok: true,
    issueIds: candidates,
    change:
      target.short === undefined
        ? { patch, label: target.label }
        : { patch, label: target.label, short: target.short },
  };
}

// ---------------------------------------------------------------------------
// The inline confirmation
// ---------------------------------------------------------------------------

/** The bulk bar's confirmation sentence and button. */
export interface BulkConfirmText {
  message: string;
  confirmLabel: string;
}

/** What the confirmation needs to name projects and teams. */
export interface BulkConfirmNames {
  project: (projectId: string) => string | undefined;
  /** A project's teams (Linear may refuse issues of other teams). */
  projectTeamIds: (projectId: string) => readonly string[] | undefined;
  team: (teamId: string) => string | undefined;
}

// "Atlas billing migration", "Atlas billing migration and Beacon search",
// "3 projects".
function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.length} projects`;
}

/**
 * Whether a change asks first, and its words: at BULK_CONFIRM_AT issues
 * or more, or for a drag that changes any issue's project. A move names
 * the projects issues leave ("2 of them move from Atlas billing migration
 * to Garnet mobile app.") and the teams the target project does not
 * include; every confirmation ends "This changes them in Linear, as you."
 */
export function bulkConfirm(input: {
  change: IssueChange;
  issueIds: readonly string[];
  facts: Readonly<Record<string, IssueRowFacts>>;
  drag: boolean;
  names: BulkConfirmNames;
}): BulkConfirmText | null {
  const { change, issueIds, facts, names } = input;
  const n = issueIds.length;
  const move = change.patch.move;
  const rows = issueIds
    .map((id) => facts[id])
    .filter((row): row is IssueRowFacts => row !== undefined);
  const leaving =
    move === undefined
      ? []
      : rows.filter((row) => row.projectId !== move.projectId);
  if (n < BULK_CONFIRM_AT && !(input.drag && leaving.length > 0)) return null;
  const what = n === 1 ? (rows[0]?.identifier ?? '1 issue') : `${n} issues`;
  const tail =
    n === 1
      ? 'This changes it in Linear, as you.'
      : 'This changes them in Linear, as you.';
  if (move === undefined) {
    // "High priority", but "no priority" (never "No priority priority"),
    // as the done toast words it.
    const value =
      changeKind(change.patch) !== 'priority'
        ? change.label
        : change.patch.priority === 0
          ? 'no priority'
          : `${change.label} priority`;
    return {
      message: `Set ${what} to ${value}? ${tail}`,
      confirmLabel: `Set ${what}`,
    };
  }
  const parts = [`Move ${what} to ${change.label}?`];
  if (leaving.length > 0) {
    const from = nameList([
      ...new Set(
        leaving.map((row) =>
          row.projectId === null
            ? 'no project'
            : (names.project(row.projectId) ?? 'another project')
        )
      ),
    ]);
    const to =
      move.projectId === null
        ? null
        : (names.project(move.projectId) ?? 'the new project');
    const subject =
      n === 1
        ? 'It'
        : leaving.length === n
          ? 'All of them'
          : `${leaving.length} of them`;
    const verb = n === 1 || leaving.length === 1 ? 'moves' : 'move';
    parts.push(
      to === null
        ? `${subject} ${n === 1 || leaving.length === 1 ? 'leaves' : 'leave'} ${from}.`
        : `${subject} ${verb} from ${from} to ${to}.`
    );
  }
  if (move.projectId !== null) {
    const teamIds = names.projectTeamIds(move.projectId);
    if (teamIds !== undefined) {
      const outside = rows.filter((row) => !teamIds.includes(row.teamId));
      const teams = [...new Set(outside.map((row) => row.teamId))];
      if (outside.length > 0) {
        const teamNames = teams
          .map((id) => names.team(id) ?? 'another team')
          .join(' and ');
        const project = names.project(move.projectId) ?? 'The project';
        parts.push(
          `${outside.length === 1 ? '1 is' : `${outside.length} are`} in ${teamNames}, which ${project} does not include.`
        );
      }
    }
  }
  parts.push(tail);
  return { message: parts.join(' '), confirmLabel: `Move ${what}` };
}

// ---------------------------------------------------------------------------
// Pending rows
// ---------------------------------------------------------------------------

/** The values a pending row shows at once, and its note. */
export interface RowOverlay {
  values: Partial<
    Pick<
      TaskRowData,
      | 'milestone'
      | 'milestoneProject'
      | 'assignee'
      | 'assigneeTone'
      | 'unassignedLabel'
      | 'state'
      | 'stateKind'
      | 'priority'
      | 'priorityLabel'
    >
  >;
  /** "Moving to Garnet mobile app › Push notifications…", "Saving…". */
  note: string;
}

/** What a row shows while `change` is in flight: the new value in its cell
    and the note ("Moving to Push notifications…", "Saving…"); it stays
    where it is until the server places it. */
export function rowOverlay(change: IssueChange): RowOverlay {
  const patch = change.patch;
  const values: RowOverlay['values'] = {};
  if (patch.move !== undefined) {
    // The milestone's name alone while pending (the server names its
    // project again once the row is placed).
    values.milestone =
      patch.move.projectId === null || patch.move.milestoneId === null
        ? null
        : (change.short ?? change.label);
    values.milestoneProject = undefined;
  }
  if (patch.assigneeId !== undefined) {
    values.assignee = patch.assigneeId === null ? null : change.label;
    // In flight, no hue (the neutral hatch): a plain "Unassigned".
    values.assigneeTone = undefined;
    values.unassignedLabel = undefined;
  }
  if (patch.state !== undefined) {
    values.state = patch.state.name;
    values.stateKind = patch.state.type;
  }
  if (patch.priority !== undefined) {
    values.priority = patch.priority;
    values.priorityLabel = PRIORITY_LABEL[patch.priority];
  }
  return {
    values,
    note:
      patch.move !== undefined
        ? `Moving to ${change.short ?? change.label}…`
        : 'Saving…',
  };
}

/**
 * Whether an issue, once `change` is applied, no longer passes the view's
 * filters on the fields the change sets (project, milestone, initiative,
 * assignee, status type, priority): the toast says how many left the
 * view. Quick filters are not judged here (the server decides those).
 */
export function leavesFilters(
  query: IssueListQuery,
  facts: IssueRowFacts,
  patch: IssueBulkPatch,
  context: {
    viewerId: string;
    /** A project's first initiative (undefined when unknown). */
    homeInitiative: (projectId: string) => string | null | undefined;
  }
): boolean {
  const { filters } = query;
  if (patch.move !== undefined) {
    const { projectId, milestoneId } = patch.move;
    if (
      filters.projectIds.length > 0 &&
      !filters.projectIds.includes(projectId ?? LIST_NONE)
    ) {
      return true;
    }
    if (
      filters.milestoneIds.length > 0 &&
      !filters.milestoneIds.includes(milestoneId ?? LIST_NONE)
    ) {
      return true;
    }
    if (filters.initiativeIds.length > 0) {
      if (projectId === null) return true;
      const home = context.homeInitiative(projectId);
      if (
        home !== undefined &&
        !filters.initiativeIds.includes(home ?? LIST_NONE)
      ) {
        return true;
      }
    }
  }
  if (patch.assigneeId !== undefined && filters.assigneeIds.length > 0) {
    const wanted = filters.assigneeIds.map((id) =>
      id === LIST_ME ? context.viewerId : id
    );
    if (!wanted.includes(patch.assigneeId ?? LIST_NONE)) return true;
  }
  if (
    patch.priority !== undefined &&
    filters.priorities.length > 0 &&
    !filters.priorities.includes(patch.priority)
  ) {
    return true;
  }
  if (
    patch.state !== undefined &&
    !filters.stateTypes.includes(patch.state.type)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/** A toast as plain data: the island turns `action` into a button. */
export interface MoveToastModel {
  kind: 'info' | 'error';
  label: string;
  message: string;
  /** undo: send undoRequests; select: select the rows not changed. */
  action: 'undo' | 'select' | null;
  duration: number;
}

// "ENG-12" for one issue, "3 issues" for more.
function issuesPhrase(
  count: number,
  identifiers: readonly (string | null)[]
): string {
  if (count === 1) return identifiers[0] ?? '1 issue';
  return `${count} issues`;
}

// The sentence of an all-changed bulk result: "Moved 2 issues to …".
function doneSentence(change: IssueChange, what: string): string {
  const patch = change.patch;
  switch (changeKind(patch)) {
    case 'move':
      return `Moved ${what} to ${change.label}.`;
    case 'assignee':
      return patch.assigneeId === null
        ? `Unassigned ${what}.`
        : `Assigned ${what} to ${change.label}.`;
    case 'state':
      return `Set ${what} to ${change.label}.`;
    case 'priority':
      return patch.priority === 0
        ? `Set ${what} to no priority.`
        : `Set ${what} to ${change.label} priority.`;
  }
}

// A message without its final period, to continue the sentence.
function clause(message: string): string {
  return message.replace(/[.\s]+$/u, '');
}

/** "3:05 PM" in `timeZone` (the browser's own when omitted). */
export function clockTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
}

/**
 * The allocation sentences after a change (the plan before and after,
 * §7.3): issues the next run now gives to a lead, and projects whose
 * allocation stopped. Empty when nothing moved for allocation.
 */
export function allocationSentences(
  allocation: IssueBulkResult['allocation'],
  changed: number
): string[] {
  const lines: string[] = [];
  for (const handed of allocation.handedOver) {
    const k = handed.issueIds.length;
    const subject =
      changed === 1 ? 'It is' : k === 1 ? '1 of them is' : `${k} of them are`;
    const object = k === 1 ? 'it' : 'them';
    lines.push(
      handed.live
        ? `${subject} unassigned in ${handed.projectName}’s next milestone: the next allocation run gives ${object} to ${handed.leadName}.`
        : `${subject} unassigned in ${handed.projectName}’s next milestone: a live allocation run would give ${object} to ${handed.leadName} (allocation is in dry run).`
    );
  }
  for (const stopped of allocation.stopped) {
    lines.push(
      `Allocation is stopped for ${stopped.projectName}: ${blockedReasonLine(stopped.reason, stopped.gaps)}.`
    );
  }
  return lines;
}

/**
 * The toast a bulk change ends with (one action per toast):
 * - every requested issue changed (some may already have had it): "Moved
 *   2 issues to Garnet mobile app › Push notifications." with Undo for 8 s,
 *   plus " 1 already had that.";
 * - nothing to do: "Nothing to change: the 3 issues already had that.";
 * - some not changed: "Partly saved · Changed 2 of 3 issues. 1 not changed:
 *   {Linear's or the planner's sentence} and 1 more." with Select them;
 * - a stop part-way: Linear's rate limit ("Try the rest after 3:05 PM.")
 *   or a rejected sign-in, with Select them;
 * then the allocation sentences and " 2 no longer match these filters."
 */
export function bulkResultToast(
  result: IssueBulkResult,
  change: IssueChange,
  context: { leftView?: number; timeZone?: string } = {}
): MoveToastModel {
  const { counts } = result;
  const requested =
    counts.changed + counts.unchanged + counts.skipped + counts.failed;
  const notChanged = result.outcomes.filter(
    (o) => o.status === 'failed' || o.status === 'skipped'
  );
  const extra = [
    ...allocationSentences(result.allocation, counts.changed),
    ...(context.leftView !== undefined && context.leftView > 0
      ? [
          `${context.leftView === 1 ? '1 no longer matches' : `${context.leftView} no longer match`} these filters.`,
        ]
      : []),
  ];
  const withExtra = (message: string) => [message, ...extra].join(' ');

  if (result.stopped !== null) {
    const message =
      result.stopped.code === 'rate_limited'
        ? `Linear’s rate limit: ${counts.changed} of ${requested} changed. ${
            result.stopped.retryAt === null
              ? 'Try the rest in a few minutes.'
              : `Try the rest after ${clockTime(result.stopped.retryAt, context.timeZone)}.`
          }`
        : result.stopped.code === 'read_only'
          ? `Your Linear API key only allows reading: ${counts.changed} of ${requested} changed. Connect a key with Write access to change the rest.`
          : `Linear stopped accepting your sign-in after ${counts.changed} of ${requested}. Sign in again, then retry the rest.`;
    return {
      kind: 'error',
      label: 'Partly saved',
      message: withExtra(message),
      action: 'select',
      duration: 12_000,
    };
  }

  if (notChanged.length > 0) {
    const first = notChanged[0];
    const firstMessage = first === undefined ? '' : clause(first.message);
    const more =
      notChanged.length > 1 ? ` and ${notChanged.length - 1} more` : '';
    return {
      kind: 'error',
      label: counts.changed === 0 ? 'Not saved' : 'Partly saved',
      message: withExtra(
        `Changed ${counts.changed} of ${requested} ${requested === 1 ? 'issue' : 'issues'}. ${notChanged.length} not changed: ${firstMessage}${more}.`
      ),
      action: 'select',
      duration: 12_000,
    };
  }

  if (counts.changed === 0) {
    const ids = result.outcomes.map((o) => o.identifier);
    return {
      kind: 'info',
      label: 'No change',
      message:
        requested === 1
          ? `Nothing to change: ${ids[0] ?? 'the issue'} already had that.`
          : `Nothing to change: the ${requested} issues already had that.`,
      action: null,
      duration: 4000,
    };
  }

  const changed = result.outcomes.filter((o) => o.status === 'changed');
  const what = issuesPhrase(
    changed.length,
    changed.map((o) => o.identifier)
  );
  const already =
    counts.unchanged > 0 ? ` ${counts.unchanged} already had that.` : '';
  return {
    kind: 'info',
    label: 'Saved',
    message: withExtra(`${doneSentence(change, what)}${already}`),
    action: 'undo',
    duration: UNDO_TOAST_MS,
  };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** One PATCH /api/issues of an Undo: issues that go back to one place. */
export interface UndoRequest {
  issueIds: string[];
  patch: IssueBulkPatch;
}

/**
 * Undo as requests: the changed issues grouped by their values before the
 * change, of every field the change set (a move by project and milestone,
 * the assignee, the priority, the status by type and name), so a change
 * of two fields goes back as one tuple per group. Sent one after another.
 * An issue whose status the planner could not name is left out of a
 * status undo.
 */
export function undoRequests(
  result: IssueBulkResult,
  patch: IssueBulkPatch
): UndoRequest[] {
  const groups = new Map<string, UndoRequest>();
  for (const outcome of result.outcomes) {
    if (outcome.status !== 'changed') continue;
    const before = outcome.before;
    const back: IssueBulkPatch = {};
    if (patch.move !== undefined) {
      back.move = {
        projectId: before.projectId,
        milestoneId: before.projectId === null ? null : before.milestoneId,
      };
    }
    if (patch.assigneeId !== undefined) back.assigneeId = before.assigneeId;
    if (patch.priority !== undefined) back.priority = before.priority;
    if (patch.state !== undefined && before.stateName.trim() !== '') {
      back.state = { type: before.stateType, name: before.stateName };
    }
    if (Object.keys(back).length === 0) continue;
    const key = JSON.stringify([
      back.move ?? null,
      back.assigneeId === undefined ? '~' : back.assigneeId,
      back.priority ?? null,
      back.state === undefined
        ? null
        : [back.state.type, stateNameKey(back.state.name)],
    ]);
    const found = groups.get(key);
    if (found === undefined) {
      groups.set(key, { issueIds: [outcome.issueId], patch: back });
    } else {
      found.issueIds.push(outcome.issueId);
    }
  }
  return [...groups.values()];
}

/**
 * The toast after Undo, over the answers of its requests: "Undone · 2
 * issues are back where they were." or "Undid 1 of 2: ENG-12 left the
 * planner; undo it in Linear." (an issue the change took out of the
 * planner, such as a closed issue moved to no project, cannot be put back
 * from here). `failure` is a refused request's sentence.
 */
export function undoResultToast(
  results: readonly IssueBulkResult[],
  requested: number,
  failure: string | null = null
): MoveToastModel {
  let back = 0;
  const problems: string[] = [];
  for (const result of results) {
    for (const outcome of result.outcomes) {
      if (outcome.status === 'changed' || outcome.status === 'unchanged') {
        back += 1;
      } else if (outcome.status === 'failed' && outcome.code === 'not_found') {
        problems.push(
          `${outcome.identifier ?? 'An issue'} left the planner; undo it in Linear`
        );
      } else {
        problems.push(clause(outcome.message));
      }
    }
  }
  if (failure !== null) problems.push(clause(failure));
  if (problems.length === 0 && back >= requested) {
    return {
      kind: 'info',
      label: 'Undone',
      message:
        requested === 1
          ? 'The issue is back where it was.'
          : `${requested} issues are back where they were.`,
      action: null,
      duration: 4000,
    };
  }
  const more = problems.length > 1 ? ` and ${problems.length - 1} more` : '';
  return {
    kind: 'error',
    label: 'Partly undone',
    message: `Undid ${back} of ${requested}: ${problems[0] ?? 'some issues were not changed back'}${more}.`,
    action: null,
    duration: 12_000,
  };
}

/**
 * The toast when a later request of an Undo is refused workspace_changed
 * after earlier ones went through. The tab cannot refresh to show those
 * rows back (refusalRefreshes: it shows a workspace the browser switched
 * away from), so its rows keep the values from before the Undo; the toast
 * says how many were undone all the same (undoResultToast, with the
 * refusal as the reason for the rest) and that a reload shows them. The
 * hook adds the refusal's Reload. Null when no request went through: the
 * refusal's own toast says everything then.
 */
export function staleUndoToast(
  results: readonly IssueBulkResult[],
  requested: number,
  refusalMessage: string
): MoveToastModel | null {
  if (results.length === 0) return null;
  const model = undoResultToast(results, requested, refusalMessage);
  return {
    ...model,
    message: `${model.message} The rows here still show the values from before the Undo until you reload.`,
    duration: 12_000,
  };
}

/**
 * Whether the Issues page refreshes after a bulk change or an Undo was
 * refused with `code`: never for 409 workspace_changed (this tab shows a
 * workspace the browser switched away from in another tab). A refresh
 * re-renders the layout too, so the tab would turn into the other
 * workspace without a reload, at the same address (Globex's ENG-1 where
 * Acme's was), and the next edit would land there; the refusal's toast
 * offers Reload instead (architecture §8.1 "Stale tabs"). Undo refreshes
 * on every other answer, since its earlier requests may have moved rows.
 */
export function refusalRefreshes(code: string | null): boolean {
  return code !== 'workspace_changed';
}

/** The issues of a result that were not changed (the toast's Select them). */
export function notChangedIds(result: IssueBulkResult): string[] {
  return result.outcomes
    .filter((o) => o.status === 'failed' || o.status === 'skipped')
    .map((o) => o.issueId);
}

/** A row's "Not moved · …" / "Not saved · …" note and its tone
    (architecture §8.2): always danger (red), whether Linear refused, the
    write failed or the issue was skipped (its team lacks the status, or a
    rate limit stopped the run before it), so "Not saved" is red wherever
    it appears, as in the error toast above the rows. */
export interface FailureNote {
  text: string;
  tone: 'danger';
}

/** "Not moved · …" / "Not saved · …": the note a row keeps when its change
    did not happen, by row id. */
export function failureNotes(
  result: IssueBulkResult,
  change: IssueChange
): Map<string, FailureNote> {
  const lead = change.patch.move !== undefined ? 'Not moved' : 'Not saved';
  const notes = new Map<string, FailureNote>();
  for (const outcome of result.outcomes) {
    if (outcome.status === 'failed' || outcome.status === 'skipped') {
      notes.set(outcome.issueId, {
        text: `${lead} · ${clause(outcome.message)}`,
        tone: 'danger',
      });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The milestone group's menu (its weight)
// ---------------------------------------------------------------------------

/** A milestone group's menu data: the milestone and its weight now. */
export interface MilestoneMenuData {
  milestoneId: string;
  name: string;
  weight: number | null;
}

/** What weight does (the spec's sentence, architecture §8.4). */
export const WEIGHT_HINT =
  'Weight changes only the order on screen, never which milestone is next.';

/** The menu's line about the weight (a disabled row, which wraps). */
export const WEIGHT_LINE = WEIGHT_HINT;

/** "Becomes 2", "Becomes −1" (U+2212, the typographic minus). */
function becomes(weight: number): string {
  return `Becomes ${weight < 0 ? `\u2212${-weight}` : weight}`;
}

/**
 * A milestone group's "…" menu: Raise weight, Lower weight, Clear weight
 * (only when set), each hinted with the weight it leaves, a line that
 * cannot be chosen saying the weight changes only the order (never which
 * milestone is next), then Open milestone (its timeline drawer, with the
 * exact number field). Raising stops at `max`, lowering at `min`.
 */
export function milestoneMenuOptions(
  menu: MilestoneMenuData,
  bounds: { min: number; max: number }
): PickerOption[] {
  const now = menu.weight ?? 0;
  const list: PickerOption[] = [
    {
      value: 'raise',
      label: 'Raise weight',
      hint: becomes(now + 1),
      disabled: now + 1 > bounds.max,
      group: 'Weight',
    },
    {
      value: 'lower',
      label: 'Lower weight',
      hint: becomes(now - 1),
      disabled: now - 1 < bounds.min,
      group: 'Weight',
    },
  ];
  if (menu.weight !== null) {
    list.push({ value: 'clear', label: 'Clear weight', group: 'Weight' });
  }
  list.push({
    value: 'about',
    label: WEIGHT_LINE,
    disabled: true,
    group: 'Weight',
  });
  list.push({ value: 'open', label: 'Open milestone', group: 'Milestone' });
  return list;
}

/** The weight a menu choice leaves (null = cleared); undefined for a
    choice that is not a weight change. */
export function weightAfter(
  choice: string,
  weight: number | null
): number | null | undefined {
  const now = weight ?? 0;
  if (choice === 'raise') return now + 1 === 0 ? null : now + 1;
  if (choice === 'lower') return now - 1 === 0 ? null : now - 1;
  if (choice === 'clear') return null;
  return undefined;
}

/** "Dual-write has weight 2 now." / "Dual-write has no weight now." */
export function weightToast(name: string, weight: number | null): string {
  return weight === null || weight === 0
    ? `${name} has no weight now.`
    : `${name} has weight ${weight} now.`;
}

// ---------------------------------------------------------------------------
// The row menu
// ---------------------------------------------------------------------------

/** The row "…" menu's stages: the actions, then one picker per field. */
export type RowMenuStage = 'menu' | 'move' | 'assign' | 'status' | 'priority';

/** The read-only items' values. */
export type RowMenuAction =
  | 'open'
  | 'chain'
  | 'page'
  | 'linear'
  | 'copy'
  | Exclude<RowMenuStage, 'menu'>;

/**
 * A row's "…" menu: Open (↵); the edits (Move to milestone… M, Assign
 * to… A, Status… S, Priority… P), headed "{n} selected issues" when they
 * act on a selection, disabled with "Needs Linear write access" without
 * the grant, left out for a guest; Blocking chain (only when the issue
 * blocks or waits on something: its own chain graph); Open issue page;
 * Open in Linear ↗; Copy link.
 */
export function rowMenuOptions(input: {
  facts: IssueRowFacts | undefined;
  readOnly: boolean;
  canWriteLinear: boolean;
  /** How many issues the edits act on (the selection, or 1). */
  targets: number;
}): PickerOption[] {
  const list: PickerOption[] = [{ value: 'open', label: 'Open', hint: '↵' }];
  if (!input.readOnly) {
    const disabled = !input.canWriteLinear;
    const group =
      input.targets > 1 ? `${input.targets} selected issues` : 'Change';
    const edit = (value: RowMenuAction, label: string, key: string) =>
      list.push({
        value,
        label,
        hint: disabled ? 'Needs Linear write access' : key,
        disabled,
        group,
      });
    edit('move', 'Move to milestone…', 'M');
    edit('assign', 'Assign to…', 'A');
    edit('status', 'Status…', 'S');
    edit('priority', 'Priority…', 'P');
  }
  if (input.facts?.related === true) {
    list.push({ value: 'chain', label: 'Blocking chain', group: 'Go to' });
  }
  list.push({ value: 'page', label: 'Open issue page', group: 'Go to' });
  list.push({ value: 'linear', label: 'Open in Linear ↗', group: 'Go to' });
  list.push({ value: 'copy', label: 'Copy link', group: 'Go to' });
  return list;
}

/**
 * The status picker of one issue (its cell, or the row menu for one
 * issue): its own team's statuses in Linear's order. Values: state ids.
 */
export function teamStateChoices(
  options: IssueListOptions | null,
  teamId: string
): { id: string; name: string; kind: WorkflowStateType }[] {
  const team = options?.teams.find((t) => t.id === teamId);
  return (team?.states ?? []).map((state) => ({
    id: state.id,
    name: state.name,
    kind: state.type,
  }));
}

/** The people one issue can be assigned to (active, non-app). */
export function assignablePeople(
  options: IssueListOptions | null
): { id: string; name: string; keywords: string[] }[] {
  return (options?.people ?? [])
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, name: p.name, keywords: [p.displayName] }));
}
