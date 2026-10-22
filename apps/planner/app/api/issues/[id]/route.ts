import { requireApiActor } from '../../../../lib/http';
import { getIssue, patchIssue } from '../../../../lib/issue-routes';

/**
 * GET /api/issues/[id] (signed in): the issue's IssueDetailResult, by id
 * or identifier. Private, never cached. 200 { result }.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return getIssue(request, id, requireApiActor);
}

/**
 * PATCH /api/issues/[id] (Linear write access; owner decision 2026-10-21):
 * an IssuePatch — title, description, stateId, assigneeId, priority,
 * projectId, projectMilestoneId, dueDate, estimate, labelIds — written to
 * Linear with the signed-in person's own token. Same-origin JSON only.
 * 200 { result: { issue, changed } }.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  return patchIssue(request, id, requireApiActor);
}
