import { requireApiActor } from '../../../../lib/http';
import { patchMilestone } from '../../../../lib/timeline-edits';

/**
 * PATCH /api/milestones/[id] { targetDate?, weight?, doneMeans? } (anyone
 * signed in): re-dates the milestone in Linear with the signed-in person's
 * own token and sets the planner's own weight override and "done means…".
 * Same-origin JSON only; the engine requires Linear write scope for the
 * date only (weight and "done means…" need just the session).
 * 200 { ok: true }.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return patchMilestone(request, id, requireApiActor);
}
