// Milestone and project edits (§7, §7.1), open to every signed-in person
// since the owner decision of 2026-10-22 (there is no PM role) but a
// read-only one (a Linear guest), whom engine.ts refuses first. Linear
// writes (milestone target date, project lead) go through the person's own
// token, so they need write scope and Linear attributes them to the person;
// tool-owned writes (weight, "done means…") go to milestone meta and need
// only a session. Every edit is validated against the mirror, patches the
// mirror with what Linear returned, and appends an audit entry with
// before/after (the audit log is how everyone sees who changed what).

import {
  type IsoDate,
  isValidIsoDate,
  type Milestone,
  type Project,
  type Snapshot,
} from '@better-tracker/core';

import { linearWrite } from './linear-errors';
import { requireWriteScope } from './permissions';
import { type EngineRuntime, requireInstallation } from './runtime';
import { type Actor, EngineInputError } from './types';
import { viewerSnapshot } from './visibility';

/** Inclusive bounds of the display weight override (§7.1). */
export const WEIGHT_MIN = -1000;
export const WEIGHT_MAX = 1000;
// Any line break, including the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * True when text holds a control character other than tab: C0 (U+0000 to
 * U+001F, line breaks included) or DEL (U+007F). People never mean to type
 * them; Postgres refuses U+0000 in text, and a title made of them reads
 * as blank. Callers check line breaks first for their own message.
 */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/** Longest accepted "done means…" text, in characters (§7.1). */
export const DONE_MEANS_MAX_LENGTH = 280;

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * User-perceived characters (an emoji with modifiers counts once), so a
 * length limit matches what the person typed. Shared with issue edits.
 */
export function characterCount(text: string): number {
  return Array.from(GRAPHEMES.segment(text)).length;
}

function invalid(message: string): EngineInputError {
  return new EngineInputError('invalid', message);
}

/**
 * The workspace snapshots for an edit by `actor`: `visible`, the mirror
 * narrowed to what they may see (§2.13), which every lookup and validation
 * uses (an entity of a team they cannot see reads as not found), and
 * `full`, the whole mirror, for deciding what a write changes in it. The
 * workspace must still have an active installation (an uninstalled app
 * must not keep writing to Linear or changing its data), and a conflict
 * when it was never synced. Shared with the issue edits (issue-edits.ts).
 */
export async function snapshotsFor(
  rt: EngineRuntime,
  actor: Actor
): Promise<{ full: Snapshot; visible: Snapshot }> {
  const workspaceId = actor.session.workspaceId;
  await requireInstallation(rt, workspaceId);
  const view = await rt.mirror.current(workspaceId);
  if (view === null) {
    throw new EngineInputError(
      'conflict',
      'The workspace has not been synced from Linear yet.'
    );
  }
  return {
    full: view.snapshot,
    visible: viewerSnapshot(view.snapshot, workspaceId, actor).snapshot,
  };
}

/** The mirror narrowed to what `actor` may see (snapshotsFor's `visible`). */
export async function snapshotFor(
  rt: EngineRuntime,
  actor: Actor
): Promise<Snapshot> {
  return (await snapshotsFor(rt, actor)).visible;
}

function findMilestone(snapshot: Snapshot, milestoneId: unknown): Milestone {
  const milestone =
    typeof milestoneId === 'string'
      ? snapshot.milestones.get(milestoneId)
      : undefined;
  if (milestone === undefined) {
    throw new EngineInputError(
      'not_found',
      'That milestone is not in the mirror.'
    );
  }
  return milestone;
}

function findProject(snapshot: Snapshot, projectId: unknown): Project {
  const project =
    typeof projectId === 'string'
      ? snapshot.projects.get(projectId)
      : undefined;
  if (project === undefined) {
    throw new EngineInputError(
      'not_found',
      'That project is not in the mirror.'
    );
  }
  return project;
}

/**
 * Validates a "done means…" text: trimmed, one line, no control
 * characters (tab aside), at most DONE_MEANS_MAX_LENGTH characters; empty
 * (or null) clears it.
 */
export function normalizeDoneMeans(text: unknown): string | null {
  if (text === null) return null;
  if (typeof text !== 'string') throw invalid('"Done means…" must be text.');
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (LINE_BREAK.test(trimmed)) {
    throw invalid('"Done means…" must be a single line.');
  }
  if (hasControlCharacter(trimmed)) {
    throw invalid('"Done means…" cannot contain control characters.');
  }
  if (characterCount(trimmed) > DONE_MEANS_MAX_LENGTH) {
    throw invalid(
      `"Done means…" must be at most ${DONE_MEANS_MAX_LENGTH} characters.`
    );
  }
  return trimmed;
}

/** Validates a weight override: an integer in [WEIGHT_MIN, WEIGHT_MAX] or null. */
export function normalizeWeight(weight: unknown): number | null {
  if (weight === null) return null;
  if (
    typeof weight !== 'number' ||
    !Number.isInteger(weight) ||
    weight < WEIGHT_MIN ||
    weight > WEIGHT_MAX
  ) {
    throw invalid(
      `Weight must be a whole number from ${WEIGHT_MIN} to ${WEIGHT_MAX}, or empty.`
    );
  }
  // Normalise -0 so it reads back as 0.
  return weight === 0 ? 0 : weight;
}

