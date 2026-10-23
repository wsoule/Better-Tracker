import { requireApiActor } from '../../../../lib/http';
import { getIssueListOptionsRoute } from '../../../../lib/issue-routes';

/**
 * GET /api/issues/options (signed in): the Issues page's picker options
 * as the person may see them, with the mirror version. Private, never
 * cached. 200 { options, mirrorVersion }.
 */
export async function GET(request: Request): Promise<Response> {
  return getIssueListOptionsRoute(request, requireApiActor);
}
