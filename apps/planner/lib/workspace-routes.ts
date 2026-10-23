import type { WorkspaceSettings } from '@better-tracker/core';
import type { Engine } from '@better-tracker/engine';
import { z } from 'zod';

import { digestPreview } from './adapters/settings';
import { errorResponse, jsonError, readJson, refuseReadOnly } from './http';
import type { ApiActorResolver } from './timeline-edits';

// The workspace-wide operations of /runs and /settings as route handlers
// (architecture §8.1): POST /api/runs { mode }, POST /api/sync,
// POST /api/warnings/preview and PATCH /api/settings. The app/api route
// files only pass requireApiActor in; the handlers live here so tests can
// run them with a fake actor resolver and a stubbed engine.
//
// Order in every handler: resolve the actor (CSRF guard + signed in) →
// the read-only check (403 read_only for a Linear guest: owner decision
// 2026-10-22, "Guests limited to read only") → validate the JSON body with
// zod (a malformed body never reaches the engine: 400) → call the engine,
// mapping its errors with errorResponse. There is no role check: any
// signed-in person of the workspace but a guest may call all four (owner
// decision 2026-10-22). fullSync and the preview take no actor in the
// engine, so the read-only check here is what keeps a guest from them;
// runAllocation and updateSettings refuse a guest in the engine too. None
// of them writes to Linear with the person's token, so none needs the
// write grant; the engine audits every settings change.

/** POST /api/runs body. */
export const runRequestSchema = z.strictObject({
  mode: z.enum(['dry_run', 'live'], {
    message: 'must be dry_run or live',
  }),
});

/** POST /api/sync and /api/warnings/preview take no options: `{}`. */
export const emptyBodySchema = z.strictObject({});

const userIds = z
  .array(z.string().trim().min(1).max(200))
  .max(1000, { message: 'lists at most 1000 people' });

const days = z
  .number()
  .int({ message: 'must be a whole number of days' })
  .min(1, { message: 'must be at least 1 day' })
  .max(90, { message: 'must be at most 90 days' });

/**
 * PATCH /api/settings body: any subset of the settings, at least one
 * field. Shapes and ranges are checked here; the engine applies the rules
 * that need the mirror (watchers must be mirrored people, not the app
 * user; the timezone must be a real IANA zone). The watcher list may be
 * empty. The retired `pmUserIds` is an unknown key, so it is a 400.
 */
export const settingsPatchSchema = z
  .strictObject({
    watcherUserIds: userIds.optional(),
    allocationMode: z
      .enum(['dry_run', 'live'], { message: 'must be dry_run or live' })
      .optional(),
    warningsMode: z
      .enum(['preview', 'live'], { message: 'must be preview or live' })
      .optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    tuning: z
      .strictObject({
        warnLeadDays: days.optional(),
        paceWindowDays: days.optional(),
        stallDays: days.optional(),
        overdueRepeatDays: days.optional(),
        newBadgeDays: days.optional(),
        timelineDaysBack: days.optional(),
        timelineDaysAhead: days.optional(),
        activeProjectStatuses: z
          .array(
            z.enum([
              'backlog',
              'planned',
              'started',
              'paused',
              'completed',
              'canceled',
            ])
          )
          .min(1, { message: 'must list at least one project status' })
          .max(6)
          .optional(),
      })
      // `tuning: {}` would save nothing and still write an audit entry.
      .refine((tuning) => Object.values(tuning).some((v) => v !== undefined), {
        message: 'send at least one tuning value to change',
      })
      .optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'send at least one setting to change',
  });

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Drops keys whose value is undefined, so the engine sees only real fields. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** What startRun needs: runs, and the saved allocation mode (the live gate). */
export type RunEngine = Pick<Engine, 'runAllocation'> & {
  load(
    workspaceId: string
  ): Promise<{ settings: Pick<WorkspaceSettings, 'allocationMode'> }>;
};

/**
 * POST /api/runs { mode }: a manual allocation run started by the
 * signed-in person (recorded as a manual run). A live run is refused
 * (409 live_runs_off) while the workspace's allocation mode is dry run:
 * switching it to live in Settings → Modes is the gate (§7.4: dry run
 * until someone switches it live; anyone signed in may, and the switch is
 * audited). 201 { run }.
 */
