import { requireApiActor } from '../../../../lib/http';
import { patchMilestone } from '../../../../lib/timeline-edits';

/**
 * PATCH /api/milestones/[id] { targetDate?, weight?, doneMeans? } (PMs):
 * re-dates the milestone in Linear as the signed-in PM and sets the
 * planner's own weight override and "done means…". Same-origin JSON only;
 * the engine checks isPm and Linear write scope. 200 { ok: true }.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return patchMilestone(request, id, requireApiActor);
}
