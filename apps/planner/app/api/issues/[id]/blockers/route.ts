import { requireApiActor } from '../../../../../lib/http';
import { postBlocker } from '../../../../../lib/issue-routes';

/**
 * POST /api/issues/[id]/blockers { blockerIssueId } (Linear write
 * access): records in Linear, as the signed-in person, that the blocker
 * blocks this issue. 201 { relation }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return postBlocker(request, id, requireApiActor);
}
