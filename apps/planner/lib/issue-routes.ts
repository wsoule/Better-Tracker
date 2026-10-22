import {
  COMMENT_MAX_LENGTH,
  ISSUE_DESCRIPTION_MAX_LENGTH,
  ISSUE_TITLE_MAX_LENGTH,
  type IssuePatch,
  isValidIsoDate,
  type Priority,
  type Snapshot,
} from '@better-tracker/core';
import type { Actor, Engine } from '@better-tracker/engine';
import { z } from 'zod';

import { findIssue, issuePagePath, searchIssueMirror } from './adapters/issue';
import {
  errorResponse,
  jsonError,
  needsWriteScope,
  readJson,
  refuseReadOnly,
} from './http';
import { type ApiActorResolver, parseEntityId } from './timeline-edits';

// The issue page's routes (architecture §8.1, §8.5; owner decision
// 2026-10-21: every signed-in person edits issues with their own Linear
// token):
//
//   GET    /api/issues/[id]            IssueDetailResult (id or identifier)
//   PATCH  /api/issues/[id]            an IssuePatch → { result }
//   POST   /api/issues/[id]/comments   { body } → 201 { comment }
//   POST   /api/issues/[id]/blockers   { blockerIssueId } → 201 { relation }
//   DELETE /api/relations/[id]         → 204
//   GET    /api/issues/search?q=&near= the relation picker's mirror search
//
// The app/api route files only pass their params and requireApiActor in;
// the handlers live here so tests can run them with a fake actor resolver
// and a recording engine. Order in every write: resolve the actor (CSRF
// guard + signed in) → the read-only check (403 read_only for a Linear
// guest; owner decision 2026-10-22, "Guests limited to read only") →
// strict zod body (unknown keys, wrong types, an empty patch: 400 before
// the engine) → Linear write scope (403 needs_write_scope with the
// grant_write link; no role check) → the engine, which refuses a guest
// again and validates against the mirror and Linear → errorResponse
// (linear_forbidden 403, rate_limited 429).

const entityId = z.string().trim().min(1).max(200);

const isoDate = z.string().refine((value) => isValidIsoDate(value), {
  message: 'must be a calendar date (YYYY-MM-DD), or null to clear it',
});

/**
 * PATCH /api/issues/[id] body: any of the IssuePatch fields, at least one.
 * Shapes and payload bounds are checked here; the engine applies the
 * precise rules (one-line title of at most 255 characters, the team's
 * states and labels, the estimate scale, the project's milestones).
 */
export const issuePatchSchema = z
  .strictObject({
    title: z
      .string()
      .max(ISSUE_TITLE_MAX_LENGTH * 4, {
        message: `must be at most ${ISSUE_TITLE_MAX_LENGTH} characters`,
      })
      .refine((value) => value.trim() !== '', {
        message: 'must not be empty',
      })
      .optional(),
    description: z
      .string()
      .max(ISSUE_DESCRIPTION_MAX_LENGTH, {
        message: `must be at most ${ISSUE_DESCRIPTION_MAX_LENGTH} characters`,
      })
      .nullable()
      .optional(),
    stateId: entityId.optional(),
    assigneeId: entityId.nullable().optional(),
    priority: z
      .number()
      .int({ message: 'must be 0 (none), 1 (urgent), 2, 3 or 4 (low)' })
      .min(0, { message: 'must be 0 (none), 1 (urgent), 2, 3 or 4 (low)' })
      .max(4, { message: 'must be 0 (none), 1 (urgent), 2, 3 or 4 (low)' })
      .optional(),
    projectId: entityId.nullable().optional(),
    projectMilestoneId: entityId.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    estimate: z
      .number()
      .int({ message: 'must be a whole number, or null to clear it' })
      .min(0, { message: 'must not be negative' })
      .max(1000, { message: 'must be at most 1000' })
      .nullable()
      .optional(),
    labelIds: z
      .array(entityId)
      .max(200, { message: 'lists at most 200 labels' })
      .optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'send at least one field to change',
  });

/** POST /api/issues/[id]/comments body. */
export const commentSchema = z.strictObject({
  body: z
    .string()
    // The engine counts characters (an emoji is one); this bounds the
    // payload in UTF-16 units.
    .max(COMMENT_MAX_LENGTH * 2, {
      message: `must be at most ${COMMENT_MAX_LENGTH} characters`,
    })
    .refine((value) => value.trim() !== '', { message: 'must not be empty' }),
});

/** POST /api/issues/[id]/blockers body: the issue that blocks [id]. */
export const blockerSchema = z.strictObject({ blockerIssueId: entityId });

/** Drops keys whose value is undefined, so the engine sees only real fields. */
function patchFrom(body: z.infer<typeof issuePatchSchema>): IssuePatch {
  const patch: IssuePatch = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.stateId !== undefined) patch.stateId = body.stateId;
  if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId;
  if (body.priority !== undefined) patch.priority = body.priority as Priority;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.projectMilestoneId !== undefined) {
    patch.projectMilestoneId = body.projectMilestoneId;
  }
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.estimate !== undefined) patch.estimate = body.estimate;
  if (body.labelIds !== undefined) patch.labelIds = body.labelIds;
  return patch;
}

const NO_WRITE_SCOPE =
  'Allow edits in Linear first: the planner edits issues with your own Linear account.';

/** The 403 for a person whose Linear token may not write (yet). */
function refuseWithoutWriteScope(
  actor: Actor,
  returnTo: string
): Response | null {
  return actor.canWriteLinear
    ? null
    : needsWriteScope(NO_WRITE_SCOPE, returnTo);
}

