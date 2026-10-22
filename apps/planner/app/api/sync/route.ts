import { requireApiActor } from '../../../lib/http';
import { resync } from '../../../lib/workspace-routes';

/**
 * POST /api/sync {} (anyone signed in): a full resync of the workspace
 * from Linear, the same job the worker runs every 15 minutes. Same-origin
 * JSON only. 200 { sync } (a SyncResult; `ok: false` carries Linear's error).
 */
export function POST(request: Request): Promise<Response> {
  return resync(request, requireApiActor);
}
