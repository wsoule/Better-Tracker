// PM edits (§7, §7.1). Linear writes (milestone target date, project lead)
// go through the signed-in PM's own token so Linear attributes them to the
// person; tool-owned writes (weight, "done means…") go to milestone meta.
// Every edit is validated against the mirror, patches the mirror with what
// Linear returned, and appends an audit entry with before/after.

import {
  type IsoDate,
  isValidIsoDate,
  type Milestone,
  type MilestoneMeta,
  type Project,
  type Snapshot,
} from '@better-tracker/core';

import { requirePm, requireWriteScope } from './permissions';
import { type EngineRuntime, requireInstallation } from './runtime';
import { type Actor, EngineInputError } from './types';

/** Inclusive bounds of the display weight override (§7.1). */
export const WEIGHT_MIN = -1000;
export const WEIGHT_MAX = 1000;
// Any line break, including the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** Longest accepted "done means…" text, in characters (§7.1). */
export const DONE_MEANS_MAX_LENGTH = 280;

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

// User-perceived characters (an emoji with modifiers counts once), so the
// length limit matches what the person typed.
function characterCount(text: string): number {
  return Array.from(GRAPHEMES.segment(text)).length;
}

function invalid(message: string): EngineInputError {
  return new EngineInputError('invalid', message);
}

// The actor's workspace snapshot. The workspace must still have an active
// installation (an uninstalled app must not keep writing to Linear or
// changing its data), and a conflict when it was never synced.
async function snapshotFor(rt: EngineRuntime, actor: Actor): Promise<Snapshot> {
  await requireInstallation(rt, actor.session.workspaceId);
  const view = await rt.mirror.current(actor.session.workspaceId);
  if (view === null) {
    throw new EngineInputError(
      'conflict',
      'The workspace has not been synced from Linear yet.'
    );
  }
  return view.snapshot;
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
 * Validates a "done means…" text: trimmed, one line, at most
 * DONE_MEANS_MAX_LENGTH characters; empty (or null) clears it.
 */
export function normalizeDoneMeans(text: unknown): string | null {
  if (text === null) return null;
  if (typeof text !== 'string') throw invalid('"Done means…" must be text.');
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (LINE_BREAK.test(trimmed)) {
    throw invalid('"Done means…" must be a single line.');
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

/** Moves a milestone's target date in Linear (as the PM). */
export async function setMilestoneTargetDate(
  rt: EngineRuntime,
  actor: Actor,
  milestoneId: string,
  targetDate: IsoDate | null
): Promise<void> {
  requirePm(actor);
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
  const updated = await gateway.updateMilestoneTargetDate(
    milestoneId,
    targetDate
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

/** Sets or clears a project's lead in Linear (as the PM). */
export async function setProjectLead(
  rt: EngineRuntime,
  actor: Actor,
  projectId: string,
  leadId: string | null
): Promise<void> {
  requirePm(actor);
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
  const updated = await gateway.updateProjectLead(projectId, leadId);
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
// Unchanged values write nothing (no audit noise). The store upserts the
// whole row, so edits of one milestone run one at a time: a weight and a
// "done means…" saved together must not overwrite each other.
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

// The read-modify-write behind updateMeta (run under its per-milestone key).
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
  const next: MilestoneMeta = {
    milestoneId,
    weight: existing?.weight ?? null,
    doneMeans: existing?.doneMeans ?? null,
    updatedAt: rt.nowIso(),
    updatedBy: actor.session.userId,
  };
  const before = next[change.field];
  if (before === change.value) return;
  if (change.field === 'weight') next.weight = change.value;
  else next.doneMeans = change.value;
  await rt.store.upsertMilestoneMeta(workspaceId, next);
  await rt.store.appendAudit({
    workspaceId,
    actorUserId: actor.session.userId,
    action:
      change.field === 'weight' ? 'milestone.weight' : 'milestone.done_means',
    subjectId: milestoneId,
    before,
    after: change.value,
    at: next.updatedAt,
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
  requirePm(actor);
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
  requirePm(actor);
  await updateMeta(rt, actor, milestoneId, {
    field: 'doneMeans',
    value: normalizeDoneMeans(text),
  });
}
