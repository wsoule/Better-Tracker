import { requireApiActor } from '../../../../lib/http';
import { previewWarnings } from '../../../../lib/pm-routes';

/**
 * POST /api/warnings/preview {} (PMs): builds today's warning digests
 * without recording or sending anything (engine.runWarnings with
 * previewOnly). Same-origin JSON only. 200 { preview }.
 */
export function POST(request: Request): Promise<Response> {
  return previewWarnings(request, requireApiActor);
}
