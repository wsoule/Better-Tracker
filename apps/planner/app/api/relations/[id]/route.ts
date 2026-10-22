import { requireApiActor } from '../../../../lib/http';
import { deleteRelation } from '../../../../lib/issue-routes';

/**
 * DELETE /api/relations/[id] (Linear write access): removes a blocks
 * relation in Linear as the signed-in person. Same-origin only. 204.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return deleteRelation(request, id, requireApiActor);
}
