import { requireApiActor } from '../../../../../lib/http';
import { postComment } from '../../../../../lib/issue-routes';

/**
 * POST /api/issues/[id]/comments { body } (Linear write access): adds a
 * comment (markdown) as the signed-in person. 201 { comment }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return postComment(request, id, requireApiActor);
}