export async function startRun<E extends RunEngine>(
  request: Request,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const body = await readJson(request, runRequestSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  const workspaceId = actor.session.workspaceId;
  try {
    if (body.mode === 'live') {
      const { settings } = await engine.load(workspaceId);
      if (settings.allocationMode !== 'live') {
        return jsonError(
          409,
          'live_runs_off',
          'Live runs are off: allocation is in dry run. Switch it to live in Settings → Modes first.'
        );
      }
    }
    const run = await engine.runAllocation({
      workspaceId,
      mode: body.mode,
      trigger: 'manual',
      actor,
    });
    return Response.json({ run }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export type SyncEngine = Pick<Engine, 'fullSync'>;

/** Minimum time between two resyncs of one workspace started from the web. */
export const RESYNC_COOLDOWN_MS = 60_000;

/**
 * When the last web resync of each workspace was accepted. A full sync
 * pages every Linear connection with the app's token, whose hourly quota
 * allocation, webhook refetches and the worker's sync share, so the route
 * accepts one per workspace per minute (the engine also joins concurrent
 * syncs of a workspace into one). Per process, like the engine.
 */
export interface ResyncCooldown {
  now: () => number;
  acceptedAt: Map<string, number>;
}

export function createResyncCooldown(
  now: () => number = Date.now
): ResyncCooldown {
  return { now, acceptedAt: new Map() };
}

const processCooldown = createResyncCooldown();

/**
 * POST /api/sync {}: a full resync from Linear. 200 { sync } (the result
 * without its counts: they are of the whole mirror, which may hold teams
 * the caller cannot see, §2.13); 429 resync_cooldown with Retry-After
 * (seconds) when this workspace was resynced from the web less than
 * RESYNC_COOLDOWN_MS ago; 403 read_only for a Linear guest (which, like a
 * bad body, never starts the clock).
 */
export async function resync<E extends SyncEngine>(
  request: Request,
  resolve: ApiActorResolver<E>,
  cooldown: ResyncCooldown = processCooldown
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const body = await readJson(request, emptyBodySchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  const workspaceId = actor.session.workspaceId;
  const now = cooldown.now();
  const last = cooldown.acceptedAt.get(workspaceId);
  if (last !== undefined && now - last < RESYNC_COOLDOWN_MS) {
    const seconds = Math.max(
      1,
      Math.ceil((last + RESYNC_COOLDOWN_MS - now) / 1000)
    );
    return jsonError(
      429,
      'resync_cooldown',
      `Resynced less than a minute ago. Try again in ${seconds} s.`,
      {},
      { 'Retry-After': String(seconds) }
    );
  }
  cooldown.acceptedAt.set(workspaceId, now);
  try {
    const { ok, version, durationMs, error } =
      await engine.fullSync(workspaceId);
    return Response.json({
      sync: { workspaceId, ok, version, durationMs, error },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export type PreviewEngine = Pick<Engine, 'runWarnings'>;

/**
 * POST /api/warnings/preview {}: today's digests, built but not recorded
 * or sent. 200 { preview } in the shape the Status section renders; 403
 * read_only for a Linear guest (the preview computes everyone's digests).
 */
export async function previewWarnings<E extends PreviewEngine>(
  request: Request,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const body = await readJson(request, emptyBodySchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  try {
    // Everyone's digests, as far as the person asking may see (§2.13).
    const result = await engine.runWarnings({
      workspaceId: actor.session.workspaceId,
      previewOnly: true,
      viewer: actor,
    });
    return Response.json({ preview: digestPreview(result) });
  } catch (error) {
    return errorResponse(error);
  }
}

export type SettingsEngine = Pick<Engine, 'updateSettings'>;

/**
 * PATCH /api/settings: a validated partial settings patch. 200
 * { settings }; 403 read_only for a Linear guest.
 */
export async function patchSettings<E extends SettingsEngine>(
  request: Request,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const body = await readJson(request, settingsPatchSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  const patch = definedOnly({
    ...body,
    tuning: body.tuning === undefined ? undefined : definedOnly(body.tuning),
  });
  try {
    // The engine merges a partial `tuning` over the saved one
    // (applySettingsPatch); its signature types tuning as a whole Tuning.
    const settings = await engine.updateSettings(
      actor,
      patch as Parameters<SettingsEngine['updateSettings']>[1]
    );
    return Response.json({ settings });
  } catch (error) {
    return errorResponse(error);
  }
}
