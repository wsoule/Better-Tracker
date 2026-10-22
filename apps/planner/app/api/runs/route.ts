import { requireApiActor } from '../../../lib/http';
import { startRun } from '../../../lib/workspace-routes';

/**
 * POST /api/runs { mode: 'dry_run' | 'live' } (anyone signed in): starts
 * a manual allocation run, which syncs from Linear first and answers when
 * the run is finished. Live runs only while Settings → Modes says
 * allocation is live (409 otherwise); a run already in progress is 409
 * too. Same-origin JSON only. 201 { run }.
 */
export function POST(request: Request): Promise<Response> {
  return startRun(request, requireApiActor);
}
