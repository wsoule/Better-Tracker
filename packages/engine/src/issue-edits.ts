// A person's own issue edits (owner decision 2026-10-21): fields, comments
// and blocking relations. A read-only person (a Linear guest) is refused
// first, in engine.ts. Every write needs actor.canWriteLinear (any
// signed-in person but a guest who granted write), is validated before
// Linear is called (the mirror, plus the team's live labels and estimate
// scale), goes to Linear with that person's token so Linear's permissions
// apply and its history credits them, patches the mirror at once (the
// store bumps the mirror version, so the next page render shows it) and
// appends one audit entry per changed field. The planner's only automatic
// write stays allocation (allocation-run.ts).

import {
  COMMENT_MAX_LENGTH,
  containsLinearCredential,
  elapsedMs,
  estimateLabel,
  type IsoDateTime,
  isAllowedEstimate,
  ISSUE_DESCRIPTION_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
  isValidIsoDate,
  type BlockingRelation,
  type Issue,
  type IssueComment,
  type IssueExtras,
  type IssueLabel,
  type IssuePatch,
  type IssuePatchField,
  introducesLinearCredential,
  type Snapshot,
} from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type {
  AuditEntry,
  MirrorEntity,
  MirrorRef,
} from '@better-tracker/store';

import {
  engineErrorFromLinear,
  isLinearApiError,
  linearWrite,
} from './linear-errors';
import {
  characterCount,
  hasControlCharacter,
  snapshotFor,
  snapshotsFor,
} from './milestone-edits';
import { requireWriteScope } from './permissions';
import { type EngineRuntime } from './runtime';
import { type Actor, EngineInputError, type IssueUpdateResult } from './types';
import { keepsLooseIssue, relationRefsTouching } from './webhooks';

// Any line break, including the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** api_key mode refuses newly typed key-shaped text before Linear (§7.12). */
export const KEY_TEXT_MESSAGE =
  'That looks like a Linear API key; it was not sent.';

// api_key mode only (security S14): a key pasted into the wrong field is
// refused before it reaches Linear. Only a newly typed run counts, so an
// existing text that already quotes one can still be edited.
function refuseNewKeyText(
  rt: EngineRuntime,
  previous: string | null,
  next: string | null | undefined
): void {
  if (rt.config.auth !== 'api_key' || typeof next !== 'string') return;
  if (introducesLinearCredential(previous, next)) {
    throw new EngineInputError('invalid', KEY_TEXT_MESSAGE);
  }
}

/**
 * The patch fields in the order they are validated, written and audited
 * (shared with the bulk edits, bulk-issue-edits.ts).
 */
export const PATCH_FIELDS: readonly IssuePatchField[] = [
  'title',
  'description',
  'stateId',
  'assigneeId',
  'priority',
  'projectId',
  'projectMilestoneId',
  'dueDate',
  'estimate',
  'labelIds',
];

/** The audit action per field (shared with the bulk edits). */
export const AUDIT_ACTION: Readonly<
  Record<IssuePatchField, AuditEntry['action']>
> = {
  title: 'issue.title',
  description: 'issue.description',
  stateId: 'issue.state',
  assigneeId: 'issue.assignee',
  priority: 'issue.priority',
  projectId: 'issue.project',
  projectMilestoneId: 'issue.milestone',
  dueDate: 'issue.due_date',
  estimate: 'issue.estimate',
  labelIds: 'issue.labels',
};

/** The fields the mirror does not keep; their current values are read live. */
const LIVE_FIELDS: ReadonlySet<IssuePatchField> = new Set([
  'description',
  'dueDate',
  'estimate',
  'labelIds',
]);