function notFound(): Response {
  return jsonError(
    404,
    'not_found',
    'That issue is not in the planner (it may be in a closed project, or in a team the app cannot see).'
  );
}

/** The issue page a grant_write link returns to: /issues/<id>. */
function pageFor(id: string): string {
  return issuePagePath(id);
}

export type IssueReadEngine = Pick<Engine, 'getIssueDetail'> & {
  /** `viewer`: the mirror narrowed to what that person may see (§2.13). */
  load(workspaceId: string, viewer?: Actor): Promise<{ snapshot: Snapshot }>;
};

/**
 * GET /api/issues/[id]: the IssueDetailResult for an id or an identifier
 * ("ENG-24"). Private to the person (their token read the live part),
 * never cached. 200 { result }.
 */
export async function getIssue<E extends IssueReadEngine>(
  request: Request,
  rawId: string,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const key = parseEntityId(rawId);
  if (key === null) return notFound();
  const { engine, actor } = context;
  try {
    const { snapshot } = await engine.load(actor.session.workspaceId, actor);
    const issue = findIssue(snapshot.issues, key);
    if (issue === undefined) return notFound();
    const result = await engine.getIssueDetail(actor, issue.id);
    return Response.json(
      { result },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return errorResponse(error, { returnTo: pageFor(key) });
  }
}

export type IssuePatchEngine = Pick<Engine, 'updateIssue'>;

/** PATCH /api/issues/[id]: edits the issue in Linear as the person. */
export async function patchIssue<E extends IssuePatchEngine>(
  request: Request,
  rawId: string,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const id = parseEntityId(rawId);
  if (id === null) return notFound();
  const body = await readJson(request, issuePatchSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  const refused = refuseWithoutWriteScope(actor, pageFor(id));
  if (refused !== null) return refused;
  try {
    const result = await engine.updateIssue(actor, id, patchFrom(body));
    return Response.json({ result });
  } catch (error) {
    return errorResponse(error, { returnTo: pageFor(id) });
  }
}

export type CommentEngine = Pick<Engine, 'addComment'>;

/** POST /api/issues/[id]/comments { body }: a comment as the person. */
export async function postComment<E extends CommentEngine>(
  request: Request,
  rawId: string,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const id = parseEntityId(rawId);
  if (id === null) return notFound();
  const body = await readJson(request, commentSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  const refused = refuseWithoutWriteScope(actor, pageFor(id));
  if (refused !== null) return refused;
  try {
    const comment = await engine.addComment(actor, id, body.body);
    return Response.json({ comment }, { status: 201 });
  } catch (error) {
    return errorResponse(error, { returnTo: pageFor(id) });
  }
}

export type BlockerEngine = Pick<Engine, 'addBlocker'>;

/**
 * POST /api/issues/[id]/blockers { blockerIssueId }: "blockerIssueId
 * blocks [id]" in Linear, as the person. For "this blocks X" the client
 * posts to X with this issue as the blocker. 201 { relation }.
 */
export async function postBlocker<E extends BlockerEngine>(
  request: Request,
  rawId: string,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const readOnly = refuseReadOnly(context.actor);
  if (readOnly !== null) return readOnly;
  const id = parseEntityId(rawId);
  if (id === null) return notFound();
  const body = await readJson(request, blockerSchema);
  if (body instanceof Response) return body;
  const { engine, actor } = context;
  const refused = refuseWithoutWriteScope(actor, pageFor(id));
  if (refused !== null) return refused;
  try {
    const relation = await engine.addBlocker(actor, id, body.blockerIssueId);
    return Response.json({ relation }, { status: 201 });
  } catch (error) {
    return errorResponse(error, { returnTo: pageFor(id) });
  }
}

export type RelationEngine = Pick<Engine, 'removeRelation'>;

/**
 * DELETE /api/relations/[id]: removes a blocks relation in Linear, as the
 * person. Takes no body. 204.
 */
export async function deleteRelation<E extends RelationEngine>(
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
    return jsonError(404, 'not_found', 'That relation is not in the planner.');
  }
  const { engine, actor } = context;
  const refused = refuseWithoutWriteScope(actor, '/week');
  if (refused !== null) return refused;
  try {
    await engine.removeRelation(actor, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

export type SearchEngine = {
  /** `viewer`: the mirror narrowed to what that person may see (§2.13). */
  load(workspaceId: string, viewer?: Actor): Promise<{ snapshot: Snapshot }>;
};

/**
 * GET /api/issues/search?q=<text>[&near=<issue id>]: the relation
 * picker's search over the mirror (identifier or title; open issues and
 * the near issue's milestone and project first; at most 20). Private,
 * never cached. 200 { results }.
 */
export async function searchIssues<E extends SearchEngine>(
  request: Request,
  resolve: ApiActorResolver<E>
): Promise<Response> {
  const context = await resolve(request);
  if (context instanceof Response) return context;
  const params = new URL(request.url).searchParams;
  const query = params.get('q') ?? '';
  if (query.length > 200) {
    return jsonError(400, 'invalid', 'q: must be at most 200 characters');
  }
  const near = parseEntityId(params.get('near') ?? '');
  const { engine, actor } = context;
  try {
    const { snapshot } = await engine.load(actor.session.workspaceId, actor);
    return Response.json(
      { results: searchIssueMirror(snapshot, query, { near }) },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
