import { requireApiActor } from '../../../lib/http';
import { bulkUpdateIssues } from '../../../lib/issue-routes';

/**
 * PATCH /api/issues (Linear write access; owner request 2026-10-22,
 * "every issue in one list"): the Issues page's bulk change, drop and
 * Undo. `{ issueIds, patch, returnTo? }` with an IssueBulkPatch (move,
 * assigneeId, priority, state), at most 100 issues, written to Linear
 * with the signed-in person's own token and audited per issue.
 * Same-origin JSON only. 200 { result: IssueBulkResult }.
 */
export async function PATCH(request: Request): Promise<Response> {
  return bulkUpdateIssues(request, requireApiActor);
}