function invalid(message: string): EngineInputError {
  return new EngineInputError('invalid', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A description or comment as the audit log keeps it: its length in
 * characters, none of its words. Settings → Audit is open to every
 * signed-in person, while these texts are read with each person's own
 * token so Linear's permissions decide who sees them (and an excerpt of a
 * short comment would be all of it). Null stays null.
 */
export function textSummary(text: string | null): { length: number } | null {
  if (text === null) return null;
  return { length: characterCount(text) };
}

/**
 * Checks the shape and simple limits of an edit, before anything is read:
 * a plain object with only IssuePatch keys and at least one value; title
 * trimmed, one line, 1–ISSUE_TITLE_MAX_LENGTH characters; description at
 * most ISSUE_DESCRIPTION_MAX_LENGTH (blank → null); ids as strings (null
 * where the field may be empty); priority an integer 0–4; due date a
 * calendar date or null; estimate a non-negative integer or null; label
 * ids a list of strings (duplicates dropped). Returns the normalised patch.
 */
export function normalizeIssuePatch(raw: unknown): IssuePatch {
  if (!isPlainObject(raw)) throw invalid('The edit must be an object.');
  for (const key of Object.keys(raw)) {
    if (!(PATCH_FIELDS as readonly string[]).includes(key)) {
      throw invalid(`Unknown issue field: ${key}.`);
    }
  }
  const patch: IssuePatch = {};
  const value = (key: IssuePatchField): unknown => raw[key];
  const present = (key: IssuePatchField): boolean => value(key) !== undefined;
  const idOrNull = (key: IssuePatchField, label: string): string | null => {
    const v = value(key);
    if (v === null) return null;
    if (typeof v !== 'string' || v === '') {
      throw invalid(`${label} must be an id, or empty.`);
    }
    return v;
  };

  if (present('title')) {
    const title = value('title');
    if (typeof title !== 'string') throw invalid('The title must be text.');
    const trimmed = title.trim();
    if (trimmed === '') throw invalid('The title cannot be empty.');
    if (LINE_BREAK.test(trimmed)) {
      throw invalid('The title must be a single line.');
    }
    if (hasControlCharacter(trimmed)) {
      throw invalid('The title cannot contain control characters.');
    }
    if (characterCount(trimmed) > ISSUE_TITLE_MAX_LENGTH) {
      throw invalid(
        `The title must be at most ${ISSUE_TITLE_MAX_LENGTH} characters.`
      );
    }
    patch.title = trimmed;
  }
  if (present('description')) {
    const description = value('description');
    if (description !== null && typeof description !== 'string') {
      throw invalid('The description must be text, or empty.');
    }
    if (
      typeof description === 'string' &&
      description.length > ISSUE_DESCRIPTION_MAX_LENGTH
    ) {
      throw invalid(
        `The description must be at most ${ISSUE_DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')} characters.`
      );
    }
    patch.description =
      description === null || description.trim() === '' ? null : description;
  }
  if (present('stateId')) {
    const stateId = value('stateId');
    if (typeof stateId !== 'string' || stateId === '') {
      throw invalid('The status must be a workflow state id.');
    }
    patch.stateId = stateId;
  }
  if (present('assigneeId')) {
    patch.assigneeId = idOrNull('assigneeId', 'The assignee');
  }
  if (present('priority')) {
    const priority = value('priority');
    if (
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 4
    ) {
      throw invalid(
        'Priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).'
      );
    }
    patch.priority = priority as IssuePatch['priority'];
  }
  if (present('projectId')) {
    patch.projectId = idOrNull('projectId', 'The project');
  }
  if (present('projectMilestoneId')) {
    patch.projectMilestoneId = idOrNull('projectMilestoneId', 'The milestone');
  }
  if (present('dueDate')) {
    const dueDate = value('dueDate');
    if (
      dueDate !== null &&
      (typeof dueDate !== 'string' || !isValidIsoDate(dueDate))
    ) {
      throw invalid(
        'The due date must be a calendar date (YYYY-MM-DD) or empty.'
      );
    }
    patch.dueDate = dueDate;
  }
  if (present('estimate')) {
    const estimate = value('estimate');
    if (
      estimate !== null &&
      (typeof estimate !== 'number' ||
        !Number.isInteger(estimate) ||
        estimate < 0)
    ) {
      throw invalid('The estimate must be a whole number, or empty.');
    }
    patch.estimate = estimate;
  }
  if (present('labelIds')) {
    const labelIds = value('labelIds');
    if (
      !Array.isArray(labelIds) ||
      !labelIds.every((id): id is string => typeof id === 'string' && id !== '')
    ) {
      throw invalid('Labels must be a list of label ids.');
    }
    patch.labelIds = [...new Set(labelIds)];
  }
  if (Object.keys(patch).length === 0) throw invalid('Nothing to change.');
  return patch;
}

/** The text of a new comment: trimmed, 1–COMMENT_MAX_LENGTH characters. */
export function normalizeCommentBody(body: unknown): string {
  if (typeof body !== 'string') throw invalid('The comment must be text.');
  const trimmed = body.trim();
  if (trimmed === '') throw invalid('The comment cannot be empty.');
  if (characterCount(trimmed) > COMMENT_MAX_LENGTH) {
    throw invalid(
      `The comment must be at most ${COMMENT_MAX_LENGTH.toLocaleString('en-US')} characters.`
    );
  }
  return trimmed;
}

function findIssue(
  snapshot: Snapshot,
  issueId: unknown,
  what = 'issue'
): Issue {
  const issue =
    typeof issueId === 'string' ? snapshot.issues.get(issueId) : undefined;
  if (issue === undefined) {
    throw new EngineInputError(
      'not_found',
      `That ${what} is not in the planner (it may be in a closed project, or in a team the app cannot see).`
    );
  }
  return issue;
}

/**
 * Checks the patch's ids against the mirror: a state of the issue's team,
 * an active person, a mirrored project, a milestone of the issue's
 * (possibly new) project. Moving to another project without naming a
 * milestone clears the old project's milestone. Returns the patch Linear
 * gets; throws EngineInputError('invalid'). Shared with the bulk edits.
 */
export function checkAgainstMirror(
  snapshot: Snapshot,
  issue: Issue,
  patch: IssuePatch
): IssuePatch {
  const linear: IssuePatch = { ...patch };
  if (patch.stateId !== undefined) {
    const state = snapshot.states.get(patch.stateId);
    if (state === undefined || state.teamId !== issue.teamId) {
      const team = snapshot.teams.get(issue.teamId);
      throw invalid(
        `That status is not in the ${team?.name ?? 'issue’s team'} workflow.`
      );
    }
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
    const person = snapshot.users.get(patch.assigneeId);
    if (person === undefined)
      throw invalid('The assignee must be a Linear user.');
    if (person.app) throw invalid(`${person.name} is an app, not a person.`);
    if (!person.active) {
      throw invalid(`${person.name} is deactivated in Linear.`);
    }
  }
  const projectId =
    patch.projectId === undefined ? issue.projectId : patch.projectId;
  if (patch.projectId !== undefined && patch.projectId !== null) {
    if (!snapshot.projects.has(patch.projectId)) {
      throw invalid(
        'That project is not in the planner (closed, or not visible to the app).'
      );
    }
  }
  if (
    patch.projectMilestoneId !== undefined &&
    patch.projectMilestoneId !== null
  ) {
    const milestone = snapshot.milestones.get(patch.projectMilestoneId);
    if (milestone === undefined) {
      throw invalid('That milestone is not in the planner.');
    }
    if (projectId === null) {
      throw invalid('An issue without a project cannot have a milestone.');
    }
    if (milestone.projectId !== projectId) {
      const project = snapshot.projects.get(projectId);
      throw invalid(
        `${milestone.name} is not a milestone of ${project?.name ?? 'that project'}.`
      );
    }
  }
  if (
    patch.projectId !== undefined &&
    patch.projectId !== issue.projectId &&
    patch.projectMilestoneId === undefined &&
    issue.milestoneId !== null
  ) {
    linear.projectMilestoneId = null;
  }
  return linear;
}

// Checks a label set against the team's usable labels and the ones the
// issue carries now (read live): every label must be one of them, and a
// single-select group may contribute only one. A carried label the team
// can no longer apply (archived: Linear keeps it on its issues but stops
// new uses, linear.app/docs/labels) may stay, since an edit sends the
// whole set back; it can be removed but never added anew.
function checkLabels(
  labelIds: readonly string[],
  usable: readonly IssueLabel[],
  carried: readonly IssueLabel[]
): IssueLabel[] {
  const byId = new Map(
    [...carried, ...usable].map((label) => [label.id, label])
  );
  const chosen: IssueLabel[] = [];
  const groups = new Map<string, string>();
  for (const id of labelIds) {
    const label = byId.get(id);
    if (label === undefined) {
      throw invalid("A label is not available on this issue's team.");
    }
    if (label.group?.singleSelect === true) {
      const other = groups.get(label.group.id);
      if (other !== undefined) {
        throw invalid(
          `Only one ${label.group.name} label can be applied (${other} or ${label.name}).`
        );
      }
      groups.set(label.group.id, label.name);
    }
    chosen.push(label);
  }
  return chosen;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** One field change with its audit values. */
interface FieldChange {
  field: IssuePatchField;
  before: unknown;
  after: unknown;
}

function labelRefs(
  labels: readonly IssueLabel[]
): { id: string; name: string }[] {
  return labels.map((label) => ({ id: label.id, name: label.name }));
}

// The changes the patch makes, in field order, with audit before/after
// values. `extras` holds the live values of description, due date,
// estimate and labels when the patch touches any of them.
function diffPatch(
  issue: Issue,
  patch: IssuePatch,
  extras: IssueExtras | null,
  chosenLabels: IssueLabel[] | null
): FieldChange[] {
  const changes: FieldChange[] = [];
  const add = (
    field: IssuePatchField,
    before: unknown,
    after: unknown
  ): void => {
    changes.push({ field, before, after });
  };
  for (const field of PATCH_FIELDS) {
    if (patch[field] === undefined) continue;
    switch (field) {
      case 'title':
        if (patch.title !== issue.title) add(field, issue.title, patch.title);
        break;
      case 'description': {
        const before = extras?.description ?? null;
        const after = patch.description ?? null;
        if (before !== after)
          add(field, textSummary(before), textSummary(after));
        break;
      }
      case 'stateId':
        if (patch.stateId !== issue.stateId) {
          add(field, issue.stateId, patch.stateId);
        }
        break;
      case 'assigneeId':
        if (patch.assigneeId !== issue.assigneeId) {
          add(field, issue.assigneeId, patch.assigneeId);
        }
        break;
      case 'priority':
        if (patch.priority !== issue.priority) {
          add(field, issue.priority, patch.priority);
        }
        break;
      case 'projectId':
        if (patch.projectId !== issue.projectId) {
          add(field, issue.projectId, patch.projectId);
        }
        break;
      case 'projectMilestoneId':
        if (patch.projectMilestoneId !== issue.milestoneId) {
          add(field, issue.milestoneId, patch.projectMilestoneId);
        }
        break;
      case 'dueDate': {
        const before = extras?.dueDate ?? null;
        if (patch.dueDate !== before) add(field, before, patch.dueDate);
        break;
      }
      case 'estimate': {
        const before = extras?.estimate ?? null;
        if (patch.estimate !== before) add(field, before, patch.estimate);
        break;
      }
      case 'labelIds': {
        const before = extras?.labels ?? [];
        const after = chosenLabels ?? [];
        if (
          !sameSet(
            before.map((label) => label.id),
            after.map((label) => label.id)
          )
        ) {
          add(field, labelRefs(before), labelRefs(after));
        }
        break;
      }
    }
  }
  return changes;
}

/** The later of two instants (the first when either does not parse). */
export function laterOf(a: IsoDateTime, b: IsoDateTime): IsoDateTime {
  return (elapsedMs(b, a) ?? 0) > 0 ? b : a;
}

/**
 * The mirror writes that keep `updated` exactly as a full sync would: an
 * issue moved out of every mirrored project while closed (or into a
 * project the mirror does not hold) leaves the mirror with its relations.
 * Shared with the bulk edits.
 */
export function issueMirrorChanges(
  snapshot: Snapshot,
  updated: Issue
): { upsert: MirrorEntity[]; remove: MirrorRef[] } {
  const keep =
    updated.projectId === null
      ? keepsLooseIssue(snapshot, updated)
      : snapshot.projects.has(updated.projectId);
  if (keep) return { upsert: [{ kind: 'issue', entity: updated }], remove: [] };
  return {
    upsert: [],
    remove: [
      { kind: 'issue', id: updated.id },
      ...relationRefsTouching(snapshot, updated.id),
    ],
  };
}

/**
 * Applies mirror changes after a Linear write. Linear already has the
 * change, so a failure here is logged, not thrown: the next sync heals it.
 * Shared with the bulk edits.
 */
export async function patchMirror(
  rt: EngineRuntime,
  workspaceId: string,
  changes: { upsert: MirrorEntity[]; remove: MirrorRef[] },
  log: Logger
): Promise<void> {
  try {
    await rt.store.applyMirrorChanges(workspaceId, changes);
  } catch (error) {
    log.warn('could not patch the mirror after an issue edit', { error });
  }
}

// After a relation write, re-reads both issues' relations through the app
// (the mirror's own view) and replaces every mirrored relation touching
// them, as an Issue webhook would. When that read fails the direct change
// is applied instead.
async function refreshRelations(
  rt: EngineRuntime,
  workspaceId: string,
  snapshot: Snapshot,
  issueIds: readonly string[],
  fallback: { upsert: MirrorEntity[]; remove: MirrorRef[] },
  log: Logger
): Promise<void> {
  let changes = fallback;
  try {
    const app = await rt.linear.forApp(workspaceId);
    const lists = await Promise.all(
      issueIds.map((id) => app.fetchIssueRelations(id))
    );
    const upsert = new Map<string, BlockingRelation>();
    for (const relation of lists.flat()) upsert.set(relation.id, relation);
    const remove = new Map<string, MirrorRef>();
    for (const id of issueIds) {
      for (const ref of relationRefsTouching(snapshot, id)) {
        remove.set(ref.id, ref);
      }
    }
    changes = {
      remove: [...remove.values()],
      upsert: [...upsert.values()].map((entity): MirrorEntity => ({
        kind: 'relation',
        entity,
      })),
    };
  } catch (error) {
    log.warn(
      'could not re-read relations after a relation edit; patching directly',
      {
        error,
      }
    );
  }
  await patchMirror(rt, workspaceId, changes, log);
}

async function audit(
  rt: EngineRuntime,
  actor: Actor,
  entries: {
    action: AuditEntry['action'];
    subjectId: string;
    before: unknown;
    after: unknown;
  }[]
): Promise<void> {
  const at = rt.nowIso();
  for (const entry of entries) {
    await rt.store.appendAudit({
      workspaceId: actor.session.workspaceId,
      actorUserId: actor.session.userId,
      action: entry.action,
      subjectId: entry.subjectId,
      before: entry.before,
      after: entry.after,
      at,
    });
  }
}

// The live fields an edit needs, read as the person: the extras (current
// values for the audit's "before" and the team's estimate scale) when a
// live field changes, and the team's labels when the label set does.
async function readLiveForEdit(
  gateway: LinearGateway,
  issue: Issue,
  patch: IssuePatch
): Promise<{ extras: IssueExtras | null; labels: IssueLabel[] | null }> {
  const needsExtras = PATCH_FIELDS.some(
    (field) => LIVE_FIELDS.has(field) && patch[field] !== undefined
  );
  const [extras, labels] = await Promise.all([
    needsExtras
      ? linearWrite('read the issue', () => gateway.fetchIssueDetail(issue.id))
      : Promise.resolve(null),
    patch.labelIds !== undefined
      ? linearWrite('read the labels', () =>
          gateway.listIssueLabels(issue.teamId)
        )
      : Promise.resolve(null),
  ]);
  if (needsExtras && extras === null) {
    throw new EngineInputError(
      'not_found',
      `Linear does not show ${issue.identifier} to your account: it is in a team you cannot see, or it was deleted or archived.`
    );
  }
  return { extras, labels };
}

/**
 * Edits one issue's fields as the person (see the file comment). No-op
 * values are dropped; when nothing changes, nothing is written. Edits of
 * one issue run one at a time in this process, so each audit "before" is
 * the value the previous edit left.
 */
export async function updateIssue(
  rt: EngineRuntime,
  actor: Actor,
  issueId: string,
  rawPatch: IssuePatch
): Promise<IssueUpdateResult> {
  requireWriteScope(actor);
  const patch = normalizeIssuePatch(rawPatch);
  const workspaceId = actor.session.workspaceId;
  const log = rt.logger.child({
    workspaceId,
    userId: actor.session.userId,
    issueId,
    op: 'issue_update',
  });
  return rt.serialize(`issue\u0000${workspaceId}\u0000${issueId}`, async () => {
    const { full, visible: snapshot } = await snapshotsFor(rt, actor);
    const issue = findIssue(snapshot, issueId);
    const linearPatch = checkAgainstMirror(snapshot, issue, patch);
    refuseNewKeyText(rt, issue.title, linearPatch.title);

    const gateway = await rt.linear.forSession(actor.session);
    const live = await readLiveForEdit(gateway, issue, linearPatch);
    refuseNewKeyText(
      rt,
      live.extras?.description ?? null,
      linearPatch.description
    );
    if (linearPatch.estimate !== undefined && linearPatch.estimate !== null) {
      const scale = live.extras?.estimateScale;
      if (scale === undefined || scale.type === 'notUsed') {
        throw invalid("This issue's team does not use estimates.");
      }
      if (!isAllowedEstimate(scale, linearPatch.estimate)) {
        throw invalid(
          `${estimateLabel(scale, linearPatch.estimate)} is not on this team's estimate scale.`
        );
      }
    }
    const chosenLabels =
      linearPatch.labelIds === undefined
        ? null
        : checkLabels(
            linearPatch.labelIds,
            live.labels ?? [],
            live.extras?.labels ?? []
          );

    const changes = diffPatch(issue, linearPatch, live.extras, chosenLabels);
    if (changes.length === 0) return { issue, changed: [] };
    const send: IssuePatch = {};
    for (const change of changes) {
      Object.assign(send, { [change.field]: linearPatch[change.field] });
    }

    const written = await linearWrite('update the issue', () =>
      gateway.updateIssueFields(issue.id, send)
    );
    // The mirror's lastStateChangeAt may be history-refined; a write that
    // did not move the state must not replace it with the approximation.
    const updated: Issue =
      send.stateId === undefined
        ? {
            ...written,
            lastStateChangeAt: laterOf(
              issue.lastStateChangeAt,
              written.lastStateChangeAt
            ),
          }
        : written;
    await patchMirror(rt, workspaceId, issueMirrorChanges(full, updated), log);
    await audit(
      rt,
      actor,
      changes.map((change) => ({
        action: AUDIT_ACTION[change.field],
        subjectId: issue.id,
        before: change.before,
        after: change.after,
      }))
    );
    const changed = changes.map((change) => change.field);
    log.info('issue edited', { identifier: issue.identifier, changed });
    return { issue: updated, changed };
  });
}

/** Adds a comment to an issue as the person; returns it as the page shows it. */
export async function addComment(
  rt: EngineRuntime,
  actor: Actor,
  issueId: string,
  body: string
): Promise<IssueComment> {
  requireWriteScope(actor);
  const text = normalizeCommentBody(body);
  if (rt.config.auth === 'api_key' && containsLinearCredential(text)) {
    throw new EngineInputError('invalid', KEY_TEXT_MESSAGE);
  }
  const snapshot = await snapshotFor(rt, actor);
  const issue = findIssue(snapshot, issueId);
  const gateway = await rt.linear.forSession(actor.session);
  const { id } = await linearWrite('add the comment', () =>
    gateway.createComment(issue.id, text)
  );
  const createdAt = rt.nowIso();
  await audit(rt, actor, [
    {
      action: 'issue.comment',
      subjectId: issue.id,
      before: null,
      after: { commentId: id, ...textSummary(text) },
    },
  ]);
  rt.logger.info('comment added', {
    workspaceId: actor.session.workspaceId,
    userId: actor.session.userId,
    issueId: issue.id,
    commentId: id,
  });
  return {
    id,
    body: text,
    createdAt,
    url: null,
    parentId: null,
    author: { id: actor.session.userId, name: actor.session.userName },
    externalAuthor: null,
  };
}

/**
 * Adds "blocker blocks issue" as the person. The blocker must be another
 * mirrored issue, and the relation must not exist yet (conflict).
 */
export async function addBlocker(
  rt: EngineRuntime,
  actor: Actor,
  issueId: string,
  blockerIssueId: string
): Promise<BlockingRelation> {
  requireWriteScope(actor);
  const workspaceId = actor.session.workspaceId;
  const log = rt.logger.child({
    workspaceId,
    userId: actor.session.userId,
    issueId,
    op: 'add_blocker',
  });
  return rt.serialize(
    `relations\u0000${workspaceId}\u0000${issueId}`,
    async () => {
      const { full, visible: snapshot } = await snapshotsFor(rt, actor);
      const issue = findIssue(snapshot, issueId);
      const blocker = findIssue(snapshot, blockerIssueId, 'blocking issue');
      if (blocker.id === issue.id)
        throw invalid('An issue cannot block itself.');
      const exists = snapshot.data.relations.some(
        (r) => r.blockerId === blocker.id && r.blockedId === issue.id
      );
      if (exists) {
        throw new EngineInputError(
          'conflict',
          `${blocker.identifier} already blocks ${issue.identifier}.`
        );
      }
      const gateway = await rt.linear.forSession(actor.session);
      const relation = await linearWrite('add the blocking relation', () =>
        gateway.createBlockingRelation(blocker.id, issue.id)
      );
      await refreshRelations(
        rt,
        workspaceId,
        full,
        [issue.id, blocker.id],
        { upsert: [{ kind: 'relation', entity: relation }], remove: [] },
        log
      );
      await audit(rt, actor, [
        {
          action: 'issue.blocker_added',
          subjectId: issue.id,
          before: null,
          after: {
            relationId: relation.id,
            blockerId: blocker.id,
            blockerIdentifier: blocker.identifier,
            blockedIdentifier: issue.identifier,
          },
        },
      ]);
      log.info('blocking relation added', {
        relationId: relation.id,
        blocker: blocker.identifier,
        blocked: issue.identifier,
      });
      return relation;
    }
  );
}

/**
 * Removes a blocks relation as the person. A relation Linear no longer
 * has counts as removed (the end state the person asked for).
 */
export async function removeRelation(
  rt: EngineRuntime,
  actor: Actor,
  relationId: string
): Promise<void> {
  requireWriteScope(actor);
  const workspaceId = actor.session.workspaceId;
  const { full, visible: snapshot } = await snapshotsFor(rt, actor);
  const relation =
    typeof relationId === 'string'
      ? snapshot.data.relations.find((r) => r.id === relationId)
      : undefined;
  if (relation === undefined) {
    throw new EngineInputError(
      'not_found',
      'That blocking relation is not in the planner.'
    );
  }
  const log = rt.logger.child({
    workspaceId,
    userId: actor.session.userId,
    relationId: relation.id,
    op: 'remove_relation',
  });
  const gateway = await rt.linear.forSession(actor.session);
  try {
    await gateway.deleteRelation(relation.id);
  } catch (error) {
    if (!isLinearApiError(error) || error.kind !== 'not_found') {
      throw engineErrorFromLinear(error, 'remove the relation');
    }
    log.info('relation already gone in Linear');
  }
  await refreshRelations(
    rt,
    workspaceId,
    full,
    [relation.blockedId, relation.blockerId],
    { upsert: [], remove: [{ kind: 'relation', id: relation.id }] },
    log
  );
  const blocker = snapshot.issues.get(relation.blockerId);
  const blocked = snapshot.issues.get(relation.blockedId);
  await audit(rt, actor, [
    {
      action: 'issue.relation_removed',
      subjectId: relation.blockedId,
      before: {
        relationId: relation.id,
        blockerId: relation.blockerId,
        blockedId: relation.blockedId,
        blockerIdentifier: blocker?.identifier ?? null,
        blockedIdentifier: blocked?.identifier ?? null,
      },
      after: null,
    },
  ]);
  log.info('blocking relation removed', {
    blocker: blocker?.identifier ?? relation.blockerId,
    blocked: blocked?.identifier ?? relation.blockedId,
  });
}
