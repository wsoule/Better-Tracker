import { requireApiActor } from '../../../../lib/http';
import { patchProject } from '../../../../lib/timeline-edits';

/**
 * PATCH /api/projects/[id] { leadId: string | null } (PMs): sets or clears
 * the project lead in Linear as the signed-in PM. Same-origin JSON only;
 * the engine checks isPm, Linear write scope and that the lead is an
 * active person. 200 { ok: true }.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return patchProject(request, id, requireApiActor);
}