/** Moves a milestone's target date in Linear (as the signed-in person). */
export async function setMilestoneTargetDate(
  rt: EngineRuntime,
  actor: Actor,
  milestoneId: string,
  targetDate: IsoDate | null
): Promise<void> {
  requireWriteScope(actor);
  if (
    targetDate !== null &&
    (typeof targetDate !== 'string' || !isValidIsoDate(targetDate))
  ) {
    throw invalid('Target date must be a calendar date (YYYY-MM-DD) or empty.');
  }
  const workspaceId = actor.session.workspaceId;
  const before = findMilestone(await snapshotFor(rt, actor), milestoneId);
  if (before.targetDate === targetDate) return;

  const gateway = await rt.linear.forSession(actor.session);
  // Linear's refusals map like issue edits' (§7.2): forbidden → 403,
  // a rejected token → sign in again, rate limit → 429.
  const updated = await linearWrite('change the milestone date', () =>
    gateway.updateMilestoneTargetDate(milestoneId, targetDate)
  );
  await rt.store.applyMirrorChanges(workspaceId, {
    upsert: [{ kind: 'milestone', entity: updated }],
    remove: [],
  });
  await rt.store.appendAudit({
    workspaceId,
    actorUserId: actor.session.userId,
    action: 'milestone.target_date',
    subjectId: milestoneId,
    before: before.targetDate,
    after: updated.targetDate,
    at: rt.nowIso(),
  });
  rt.logger.info('milestone target date changed', {
    workspaceId,
    userId: actor.session.userId,
    milestoneId,
    before: before.targetDate,
    after: updated.targetDate,
  });
}

/** Sets or clears a project's lead in Linear (as the signed-in person). */
export async function setProjectLead(
  rt: EngineRuntime,
  actor: Actor,
  projectId: string,
  leadId: string | null
): Promise<void> {
  requireWriteScope(actor);
  const workspaceId = actor.session.workspaceId;
  const snapshot = await snapshotFor(rt, actor);
  const before = findProject(snapshot, projectId);
  if (leadId !== null) {
    const lead =
      typeof leadId === 'string' ? snapshot.users.get(leadId) : undefined;
    if (lead === undefined) throw invalid('The lead must be a Linear user.');
    if (lead.app) throw invalid(`${lead.name} is an app, not a person.`);
    if (!lead.active) throw invalid(`${lead.name} is deactivated in Linear.`);
  }
  if (before.leadId === leadId) return;

  const gateway = await rt.linear.forSession(actor.session);
  const updated = await linearWrite('change the project lead', () =>
    gateway.updateProjectLead(projectId, leadId)
  );
  await rt.store.applyMirrorChanges(workspaceId, {
    upsert: [{ kind: 'project', entity: updated }],
    remove: [],
  });
  await rt.store.appendAudit({
    workspaceId,
    actorUserId: actor.session.userId,
    action: 'project.lead',
    subjectId: projectId,
    before: before.leadId,
    after: updated.leadId,
    at: rt.nowIso(),
  });
  rt.logger.info('project lead changed', {
    workspaceId,
    userId: actor.session.userId,
    projectId,
    before: before.leadId,
    after: updated.leadId,
  });
}

/** One tool-owned milestone field and its new value. */
type MetaChange =
  | { field: 'weight'; value: number | null }
  | { field: 'doneMeans'; value: string | null };

// Writes one tool-owned field of a milestone's meta, keeping the other.
// Unchanged values write nothing (no audit noise). The store writes only
// that column, so a weight and a "done means…" saved at the same time, even
// by two web instances, both stick. Edits of one milestone still run one
// at a time in this process so each audit entry's "before" is the value
// the previous edit left.
async function updateMeta(
  rt: EngineRuntime,
  actor: Actor,
  milestoneId: string,
  change: MetaChange
): Promise<void> {
  const workspaceId = actor.session.workspaceId;
  findMilestone(await snapshotFor(rt, actor), milestoneId);
  await rt.serialize(`meta\u0000${workspaceId}\u0000${milestoneId}`, () =>
    writeMeta(rt, actor, milestoneId, change)
  );
}

// Reads the current value (for the unchanged check and the audit's
// "before"), then writes just the changed field.
async function writeMeta(
  rt: EngineRuntime,
  actor: Actor,
  milestoneId: string,
  change: MetaChange
): Promise<void> {
  const workspaceId = actor.session.workspaceId;
  const existing = (await rt.store.listMilestoneMeta(workspaceId)).find(
    (meta) => meta.milestoneId === milestoneId
  );
  const before = existing?.[change.field] ?? null;
  if (before === change.value) return;
  const at = rt.nowIso();
  await rt.store.updateMilestoneMetaField(
    workspaceId,
    milestoneId,
    change.field,
    change.value,
    actor.session.userId,
    at
  );
  await rt.store.appendAudit({
    workspaceId,
    actorUserId: actor.session.userId,
    action:
      change.field === 'weight' ? 'milestone.weight' : 'milestone.done_means',
    subjectId: milestoneId,
    before,
    after: change.value,
    at,
  });
  rt.logger.info('milestone meta changed', {
    workspaceId,
    userId: actor.session.userId,
    milestoneId,
    field: change.field,
  });
}

/** Sets or clears a milestone's display weight override (tool-owned). */
export async function setMilestoneWeight(
  rt: EngineRuntime,
  actor: Actor,
  milestoneId: string,
  weight: number | null
): Promise<void> {
  await updateMeta(rt, actor, milestoneId, {
    field: 'weight',
    value: normalizeWeight(weight),
  });
}

/** Sets or clears a milestone's "done means…" (tool-owned). */
export async function setMilestoneDoneMeans(
  rt: EngineRuntime,
  actor: Actor,
  milestoneId: string,
  text: string | null
): Promise<void> {
  await updateMeta(rt, actor, milestoneId, {
    field: 'doneMeans',
    value: normalizeDoneMeans(text),
  });
}
