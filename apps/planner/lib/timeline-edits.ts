import { isValidIsoDate } from '@better-tracker/core';
import {
  type Actor,
  DONE_MEANS_MAX_LENGTH,
  type Engine,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from '@better-tracker/engine';
import { z } from 'zod';

import { errorResponse, jsonError, readJson, refuseReadOnly } from './http';

// The timeline's milestone and lead edits as route handlers (§8.1):
// PATCH /api/milestones/[id] { targetDate?, weight?, doneMeans? } and
// PATCH /api/projects/[id] { leadId }. The app/api route files only pass
// their params and requireApiActor in; the handlers live here so tests can
// run them with a fake actor resolver and a recording engine (a route file
// may export nothing but its HTTP methods).
//
// Order: resolve the actor (CSRF guard + signed in) → the read-only check
// (403 read_only for a Linear guest; owner decision 2026-10-22, "Guests
// limited to read only") → validate the JSON body with zod → call the
// engine, which refuses a guest again and requires canWriteLinear for the
// two Linear writes (the target date and the lead, made with the person's
// own token) and re-validates everything → 200 { ok: true }, or the
// engine's error mapped by errorResponse. There is no role check (owner
// decision 2026-10-22): weight and "done means…" need only a session. A
// malformed body never reaches the engine.

/** What requireApiActor gives a route: the engine and actor, or a Response. */
export type ApiActorResolver<E> = (
  request: Request
) => Promise<{ engine: E; actor: Actor } | Response>;

export type MilestoneEditEngine = Pick<
  Engine,
  'setMilestoneTargetDate' | 'setMilestoneWeight' | 'setMilestoneDoneMeans'
>;

export type ProjectEditEngine = Pick<Engine, 'setProjectLead'>;

const isoDate = z.string().refine((value) => isValidIsoDate(value), {
  message: 'must be a calendar date (YYYY-MM-DD), or null to clear it',
});

/**
 * PATCH /api/milestones/[id] body: at least one field. The engine applies
 * the precise rules (weight range, one-line "done means…" of at most
 * DONE_MEANS_MAX_LENGTH characters); the length cap here only bounds the
 * payload, since characters are counted as graphemes there.
 */
export const milestonePatchSchema = z
  .strictObject({
    targetDate: isoDate.nullable().optional(),
    weight: z
      .number()
      .int({ message: 'must be a whole number, or null to clear it' })
      .min(WEIGHT_MIN, { message: `must be at least ${WEIGHT_MIN}` })
      .max(WEIGHT_MAX, { message: `must be at most ${WEIGHT_MAX}` })
      .nullable()
      .optional(),
    doneMeans: z
      .string()
      .max(DONE_MEANS_MAX_LENGTH * 8, {
        message: `must be at most ${DONE_MEANS_MAX_LENGTH} characters`,
      })
      .nullable()
      .optional(),
  })
  .refine(
    (body) =>
      body.targetDate !== undefined ||
      body.weight !== undefined ||
      body.doneMeans !== undefined,
    { message: 'send at least one of targetDate, weight or doneMeans' }
  );

export type MilestonePatch = z.infer<typeof milestonePatchSchema>;

/** PATCH /api/projects/[id] body: the new lead's user id, or null. */
export const projectPatchSchema = z.strictObject({
  leadId: z.string().trim().min(1).max(200).nullable(),
});

export type ProjectPatch = z.infer<typeof projectPatchSchema>;

/** A route param that can be an entity id, else null (→ 404). */
export function parseEntityId(raw: string): string | null {
  const id = raw.trim();
  return id === '' || id.length > 200 ? null : id;
}

/**
 * Applies a milestone PATCH: target date first (the Linear write), then the
 * tool-owned weight and "done means…". A failure stops there and is
 * reported; fields before it stay saved.
 */
export async function patchMilestone<E extends MilestoneEditEngine>(
  request: Request,
  rawId: string,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const id = parseEntityId(rawId);
  if (id === null) {
    return jsonError(404, 'not_found', 'That milestone is not in the mirror.');
  }
  const body = await readJson(request, milestonePatchSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  try {
    if (body.targetDate !== undefined) {
      await engine.setMilestoneTargetDate(actor, id, body.targetDate);
    }
    if (body.weight !== undefined) {
      await engine.setMilestoneWeight(actor, id, body.weight);
    }
    if (body.doneMeans !== undefined) {
      await engine.setMilestoneDoneMeans(actor, id, body.doneMeans);
    }
  } catch (error) {
    // A needs_write_scope answer's grant link comes back to this milestone.
    return errorResponse(error, {
      returnTo: `/timeline?milestone=${encodeURIComponent(id)}`,
    });
  }
  return Response.json({ ok: true });
}

/**
 * Applies a project PATCH: sets or clears the lead in Linear, with the
 * signed-in person's own token (the engine requires the write grant).
 */
export async function patchProject<E extends ProjectEditEngine>(
  request: Request,
  rawId: string,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const id = parseEntityId(rawId);
  if (id === null) {
    return jsonError(404, 'not_found', 'That project is not in the mirror.');
  }
  const body = await readJson(request, projectPatchSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  try {
    await engine.setProjectLead(actor, id, body.leadId);
  } catch (error) {
    return errorResponse(error, {
      returnTo: `/timeline?project=${encodeURIComponent(id)}`,
    });
  }
  return Response.json({ ok: true });
}
