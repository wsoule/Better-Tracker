import { requireApiActor } from '../../../../lib/http';
import { searchIssues } from '../../../../lib/issue-routes';

/**
 * GET /api/issues/search?q=<text>[&near=<issue id>] (signed in): the
 * relation picker's search over the mirror, at most 20 issues. Private,
 * never cached. 200 { results }.
 */
export async function GET(request: Request): Promise<Response> {
  return searchIssues(request, requireApiActor);
}
